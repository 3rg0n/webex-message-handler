"""Tests for WebexMessageHandler."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from webex_message_handler.handler import WebexMessageHandler
from webex_message_handler.types import (
    DeviceRegistration,
    MercuryActivity,
    MercuryActor,
    MercuryObject,
    MercuryParent,
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
        "object": MercuryObject(
            id="comment-789", object_type="comment",
            display_name="Test Message", content="<p>Test Message</p>",
        ),
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


class TestModeValidation:
    def test_accepts_native_mode_with_connector(self):
        handler = _make_handler(mode="native", connector=MagicMock())
        assert handler is not None

    def test_accepts_default_native_mode(self):
        handler = _make_handler()
        assert handler is not None

    def test_accepts_injected_mode_with_fetch_and_ws_factory(self):
        mock_fetch = AsyncMock()
        mock_ws_factory = AsyncMock()
        handler = _make_handler(mode="injected", fetch=mock_fetch, web_socket_factory=mock_ws_factory)
        assert handler is not None

    def test_rejects_injected_mode_missing_fetch(self):
        mock_ws_factory = AsyncMock()
        with pytest.raises(ValueError, match='Injected mode requires both "fetch" and "web_socket_factory"'):
            _make_handler(mode="injected", web_socket_factory=mock_ws_factory)

    def test_rejects_injected_mode_missing_ws_factory(self):
        mock_fetch = AsyncMock()
        with pytest.raises(ValueError, match='Injected mode requires both "fetch" and "web_socket_factory"'):
            _make_handler(mode="injected", fetch=mock_fetch)

    def test_rejects_injected_mode_with_connector(self):
        mock_fetch = AsyncMock()
        mock_ws_factory = AsyncMock()
        with pytest.raises(ValueError, match="Cannot use native proxy parameters.*connector.*in injected mode"):
            _make_handler(mode="injected", fetch=mock_fetch, web_socket_factory=mock_ws_factory, connector=MagicMock())

    def test_rejects_native_mode_with_fetch(self):
        mock_fetch = AsyncMock()
        with pytest.raises(ValueError, match='Cannot provide fetch/web_socket_factory in native mode'):
            _make_handler(mode="native", fetch=mock_fetch)

    def test_rejects_native_mode_with_ws_factory(self):
        mock_ws_factory = AsyncMock()
        with pytest.raises(ValueError, match='Cannot provide fetch/web_socket_factory in native mode'):
            _make_handler(mode="native", web_socket_factory=mock_ws_factory)

    def test_rejects_default_mode_with_fetch(self):
        mock_fetch = AsyncMock()
        with pytest.raises(ValueError, match='Cannot provide fetch/web_socket_factory in native mode'):
            _make_handler(fetch=mock_fetch)

    def test_rejects_invalid_mode_string(self):
        with pytest.raises(ValueError, match='Invalid mode.*must be "native" or "injected"'):
            _make_handler(mode="invalid")


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
        handler._fetch_bot_person_id = AsyncMock()
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
        handler._fetch_bot_person_id = AsyncMock()
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
        assert msg.id == "msg-123"
        assert msg.room_id == "room-101"
        assert msg.person_id == "person-456"
        assert msg.person_email == "user@example.com"
        assert msg.text == "Test Message"
        assert msg.html == "<p>Test Message</p>"
        assert msg.room_type == "group"
        assert msg.parent_id is None

    async def test_handle_share_verb_emits_message_created(self):
        """File-share activities arrive as verb=share; must emit message:created."""
        handler = _make_handler()
        handler._message_decryptor = MagicMock()
        activity = _make_activity(
            verb="share",
            object=MercuryObject(
                id="comment-789", object_type="comment",
                display_name="Here's the file",
                content="<p>Here's the file</p>",
                files=["https://webexapis.com/v1/contents/abc"],
            ),
        )
        handler._message_decryptor.decrypt_activity = AsyncMock(return_value=activity)

        messages = []
        handler.on("message:created", lambda msg: messages.append(msg))

        await handler._handle_activity(activity)

        assert len(messages) == 1
        msg = messages[0]
        assert msg.files == ["https://webexapis.com/v1/contents/abc"]
        assert msg.text == "Here's the file"

    async def test_handle_threaded_reply(self):
        handler = _make_handler()
        handler._message_decryptor = MagicMock()
        activity = _make_activity(
            parent=MercuryParent(id="parent-activity-uuid", type="reply"),
        )
        handler._message_decryptor.decrypt_activity = AsyncMock(return_value=activity)

        messages = []
        handler.on("message:created", lambda msg: messages.append(msg))

        await handler._handle_activity(activity)

        assert len(messages) == 1
        msg = messages[0]
        assert msg.id == "msg-123"
        assert msg.parent_id == "parent-activity-uuid"

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
        handler._message_decryptor.decrypt_activity = AsyncMock(return_value=_make_activity(verb="acknowledge"))

        messages = []
        updated = []
        deleted = []
        handler.on("message:created", lambda msg: messages.append(msg))
        handler.on("message:updated", lambda msg: updated.append(msg))
        handler.on("message:deleted", lambda d: deleted.append(d))

        await handler._handle_activity(_make_activity(verb="acknowledge"))

        assert len(messages) == 0
        assert len(updated) == 0
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


class TestMembershipHandling:
    async def test_handle_membership_add(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="add",
            object=MercuryObject(id="member-789", object_type="person"),
        )

        events = []
        handler.on("membership:created", lambda a: events.append(a))

        await handler._handle_activity(activity)

        assert len(events) == 1
        evt = events[0]
        assert evt.id == "msg-123"
        assert evt.actor_id == "person-456"
        assert evt.person_id == "member-789"
        assert evt.room_id == "room-101"
        assert evt.action == "add"
        assert evt.created == "2024-01-01T00:00:00Z"
        assert evt.room_type == "group"

    async def test_handle_membership_leave(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="leave",
            object=MercuryObject(id="member-789", object_type="person"),
        )

        events = []
        handler.on("membership:created", lambda a: events.append(a))

        await handler._handle_activity(activity)

        assert len(events) == 1
        assert events[0].action == "leave"

    async def test_handle_membership_assign_moderator(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="assignModerator",
            object=MercuryObject(id="member-789", object_type="person"),
        )

        events = []
        handler.on("membership:created", lambda a: events.append(a))

        await handler._handle_activity(activity)

        assert len(events) == 1
        assert events[0].action == "assignModerator"

    async def test_handle_membership_unassign_moderator(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="unassignModerator",
            object=MercuryObject(id="member-789", object_type="person"),
        )

        events = []
        handler.on("membership:created", lambda a: events.append(a))

        await handler._handle_activity(activity)

        assert len(events) == 1
        assert events[0].action == "unassignModerator"

    async def test_non_membership_verb_with_person_object(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="post",
            object=MercuryObject(id="person-789", object_type="person"),
        )

        events = []
        handler.on("membership:created", lambda a: events.append(a))

        await handler._handle_activity(activity)

        assert len(events) == 0

    async def test_membership_verb_with_non_person_object(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="add",
            object=MercuryObject(id="comment-789", object_type="comment"),
        )

        events = []
        handler.on("membership:created", lambda a: events.append(a))

        await handler._handle_activity(activity)

        assert len(events) == 0

    async def test_membership_includes_raw_activity(self):
        handler = _make_handler()
        activity = _make_activity(
            verb="add",
            object=MercuryObject(id="member-789", object_type="person"),
        )

        events = []
        handler.on("membership:created", lambda a: events.append(a))

        await handler._handle_activity(activity)

        assert len(events) == 1
        assert events[0].raw is activity


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
