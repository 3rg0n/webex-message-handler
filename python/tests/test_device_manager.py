"""Tests for DeviceManager."""

import pytest

from tests.conftest import MockHttpDo
from webex_message_handler.device_manager import WDM_API_BASE, DeviceManager
from webex_message_handler.errors import AuthError, DeviceRegistrationError

MOCK_TOKEN = "test-token"
MOCK_DEVICE_URL = "https://wdm-a.wbx2.com/wdm/api/v1/devices/test-device-id"
MOCK_WS_URL = "wss://mercury.example.com/socket"
MOCK_USER_ID = "user-123"

MOCK_WDM_RESPONSE = {
    "webSocketUrl": MOCK_WS_URL,
    "url": MOCK_DEVICE_URL,
    "userId": MOCK_USER_ID,
    "services": {
        "encryptionServiceUrl": "https://encryption.example.com",
        "messenger": "https://messenger.example.com",
    },
}


class TestRegister:
    async def test_successful_registration(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create
        )
        dm = DeviceManager(http_do=http_do)
        result = await dm.register(MOCK_TOKEN)

        assert result.web_socket_url == MOCK_WS_URL
        assert result.device_url == MOCK_DEVICE_URL
        assert result.user_id == MOCK_USER_ID
        assert result.encryption_service_url == "https://encryption.example.com"
        assert result.services["messenger"] == "https://messenger.example.com"

    async def test_auth_error_on_401(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", status=401)  # create fails with 401
        )
        dm = DeviceManager(http_do=http_do)
        with pytest.raises(AuthError):
            await dm.register(MOCK_TOKEN)

    async def test_device_registration_error_on_non_2xx(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", status=400)  # create fails
        )
        dm = DeviceManager(http_do=http_do)
        with pytest.raises(DeviceRegistrationError, match="Failed to register device"):
            await dm.register(MOCK_TOKEN)

    async def test_device_registration_error_on_network_failure(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add(
                "POST",
                f"{WDM_API_BASE}?includeUpstreamServices=all",
                exc=ConnectionError("Network error"),
            )  # create fails
        )
        dm = DeviceManager(http_do=http_do)
        with pytest.raises(DeviceRegistrationError):
            await dm.register(MOCK_TOKEN)


class TestRefresh:
    async def test_successful_refresh(self):
        refreshed = {**MOCK_WDM_RESPONSE, "webSocketUrl": "wss://mercury-new.example.com/socket"}
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create
            .add("PUT", MOCK_DEVICE_URL, payload=refreshed)  # refresh
        )
        dm = DeviceManager(http_do=http_do)
        await dm.register(MOCK_TOKEN)
        result = await dm.refresh(MOCK_TOKEN)

        assert result.web_socket_url == "wss://mercury-new.example.com/socket"

    async def test_error_if_not_registered(self):
        http_do = MockHttpDo()
        dm = DeviceManager(http_do=http_do)
        with pytest.raises(DeviceRegistrationError, match="Device not registered"):
            await dm.refresh(MOCK_TOKEN)

    async def test_auth_error_on_401_during_refresh(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create
            .add("PUT", MOCK_DEVICE_URL, status=401)  # refresh fails
        )
        dm = DeviceManager(http_do=http_do)
        await dm.register(MOCK_TOKEN)
        with pytest.raises(AuthError):
            await dm.refresh(MOCK_TOKEN)

    async def test_device_registration_error_on_refresh_failure(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create
            .add("PUT", MOCK_DEVICE_URL, status=500)  # refresh fails
        )
        dm = DeviceManager(http_do=http_do)
        await dm.register(MOCK_TOKEN)
        with pytest.raises(DeviceRegistrationError):
            await dm.refresh(MOCK_TOKEN)


class TestUnregister:
    async def test_successful_unregister(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create
            .add("DELETE", MOCK_DEVICE_URL, status=204)  # unregister
        )
        dm = DeviceManager(http_do=http_do)
        await dm.register(MOCK_TOKEN)
        await dm.unregister(MOCK_TOKEN)

    async def test_error_if_not_registered(self):
        http_do = MockHttpDo()
        dm = DeviceManager(http_do=http_do)
        with pytest.raises(DeviceRegistrationError, match="Device not registered"):
            await dm.unregister(MOCK_TOKEN)

    async def test_auth_error_on_401_during_unregister(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create
            .add("DELETE", MOCK_DEVICE_URL, status=401)  # unregister fails
        )
        dm = DeviceManager(http_do=http_do)
        await dm.register(MOCK_TOKEN)
        with pytest.raises(AuthError):
            await dm.unregister(MOCK_TOKEN)

    async def test_device_registration_error_on_unregister_failure(self):
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create
            .add("DELETE", MOCK_DEVICE_URL, status=500)  # unregister fails
        )
        dm = DeviceManager(http_do=http_do)
        await dm.register(MOCK_TOKEN)
        with pytest.raises(DeviceRegistrationError):
            await dm.unregister(MOCK_TOKEN)


