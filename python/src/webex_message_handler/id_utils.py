"""Convert between Mercury activity UUIDs and Webex REST API IDs."""

import base64


def to_rest_id(uuid: str, resource_type: str) -> str:
    """Convert a Mercury activity UUID to a Webex REST API ID.

    Mercury uses raw UUIDs; the REST API uses base64-encoded
    ``ciscospark://us/{type}/{uuid}`` URIs.

    Args:
        uuid: Mercury UUID (e.g. activity.id).
        resource_type: Resource type — 'MESSAGE', 'PEOPLE', or 'ROOM'.

    Returns:
        REST API–compatible ID string.
    """
    uri = f"ciscospark://us/{resource_type}/{uuid}"
    return base64.b64encode(uri.encode()).decode()


def from_rest_id(rest_id: str) -> str:
    """Convert a Webex REST API ID back to a raw UUID.

    Args:
        rest_id: Base64-encoded REST API ID.

    Returns:
        The raw UUID portion.

    Raises:
        ValueError: If the format is invalid.
    """
    decoded = base64.b64decode(rest_id).decode()
    last_slash = decoded.rfind("/")
    if last_slash == -1:
        raise ValueError(f"Invalid REST ID format: {rest_id}")
    return decoded[last_slash + 1 :]
