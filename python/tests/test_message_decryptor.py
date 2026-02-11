"""Tests for MessageDecryptor."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from webex_message_handler.errors import DecryptionError
from webex_message_handler.message_decryptor import MessageDecryptor
from webex_message_handler.types import MercuryActivity, MercuryActor, MercuryObject, MercuryTarget


def _make_activity(**overrides) -> MercuryActivity:
    defaults = {
        "id": "test-123",
        "verb": "post",
        "actor": MercuryActor(id="actor-id", object_type="person", email_address="user@example.com"),
        "object": MercuryObject(
            id="msg-id",
            object_type="comment",
            display_name="Hello World",
            content="<p>Hello World</p>",
        ),
        "target": MercuryTarget(id="room-id", object_type="conversation", tags=["GROUP"]),
        "published": "2024-01-01T00:00:00Z",
    }
    defaults.update(overrides)
    return MercuryActivity(**defaults)


class TestDecryptActivity:
    async def test_passthrough_without_encryption_key_url(self):
        mock_kms = AsyncMock()
        decryptor = MessageDecryptor(kms_client=mock_kms)

        activity = _make_activity()
        result = await decryptor.decrypt_activity(activity)

        assert result == activity
        mock_kms.get_key.assert_not_called()

    async def test_uses_root_encryption_key_url(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        activity = _make_activity(encryption_key_url="https://kms.example.com/keys/key-123")

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            mock_jwe_obj = MagicMock()
            mock_jwe_obj.payload = b"decrypted-display"
            mock_jwe.JWE.return_value = mock_jwe_obj

            # Second call for content
            mock_jwe_obj2 = MagicMock()
            mock_jwe_obj2.payload = b"decrypted-content"

            call_count = [0]
            original_init = mock_jwe.JWE

            def side_effect():
                call_count[0] += 1
                if call_count[0] == 1:
                    return mock_jwe_obj
                return mock_jwe_obj2

            mock_jwe.JWE.side_effect = side_effect

            decryptor = MessageDecryptor(kms_client=mock_kms)
            result = await decryptor.decrypt_activity(activity)

        mock_kms.get_key.assert_called_once_with("https://kms.example.com/keys/key-123")
        assert result.object.display_name == "decrypted-display"
        assert result.object.content == "decrypted-content"

    async def test_uses_object_encryption_key_url(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        obj = MercuryObject(
            id="msg-id",
            object_type="comment",
            display_name="encrypted",
            content="encrypted",
            encryption_key_url="https://kms.example.com/keys/key-456",
        )
        activity = _make_activity(object=obj)

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            mock_jwe_obj = MagicMock()
            mock_jwe_obj.payload = b"decrypted"
            mock_jwe.JWE.return_value = mock_jwe_obj

            decryptor = MessageDecryptor(kms_client=mock_kms)
            await decryptor.decrypt_activity(activity)

        mock_kms.get_key.assert_called_once_with("https://kms.example.com/keys/key-456")

    async def test_uses_target_encryption_key_url(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        target = MercuryTarget(
            id="room-id",
            object_type="conversation",
            tags=["GROUP"],
            encryption_key_url="https://kms.example.com/keys/key-789",
        )
        activity = _make_activity(target=target)

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            mock_jwe_obj = MagicMock()
            mock_jwe_obj.payload = b"decrypted"
            mock_jwe.JWE.return_value = mock_jwe_obj

            decryptor = MessageDecryptor(kms_client=mock_kms)
            await decryptor.decrypt_activity(activity)

        mock_kms.get_key.assert_called_once_with("https://kms.example.com/keys/key-789")

    async def test_does_not_mutate_original(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        activity = _make_activity(encryption_key_url="https://kms.example.com/keys/key-123")
        original_display_name = activity.object.display_name
        original_content = activity.object.content

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            mock_jwe_obj = MagicMock()
            mock_jwe_obj.payload = b"decrypted"
            mock_jwe.JWE.return_value = mock_jwe_obj

            decryptor = MessageDecryptor(kms_client=mock_kms)
            result = await decryptor.decrypt_activity(activity)

        # Original unchanged
        assert activity.object.display_name == original_display_name
        assert activity.object.content == original_content
        # Result is different object
        assert result is not activity
        assert result.object is not activity.object

    async def test_handles_display_name_decryption_failure(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        activity = _make_activity(encryption_key_url="https://kms.example.com/keys/key-123")

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            call_count = [0]

            def side_effect():
                call_count[0] += 1
                obj = MagicMock()
                if call_count[0] == 1:
                    obj.deserialize.side_effect = Exception("Decryption failed")
                else:
                    obj.payload = b"decrypted-content"
                return obj

            mock_jwe.JWE.side_effect = side_effect

            mock_logger = MagicMock()
            decryptor = MessageDecryptor(kms_client=mock_kms, logger=mock_logger)
            result = await decryptor.decrypt_activity(activity)

        mock_logger.warning.assert_called()
        # displayName stays encrypted, content decrypted
        assert result.object.display_name == "Hello World"
        assert result.object.content == "decrypted-content"

    async def test_handles_content_decryption_failure(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        activity = _make_activity(encryption_key_url="https://kms.example.com/keys/key-123")

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            call_count = [0]

            def side_effect():
                call_count[0] += 1
                obj = MagicMock()
                if call_count[0] == 1:
                    obj.payload = b"decrypted-display"
                else:
                    obj.deserialize.side_effect = Exception("Content decryption failed")
                return obj

            mock_jwe.JWE.side_effect = side_effect

            mock_logger = MagicMock()
            decryptor = MessageDecryptor(kms_client=mock_kms, logger=mock_logger)
            result = await decryptor.decrypt_activity(activity)

        mock_logger.warning.assert_called()
        assert result.object.display_name == "decrypted-display"
        assert result.object.content == "<p>Hello World</p>"

    async def test_skips_empty_display_name(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        obj = MercuryObject(id="msg-id", object_type="comment", display_name="", content="encrypted")
        activity = _make_activity(object=obj, encryption_key_url="https://kms.example.com/keys/key-123")

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            mock_jwe_obj = MagicMock()
            mock_jwe_obj.payload = b"decrypted-content"
            mock_jwe.JWE.return_value = mock_jwe_obj

            decryptor = MessageDecryptor(kms_client=mock_kms)
            result = await decryptor.decrypt_activity(activity)

        assert result.object.display_name == ""
        # Only content should trigger JWE
        assert mock_jwe.JWE.call_count == 1

    async def test_skips_missing_content(self):
        mock_kms = AsyncMock()
        mock_key = MagicMock()
        mock_kms.get_key = AsyncMock(return_value=mock_key)

        obj = MercuryObject(id="msg-id", object_type="comment", display_name="encrypted")
        activity = _make_activity(object=obj, encryption_key_url="https://kms.example.com/keys/key-123")

        with patch("webex_message_handler.message_decryptor.jwe") as mock_jwe:
            mock_jwe_obj = MagicMock()
            mock_jwe_obj.payload = b"decrypted-display"
            mock_jwe.JWE.return_value = mock_jwe_obj

            decryptor = MessageDecryptor(kms_client=mock_kms)
            result = await decryptor.decrypt_activity(activity)

        assert result.object.display_name == "decrypted-display"
        assert result.object.content is None
        assert mock_jwe.JWE.call_count == 1

    async def test_throws_decryption_error_on_kms_failure(self):
        mock_kms = AsyncMock()
        mock_kms.get_key = AsyncMock(side_effect=Exception("Key not found"))

        activity = _make_activity(encryption_key_url="https://kms.example.com/keys/key-123")

        decryptor = MessageDecryptor(kms_client=mock_kms)
        with pytest.raises(DecryptionError):
            await decryptor.decrypt_activity(activity)
