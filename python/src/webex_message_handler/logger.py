"""Logger interface and built-in implementations."""

from __future__ import annotations

import logging
from typing import Protocol


class Logger(Protocol):
    """Protocol for logger implementations."""

    def debug(self, message: str, *args: object) -> None: ...
    def info(self, message: str, *args: object) -> None: ...
    def warning(self, message: str, *args: object) -> None: ...
    def error(self, message: str, *args: object) -> None: ...


class _NoopLogger:
    """Silent logger — all methods are no-ops."""

    def debug(self, message: str, *args: object) -> None:
        pass

    def info(self, message: str, *args: object) -> None:
        pass

    def warning(self, message: str, *args: object) -> None:
        pass

    def error(self, message: str, *args: object) -> None:
        pass


noop_logger: Logger = _NoopLogger()  # type: ignore[assignment]

# console_logger is a standard logging.Logger that writes to stderr
console_logger: Logger = logging.getLogger("webex_message_handler")  # type: ignore[assignment]
if not console_logger.handlers:  # type: ignore[union-attr]
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    console_logger.addHandler(_handler)  # type: ignore[union-attr]
    console_logger.setLevel(logging.DEBUG)  # type: ignore[union-attr]