class TestServiceParsing:
    async def test_empty_services(self):
        response = {**MOCK_WDM_RESPONSE, "services": {}}
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=response)  # create
        )
        dm = DeviceManager(http_do=http_do)
        result = await dm.register(MOCK_TOKEN)

        assert result.services == {}
        assert result.encryption_service_url == ""

    async def test_missing_encryption_service_url(self):
        response = {**MOCK_WDM_RESPONSE, "services": {"messenger": "https://messenger.example.com"}}
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=response)  # create
        )
        dm = DeviceManager(http_do=http_do)
        result = await dm.register(MOCK_TOKEN)

        assert "messenger" in result.services
        assert result.encryption_service_url == ""


class TestDeviceReuseAndReaping:
    async def test_reuses_existing_device_and_calls_refresh_instead_of_create(self):
        """Verify that when a device matching name+deviceType already exists,
        Register refreshes it (PUT) instead of creating a new one (POST).
        """
        http_do = (
            MockHttpDo()
            .add(
                "GET",
                WDM_API_BASE,
                payload={
                    "devices": [
                        {
                            "webSocketUrl": MOCK_WS_URL,
                            "url": MOCK_DEVICE_URL,
                            "userId": MOCK_USER_ID,
                            "name": "webex-message-handler",
                            "deviceType": "DESKTOP",
                            "services": {},
                        }
                    ]
                },
            )
            .add("PUT", MOCK_DEVICE_URL, payload=MOCK_WDM_RESPONSE)
        )
        dm = DeviceManager(http_do=http_do)
        result = await dm.register(MOCK_TOKEN)

        assert result.device_url == MOCK_DEVICE_URL
        # Should be: GET (list) + PUT (refresh)
        assert len(http_do.calls) == 2
        assert http_do.calls[0].method == "GET"
        assert http_do.calls[1].method == "PUT"

    async def test_reaps_devices_on_403_and_retries_create(self):
        """Verify that a 403 on create triggers reaping of this client's own
        devices followed by a single retry.
        """
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, payload={"devices": []})  # reuse check: empty
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", status=403)  # first POST fails
            .add(
                "GET",
                WDM_API_BASE,
                payload={
                    "devices": [
                        {
                            "url": f"{MOCK_DEVICE_URL}/old",
                            "name": "webex-message-handler",
                            "deviceType": "DESKTOP",
                        }
                    ]
                },
            )  # reap: return device to delete
            .add("DELETE", f"{MOCK_DEVICE_URL}/old", status=204)  # delete old device
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # retry POST
        )
        dm = DeviceManager(http_do=http_do)
        result = await dm.register(MOCK_TOKEN)

        assert result.device_url == MOCK_DEVICE_URL
        # Should be: GET (reuse) + POST (403) + GET (reap) + DELETE + POST (retry)
        assert len(http_do.calls) == 5
        assert http_do.calls[0].method == "GET"
        assert http_do.calls[1].method == "POST"
        assert http_do.calls[2].method == "GET"
        assert http_do.calls[3].method == "DELETE"
        assert http_do.calls[4].method == "POST"

    async def test_falls_back_to_create_when_list_fails(self):
        """Verify that when list fails, register falls back to create."""
        http_do = (
            MockHttpDo()
            .add("GET", WDM_API_BASE, status=500)  # list fails
            .add("POST", f"{WDM_API_BASE}?includeUpstreamServices=all", payload=MOCK_WDM_RESPONSE)  # create succeeds
        )
        dm = DeviceManager(http_do=http_do)
        result = await dm.register(MOCK_TOKEN)

        assert result.device_url == MOCK_DEVICE_URL
        # Should be: GET (list fails) + POST (create succeeds)
        assert len(http_do.calls) == 2
