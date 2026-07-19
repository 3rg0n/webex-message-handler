"""WDM device registration, refresh, and unregistration."""

from __future__ import annotations

import json
from typing import Any

from .errors import AuthError, DeviceRegistrationError
from .logger import Logger, noop_logger
from .types import DeviceRegistration, FetchFunction, FetchRequest
from .url_validation import validate_webex_url

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
        """Register a new device with WDM.

        To avoid leaking a new device on every Connect() (which eventually trips the
        Webex per-user device cap → HTTP 403), it first lists existing devices and
        reuses/refreshes one matching this client's name+deviceType. Only when no
        reusable device exists does it POST a new one. If registration fails because
        the account already has excessive registrations, it reaps this client's own
        devices and retries once.
        """
        self._logger.debug("Registering device with WDM")

        # Reuse-before-register: if a device of ours already exists, refresh it.
        existing_url = await self._find_reusable_device(token)
        if existing_url:
            self._device_url = existing_url
            try:
                reg = await self.refresh(token)
                self._logger.info("Reused existing WDM device registration")
                return reg
            except Exception:
                # Refresh failed (device stale/deleted server-side) — fall through to
                # create a fresh one.
                self._device_url = None

        try:
            reg = await self._create_device(token)
        except DeviceRegistrationError as exc:
            if self._is_excessive_registrations_error(exc):
                msg = "Excessive device registrations detected — reaping this client's devices and retrying"
                self._logger.warning(msg)
                await self._reap_own_devices(token)
                return await self._create_device(token)
            raise
        return reg

    async def _create_device(self, token: str) -> DeviceRegistration:
        """Perform the raw POST /devices registration."""
        try:
            create_url = f"{WDM_API_BASE}?includeUpstreamServices=all"
            response = await self._http_do(
                FetchRequest(
                    url=create_url,
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

    async def _find_reusable_device(self, token: str) -> str | None:
        """List existing WDM devices and return the URL of one matching this
        client's name+deviceType, or None if none/on any error (in which case the
        caller falls back to creating a new device — best-effort, never fatal).
        """
        try:
            devices = await self._list_devices(token)
            for device in devices:
                device_data: dict[str, Any] = device if isinstance(device, dict) else device.__dict__
                if (
                    device_data.get("name") == _DEVICE_BODY["name"]
                    and device_data.get("deviceType") == _DEVICE_BODY["deviceType"]
                    and device_data.get("url")
                ):
                    return device_data["url"]
        except Exception as exc:
            self._logger.debug(f"Could not list existing devices (will create new): {exc}")
        return None

    async def _reap_own_devices(self, token: str) -> None:
        """Best-effort deletes all WDM devices matching this client's
        name+deviceType, to recover from the per-user device cap. Never fatal.
        """
        try:
            devices = await self._list_devices(token)
            reaped = 0
            for device in devices:
                device_data: dict[str, Any] = device if isinstance(device, dict) else device.__dict__
                if (
                    device_data.get("name") != _DEVICE_BODY["name"]
                    or device_data.get("deviceType") != _DEVICE_BODY["deviceType"]
                    or not device_data.get("url")
                ):
                    continue
                try:
                    resp = await self._http_do(
                        FetchRequest(
                            url=device_data["url"],
                            method="DELETE",
                            headers={"Authorization": f"Bearer {token}"},
                        )
                    )
                    if resp.ok or resp.status == 404:
                        reaped += 1
                except Exception as exc:
                    self._logger.debug(f"Failed to reap device {device_data.get('url')}: {exc}")
            self._logger.info(f"Reaped {reaped} stale WDM device(s)")
        except Exception as exc:
            self._logger.warning(f"Could not list devices to reap: {exc}")

    async def _list_devices(self, token: str) -> list[Any]:
        """Fetches the account's current WDM device registrations."""
        response = await self._http_do(
            FetchRequest(
                url=WDM_API_BASE,
                method="GET",
                headers={"Authorization": f"Bearer {token}"},
            )
        )

        if response.status == 401:
            raise AuthError("Unauthorized to list devices")

        if not response.ok:
            raise DeviceRegistrationError(
                f"Failed to list devices: {response.status}",
                response.status,
            )

        data = await response.json()
        return data.get("devices", [])

    @staticmethod
    def _is_excessive_registrations_error(error: Exception) -> bool:
        """Report whether error is the WDM per-user device cap rejection (HTTP 403)."""
        return isinstance(error, DeviceRegistrationError) and error.status_code == 403

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

        web_socket_url = data["webSocketUrl"]
        encryption_service_url = services.get("encryptionServiceUrl", "")

        # Validate URLs from external API response
        validate_webex_url(web_socket_url, "wss")
        if encryption_service_url:
            validate_webex_url(encryption_service_url, "https")

        return DeviceRegistration(
            web_socket_url=web_socket_url,
            device_url=data["url"],
            user_id=data["userId"],
            services=services,
            encryption_service_url=encryption_service_url,
        )
