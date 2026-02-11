"""Tests for DeviceManager."""

import pytest
from aioresponses import aioresponses

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
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=MOCK_WDM_RESPONSE)
            result = await dm.register(MOCK_TOKEN)

        assert result.web_socket_url == MOCK_WS_URL
        assert result.device_url == MOCK_DEVICE_URL
        assert result.user_id == MOCK_USER_ID
        assert result.encryption_service_url == "https://encryption.example.com"
        assert result.services["messenger"] == "https://messenger.example.com"

    async def test_auth_error_on_401(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, status=401)
            with pytest.raises(AuthError):
                await dm.register(MOCK_TOKEN)

    async def test_device_registration_error_on_non_2xx(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, status=400)
            with pytest.raises(DeviceRegistrationError, match="Failed to register device"):
                await dm.register(MOCK_TOKEN)

    async def test_device_registration_error_on_network_failure(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, exception=ConnectionError("Network error"))
            with pytest.raises(DeviceRegistrationError):
                await dm.register(MOCK_TOKEN)


class TestRefresh:
    async def test_successful_refresh(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=MOCK_WDM_RESPONSE)
            await dm.register(MOCK_TOKEN)

            refreshed = {**MOCK_WDM_RESPONSE, "webSocketUrl": "wss://mercury-new.example.com/socket"}
            m.put(MOCK_DEVICE_URL, payload=refreshed)
            result = await dm.refresh(MOCK_TOKEN)

        assert result.web_socket_url == "wss://mercury-new.example.com/socket"

    async def test_error_if_not_registered(self):
        dm = DeviceManager()
        with pytest.raises(DeviceRegistrationError, match="Device not registered"):
            await dm.refresh(MOCK_TOKEN)

    async def test_auth_error_on_401_during_refresh(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=MOCK_WDM_RESPONSE)
            await dm.register(MOCK_TOKEN)
            m.put(MOCK_DEVICE_URL, status=401)
            with pytest.raises(AuthError):
                await dm.refresh(MOCK_TOKEN)

    async def test_device_registration_error_on_refresh_failure(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=MOCK_WDM_RESPONSE)
            await dm.register(MOCK_TOKEN)
            m.put(MOCK_DEVICE_URL, status=500)
            with pytest.raises(DeviceRegistrationError):
                await dm.refresh(MOCK_TOKEN)


class TestUnregister:
    async def test_successful_unregister(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=MOCK_WDM_RESPONSE)
            await dm.register(MOCK_TOKEN)
            m.delete(MOCK_DEVICE_URL, status=204)
            await dm.unregister(MOCK_TOKEN)

    async def test_error_if_not_registered(self):
        dm = DeviceManager()
        with pytest.raises(DeviceRegistrationError, match="Device not registered"):
            await dm.unregister(MOCK_TOKEN)

    async def test_auth_error_on_401_during_unregister(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=MOCK_WDM_RESPONSE)
            await dm.register(MOCK_TOKEN)
            m.delete(MOCK_DEVICE_URL, status=401)
            with pytest.raises(AuthError):
                await dm.unregister(MOCK_TOKEN)

    async def test_device_registration_error_on_unregister_failure(self):
        dm = DeviceManager()
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=MOCK_WDM_RESPONSE)
            await dm.register(MOCK_TOKEN)
            m.delete(MOCK_DEVICE_URL, status=500)
            with pytest.raises(DeviceRegistrationError):
                await dm.unregister(MOCK_TOKEN)


class TestServiceParsing:
    async def test_empty_services(self):
        dm = DeviceManager()
        response = {**MOCK_WDM_RESPONSE, "services": {}}
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=response)
            result = await dm.register(MOCK_TOKEN)

        assert result.services == {}
        assert result.encryption_service_url == ""

    async def test_missing_encryption_service_url(self):
        dm = DeviceManager()
        response = {**MOCK_WDM_RESPONSE, "services": {"messenger": "https://messenger.example.com"}}
        with aioresponses() as m:
            m.post(WDM_API_BASE, payload=response)
            result = await dm.register(MOCK_TOKEN)

        assert "messenger" in result.services
        assert result.encryption_service_url == ""
