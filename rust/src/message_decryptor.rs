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

        // Decrypt card-action inputs. On cardAction/submit activities object.inputs
        // is a JWE string (split into inputs_encrypted by finalize_inputs), encrypted
        // under the same key; the plaintext is a JSON object of the form values.
        if let Some(ref encrypted_inputs) = decrypted.object.inputs_encrypted {
            if !encrypted_inputs.is_empty() {
                match jwe::decrypt_message_jwe(encrypted_inputs, &key) {
                    Ok(plaintext) => match serde_json::from_slice::<serde_json::Value>(&plaintext) {
                        Ok(inputs_obj) => {
                            decrypted.object.inputs = Some(inputs_obj);
                        }
                        Err(e) => {
                            warn!(
                                "Failed to parse decrypted inputs in activity {}: {e}",
                                activity.id
                            );
                        }
                    },
                    Err(e) => {
                        warn!("Failed to decrypt inputs in activity {}: {e}", activity.id);
                    }
                }
            }
        }

        Ok(decrypted)
    }
}

#[cfg(test)]
mod tests {
    use super::MessageDecryptor;
    use crate::jwe;
    use crate::kms_client::KmsClient;
    use crate::types::{
        FetchFn, FetchRequest, FetchResponse, MercuryActivity, MercuryActor, MercuryObject,
        MercuryTarget,
    };

    /// A FetchFn that always fails — decryptor tests seed the key cache directly,
    /// so no HTTP/KMS network path should ever be exercised.
    fn failing_fetch() -> FetchFn {
        std::sync::Arc::new(|_req: FetchRequest| {
            Box::pin(async {
                Err::<FetchResponse, Box<dyn std::error::Error + Send + Sync>>(
                    "fetch must not be called in this test".into(),
                )
            })
        })
    }

    /// Build a KmsClient with a content key pre-seeded so get_key() is a cache hit.
    fn seeded_kms(key_uri: &str, key: [u8; 32]) -> KmsClient {
        let mut kms = KmsClient::new(
            failing_fetch(),
            "test-token",
            "https://wdm.example.com/device",
            "user-123",
            "https://encryption.example.com",
        );
        kms.seed_key(key_uri, key);
        kms
    }

    #[tokio::test]
    async fn test_decrypt_activity_with_encrypted_inputs() {
        const KEY_URI: &str = "https://kms.example.com/keys/test-key";
        let test_key: [u8; 32] = [
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
            0x1c, 0x1d, 0x1e, 0x1f,
        ];

        // Encrypt a card-inputs JSON object with dir/A256GCM, mirroring the wire.
        let inputs_plaintext = serde_json::json!({
            "card_action": "answer_feedback",
            "response_event_id": "evt-123",
            "verdict": "up"
        });
        let encrypted_jwe = jwe::encrypt_dir_a256gcm(
            inputs_plaintext.to_string().as_bytes(),
            &test_key,
            "test-kid",
        )
        .expect("Failed to encrypt test inputs");

        // Build a cardAction activity as it arrives on the wire: inputs is the JWE
        // string; finalize_inputs() moves it into inputs_encrypted (as the socket does).
        let mut activity = MercuryActivity {
            id: "activity-123".to_string(),
            url: None,
            verb: "cardAction".to_string(),
            actor: MercuryActor {
                id: "actor-123".to_string(),
                object_type: "person".to_string(),
                email_address: Some("user@example.com".to_string()),
            },
            object: MercuryObject {
                id: "object-123".to_string(),
                object_type: "submit".to_string(),
                display_name: None,
                content: None,
                encryption_key_url: None,
                inputs: Some(serde_json::Value::String(encrypted_jwe)),
                inputs_encrypted: None,
                files: None,
            },
            target: MercuryTarget {
                id: "target-123".to_string(),
                object_type: "conversation".to_string(),
                encryption_key_url: None,
                tags: vec![],
            },
            published: "2024-01-01T00:00:00Z".to_string(),
            encryption_key_url: Some(KEY_URI.to_string()),
            parent: None,
        };
        activity.object.finalize_inputs();
        assert!(activity.object.inputs_encrypted.is_some());
        assert!(activity.object.inputs.is_none());

        // Drive the REAL decrypt_activity() end-to-end through a seeded KmsClient.
        let mut kms = seeded_kms(KEY_URI, test_key);
        let mut decryptor = MessageDecryptor::new(&mut kms);
        let decrypted = decryptor
            .decrypt_activity(&activity)
            .await
            .expect("decrypt_activity should succeed");

        let inputs = decrypted
            .object
            .inputs
            .expect("inputs should be populated after decryption");
        assert_eq!(inputs["card_action"].as_str(), Some("answer_feedback"));
        assert_eq!(inputs["response_event_id"].as_str(), Some("evt-123"));
        assert_eq!(inputs["verdict"].as_str(), Some("up"));
    }

