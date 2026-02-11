//! JWE message decryption for Webex activities.

use crate::errors::WebexError;
use crate::jwe;
use crate::kms_client::KmsClient;
use crate::types::MercuryActivity;
use tracing::warn;

/// Decrypts encrypted Webex message activities using KMS keys.
pub struct MessageDecryptor<'a> {
    kms_client: &'a mut KmsClient,
}

impl<'a> MessageDecryptor<'a> {
    pub fn new(kms_client: &'a mut KmsClient) -> Self {
        Self { kms_client }
    }

    /// Decrypt an encrypted Mercury activity.
    ///
    /// Returns a clone with decrypted `display_name` and `content` fields.
    /// If the activity is not encrypted (no `encryption_key_url`), returns a clone as-is.
    pub async fn decrypt_activity(
        &mut self,
        activity: &MercuryActivity,
    ) -> Result<MercuryActivity, WebexError> {
        // Locate encryption key URL from one of three locations
        let encryption_key_url = activity
            .encryption_key_url
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                activity
                    .object
                    .encryption_key_url
                    .as_deref()
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                activity
                    .target
                    .encryption_key_url
                    .as_deref()
                    .filter(|s| !s.is_empty())
            });

        // Not encrypted
        let encryption_key_url = match encryption_key_url {
            Some(url) => url.to_string(),
            None => return Ok(activity.clone()),
        };

        // Fetch the key from KMS
        let key = self
            .kms_client
            .get_key(&encryption_key_url)
            .await
            .map_err(|e| {
                WebexError::decryption(format!(
                    "Failed to fetch encryption key from {encryption_key_url}: {e}"
                ))
            })?;

        // Clone and decrypt fields
        let mut decrypted = activity.clone();

        // Decrypt displayName
        if let Some(ref display_name) = decrypted.object.display_name {
            if !display_name.is_empty() {
                match jwe::decrypt_message_jwe(display_name, &key) {
                    Ok(plaintext) => {
                        decrypted.object.display_name = Some(
                            String::from_utf8(plaintext).unwrap_or_else(|_| {
                                display_name.clone()
                            }),
                        );
                    }
                    Err(e) => {
                        warn!(
                            "Failed to decrypt displayName in activity {}: {e}",
                            activity.id
                        );
                    }
                }
            }
        }

        // Decrypt content
        if let Some(ref content) = decrypted.object.content {
            if !content.is_empty() {
                match jwe::decrypt_message_jwe(content, &key) {
                    Ok(plaintext) => {
                        decrypted.object.content = Some(
                            String::from_utf8(plaintext).unwrap_or_else(|_| {
                                content.clone()
                            }),
                        );
                    }
                    Err(e) => {
                        warn!(
                            "Failed to decrypt content in activity {}: {e}",
                            activity.id
                        );
                    }
                }
            }
        }

        Ok(decrypted)
    }
}
