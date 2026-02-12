"""JWE message decryption for Webex activities."""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING

from jwcrypto import jwe

from .errors import DecryptionError
from .logger import Logger, noop_logger
from .types import MercuryActivity

if TYPE_CHECKING:
    from .kms_client import KmsClient


class MessageDecryptor:
    """Decrypts encrypted Webex message activities using KMS keys."""

    def __init__(self, *, kms_client: KmsClient, logger: Logger | None = None) -> None:
        self._kms_client = kms_client
        self._logger: Logger = logger or noop_logger  # type: ignore[assignment]

    async def decrypt_activity(self, activity: MercuryActivity) -> MercuryActivity:
        """Decrypt an encrypted Mercury activity.

        Returns a copy with decrypted displayName and content fields.
        If the activity is not encrypted (no encryptionKeyUrl) returns as-is.
        """
        try:
            # Locate encryption key URL from one of three locations
            encryption_key_url = (
                activity.encryption_key_url
                or activity.object.encryption_key_url
                or activity.target.encryption_key_url
            )

            # Not encrypted
            if not encryption_key_url:
                return activity

            # Fetch the key from KMS
            try:
                key = await self._kms_client.get_key(encryption_key_url)
            except Exception as exc:
                raise DecryptionError(
                    f"Failed to fetch encryption key from {encryption_key_url}: {exc}"
                ) from exc

            # Shallow copy activity and object
            decrypted = copy.copy(activity)
            decrypted.object = copy.copy(activity.object)

            # Decrypt displayName
            if (
                decrypted.object.display_name
                and isinstance(decrypted.object.display_name, str)
                and len(decrypted.object.display_name) > 0
            ):
                try:
                    jwe_obj = jwe.JWE()
                    jwe_obj.deserialize(decrypted.object.display_name, key=key)
                    decrypted.object.display_name = jwe_obj.payload.decode("utf-8")
                except Exception as exc:
                    self._logger.warning(
                        f"Failed to decrypt displayName in activity {activity.id}: {exc}"
                    )

            # Decrypt content
            if (
                decrypted.object.content
                and isinstance(decrypted.object.content, str)
                and len(decrypted.object.content) > 0
            ):
                try:
                    jwe_obj = jwe.JWE()
                    jwe_obj.deserialize(decrypted.object.content, key=key)
                    decrypted.object.content = jwe_obj.payload.decode("utf-8")
                except Exception as exc:
                    self._logger.warning(
                        f"Failed to decrypt content in activity {activity.id}: {exc}"
                    )

            return decrypted

        except DecryptionError:
            raise
        except Exception as exc:
            raise DecryptionError(
                f"Error decrypting activity {activity.id}: {exc}"
            ) from exc
