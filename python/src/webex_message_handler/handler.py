"""Main WebexMessageHandler orchestrator."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine

from .device_manager import DeviceManager
from .errors import WebexError
from .kms_client import KmsClient
from .logger import Logger, noop_logger
from .mercury_socket import MercurySocket
from .message_decryptor import MessageDecryptor
from .types import (
    ConnectionStatus,
    DecryptedMessage,
    DeletedMessage,
    DeviceRegistration,
    HandlerStatus,
    MercuryActivity,
    WebexMessageHandlerConfig,
)

# Type alias for event callbacks
EventCallback = Callable[..., Any]


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

        self._token = config.token
        self._logger: Logger = config.logger or noop_logger  # type: ignore[assignment]

        self._device_manager = DeviceManager(logger=self._logger)
        self._mercury_socket = MercurySocket(
            logger=self._logger,
            ping_interval=config.ping_interval,
            pong_timeout=config.pong_timeout,
            reconnect_backoff_max=config.reconnect_backoff_max,
            max_reconnect_attempts=config.max_reconnect_attempts,
        )

        self._kms_client: KmsClient | None = None
        self._message_decryptor: MessageDecryptor | None = None
        self._registration: DeviceRegistration | None = None
        self._connected = False
        self._connecting = False

        # Event listeners
        self._listeners: dict[str, list[EventCallback]] = {
            "message:created": [],
            "message:deleted": [],
            "connected": [],
            "disconnected": [],
            "reconnecting": [],
            "error": [],
        }

        self._setup_mercury_listeners()

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
                    asyncio.ensure_future(result)
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

        try:
            # Step 1: Register device with WDM
            self._registration = await self._device_manager.register(self._token)
            self._logger.info("Device registered")

            # Step 2: Create KMS client
            self._kms_client = KmsClient(
                token=self._token,
                device_url=self._registration.device_url,
                user_id=self._registration.user_id,
                encryption_service_url=self._registration.encryption_service_url,
                logger=self._logger,
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
            self._emit("connected")

        except Exception:
            self._connecting = False
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
        # message:created — verb=post + objectType=comment
        if activity.verb == "post" and activity.object.object_type == "comment":
            if not self._message_decryptor:
                self._logger.warning("Received activity but decryptor not initialized")
                return

            decrypted = await self._message_decryptor.decrypt_activity(activity)
            message = DecryptedMessage(
                id=decrypted.object.id,
                room_id=decrypted.target.id,
                person_id=decrypted.actor.id,
                person_email=decrypted.actor.email_address or "",
                text=decrypted.object.display_name or "",
                html=decrypted.object.content,
                created=decrypted.published,
                room_type=self._infer_room_type(decrypted),
                raw=decrypted,
            )
            self._emit("message:created", message)
            return

        # message:deleted — verb=delete + objectType=activity
        if activity.verb == "delete" and activity.object.object_type == "activity":
            self._emit(
                "message:deleted",
                DeletedMessage(
                    message_id=activity.object.id,
                    room_id=activity.target.id,
                    person_id=activity.actor.id,
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