    #[tokio::test]
    async fn test_decrypt_activity_bad_inputs_ciphertext_warns_not_errors() {
        // A malformed inputs ciphertext must not fail the whole activity: the
        // decryptor warns and leaves inputs unset (handler falls through to empty).
        const KEY_URI: &str = "https://kms.example.com/keys/test-key";
        let test_key = [0x11u8; 32];

        let mut activity = MercuryActivity {
            id: "activity-bad".to_string(),
            url: None,
            verb: "cardAction".to_string(),
            actor: MercuryActor {
                id: "actor-1".to_string(),
                object_type: "person".to_string(),
                email_address: None,
            },
            object: MercuryObject {
                id: "obj-1".to_string(),
                object_type: "submit".to_string(),
                display_name: None,
                content: None,
                encryption_key_url: None,
                inputs: Some(serde_json::Value::String("not-a-valid-jwe".to_string())),
                inputs_encrypted: None,
                files: None,
            },
            target: MercuryTarget {
                id: "room-1".to_string(),
                object_type: "conversation".to_string(),
                encryption_key_url: None,
                tags: vec![],
            },
            published: "2024-01-01T00:00:00Z".to_string(),
            encryption_key_url: Some(KEY_URI.to_string()),
            parent: None,
        };
        activity.object.finalize_inputs();

        let mut kms = seeded_kms(KEY_URI, test_key);
        let mut decryptor = MessageDecryptor::new(&mut kms);
        let decrypted = decryptor
            .decrypt_activity(&activity)
            .await
            .expect("decrypt_activity must not error on bad inputs ciphertext");

        // inputs stays unset on decrypt failure — never the raw ciphertext.
        assert!(decrypted.object.inputs.is_none());
    }

    #[test]
    fn test_finalize_inputs_converts_string_to_encrypted() {
        let encrypted_jwe = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.test.test.test.test";
        let mut obj = MercuryObject {
            id: "test".to_string(),
            object_type: "submit".to_string(),
            inputs: Some(serde_json::Value::String(encrypted_jwe.to_string())),
            inputs_encrypted: None,
            ..Default::default()
        };

        obj.finalize_inputs();

        assert!(obj.inputs_encrypted.is_some());
        assert_eq!(obj.inputs_encrypted.as_ref().unwrap(), encrypted_jwe);
        assert!(obj.inputs.is_none());
    }

    #[test]
    fn test_finalize_inputs_leaves_object_unchanged() {
        let inputs_obj = serde_json::json!({ "key": "value" });
        let mut obj = MercuryObject {
            id: "test".to_string(),
            object_type: "submit".to_string(),
            inputs: Some(inputs_obj.clone()),
            inputs_encrypted: None,
            ..Default::default()
        };

        obj.finalize_inputs();

        // Plain object should remain in inputs.
        assert!(obj.inputs.is_some());
        assert_eq!(obj.inputs.as_ref().unwrap(), &inputs_obj);
        assert!(obj.inputs_encrypted.is_none());
    }
}
