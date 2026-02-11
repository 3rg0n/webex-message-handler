"""Error classes for webex-message-handler."""


class WebexError(Exception):
    """Base error for all webex-message-handler errors."""

    def __init__(self, message: str = "Webex error", code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class AuthError(WebexError):
    """Token is invalid, expired, or unauthorized."""

    def __init__(self, message: str = "Authentication failed — check your token") -> None:
        super().__init__(message, code="AUTH_ERROR")


class DeviceRegistrationError(WebexError):
    """WDM device registration/refresh/unregister failed."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message, code="DEVICE_REGISTRATION_ERROR")
        self.status_code = status_code


class MercuryConnectionError(WebexError):
    """WebSocket connection to Mercury failed."""

    def __init__(self, message: str, close_code: int | None = None) -> None:
        super().__init__(message, code="MERCURY_CONNECTION_ERROR")
        self.close_code = close_code


class KmsError(WebexError):
    """KMS key exchange or key retrieval failed."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="KMS_ERROR")


class DecryptionError(WebexError):
    """Message decryption failed."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="DECRYPTION_ERROR")
