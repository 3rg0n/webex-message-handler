"""Tests for Mercury activity parsing (_parse_activity)."""

from webex_message_handler.mercury_socket import _parse_activity


def test_parse_activity_inputs_encrypted_string():
    """Card-action inputs arrive as a JWE-encrypted string; the parser must
    capture it in inputs_encrypted (for later decryption), not drop it."""
    raw = {
        "id": "act-1",
        "verb": "cardAction",
        "object": {
            "objectType": "submit",
            "inputs": "eyJlbmMiOiJBMjU2R0NNIn0..abc.def.ghi",
        },
    }
    activity = _parse_activity(raw)
    assert activity.object.inputs_encrypted == "eyJlbmMiOiJBMjU2R0NNIn0..abc.def.ghi"
    assert activity.object.inputs is None


def test_parse_activity_inputs_plaintext_map():
    """Defensive: a plaintext dict still populates inputs directly."""
    raw = {
        "id": "act-2",
        "verb": "cardAction",
        "object": {
            "objectType": "submit",
            "inputs": {"verdict": "up"},
        },
    }
    activity = _parse_activity(raw)
    assert activity.object.inputs_encrypted is None
    assert activity.object.inputs == {"verdict": "up"}


def test_parse_activity_no_inputs():
    """An activity without inputs leaves both fields unset."""
    raw = {
        "id": "act-3",
        "verb": "post",
        "object": {"objectType": "comment"},
    }
    activity = _parse_activity(raw)
    assert activity.object.inputs is None
    assert activity.object.inputs_encrypted is None
