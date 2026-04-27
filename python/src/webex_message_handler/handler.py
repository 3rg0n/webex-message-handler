"""Main WebexMessageHandler orchestrator."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import aiohttp

from .device_manager import DeviceManager
from .kms_client import KmsClient
from .logger import Logger, noop_logger
from .mention_parser import parse_mentions
from .mercury_socket import MercurySocket
from .message_decryptor import MessageDecryptor
from .types import (
    AttachmentAction,
    ConnectionStatus,
    DecryptedMessage,
    DeletedMessage,
    DeviceRegistration,
    FetchFunction,
    FetchRequest,
    FetchResponse,
    HandlerStatus,
    InjectedWebSocket,
    MembershipActivity,
    MetricsEvent,
    MercuryActivity,
    RoomActivity,
    WebexMessageHandlerConfig,
    WebSocketFactory,
)

if TYPE_CHECKING:
    pass

import base64
import json as _json

# Type alias for event callbacks
EventCallback = Callable[..., Any]


def extract_person_uuid(person_id: str) -> str:
    """Extract the raw UUID from a Webex person ID.

    The Webex REST API returns base64-encoded IDs like:
        "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9mYjUx..." → "ciscospark://us/PEOPLE/fb51254f-..."

    Mercury wire format uses raw UUIDs:
        "fb51254f-3b37-4e50-aa04-45744c2effc7"

    This function normalizes both formats to the raw UUID for comparison.
    """
    try:
        decoded = base64.b64decode(person_id).decode("utf-8")
        if decoded.startswith("ciscospark://"):
            uuid = decoded.rsplit("/", 1)[-1]
            if uuid:
                return uuid
    except (ValueError, UnicodeDecodeError):
        # Not base64 or invalid UTF-8 — treat as raw UUID
        pass
    return person_id


class WebexMessageHandler:
    """Receives and decrypts Webex messages over Mercury WebSocket.

    Usage::

        handler = WebexMessageHandler(WebexMessageHandlerConfig(token="..."))

        @handler.on("message:created")
        async def on_message(msg: DecryptedMessage):
            print(f"[{msg.person_email}] {msg.text}")

        await handler.connect()
    """

    def __init__(self, config: WebexMessageHandlerConfig) -> None:
        if not config.token or not isinstance(config.token, str):
            raise ValueError("WebexMessageHandler requires a non-empty token string")

        # Validate networking mode configuration
        mode = config.mode
        if mode == "injected":
            if not config.fetch or not config.web_socket_factory:
                raise ValueError('Injected mode requires both "fetch" and "web_socket_factory"')
            if config.connector:
                raise ValueError("Cannot use native proxy parameters (connector) in injected mode")
        elif mode == "native":
            if config.fetch or config.web_socket_factory:
                raise ValueError('Cannot provide fetch/web_socket_factory in native mode — set mode to "injected"')
        else:
            raise ValueError(f'Invalid mode "{mode}" — must be "native" or "injected"')

        self._token = config.token
        self._logger: Logger = config.logger or noop_logger  # type: ignore[assignment]
        self._connector = config.connector

        # Create adapters based on mode
        if mode == "native":
            self._http_do = self._create_native_http_adapter(config.connector)
            self._ws_factory = self._create_native_ws_adapter(config.connector)
        else:
            # injected mode - use provided functions
            self._http_do = config.fetch  # type: ignore[assignment]
            self._ws_factory = config.web_socket_factory  # type: ignore[assignment]

        self._device_manager = DeviceManager(
            logger=self._logger,
            http_do=self._http_do,
        )
        self._mercury_socket = MercurySocket(
            logger=self._logger,
            ws_factory=self._ws_factory,
            ping_interval=config.ping_interval,
            pong_timeout=config.pong_timeout,
            reconnect_backoff_max=config.reconnect_backoff_max,
            max_reconnect_attempts=config.max_reconnect_attempts,
            reconnect_stability_seconds=config.reconnect_stability_seconds,
        )

        self._ignore_self_messages = config.ignore_self_messages
        self._bot_person_id: str | None = None
        self._metrics_callback = config.metrics_callback

        self._kms_client: KmsClient | None = None
        self._message_decryptor: MessageDecryptor | None = None
        self._registration: DeviceRegistration | None = None
        self._connected = False
        self._connecting = False

        # Activity replay protection: map of activity_id -> timestamp
        self._recent_activity_ids: dict[str, float] = {}

        # Event listeners
        self._listeners: dict[str, list[EventCallback]] = {
            "message:created": [],
            "message:updated": [],
            "message:deleted": [],
            "membership:created": [],
            "attachmentAction:created": [],
            "room:created": [],
            "room:updated": [],
            "connected": [],
            "disconnected": [],
            "reconnecting": [],
            "error": [],
        }

        self._setup_mercury_listeners()

    def _report_metric(self, name: str, start_time: float, success: bool, metadata: dict[str, str] | None = None) -> None:
        """Report a timing metric if callback is set."""
        if self._metrics_callback:
            duration_ms = (time.monotonic() - start_time) * 1000
            self._metrics_callback(MetricsEvent(name=name, duration_ms=duration_ms, success=success, metadata=metadata))

    def _create_native_http_adapter(
        self, connector: aiohttp.BaseConnector | None
    ) -> FetchFunction:
        """Create HTTP adapter using native aiohttp."""
        async def http_do(request: FetchRequest) -> FetchResponse:
            # When a shared connector is provided, don't let the session close it.
            # When no connector is provided, let the session own (and close) the auto-created one.
            session = aiohttp.ClientSession(
                connector=connector,
                connector_owner=connector is None,
                trust_env=True,
            )
            try:
                response = await session.request(
                    request.method,
                    request.url,
                    headers=request.headers,
                    data=request.body,
                )
                # Read the body eagerly so we can close the session
                body_bytes = await response.read()
                status = response.status
                ok = 200 <= status < 300
                await session.close()
            except Exception:
                await session.close()
                raise

            class EagerFetchResponse:
                def __init__(self) -> None:
                    self.status = status
                    self.ok = ok

                async def json(self) -> Any:
                    return _json.loads(body_bytes)

                async def text(self) -> str:
                    return body_bytes.decode("utf-8")

            return EagerFetchResponse()  # type: ignore[return-value]

        return http_do

    def _create_native_ws_adapter(
        self, connector: aiohttp.BaseConnector | None
    ) -> WebSocketFactory:
        """Create WebSocket adapter using native aiohttp."""
        async def ws_factory(url: str) -> InjectedWebSocket:
            session = aiohttp.ClientSession(connector=connector)
            ws = await session.ws_connect(url, max_msg_size=1 * 1024 * 1024)  # 1MB

            # Attach session for cleanup
            ws._session = session  # type: ignore[attr-defined]

            return ws  # type: ignore[return-value]

        return ws_factory

    def on(self, event: str, callback: EventCallback | None = None) -> Any:
        """Register an event listener. Can be used as a decorator.

        Usage as decorator::

            @handler.on("message:created")
            async def on_message(msg):
                ...

        Usage as method::

            handler.on("message:created", my_callback)
        """
        if callback is not None:
            if event not in self._listeners:
                self._listeners[event] = []
            self._listeners[event].append(callback)
            return callback

        # Decorator usage
        def decorator(func: EventCallback) -> EventCallback:
            if event not in self._listeners:
                self._listeners[event] = []
            self._listeners[event].append(func)
            return func

        return decorator

    def off(self, event: str, callback: EventCallback) -> None:
        """Remove an event listener."""
        listeners = self._listeners.get(event, [])
        if callback in listeners:
            listeners.remove(callback)

    def _emit(self, event: str, *args: Any) -> None:
        """Emit an event to all registered listeners."""
        for callback in self._listeners.get(event, []):
            try:
                result = callback(*args)
                if asyncio.iscoroutine(result):
                    task = asyncio.ensure_future(result)
                    task.add_done_callback(
                        lambda t, ev=event: self._logger.error(
                            f"Error in async {ev} listener: {t.exception()}"
                        ) if not t.cancelled() and t.exception() else None
                    )
            except Exception as exc:
                self._logger.error(f"Error in {event} listener: {exc}")

    async def connect(self) -> None:
        """Establish the full connection pipeline.

        1. Register device with WDM
        2. Connect Mercury WebSocket
        3. Initialize KMS (ECDH handshake)
        4. Begin receiving encrypted messages
        """
        if self._connecting:
            raise RuntimeError("connect() already in progress")
        if self._connected:
            raise RuntimeError("Already connected. Call disconnect() first, or use reconnect(new_token).")

        self._logger.info("Connecting to Webex...")
        self._connecting = True

        connect_start = time.monotonic()
        try:
            # Step 1: Register device with WDM
            self._registration = await self._device_manager.register(self._token)
            self._logger.info("Device registered")

            # Step 1.5: Fetch bot person info if self-message filtering is enabled
            if self._ignore_self_messages:
                await self._fetch_bot_person_id()

            # Step 2: Create KMS client
            self._kms_client = KmsClient(
                token=self._token,
                device_url=self._registration.device_url,
                user_id=self._registration.user_id,
                encryption_service_url=self._registration.encryption_service_url,
                logger=self._logger,
                http_do=self._http_do,
            )

            # Step 3: Connect Mercury WebSocket FIRST (KMS responses arrive here)
            await self._mercury_socket.connect(
                self._registration.web_socket_url,
                self._token,
            )
            self._logger.info("Mercury connected")

            # Step 4: Initialize KMS (ECDH handshake — response via Mercury)
            await self._kms_client.initialize()
            self._logger.info("KMS initialized")

            # Step 5: Create message decryptor
            self._message_decryptor = MessageDecryptor(
                kms_client=self._kms_client,
                logger=self._logger,
            )

            self._connecting = False
            self._connected = True
            self._logger.info("Connected to Webex")
            self._report_metric("connect", connect_start, True)
            self._emit("connected")

        except Exception:
            self._connecting = False
            self._report_metric("connect", connect_start, False)
            raise

    async def disconnect(self) -> None:
        """Tear down the connection cleanly."""
        self._logger.info("Disconnecting from Webex...")
        self._connected = False

        await self._mercury_socket.disconnect()

        if self._registration:
            try:
                await self._device_manager.unregister(self._token)
                self._logger.info("Device unregistered")
            except Exception as exc:
                self._logger.warning(f"Failed to unregister device: {exc}")

        self._registration = None
        self._kms_client = None
        self._message_decryptor = None
        self._bot_person_id = None

    async def reconnect(self, new_token: str) -> None:
        """Update the access token and re-establish the connection.

        Tears down the existing connection and reconnects from scratch.
        """
        if not new_token or not isinstance(new_token, str):
            raise ValueError("reconnect() requires a non-empty token string")

        self._logger.info("Reconnecting with new token...")
        await self.disconnect()
        self._token = new_token
        await self.connect()

    @property
    def connected(self) -> bool:
        """Whether the handler is fully connected."""
        return self._connected and self._mercury_socket.connected

    def status(self) -> HandlerStatus:
        """Return a structured health check of all connection subsystems."""
        reconnect_attempt = self._mercury_socket.current_reconnect_attempts

        if self._connected and self._mercury_socket.connected:
            status: ConnectionStatus = "connected"
        elif self._connecting:
            status = "connecting"
        elif reconnect_attempt > 0:
            status = "reconnecting"
        else:
            status = "disconnected"

        return HandlerStatus(
            status=status,
            web_socket_open=self._mercury_socket.connected,
            kms_initialized=self._kms_client is not None,
            device_registered=self._registration is not None,
            reconnect_attempt=reconnect_attempt,
        )

    async def _fetch_bot_person_id(self) -> None:
        """Fetch the bot's person ID for self-message filtering.

        Raises on failure — connect() will not proceed without a valid bot ID
        when ignore_self_messages is enabled.
        """
        self._logger.debug("Fetching bot person info for self-message filtering")
        response = await self._http_do(
            FetchRequest(
                url="https://webexapis.com/v1/people/me",
                method="GET",
                headers={
                    "Authorization": f"Bearer {self._token}",
                    "Content-Type": "application/json",
                },
            )
        )
        if not response.ok:
            raise RuntimeError(
                f"Failed to fetch bot identity for self-message filtering: HTTP {response.status}. "
                "Set ignore_self_messages=False to skip this check (not recommended — may cause message loops)."
            )
        data = await response.json()
        raw_id = data.get("id", "")
        self._bot_person_id = extract_person_uuid(raw_id)
        self._logger.info(f"Bot person ID cached for self-message filtering: {self._bot_person_id}")

    def _setup_mercury_listeners(self) -> None:
        # Forward KMS messages from Mercury to the KMS client
        def on_kms_response(data: dict[str, Any]) -> None:
            if self._kms_client:
                self._kms_client.handle_kms_message(data)

        self._mercury_socket.on("kms:response", on_kms_response)

        # Handle conversation activities
        def on_activity(activity: MercuryActivity) -> None:
            asyncio.ensure_future(self._handle_activity_safe(activity))

        self._mercury_socket.on("activity", on_activity)

        # Handle Mercury reconnection
        def on_mercury_connected() -> None:
            asyncio.ensure_future(self._on_reconnect())

        self._mercury_socket.on("connected", on_mercury_connected)

        # Forward disconnected events
        def on_disconnected(reason: str) -> None:
            self._connected = False
            self._emit("disconnected", reason)

        self._mercury_socket.on("disconnected", on_disconnected)

        # Forward reconnecting events
        def on_reconnecting(attempt: int) -> None:
            self._emit("reconnecting", attempt)

        self._mercury_socket.on("reconnecting", on_reconnecting)

        # Forward error events
        def on_error(err: Exception) -> None:
            self._emit("error", err)

        self._mercury_socket.on("error", on_error)

    async def _handle_activity_safe(self, activity: MercuryActivity) -> None:
        try:
            await self._handle_activity(activity)
        except Exception as exc:
            self._logger.error(f"Error handling activity: {exc}")
            self._emit("error", exc if isinstance(exc, Exception) else Exception(str(exc)))

    async def _handle_activity(self, activity: MercuryActivity) -> None:
        # Activity replay protection: check if we've already seen this activity
        if activity.id in self._recent_activity_ids:
            self._logger.warning(f"Duplicate activity detected, skipping: {activity.id}")
            return

        # Record this activity and perform sweep every 100 activities
        self._recent_activity_ids[activity.id] = time.time()
        if len(self._recent_activity_ids) % 100 == 0:
            self._sweep_old_activity_ids()

        # message:created or message:updated — verb=post/update + objectType=comment
        if activity.verb in ("post", "update") and activity.object.object_type == "comment":
            if not self._message_decryptor:
                self._logger.warning("Received activity but decryptor not initialized")
                return

            decrypt_start = time.monotonic()
            try:
                decrypted = await self._message_decryptor.decrypt_activity(activity)
                self._report_metric("decrypt", decrypt_start, True)
            except Exception:
                self._report_metric("decrypt", decrypt_start, False)
                raise

            mentions = parse_mentions(decrypted.object.content)
            message = DecryptedMessage(
                id=decrypted.id,
                room_id=decrypted.target.id,
                person_id=decrypted.actor.id,
                person_email=decrypted.actor.email_address or "",
                text=decrypted.object.display_name or "",
                created=decrypted.published,
                parent_id=decrypted.parent.id if decrypted.parent else None,
                mentioned_people=mentions.mentioned_people,
                mentioned_groups=mentions.mentioned_groups,
                files=decrypted.object.files or [],
                html=decrypted.object.content,
                room_type=self._infer_room_type(decrypted),
                raw=decrypted,
            )
            # Filter self-messages if enabled
            if (
                self._ignore_self_messages
                and self._bot_person_id
                and extract_person_uuid(message.person_id) == self._bot_person_id
            ):
                self._logger.debug(f"Ignoring self-message from bot ({self._bot_person_id})")
                return

            event_name = "message:updated" if activity.verb == "update" else "message:created"
            self._emit(event_name, message)
            return

        # message:deleted — verb=delete + objectType=activity
        if activity.verb == "delete" and activity.object.object_type == "activity":
            self._logger.info(f"Message deleted: {activity.object.id}")
            self._emit(
                "message:deleted",
                DeletedMessage(
                    message_id=activity.object.id,
                    room_id=activity.target.id,
                    person_id=activity.actor.id,
                ),
            )
            return

        # membership:created — membership verbs + objectType=person
        membership_verbs = {"add", "leave", "assignModerator", "unassignModerator"}
        if activity.verb in membership_verbs and activity.object.object_type == "person":
            self._emit(
                "membership:created",
                MembershipActivity(
                    id=activity.id,
                    actor_id=activity.actor.id,
                    person_id=activity.object.id,
                    room_id=activity.target.id,
                    action=activity.verb,
                    created=activity.published,
                    room_type=self._infer_room_type(activity),
                    raw=activity,
                ),
            )
            return

        # attachmentAction:created — verb=cardAction + objectType=submit
        if activity.verb == "cardAction" and activity.object.object_type == "submit":
            self._emit(
                "attachmentAction:created",
                AttachmentAction(
                    id=activity.id,
                    message_id=activity.parent.id if activity.parent else "",
                    person_id=activity.actor.id,
                    person_email=activity.actor.email_address or "",
                    room_id=activity.target.id,
                    inputs=activity.object.inputs or {},
                    created=activity.published,
                    raw=activity,
                ),
            )
            return

        # room:created or room:updated — verb=create/update + object.objectType=conversation
        if activity.verb in ("create", "update") and activity.object.object_type == "conversation":
            event_name = "room:created" if activity.verb == "create" else "room:updated"
            self._emit(
                event_name,
                RoomActivity(
                    id=activity.id,
                    room_id=activity.target.id,
                    actor_id=activity.actor.id,
                    action="created" if activity.verb == "create" else "updated",
                    created=activity.published,
                    raw=activity,
                ),
            )

    @staticmethod
    def _infer_room_type(activity: MercuryActivity) -> str | None:
        tags = activity.target.tags
        if not tags:
            return None
        if "ONE_ON_ONE" in tags:
            return "direct"
        if "TEAM" in tags or "LOCKED" in tags or "GROUP" in tags:
            return "group"
        return None

    def _sweep_old_activity_ids(self) -> None:
        """Remove activity IDs older than 300 seconds (5 minutes)."""
        cutoff_time = time.time() - 300
        old_ids = [
            activity_id
            for activity_id, timestamp in self._recent_activity_ids.items()
            if timestamp < cutoff_time
        ]
        for activity_id in old_ids:
            del self._recent_activity_ids[activity_id]
        if old_ids:
            self._logger.debug(f"Swept {len(old_ids)} old activity IDs from replay protection cache")

    async def _on_reconnect(self) -> None:
        self._logger.info("Mercury reconnected, refreshing device and KMS")

        try:
            if self._registration:
                self._registration = await self._device_manager.refresh(self._token)
        except Exception as exc:
            self._logger.warning(f"Device refresh on reconnect failed: {exc}")

        try:
            if self._kms_client:
                await self._kms_client.initialize()
        except Exception as exc:
            self._logger.warning(f"KMS re-init on reconnect failed: {exc}")

        self._connected = True
        self._emit("connected")
