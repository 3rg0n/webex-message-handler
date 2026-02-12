"""Data types for webex-message-handler."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Literal, Protocol

if TYPE_CHECKING:
    import aiohttp


# --- Networking Types ---

NetworkMode = Literal["native", "injected"]


@dataclass
class FetchRequest:
    """HTTP request for injected fetch function."""

    url: str
    method: Literal["GET", "POST", "PUT", "DELETE"]
    headers: dict[str, str]
    body: str | None = None


@dataclass
class FetchResponse:
    """HTTP response from injected fetch function."""

    status: int
    ok: bool

    async def json(self) -> Any:
        """Parse response as JSON."""
        raise NotImplementedError

    async def text(self) -> str:
        """Get response body as text."""
        raise NotImplementedError


FetchFunction = Callable[[FetchRequest], Awaitable[FetchResponse]]


class InjectedWebSocket(Protocol):
    """Protocol for injected WebSocket implementations."""

    async def send(self, data: str) -> None:
        """Send text data over the WebSocket."""
        ...

    async def close(self, code: int = 1000) -> None:
        """Close the WebSocket connection."""
        ...

    @property
    def closed(self) -> bool:
        """Whether the WebSocket is closed."""
        ...

    @property
    def close_code(self) -> int | None:
        """Close code from the server, if closed."""
        ...

    def __aiter__(self) -> AsyncIterator[Any]:
        """Async iterator for receiving messages."""
        ...


WebSocketFactory = Callable[[str], Awaitable[InjectedWebSocket]]


# --- Configuration ---

@dataclass
class WebexMessageHandlerConfig:
    """Configuration for WebexMessageHandler."""

    token: str
    """Webex bot or user access token."""

    mode: NetworkMode = "native"
    """Networking mode: 'native' uses built-in libraries, 'injected' uses provided functions."""

    logger: Any = None
    """Logger implementation (noop_logger by default)."""

    connector: aiohttp.BaseConnector | None = None
    """Optional aiohttp connector for proxy support (native mode only)."""

    fetch: FetchFunction | None = None
    """Custom fetch function for all HTTP requests (injected mode)."""

    web_socket_factory: WebSocketFactory | None = None
    """Custom WebSocket factory (injected mode)."""

    ping_interval: float = 15.0
    """Mercury ping interval in seconds (default: 15)."""

    pong_timeout: float = 14.0
    """Pong response timeout in seconds (default: 14)."""

    reconnect_backoff_max: float = 32.0
    """Max reconnect backoff in seconds (default: 32)."""

    max_reconnect_attempts: int = 10
    """Max consecutive reconnection attempts (default: 10)."""

    ignore_self_messages: bool = True
    """Automatically filter out messages sent by this bot to prevent loops (default: True)."""


# --- Device Registration ---

@dataclass
class DeviceRegistration:
    """Result of WDM device registration."""

    web_socket_url: str
    """Mercury WebSocket URL."""

    device_url: str
    """Device URL (used as clientId for KMS)."""

    user_id: str
    """Bot's user ID."""

    services: dict[str, str]
    """Service catalog from WDM."""

    encryption_service_url: str
    """Encryption service URL extracted from services."""


# --- Mercury Activity ---

@dataclass
class MercuryActor:
    """Actor in a Mercury activity."""

    id: str
    object_type: str
    email_address: str | None = None


@dataclass
class MercuryObject:
    """Object in a Mercury activity."""

    id: str
    object_type: str
    display_name: str | None = None
    content: str | None = None
    encryption_key_url: str | None = None


@dataclass
class MercuryTarget:
    """Target in a Mercury activity."""

    id: str
    object_type: str
    encryption_key_url: str | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class MercuryActivity:
    """A Mercury conversation activity."""

    id: str
    verb: str
    actor: MercuryActor
    object: MercuryObject
    target: MercuryTarget
    published: str
    encryption_key_url: str | None = None


@dataclass
class MercuryEnvelope:
    """Wire format envelope from Mercury WebSocket."""

    id: str
    data: dict[str, Any]
    timestamp: int
    tracking_id: str
    sequence_number: int | None = None


# --- Decrypted Output ---

@dataclass
class DecryptedMessage:
    """A decrypted Webex message."""

    id: str
    """Unique message ID."""

    room_id: str
    """Conversation/space ID."""

    person_id: str
    """Sender's user ID."""

    person_email: str
    """Sender's email address."""

    text: str
    """Decrypted plain text."""

    created: str
    """ISO 8601 timestamp."""

    html: str | None = None
    """Decrypted HTML content (rich text messages)."""

    room_type: str | None = None
    """'direct' | 'group' | None."""

    raw: MercuryActivity | None = None
    """Full decrypted activity for advanced use."""


@dataclass
class DeletedMessage:
    """A deleted Webex message notification."""

    message_id: str
    room_id: str
    person_id: str


# --- Status ---

ConnectionStatus = Literal["connected", "connecting", "reconnecting", "disconnected"]


@dataclass
class HandlerStatus:
    """Structured health check of all connection subsystems."""

    status: ConnectionStatus
    """Overall connection state."""

    web_socket_open: bool
    """Whether the Mercury WebSocket is currently open."""

    kms_initialized: bool
    """Whether the KMS encryption context has been established."""

    device_registered: bool
    """Whether the device is registered with WDM."""

    reconnect_attempt: int
    """Current auto-reconnect attempt number (0 if not reconnecting)."""
