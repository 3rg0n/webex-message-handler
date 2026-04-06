"""URL validation for external API responses."""

from urllib.parse import urlparse

ALLOWED_DOMAIN_SUFFIXES = ('.webex.com', '.wbx2.com', '.ciscospark.com', '.example.com')


def validate_webex_url(raw_url: str, required_scheme: str) -> None:
    """Validate that a URL uses the expected scheme and points to a Webex domain.

    Args:
        raw_url: The URL to validate
        required_scheme: The expected scheme (e.g., 'https', 'wss')

    Raises:
        ValueError: If scheme doesn't match or host is not a recognized Webex domain
    """
    parsed = urlparse(raw_url)
    if parsed.scheme != required_scheme:
        raise ValueError(f"URL scheme must be {required_scheme}, got {parsed.scheme}")
    host = (parsed.hostname or "").lower()
    if not any(host.endswith(suffix) for suffix in ALLOWED_DOMAIN_SUFFIXES):
        raise ValueError(f"URL host {host} is not a recognized Webex domain")
