"""KMS client for ECDH key exchange and encryption key retrieval.

Implements the Webex KMS protocol:
1. Fetch KMS cluster details (rsaPublicKey, kmsCluster)
2. ECDH handshake: generate local P-256 keypair, wrap with RSA-OAEP,
   send via HTTP, receive response via Mercury, derive shared key
3. Key retrieval: wrap request with ECDH-derived key, send via HTTP,
   receive via Mercury, unwrap to get content key
4. Decryption keys are JWE A256KW + A256GCM
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from jwcrypto import jwe, jwk
from jwcrypto.common import base64url_decode, base64url_encode

from .errors import KmsError
from .logger import Logger, noop_logger
from .types import FetchFunction, FetchRequest

KMS_RESPONSE_TIMEOUT = 30.0  # seconds


class KmsClient:
    """KMS client for Webex end-to-end encryption.

    Performs the ECDH key exchange and retrieves content encryption keys
    using the two-channel pattern: HTTP POST → 202, response via Mercury.
    """

    def __init__(
        self,
        *,
        token: str,
        device_url: str,
        user_id: str,
        encryption_service_url: str,
        logger: Logger | None = None,
        http_do: FetchFunction,
    ) -> None:
        self._token = token
        self._device_url = device_url
        self._user_id = user_id
        self._encryption_service_url = encryption_service_url
        self._http_do = http_do
        self._logger: Logger = logger or noop_logger  # type: ignore[assignment]

        self._kms_cluster: str = ""
        self._ephemeral_key: jwk.JWK | None = None
        self._context_expiration: datetime | None = None
        self._key_cache: dict[str, jwk.JWK] = {}
        self._initialized = False

        # Pending KMS requests waiting for Mercury responses (FIFO)
        self._pending_requests: dict[str, _PendingRequest] = {}

    def handle_kms_message(self, data: dict[str, Any]) -> None:
        """Handle a KMS response that arrived via Mercury WebSocket.

        Called by the handler when an encryption.kms_message event is received.
        """
        kms_messages = data.get("kmsMessages") or (data.get("encryption", {}) or {}).get("kmsMessages")
        if not kms_messages or not isinstance(kms_messages, list):
            self._logger.debug(f"Received KMS message without kmsMessages array, keys: {list(data.keys())}")
            return

        for wrapped in kms_messages:
            self._logger.debug(f"Received KMS response, pending requests: {len(self._pending_requests)}")

            # Resolve the first pending request (FIFO)
            if self._pending_requests:
                first_key = next(iter(self._pending_requests))
                pending = self._pending_requests.pop(first_key)
                pending.timeout_handle.cancel()
                pending.future.set_result(wrapped)
            else:
                self._logger.warning("Received KMS response but no pending requests")

    async def initialize(self) -> None:
        """Initialize KMS context with ECDH handshake."""
        try:
            self._logger.info("Initializing KMS client")
            self._logger.debug(f"Encryption service URL: {self._encryption_service_url}")

            # Step 1: Fetch KMS details
            kms_details_url = f"{self._encryption_service_url}/kms/{self._user_id}"
            response = await self._http_do(
                FetchRequest(
                    url=kms_details_url,
                    method="GET",
                    headers={"Authorization": f"Bearer {self._token}"},
                )
            )
            if not response.ok:
                raise KmsError(f"Failed to fetch KMS details: {response.status}")
            kms_details = await response.json()

            self._kms_cluster = kms_details["kmsCluster"]
            rsa_public_key_raw = kms_details["rsaPublicKey"]
            if isinstance(rsa_public_key_raw, str):
                rsa_public_key_raw = json.loads(rsa_public_key_raw)

            # Step 2: Generate local ECDH keypair (P-256)
            local_ecdh_key = jwk.JWK.generate(kty="EC", crv="P-256")

            # Step 3: Build ECDH request body
            request_id = str(uuid.uuid4())
            ecdh_request_body = {
                "client": {
                    "clientId": self._device_url,
                    "credential": {
                        "userId": self._user_id,
                        "bearer": self._token,
                    },
                },
                "method": "create",
                "uri": f"{self._kms_cluster}/ecdhe",
                "requestId": request_id,
                "jwk": json.loads(local_ecdh_key.export_public()),
            }

            # Step 4: Wrap ECDH request with server RSA public key (JWE RSA-OAEP + A256GCM)
            rsa_key = jwk.JWK(**rsa_public_key_raw)
            wrapped = _jwe_encrypt(
                plaintext=json.dumps(ecdh_request_body).encode(),
                key=rsa_key,
                alg="RSA-OAEP",
                enc="A256GCM",
            )

            # Step 5: POST ECDH request and wait for Mercury response
            wrapped_response = await self._send_kms_request(request_id, wrapped)

            # Step 6: Unwrap ECDH response (JWS signed or JWE encrypted)
            response_body = _unwrap_kms_response(wrapped_response, local_ecdh_key)
            response_data = json.loads(response_body)

            remote_jwk_data = response_data.get("body", {}).get("key", {}).get("jwk") or response_data.get("key", {}).get("jwk")
            if not remote_jwk_data:
                # Try alternate response structures
                if "body" in response_data and "key" in response_data["body"]:
                    remote_jwk_data = response_data["body"]["key"]
                    if isinstance(remote_jwk_data, dict) and "jwk" in remote_jwk_data:
                        remote_jwk_data = remote_jwk_data["jwk"]

            if not remote_jwk_data:
                raise KmsError(
                    f"No key in ECDH response, body keys: {list(response_data.get('body', {}).keys())}"
                )

            # Step 7: Derive shared key via ECDH
            remote_ecdh_key = jwk.JWK(**remote_jwk_data) if isinstance(remote_jwk_data, dict) else jwk.JWK(**json.loads(remote_jwk_data))

            # Get the remote key URI for use as kid on the derived key
            remote_key_uri = (
                response_data.get("body", {}).get("key", {}).get("uri")
                or response_data.get("key", {}).get("uri")
                or ""
            )

            shared_key = _derive_ecdh_shared_key(local_ecdh_key, remote_ecdh_key, kid=remote_key_uri)
            self._ephemeral_key = shared_key

            # Extract expiration from response if available
            expiration_str = (
                response_data.get("body", {}).get("key", {}).get("expirationDate")
                or response_data.get("key", {}).get("expirationDate")
            )
            if expiration_str:
                try:
                    self._context_expiration = datetime.fromisoformat(expiration_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    self._context_expiration = datetime.now(timezone.utc) + timedelta(hours=1)
            else:
                self._context_expiration = datetime.now(timezone.utc) + timedelta(hours=1)

            self._initialized = True
            self._logger.info("KMS client initialized successfully")

        except KmsError:
            raise
        except Exception as exc:
            raise KmsError(f"KMS initialization failed: {exc}") from exc

    async def get_key(self, key_uri: str) -> jwk.JWK:
        """Retrieve an encryption key from KMS.

        Returns a cached key if available. Re-initializes context if expired.
        """
        try:
            # Check cache
            cached = self._key_cache.get(key_uri)
            if cached:
                self._logger.debug(f"Cache hit for key: {key_uri}")
                return cached

            # Check context expiration
            if self._is_context_expired():
                self._logger.info("Context expired, re-initializing")
                await self.initialize()

            if not self._initialized or not self._ephemeral_key:
                raise KmsError("KMS context not initialized")

            # Build retrieve request
            request_id = str(uuid.uuid4())
            retrieve_body = {
                "client": {
                    "clientId": self._device_url,
                    "credential": {
                        "userId": self._user_id,
                        "bearer": self._token,
                    },
                },
                "method": "retrieve",
                "uri": key_uri,
                "requestId": request_id,
            }

            # Wrap with ephemeral key (dir + A256GCM — key is CEK directly)
            wrapped = _jwe_encrypt(
                plaintext=json.dumps(retrieve_body).encode(),
                key=self._ephemeral_key,
                alg="dir",
                enc="A256GCM",
            )

            # POST and wait for Mercury response
            wrapped_response = await self._send_kms_request(request_id, wrapped)

            # Unwrap response
            response_body = _unwrap_kms_response(wrapped_response, self._ephemeral_key)
            response_data = json.loads(response_body)

            # Extract the content key
            key_data = response_data.get("body", {}).get("key", {}).get("jwk") or response_data.get("key", {}).get("jwk")
            if not key_data:
                if "body" in response_data and "key" in response_data["body"]:
                    key_obj = response_data["body"]["key"]
                    if isinstance(key_obj, dict) and "jwk" in key_obj:
                        key_data = key_obj["jwk"]
                    else:
                        key_data = key_obj

            if not key_data:
                raise KmsError("No key found in KMS response")

            if isinstance(key_data, str):
                key_data = json.loads(key_data)

            content_key = jwk.JWK(**key_data)
            self._key_cache[key_uri] = content_key
            self._logger.info(f"Key retrieved and cached: {key_uri}")
            return content_key

        except KmsError:
            raise
        except Exception as exc:
            raise KmsError(f"Failed to get key: {exc}") from exc

    async def _send_kms_request(self, request_id: str, wrapped: str) -> str:
        """Send a KMS request via HTTP and wait for the response via Mercury."""
        loop = asyncio.get_event_loop()
        future: asyncio.Future[str] = loop.create_future()
        timeout_handle = loop.call_later(
            KMS_RESPONSE_TIMEOUT,
            lambda: (
                self._pending_requests.pop(request_id, None),
                future.set_exception(
                    KmsError(f"KMS request {request_id} timed out after {KMS_RESPONSE_TIMEOUT}s")
                ) if not future.done() else None,
            ),
        )

        self._pending_requests[request_id] = _PendingRequest(future=future, timeout_handle=timeout_handle)

        # POST the request
        try:
            response = await self._http_do(
                FetchRequest(
                    url=f"{self._encryption_service_url}/kms/messages",
                    method="POST",
                    headers={
                        "Authorization": f"Bearer {self._token}",
                        "Content-Type": "application/json",
                    },
                    body=json.dumps({
                        "destination": self._kms_cluster,
                        "kmsMessages": [wrapped],
                    }),
                )
            )
            self._logger.debug(f"KMS HTTP POST response: {response.status}")
            if not response.ok:
                self._pending_requests.pop(request_id, None)
                timeout_handle.cancel()
                error_body = await response.text()
                raise KmsError(f"KMS HTTP request failed: {response.status} {error_body}")
        except KmsError:
            raise
        except Exception as exc:
            self._pending_requests.pop(request_id, None)
            timeout_handle.cancel()
            raise KmsError(f"KMS HTTP request failed: {exc}") from exc

        self._logger.debug(f"KMS request {request_id} sent, waiting for Mercury response...")
        return await future

    def _is_context_expired(self) -> bool:
        if not self._initialized or not self._context_expiration:
            return True
        buffer = timedelta(seconds=30)
        return datetime.now(timezone.utc) > (self._context_expiration - buffer)


class _PendingRequest:
    """A pending KMS request awaiting Mercury response."""

    __slots__ = ("future", "timeout_handle")

    def __init__(self, future: asyncio.Future[str], timeout_handle: asyncio.TimerHandle) -> None:
        self.future = future
        self.timeout_handle = timeout_handle


def _jwe_encrypt(plaintext: bytes, key: jwk.JWK, alg: str, enc: str) -> str:
    """Encrypt plaintext as JWE compact serialization."""
    protected_header: dict[str, str] = {"alg": alg, "enc": enc}
    # Include kid in header if the key has one (KMS needs it to identify the decryption key)
    kid = key.get("kid")
    if kid:
        protected_header["kid"] = kid
    jwe_obj = jwe.JWE(plaintext, recipient=key, protected=protected_header)
    return jwe_obj.serialize(compact=True)


def _unwrap_kms_response(token: str, key: jwk.JWK) -> bytes:
    """Unwrap a KMS response — may be JWE (encrypted) or JWS (signed).

    KMS returns JWE (5 parts) or JWS (3 parts) compact serialization.
    JWE is decrypted with the provided key. JWS payload is extracted directly
    (the response arrives over an authenticated Mercury WebSocket channel).
    """
    parts = token.split(".")
    if len(parts) == 5:
        # JWE compact: header.encrypted_key.iv.ciphertext.tag
        jwe_obj = jwe.JWE()
        jwe_obj.deserialize(token, key=key)
        return jwe_obj.payload
    elif len(parts) == 3:
        # JWS compact: header.payload.signature — extract payload
        return base64url_decode(parts[1])
    else:
        raise KmsError(f"Invalid KMS response format: expected 3 or 5 parts, got {len(parts)}")


def _derive_ecdh_shared_key(local_key: jwk.JWK, remote_key: jwk.JWK, *, kid: str = "") -> jwk.JWK:
    """Derive a shared symmetric key from local and remote ECDH keys.

    Uses ECDH + HKDF to produce a 256-bit symmetric (oct) key.
    The kid parameter should be the remote key's URI (used in JWE headers).
    """
    from cryptography.hazmat.primitives.asymmetric.ec import ECDH
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    # Get cryptography private key from local JWK
    local_private = local_key.get_op_key("sign") if local_key.has_private else local_key.get_op_key("unwrapKey")
    # For EC keys, get the actual private key object
    local_crypto_key = local_key._get_private_key() if hasattr(local_key, '_get_private_key') else None

    if local_crypto_key is None:
        # Fallback: load from JWK export
        import json as _json

        from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, derive_private_key
        key_data = _json.loads(local_key.export(private_key=True))
        d_bytes = base64url_decode(key_data["d"])
        d_int = int.from_bytes(d_bytes, "big")
        local_crypto_key = derive_private_key(d_int, SECP256R1())

    # Get cryptography public key from remote JWK
    remote_crypto_key = None
    try:
        from cryptography.hazmat.primitives.asymmetric.ec import SECP256R1, EllipticCurvePublicNumbers
        remote_data = json.loads(remote_key.export())
        x_bytes = base64url_decode(remote_data["x"])
        y_bytes = base64url_decode(remote_data["y"])
        x_int = int.from_bytes(x_bytes, "big")
        y_int = int.from_bytes(y_bytes, "big")
        remote_crypto_key = EllipticCurvePublicNumbers(x_int, y_int, SECP256R1()).public_key()
    except Exception:
        pass

    if remote_crypto_key is None:
        raise KmsError("Failed to load remote ECDH public key")

    # Perform ECDH
    shared_secret = local_crypto_key.exchange(ECDH(), remote_crypto_key)

    # HKDF to derive 256-bit key
    derived = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=None,
        info=b"",
    ).derive(shared_secret)

    # Create symmetric JWK with kid (KMS needs kid in JWE header to identify the key)
    params: dict[str, str] = {"kty": "oct", "k": base64url_encode(derived)}
    if kid:
        params["kid"] = kid
    return jwk.JWK(**params)
