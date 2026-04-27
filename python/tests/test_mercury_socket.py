"""Regression tests for MercurySocket reconnect/race behavior."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import aiohttp

from webex_message_handler.mercury_socket import MercurySocket


class FakeWSMessage:
    def __init__(self, *, type_: aiohttp.WSMsgType, data: str = "") -> None:
        self.type = type_
        self.data = data


class FakeWebSocket:
    """Minimal async-iterable WS stand-in for MercurySocket.

    Iteration yields whatever has been pushed via `push_message` / `close_from_server`.
    `_session` is attached so MercurySocket's cleanup paths can be exercised.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[FakeWSMessage | None] = asyncio.Queue()
        self.close_code: int | None = None
        self.closed = False
        self.sent: list[str] = []
        session = MagicMock()
        session.closed = False
        session.close = AsyncMock()
        self._session = session

    async def send_str(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.close_code = code
        self.closed = True
        await self._queue.put(None)

    def __aiter__(self) -> FakeWebSocket:
        return self

    async def __anext__(self) -> FakeWSMessage:
        msg = await self._queue.get()
        if msg is None:
            raise StopAsyncIteration
        return msg

    async def push_message(self, message: dict[str, Any]) -> None:
        await self._queue.put(FakeWSMessage(type_=aiohttp.WSMsgType.TEXT, data=json.dumps(message)))

    async def close_from_server(self, code: int = 1000) -> None:
        self.close_code = code
        self.closed = True
        await self._queue.put(FakeWSMessage(type_=aiohttp.WSMsgType.CLOSED))


READY_MESSAGE = {"data": {"eventType": "mercury.buffer_state"}}


def _make_socket(ws: FakeWebSocket, **overrides: Any) -> MercurySocket:
    async def ws_factory(_url: str) -> Any:
        return ws

    defaults: dict[str, Any] = {
        "ws_factory": ws_factory,
        "ping_interval": 10_000.0,  # effectively disable ping during tests
        "pong_timeout": 10_000.0,
        "reconnect_backoff_max": 0.0,
        "max_reconnect_attempts": 3,
        "reconnect_stability_seconds": 60.0,
    }
    defaults.update(overrides)
    return MercurySocket(**defaults)


async def _connect_and_ready(socket: MercurySocket, ws: FakeWebSocket) -> None:
    connect_task = asyncio.create_task(socket.connect("wss://mercury.example.com/socket", "tok"))
    # Let the connect path open the ws and kick off the read loop.
    await asyncio.sleep(0)
    await ws.push_message(READY_MESSAGE)
    await connect_task


class TestStaleReadLoopDoesNotClobberNewWs:
    """Regression test for the race where the old read-loop's exit path ran
    _handle_close against the rotated-in new ws.

    Reproduction of the production outage (2026-04-25): pong-timeout path
    swapped in a fresh ws, and then the original ws's async iteration ended
    and called _handle_close against the *new* ws — triggering a redundant
    reconnect, killing its ping loop, and emitting duplicate events.
    """

    async def test_stale_read_loop_exit_does_not_emit_disconnected(self) -> None:
        ws1 = FakeWebSocket()
        socket = _make_socket(ws1)

        disconnected_reasons: list[str] = []
        reconnect_attempts: list[int] = []
        socket.on("disconnected", lambda reason: disconnected_reasons.append(reason))
        socket.on("reconnecting", lambda attempt: reconnect_attempts.append(attempt))

        await _connect_and_ready(socket, ws1)
        assert socket.connected

        # Simulate the pong-timeout path: a fresh ws has already been rotated
        # in, replacing the one this read-loop was iterating.
        ws2 = FakeWebSocket()
        ws2.closed = False
        socket._ws = ws2  # type: ignore[attr-defined]

        # Now the original ws's iteration ends. The old read-loop's tail
        # should notice it's stale and exit quietly.
        await ws1.close_from_server(code=1000)

        # Drain the read task so we can assert its side effects.
        assert socket._read_task is not None  # type: ignore[attr-defined]
        await asyncio.wait_for(socket._read_task, timeout=1.0)  # type: ignore[attr-defined]

        # No spurious disconnect or reconnect kicked off.
        assert disconnected_reasons == []
        assert reconnect_attempts == []

        # The new ws is still installed — the stale loop did not null it out.
        assert socket._ws is ws2  # type: ignore[attr-defined]

        # And the orphaned session on the stale ws was closed.
        ws1._session.close.assert_awaited()  # type: ignore[attr-defined]

        # Clean up.
        await socket.disconnect()

    async def test_stale_read_loop_does_not_emit_buffered_messages(self) -> None:
        """If the ws has been rotated, buffered TEXT messages sitting in the
        old loop's queue must not fire activity / KMS / ACK side effects.

        Without the per-iteration stale check, _handle_activity_envelope would
        ACK on the NEW socket and emit duplicate events for stale payloads.
        """
        ws1 = FakeWebSocket()
        socket = _make_socket(ws1)

        kms_events: list[Any] = []
        activity_events: list[Any] = []
        socket.on("kms:response", lambda data: kms_events.append(data))
        socket.on("activity", lambda activity: activity_events.append(activity))

        await _connect_and_ready(socket, ws1)

        # Rotate a new ws in, as _on_pong_timeout + _reconnect would.
        ws2 = FakeWebSocket()
        socket._ws = ws2  # type: ignore[attr-defined]

        # A message buffered on the old ws *after* rotation must be dropped.
        await ws1.push_message(
            {"id": "stale-1", "data": {"eventType": "conversation.activity",
                                        "activity": {"id": "a1", "verb": "post"}}}
        )
        await ws1.close_from_server(code=1000)

        assert socket._read_task is not None  # type: ignore[attr-defined]
        await asyncio.wait_for(socket._read_task, timeout=1.0)  # type: ignore[attr-defined]

        assert kms_events == []
        assert activity_events == []
        # The new ws must not have had an ACK written to it for the stale msg.
        assert ws2.sent == []

        await socket.disconnect()

    async def test_live_read_loop_exit_still_triggers_reconnect(self) -> None:
        """Sanity check: the normal (non-stale) path must still work."""
        ws = FakeWebSocket()
        socket = _make_socket(ws, max_reconnect_attempts=0)

        disconnected_reasons: list[str] = []
        socket.on("disconnected", lambda reason: disconnected_reasons.append(reason))

        await _connect_and_ready(socket, ws)
        await ws.close_from_server(code=1000)

        assert socket._read_task is not None  # type: ignore[attr-defined]
        await asyncio.wait_for(socket._read_task, timeout=1.0)  # type: ignore[attr-defined]
        # _reconnect runs on the event loop — give it a tick.
        for _ in range(5):
            await asyncio.sleep(0)

        # With max_reconnect_attempts=0, the reconnect path immediately
        # emits max-attempts-exceeded, proving it did run.
        assert "max-attempts-exceeded" in disconnected_reasons


class TestFlapStormTripsMaxAttempts:
    """Regression test for the infinite-reconnect trap.

    Previously, `_reconnect_attempts = 0` fired on every successful reconnect,
    so a flap storm of short-lived "successful" reconnects reset the counter
    each cycle and max-attempts never tripped. The fix defers the reset until
    the connection has been stable for _reconnect_stability_seconds.
    """

    async def test_counter_only_resets_after_stability_window(self) -> None:
        ws = FakeWebSocket()
        socket = _make_socket(ws, reconnect_stability_seconds=0.05)

        socket._reconnect_attempts = 2  # type: ignore[attr-defined]

        # Simulate what _reconnect does after a successful _connect_internal.
        socket._schedule_attempts_reset()  # type: ignore[attr-defined]

        # Before the window elapses, the counter is untouched.
        await asyncio.sleep(0.01)
        assert socket._reconnect_attempts == 2  # type: ignore[attr-defined]

        # After the window, it finally clears.
        await asyncio.sleep(0.1)
        assert socket._reconnect_attempts == 0  # type: ignore[attr-defined]

    async def test_flap_before_stability_preserves_counter(self) -> None:
        ws = FakeWebSocket()
        socket = _make_socket(ws, reconnect_stability_seconds=5.0)

        socket._reconnect_attempts = 4  # type: ignore[attr-defined]
        socket._schedule_attempts_reset()  # type: ignore[attr-defined]

        # A close before the window elapses must cancel the pending reset,
        # otherwise a flap storm resets the counter on every cycle.
        socket._handle_close(1000, "")  # type: ignore[attr-defined]

        # Let any queued callbacks run.
        for _ in range(5):
            await asyncio.sleep(0)

        assert socket._reconnect_attempts == 4  # type: ignore[attr-defined]
        assert socket._stability_timer_handle is None  # type: ignore[attr-defined]

    async def test_repeated_flaps_eventually_trip_max_attempts(self) -> None:
        """End-to-end: N rapid reconnect cycles with no stability window
        between them accumulate attempts until max is exceeded."""
        ws = FakeWebSocket()
        socket = _make_socket(
            ws,
            max_reconnect_attempts=3,
            reconnect_stability_seconds=60.0,  # never fires within the test
            reconnect_backoff_max=0.0,
        )

        disconnected_reasons: list[str] = []
        socket.on("disconnected", lambda reason: disconnected_reasons.append(reason))

        # Stub out the actual connect path — we're only exercising the
        # counter/close loop.
        async def fake_connect_internal() -> None:
            socket._connection_ready = True  # type: ignore[attr-defined]
            socket._ws = ws  # type: ignore[attr-defined]

        socket._connect_internal = fake_connect_internal  # type: ignore[assignment]
        socket._token = "tok"  # type: ignore[attr-defined]
        socket._base_url = "wss://mercury.example.com/socket"  # type: ignore[attr-defined]

        # Drive three rapid flap cycles: each "reconnect" succeeds, then
        # _handle_close cancels the pending stability reset, so the next
        # _reconnect sees the incremented counter.
        for _ in range(4):
            await socket._reconnect()  # type: ignore[attr-defined]
            socket._handle_close(1000, "")  # type: ignore[attr-defined]

        assert "max-attempts-exceeded" in disconnected_reasons
