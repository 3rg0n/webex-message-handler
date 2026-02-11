"""Data types for webex-message-handler."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    import aiohttp


# --- Configuration ---

@dataclass
class WebexMessageHandlerConfig:
    """Configuration for WebexMessageHandler."""

    token: str
    """Webex bot or user access token."""

    logger: Any = None
    """Logger implementation (noop_logger by default)."""

    connector: aiohttp.BaseConnector | None = None
    """Optional aiohttp connector for proxy support or custom connection handling."""

    ping_interval: float = 15.0
    """Mercury ping interval in seconds (default: 15)."""

    pong_timeout: float = 14.0
    """Pong response timeout in seconds (default: 14)."""

    reconnect_backoff_max: float = 32.0
    """Max reconnect backoff in seconds (default: 32)."""

    max_reconnect_attempts: int = 10
    """Max consecutive reconnection attempts (default: 10)."""


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
