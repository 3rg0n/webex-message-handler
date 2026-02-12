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


noop_logger: Logger = _NoopLogger()

# console_logger is a standard logging.Logger that writes to stderr
_std_logger = logging.getLogger("webex_message_handler")
if not _std_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _std_logger.addHandler(_handler)
    _std_logger.setLevel(logging.DEBUG)
console_logger: Logger = _std_logger
