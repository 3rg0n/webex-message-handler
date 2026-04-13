"""Tests for KmsClient."""

import json
from unittest.mock import AsyncMock

import pytest
from jwcrypto import jwk
from jwcrypto.common import base64url_encode

from webex_message_handler.errors import KmsError
from webex_message_handler.kms_client import KmsClient
from webex_message_handler.types import FetchRequest


class _FakeFetchResponse:
    def __init__(self, *, status: int, ok: bool, payload: dict[str, object]) -> None:
        self.status = status
        self.ok = ok
        self._payload = payload

    async def json(self) -> dict[str, object]:
        return self._payload

    async def text(self) -> str:
        return json.dumps(self._payload)


def _make_kms_response_token(payload: dict[str, object]) -> str:
    header = base64url_encode(b'{"alg":"none"}')
    body = base64url_encode(json.dumps(payload).encode("utf-8"))
    signature = base64url_encode(b"signature")
    return f"{header}.{body}.{signature}"


def _build_kms_details(*, kms_cluster: str) -> dict[str, object]:
    rsa_public_key = jwk.JWK.generate(kty="RSA", size=2048)
    return {
        "kmsCluster": kms_cluster,
        "rsaPublicKey": json.loads(rsa_public_key.export_public()),
    }


@pytest.mark.asyncio
async def test_initialize_accepts_kms_cluster_url() -> None:
    requests: list[FetchRequest] = []
    kms_details = _build_kms_details(kms_cluster="kms://ciscospark.com/keys")
    remote_key = jwk.JWK.generate(kty="EC", crv="P-256")
    wrapped_response = _make_kms_response_token(
        {
            "body": {
                "key": {
                    "jwk": json.loads(remote_key.export_public()),
                    "uri": "kms://ciscospark.com/keys/key/123",
                    "expirationDate": "2026-01-01T00:00:00Z",
                }
            }
        }
    )

    async def http_do(request: FetchRequest) -> _FakeFetchResponse:
        requests.append(request)
        return _FakeFetchResponse(status=200, ok=True, payload=kms_details)

    client = KmsClient(
        token="test-token",
        device_url="https://device.example.com",
        user_id="user-123",
        encryption_service_url="https://encryption.example.com",
        http_do=http_do,
    )
    client._send_kms_request = AsyncMock(return_value=wrapped_response)  # type: ignore[method-assign]

    await client.initialize()

    assert client._initialized is True
    assert client._kms_cluster == "kms://ciscospark.com/keys"
    assert client._ephemeral_key is not None
    assert client._ephemeral_key.get("kid") == "kms://ciscospark.com/keys/key/123"
    assert len(requests) == 1
    assert requests[0].method == "GET"
    assert requests[0].url == "https://encryption.example.com/kms/user-123"


@pytest.mark.asyncio
async def test_initialize_rejects_https_kms_cluster_url() -> None:
    kms_details = _build_kms_details(kms_cluster="https://ciscospark.com/keys")

    async def http_do(request: FetchRequest) -> _FakeFetchResponse:
        return _FakeFetchResponse(status=200, ok=True, payload=kms_details)

    client = KmsClient(
        token="test-token",
        device_url="https://device.example.com",
        user_id="user-123",
        encryption_service_url="https://encryption.example.com",
        http_do=http_do,
    )
    client._send_kms_request = AsyncMock()  # type: ignore[method-assign]

    with pytest.raises(KmsError, match="URL scheme must be kms, got https"):
        await client.initialize()

    client._send_kms_request.assert_not_called()
