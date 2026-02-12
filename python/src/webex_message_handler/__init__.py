"""Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages."""

from .device_manager import DeviceManager
from .errors import (
    AuthError,
    DecryptionError,
    DeviceRegistrationError,
    KmsError,
    MercuryConnectionError,
    WebexError,
)
from .handler import WebexMessageHandler
from .kms_client import KmsClient
from .logger import Logger, console_logger, noop_logger
from .mercury_socket import MercurySocket
from .message_decryptor import MessageDecryptor
from .types import (
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
    MercuryActivity,
    MercuryActor,
    MercuryEnvelope,
    MercuryObject,
    MercuryTarget,
    NetworkMode,
    WebexMessageHandlerConfig,
    WebSocketFactory,
)

__all__ = [
    # Main class
    "WebexMessageHandler",
    # Components
    "DeviceManager",
    "MercurySocket",
    "KmsClient",
    "MessageDecryptor",
    # Errors
    "WebexError",
    "AuthError",
    "DeviceRegistrationError",
    "MercuryConnectionError",
    "KmsError",
    "DecryptionError",
    # Logger
    "Logger",
    "noop_logger",
    "console_logger",
    # Types
    "WebexMessageHandlerConfig",
    "DeviceRegistration",
    "MercuryActor",
    "MercuryObject",
    "MercuryTarget",
    "MercuryActivity",
    "MercuryEnvelope",
    "DecryptedMessage",
    "DeletedMessage",
    "MembershipActivity",
    "HandlerStatus",
    "ConnectionStatus",
    # Networking types
    "NetworkMode",
    "FetchRequest",
    "FetchResponse",
    "FetchFunction",
    "InjectedWebSocket",
    "WebSocketFactory",
]
