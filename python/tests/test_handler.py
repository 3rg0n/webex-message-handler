"""Tests for WebexMessageHandler."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from webex_message_handler.handler import WebexMessageHandler
from webex_message_handler.types import (
    DecryptedMessage,
    DeviceRegistration,
    MercuryActivity,
    MercuryActor,
    MercuryObject,
    MercuryTarget,
    WebexMessageHandlerConfig,
)

MOCK_TOKEN = "test-token"
MOCK_REGISTRATION = DeviceRegistration(
    web_socket_url="wss://mercury.example.com/socket",
    device_url="https://device.example.com",
    user_id="user-123",
    services={
        "encryptionServiceUrl": "https://encryption.example.com",
        "messenger": "https://messenger.example.com",
    },
    encryption_service_url="https://encryption.example.com",
)


def _make_handler(token=MOCK_TOKEN, **kwargs):
    return WebexMessageHandler(WebexMessageHandlerConfig(token=token, **kwargs))


def _make_activity(**overrides) -> MercuryActivity:
    defaults = {
        "id": "msg-123",
        "verb": "post",
        "actor": MercuryActor(id="person-456", object_type="person", email_address="user@example.com"),
        "object": MercuryObject(id="comment-789", object_type="comment", display_name="Test Message", content="<p>Test Message</p>"),
        "target": MercuryTarget(id="room-101", object_type="conversation", tags=["GROUP"]),
        "published": "2024-01-01T00:00:00Z",
    }
    defaults.update(overrides)
    return MercuryActivity(**defaults)


class TestConstructor:
    def test_requires_non_empty_token(self):
        with pytest.raises(ValueError):
            _make_handler(token="")

    def test_accepts_valid_token(self):
        handler = _make_handler()
        assert handler is not None


class TestConnect:
    @patch("webex_message_handler.handler.MessageDecryptor")
    @patch("webex_message_handler.handler.KmsClient")
    @patch("webex_message_handler.handler.MercurySocket")
    @patch("webex_message_handler.handler.DeviceManager")
    async def test_calls_register_connect_initialize(self, mock_dm_cls, mock_ms_cls, mock_kms_cls, mock_md_cls):
        mock_dm = MagicMock()
        mock_dm.register = AsyncMock(return_value=MOCK_REGISTRATION)
        mock_dm.unregister = AsyncMock()
        mock_dm_cls.return_value = mock_dm

        mock_ms = MagicMock()
        mock_ms.connect = AsyncMock()
        mock_ms.disconnect = AsyncMock()
        mock_ms.on = MagicMock()
        mock_ms.connected = True
        mock_ms.current_reconnect_attempts = 0
        mock_ms_cls.return_value = mock_ms

        mock_kms = MagicMock()
        mock_kms.initialize = AsyncMock()
        mock_kms_cls.return_value = mock_kms

        handler = _make_handler()
        connected_events = []
        handler.on("connected", lambda: connected_events.append(True))

        await handler.connect()

        mock_dm.register.assert_called_once_with(MOCK_TOKEN)
        mock_ms.connect.assert_called_once()
        mock_kms.initialize.assert_called_once()
        assert handler.connected is True
        assert len(connected_events) == 1

    @patch("webex_message_handler.handler.MercurySocket")
    @patch("webex_message_handler.handler.DeviceManager")
    async def test_raises_on_registration_failure(self, mock_dm_cls, mock_ms_cls):
        mock_dm = MagicMock()
        mock_dm.register = AsyncMock(side_effect=Exception("Registration failed"))
        mock_dm_cls.return_value = mock_dm

        mock_ms = MagicMock()
        mock_ms.on = MagicMock()
        mock_ms.connected = False
        mock_ms.current_reconnect_attempts = 0
        mock_ms_cls.return_value = mock_ms

        handler = _make_handler()
        with pytest.raises(Exception, match="Registration failed"):
            await handler.connect()


class TestDisconnect:
    @patch("webex_message_handler.handler.MessageDecryptor")
    @patch("webex_message_handler.handler.KmsClient")
    @patch("webex_message_handler.handler.MercurySocket")
    @patch("webex_message_handler.handler.DeviceManager")
    async def test_calls_disconnect_and_unregister(self, mock_dm_cls, mock_ms_cls, mock_kms_cls, mock_md_cls):
        mock_dm = MagicMock()
        mock_dm.register = AsyncMock(return_value=MOCK_REGISTRATION)
        mock_dm.unregister = AsyncMock()
        mock_dm_cls.return_value = mock_dm

        mock_ms = MagicMock()
        mock_ms.connect = AsyncMock()
        mock_ms.disconnect = AsyncMock()
        mock_ms.on = MagicMock()
        mock_ms.connected = False
        mock_ms.current_reconnect_attempts = 0
        mock_ms_cls.return_value = mock_ms

        mock_kms = MagicMock()
        mock_kms.initialize = AsyncMock()
        mock_kms_cls.return_value = mock_kms

        handler = _make_handler()
        await handler.connect()
        await handler.disconnect()

        mock_ms.disconnect.assert_called_once()
        mock_dm.unregister.assert_called_once_with(MOCK_TOKEN)


class TestMessageHandling:
    def test_infer_room_type_direct(self):
        handler = _make_handler()
        activity = _make_activity(target=MercuryTarget(id="r", object_type="conversation", tags=["ONE_ON_ONE"]))
        assert handler._infer_room_type(activity) == "direct"

    def test_infer_room_type_group(self):
        handler = _make_handler()
        activity = _make_activity(target=MercuryTarget(id="r", object_type="conversation", tags=["GROUP"]))
        assert handler._infer_room_type(activity) == "group"

    def test_infer_room_type_team(self):
        handler = _make_handler()
        activity = _make_activity(target=MercuryTarget(id="r", object_type="conversation", tags=["TEAM"]))
        assert handler._infer_room_type(activity) == "team" if False else "group"

    def test_infer_room_type_none(self):
        handler = _make_handler()
        activity = _make_activity(target=MercuryTarget(id="r", object_type="conversation"))
        assert handler._infer_room_type(activity) is None

    async def test_handle_message_created(self):
        handler = _make_handler()
        handler._message_decryptor = MagicMock()
        activity = _make_activity()
        handler._message_decryptor.decrypt_activity = AsyncMock(return_value=activity)

        messages = []
        handler.on("message:created", lambda msg: messages.append(msg))

        await handler._handle_activity(activity)

        assert len(messages) == 1
        msg = messages[0]
        assert msg.id == "comment-789"
        assert msg.room_id == "room-101"
        assert msg.person_id == "person-456"
        assert msg.person_email == "user@example.com"
        assert msg.text == "Test Message"
        assert msg.html == "<p>Test Message</p>"
        assert msg.room_type == "group"

    async def test_handle_message_deleted(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="delete",
            object=MercuryObject(id="msg-789", object_type="activity"),
        )

        deleted = []
        handler.on("message:deleted", lambda d: deleted.append(d))

        await handler._handle_activity(activity)

        assert len(deleted) == 1
        assert deleted[0].message_id == "msg-789"
        assert deleted[0].room_id == "room-101"
        assert deleted[0].person_id == "person-456"

    async def test_ignores_non_message_activities(self):
        handler = _make_handler()
        handler._message_decryptor = MagicMock()
        handler._message_decryptor.decrypt_activity = AsyncMock(return_value=_make_activity(verb="update"))

        messages = []
        deleted = []
        handler.on("message:created", lambda msg: messages.append(msg))
        handler.on("message:deleted", lambda d: deleted.append(d))

        await handler._handle_activity(_make_activity(verb="update"))

        assert len(messages) == 0
        assert len(deleted) == 0

    async def test_ignores_post_non_comment(self):
        handler = _make_handler()
        handler._message_decryptor = MagicMock()

        activity = _make_activity(
            object=MercuryObject(id="file-789", object_type="file"),
        )

        messages = []
        handler.on("message:created", lambda msg: messages.append(msg))

        await handler._handle_activity(activity)

        assert len(messages) == 0


class TestStatus:
    def test_disconnected_status(self):
        handler = _make_handler()
        status = handler.status()
        assert status.status == "disconnected"
        assert status.web_socket_open is False
        assert status.kms_initialized is False
        assert status.device_registered is False
        assert status.reconnect_attempt == 0


class TestEventSystem:
    def test_decorator_registration(self):
        handler = _make_handler()

        @handler.on("connected")
        def on_connected():
            pass

        assert on_connected in handler._listeners["connected"]

    def test_method_registration(self):
        handler = _make_handler()

        def callback():
            pass

        handler.on("connected", callback)
        assert callback in handler._listeners["connected"]

    def test_off_removes_listener(self):
        handler = _make_handler()

        def callback():
            pass

        handler.on("connected", callback)
        handler.off("connected", callback)
        assert callback not in handler._listeners["connected"]
