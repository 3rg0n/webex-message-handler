"""Mercury WebSocket connection with auth, heartbeat, and reconnection."""

from __future__ import annotations

import asyncio
import json
import math
import uuid
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from .errors import AuthError, MercuryConnectionError
from .logger import Logger, noop_logger
from .types import InjectedWebSocket, MercuryActivity, MercuryActor, MercuryObject, MercuryTarget, WebSocketFactory


class MercurySocket:
    """Mercury WebSocket connection manager.

    Handles connection, authentication, ping/pong heartbeat,
    activity routing, and exponential-backoff reconnection.
    """

    def __init__(
        self,
        *,
        logger: Logger | None = None,
        ws_factory: WebSocketFactory,
        ping_interval: float = 15.0,
        pong_timeout: float = 14.0,
        reconnect_backoff_max: float = 32.0,
        max_reconnect_attempts: int = 10,
    ) -> None:
        self._logger: Logger = logger or noop_logger  # type: ignore[assignment]
        self._ws_factory = ws_factory
        self._ping_interval = ping_interval
        self._pong_timeout = pong_timeout
        self._reconnect_backoff_max = reconnect_backoff_max
        self._max_reconnect_attempts = max_reconnect_attempts

        self._ws: InjectedWebSocket | None = None
        self._token: str | None = None
        self._base_url: str | None = None
        self._connection_ready = False
        self._should_reconnect = True
        self._reconnect_attempts = 0
        self._pending_pong_id: str | None = None

        self._ping_task: asyncio.Task[None] | None = None
        self._read_task: asyncio.Task[None] | None = None
        self._pong_timeout_handle: asyncio.TimerHandle | None = None

        # Event callbacks
        self._listeners: dict[str, list[Callable[..., Any]]] = {
            "connected": [],
            "disconnected": [],
            "reconnecting": [],
            "activity": [],
            "kms:response": [],
            "error": [],
        }

    def on(self, event: str, callback: Callable[..., Any]) -> None:
        """Register an event listener."""
        if event not in self._listeners:
            self._listeners[event] = []
        self._listeners[event].append(callback)

    def _emit(self, event: str, *args: Any) -> None:
        """Emit an event to all registered listeners."""
        for callback in self._listeners.get(event, []):
            try:
                callback(*args)
            except Exception as exc:
                self._logger.error(f"Error in {event} listener: {exc}")

    async def connect(self, url: str, token: str) -> None:
        """Connect to Mercury WebSocket."""
        self._token = token
        self._base_url = url
        self._should_reconnect = True
        self._reconnect_attempts = 0
        await self._connect_internal()

    async def _connect_internal(self) -> None:
        """Internal connection logic."""
        prepared_url = self._prepare_url(self._base_url or "")
        self._logger.debug(f"Connecting to Mercury at {prepared_url}")

        self._connection_ready = False
        ready_event = asyncio.Event()
        connect_error: list[Exception] = []

        try:
            self._ws = await self._ws_factory(prepared_url)
        except Exception as exc:
            raise MercuryConnectionError("Failed to connect to Mercury socket") from exc

        # Send authorization
        self._logger.debug("WebSocket opened, sending authorization")
        auth_message = json.dumps({
            "id": str(uuid.uuid4()),
            "type": "authorization",
            "data": {"token": f"Bearer {self._token}"},
        })
        await self._ws.send(auth_message)

        # Start read loop in background
        async def _read_loop() -> None:
            assert self._ws is not None
            try:
                async for msg in self._ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        raw_str = msg.data
                        self._logger.debug(f"WS message received ({len(raw_str)} bytes)")
                        try:
                            message = json.loads(raw_str)
                        except json.JSONDecodeError:
                            self._logger.error("Failed to parse Mercury message")
                            continue

                        self._handle_message(message)

                        # Check for connection ready
                        if not self._connection_ready and self._is_connection_ready(message):
                            self._connection_ready = True
                            self._logger.debug("Mercury connection ready")
                            self._start_ping_loop()
                            ready_event.set()

                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING):
                        break
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        if not self._connection_ready:
                            connect_error.append(
                                MercuryConnectionError("Failed to connect to Mercury socket")
                            )
                            ready_event.set()
                        else:
                            self._emit("error", MercuryConnectionError("WebSocket error"))
                        break
            except Exception as exc:
                if not self._connection_ready:
                    connect_error.append(
                        MercuryConnectionError(f"WebSocket error: {exc}")
                    )
                    ready_event.set()
                else:
                    self._emit("error", exc)

            # WebSocket closed
            close_code = self._ws.close_code if self._ws else None
            self._handle_close(close_code or 1000, "")

        self._read_task = asyncio.create_task(_read_loop())

        # Wait for connection ready or error
        try:
            await asyncio.wait_for(ready_event.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            await self._cleanup_ws()
            raise MercuryConnectionError("Mercury connection timeout waiting for ready signal")

        if connect_error:
            await self._cleanup_ws()
            raise connect_error[0]

    def _prepare_url(self, base_url: str) -> str:
        """Add query parameters to Mercury URL."""
        parsed = urlparse(base_url)
        existing_params = parse_qs(parsed.query)
        params = {k: v[0] if len(v) == 1 else v for k, v in existing_params.items()}
        params["outboundWireFormat"] = "text"
        params["bufferStates"] = "true"
        params["aliasHttpStatus"] = "true"
        params["clientTimestamp"] = str(int(asyncio.get_event_loop().time() * 1000))
        new_query = urlencode(params)
        return urlunparse(parsed._replace(query=new_query))

    def _is_connection_ready(self, message: dict[str, Any]) -> bool:
        event_type = message.get("data", {}).get("eventType", "")
        return "mercury.buffer_state" in event_type or "mercury.registration_status" in event_type

    def _start_ping_loop(self) -> None:
        async def _ping() -> None:
            while True:
                await asyncio.sleep(self._ping_interval)
                if self._ws and not self._ws.closed:
                    self._pending_pong_id = str(uuid.uuid4())
                    ping_message = json.dumps({
                        "id": self._pending_pong_id,
                        "type": "ping",
                    })
                    try:
                        await self._ws.send(ping_message)
                    except Exception:
                        break
                    self._logger.debug(f"Sent ping: {self._pending_pong_id}")

                    # Schedule pong timeout
                    loop = asyncio.get_event_loop()
                    self._pong_timeout_handle = loop.call_later(
                        self._pong_timeout,
                        lambda: asyncio.ensure_future(self._on_pong_timeout()),
                    )

        self._ping_task = asyncio.create_task(_ping())

    async def _on_pong_timeout(self) -> None:
        self._logger.warning(f"Pong timeout for ping {self._pending_pong_id}, reconnecting")
        self._pending_pong_id = None
        await self._close_websocket()
        await self._reconnect()

    def _handle_message(self, message: dict[str, Any]) -> None:
        try:
            msg_type = message.get("type")
            if msg_type == "pong":
                self._handle_pong(message)
            elif message.get("data", {}).get("eventType"):
                self._handle_activity_envelope(message)
            elif msg_type == "shutdown":
                self._logger.info("Received shutdown message from Mercury")
                asyncio.ensure_future(self._reconnect())
            else:
                self._logger.debug(
                    f"Unhandled Mercury message type: {msg_type}, keys: {list(message.keys())}"
                )
        except Exception as exc:
            self._logger.error(f"Error handling Mercury message: {exc}")

    def _handle_pong(self, message: dict[str, Any]) -> None:
        if self._pending_pong_id and message.get("id") == self._pending_pong_id:
            self._logger.debug(f"Received pong: {message.get('id')}")
            self._pending_pong_id = None
            if self._pong_timeout_handle:
                self._pong_timeout_handle.cancel()
                self._pong_timeout_handle = None

    def _handle_activity_envelope(self, message: dict[str, Any]) -> None:
        data = message.get("data", {})
        event_type = data.get("eventType", "")
        self._logger.debug(f"Mercury eventType: {event_type}")

        # Send ACK
        if self._ws and not self._ws.closed:
            ack = json.dumps({"messageId": message.get("id"), "type": "ack"})
            asyncio.ensure_future(self._ws.send_str(ack))

        # Route KMS messages
        if event_type.startswith("encryption."):
            self._logger.debug(f"Emitting kms:response for eventType: {event_type}")
            self._emit("kms:response", data)
            return

        # Route conversation activities
        if event_type == "conversation.activity" and "activity" in data:
            raw_activity = data["activity"]
            activity = _parse_activity(raw_activity)
            self._logger.debug(f"Emitting activity: {activity.id}")
            self._emit("activity", activity)

    def _handle_close(self, code: int, reason: str) -> None:
        self._logger.info(f"WebSocket closed with code {code}: {reason}")
        self._stop_ping_loop()
        self._connection_ready = False

        if code == 4401:
            self._logger.error("Mercury authorization failed")
            self._should_reconnect = False
            self._emit("error", AuthError("Mercury authorization failed"))
            self._emit("disconnected", "auth-failed")
            return

        if code in (4400, 4403):
            self._logger.error(f"Mercury permanent failure (code {code})")
            self._should_reconnect = False
            self._emit("error", MercuryConnectionError(f"Mercury permanent failure (code {code})", code))
            self._emit("disconnected", "permanent-failure")
            return

        if self._should_reconnect:
            asyncio.ensure_future(self._reconnect())
        else:
            self._emit("disconnected", "manual")

    async def _reconnect(self) -> None:
        if not self._should_reconnect:
            return

        if self._reconnect_attempts >= self._max_reconnect_attempts:
            self._logger.error(f"Max reconnection attempts ({self._max_reconnect_attempts}) exceeded")
            self._should_reconnect = False
            self._emit("disconnected", "max-attempts-exceeded")
            return

        self._reconnect_attempts += 1
        delay = min(1.0 * math.pow(2, self._reconnect_attempts - 1), self._reconnect_backoff_max)

        self._logger.info(
            f"Reconnecting (attempt {self._reconnect_attempts}/{self._max_reconnect_attempts}) in {delay}s"
        )
        self._emit("reconnecting", self._reconnect_attempts)

        await asyncio.sleep(delay)

        if not self._should_reconnect:
            return

        try:
            await self._connect_internal()
            self._logger.info("Successfully reconnected to Mercury")
            self._reconnect_attempts = 0
            self._emit("connected")
        except Exception as exc:
            self._logger.error(f"Reconnection failed: {exc}")
            if self._should_reconnect:
                await self._reconnect()

    def _stop_ping_loop(self) -> None:
        if self._ping_task and not self._ping_task.done():
            self._ping_task.cancel()
            self._ping_task = None
        if self._pong_timeout_handle:
            self._pong_timeout_handle.cancel()
            self._pong_timeout_handle = None
        self._pending_pong_id = None

    async def _close_websocket(self) -> None:
        if self._ws and not self._ws.closed:
            await self._ws.close(code=aiohttp.WSCloseCode.OK)

    async def _cleanup_ws(self) -> None:
        self._stop_ping_loop()
        if self._read_task and not self._read_task.done():
            self._read_task.cancel()
            try:
                await self._read_task
            except asyncio.CancelledError:
                pass
        await self._close_websocket()
        self._ws = None

    async def disconnect(self) -> None:
        """Disconnect from Mercury."""
        self._logger.info("Disconnecting from Mercury")
        self._should_reconnect = False
        self._stop_ping_loop()
        if self._read_task and not self._read_task.done():
            self._read_task.cancel()
            try:
                await self._read_task
            except asyncio.CancelledError:
                pass
        await self._close_websocket()
        self._ws = None
        self._connection_ready = False
        self._emit("disconnected", "client")

    @property
    def connected(self) -> bool:
        """Whether the WebSocket is currently open."""
        return self._ws is not None and not self._ws.closed

    @property
    def current_reconnect_attempts(self) -> int:
        """Current reconnection attempt count."""
        return self._reconnect_attempts


def _parse_activity(raw: dict[str, Any]) -> MercuryActivity:
    """Parse a raw activity dict into a MercuryActivity dataclass."""
    actor_raw = raw.get("actor", {})
    object_raw = raw.get("object", {})
    target_raw = raw.get("target", {})

    return MercuryActivity(
        id=raw.get("id", ""),
        verb=raw.get("verb", ""),
        actor=MercuryActor(
            id=actor_raw.get("id", ""),
            object_type=actor_raw.get("objectType", ""),
            email_address=actor_raw.get("emailAddress"),
        ),
        object=MercuryObject(
            id=object_raw.get("id", ""),
            object_type=object_raw.get("objectType", ""),
            display_name=object_raw.get("displayName"),
            content=object_raw.get("content"),
            encryption_key_url=object_raw.get("encryptionKeyUrl"),
        ),
        target=MercuryTarget(
            id=target_raw.get("id", ""),
            object_type=target_raw.get("objectType", ""),
            encryption_key_url=target_raw.get("encryptionKeyUrl"),
            tags=target_raw.get("tags", []),
        ),
        published=raw.get("published", ""),
        encryption_key_url=raw.get("encryptionKeyUrl"),
    )
