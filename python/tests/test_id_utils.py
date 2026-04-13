"""Tests for ID conversion utilities."""

import pytest

from webex_message_handler.id_utils import from_rest_id, to_rest_id


class TestToRestId:
    def test_roundtrip(self):
        uuid = "abc-123-def"
        rest_id = to_rest_id(uuid, "MESSAGE")
        assert from_rest_id(rest_id) == uuid

    def test_resource_types(self):
        for rt in ("MESSAGE", "PEOPLE", "ROOM"):
            rest_id = to_rest_id("uuid-1", rt)
            assert from_rest_id(rest_id) == "uuid-1"

    def test_non_empty(self):
        rest_id = to_rest_id("test-uuid", "MESSAGE")
        assert rest_id != ""
        assert rest_id != "test-uuid"


class TestFromRestId:
    def test_invalid_base64(self):
        # Not valid base64 — should raise
        with pytest.raises(Exception):
            from_rest_id("!!!invalid!!!")

    def test_invalid_format(self):
        # Valid base64 but no slash in decoded string
        import base64

        encoded = base64.b64encode(b"noslash").decode()
        with pytest.raises(ValueError):
            from_rest_id(encoded)
