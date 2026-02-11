"""WDM device registration, refresh, and unregistration."""

from __future__ import annotations

import json
from typing import Any

from .errors import AuthError, DeviceRegistrationError
from .logger import Logger, noop_logger
from .types import DeviceRegistration, FetchFunction, FetchRequest

WDM_API_BASE = "https://wdm-a.wbx2.com/wdm/api/v1/devices"

_DEVICE_BODY = {
    "deviceName": "webex-message-handler",
    "deviceType": "DESKTOP",
    "localizedModel": "python",
    "model": "python",
    "name": "webex-message-handler",
    "systemName": "webex-message-handler",
    "systemVersion": "1.0.0",
}


class DeviceManager:
    """Manages WDM device registration lifecycle."""

    def __init__(
        self,
        *,
        logger: Logger | None = None,
        http_do: FetchFunction,
    ) -> None:
        self._logger: Logger = logger or noop_logger  # type: ignore[assignment]
        self._http_do = http_do
        self._device_url: str | None = None

    async def register(self, token: str) -> DeviceRegistration:
        """Register a new device with WDM."""
        self._logger.debug("Registering device with WDM")

        try:
            response = await self._http_do(
                FetchRequest(
                    url=WDM_API_BASE,
                    method="POST",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    body=json.dumps(_DEVICE_BODY),
                )
            )

            if response.status == 401:
                self._logger.error("Device registration failed: Unauthorized")
                raise AuthError("Unauthorized to register device")

            if not response.ok:
                self._logger.error(f"Device registration failed with status {response.status}")
                raise DeviceRegistrationError("Failed to register device", response.status)

            data = await response.json()
            self._device_url = data["url"]
            registration = self._parse_device_response(data)
            self._logger.info("Device registered successfully")
            return registration

        except (AuthError, DeviceRegistrationError):
            raise
        except Exception as exc:
            self._logger.error(f"Device registration error: {exc}")
            raise DeviceRegistrationError("Failed to register device") from exc

    async def refresh(self, token: str) -> DeviceRegistration:
        """Refresh an existing device registration."""
        if not self._device_url:
            raise DeviceRegistrationError("Device not registered. Call register() first.")

        self._logger.debug("Refreshing device registration")

        try:
            response = await self._http_do(
                FetchRequest(
                    url=self._device_url,
                    method="PUT",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    body=json.dumps(_DEVICE_BODY),
                )
            )

            if response.status == 401:
                self._logger.error("Device refresh failed: Unauthorized")
                raise AuthError("Unauthorized to refresh device")

            if not response.ok:
                self._logger.error(f"Device refresh failed with status {response.status}")
                raise DeviceRegistrationError("Failed to refresh device", response.status)

            data = await response.json()
            registration = self._parse_device_response(data)
            self._logger.info("Device refreshed successfully")
            return registration

        except (AuthError, DeviceRegistrationError):
            raise
        except Exception as exc:
            self._logger.error(f"Device refresh error: {exc}")
            raise DeviceRegistrationError("Failed to refresh device") from exc

    async def unregister(self, token: str) -> None:
        """Unregister the device from WDM."""
        if not self._device_url:
            raise DeviceRegistrationError("Device not registered. Call register() first.")

        self._logger.debug("Unregistering device")

        try:
            response = await self._http_do(
                FetchRequest(
                    url=self._device_url,
                    method="DELETE",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                )
            )

            if response.status == 401:
                self._logger.error("Device unregistration failed: Unauthorized")
                raise AuthError("Unauthorized to unregister device")

            if not response.ok:
                self._logger.error(f"Device unregistration failed with status {response.status}")
                raise DeviceRegistrationError("Failed to unregister device", response.status)

            self._device_url = None
            self._logger.info("Device unregistered successfully")

        except (AuthError, DeviceRegistrationError):
            raise
        except Exception as exc:
            self._logger.error(f"Device unregistration error: {exc}")
            raise DeviceRegistrationError("Failed to unregister device") from exc

    def _parse_device_response(self, data: dict[str, Any]) -> DeviceRegistration:
        services: dict[str, str] = data.get("services", {})
        if not isinstance(services, dict):
            services = {}

        return DeviceRegistration(
            web_socket_url=data["webSocketUrl"],
            device_url=data["url"],
            user_id=data["userId"],
            services=services,
            encryption_service_url=services.get("encryptionServiceUrl", ""),
        )
