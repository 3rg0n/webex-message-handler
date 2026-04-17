//! KMS client for ECDH key exchange and encryption key retrieval.
//!
//! Implements the Webex KMS protocol:
//! 1. Fetch KMS cluster details (rsaPublicKey, kmsCluster)
//! 2. ECDH handshake: generate local P-256 keypair, wrap with RSA-OAEP,
//!    send via HTTP, receive response via Mercury, derive shared key
//! 3. Key retrieval: wrap request with ECDH-derived key, send via HTTP,
//!    receive via Mercury, unwrap to get content key
//! 4. Content keys are JWE A256KW + A256GCM

use crate::errors::WebexError;
use crate::jwe;
use crate::types::{FetchFn, FetchRequest};
use crate::url_validation::validate_webex_url;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::PublicKey;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Mutex};
use tracing::{debug, info, warn};
use uuid::Uuid;

const KMS_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PENDING_REQUESTS: usize = 100;
const MAX_KEY_CACHE_SIZE: usize = 100;
const CB_FAILURE_THRESHOLD: u32 = 3;
const CB_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq)]
enum CbState {
    Closed,
    Open,
    HalfOpen,
}

/// A pending KMS request awaiting a Mercury response.
struct PendingRequest {
    tx: oneshot::Sender<String>,
}

/// Handle for resolving KMS responses from Mercury.
///
/// This is separated from KmsClient so the Mercury event loop can resolve
/// pending requests without holding the KmsClient lock (which would deadlock
/// during initialize/get_key).
#[derive(Clone)]
pub struct KmsResponseHandler {
    pending_requests: Arc<Mutex<Vec<(String, PendingRequest)>>>,
}

impl KmsResponseHandler {
    /// Handle a KMS response that arrived via Mercury WebSocket.
    pub async fn handle_kms_message(&self, data: &Value) {
        let kms_messages = data
            .get("kmsMessages")
            .and_then(|v| v.as_array())
            .or_else(|| {
                data.get("encryption")
                    .and_then(|e| e.get("kmsMessages"))
                    .and_then(|v| v.as_array())
            });

        let kms_messages = match kms_messages {
            Some(msgs) => msgs,
            None => {
                debug!("Received KMS message without kmsMessages array");
                return;
            }
        };

        let mut pending = self.pending_requests.lock().await;

        for raw_msg in kms_messages {
            let wrapped = match raw_msg.as_str() {
                Some(s) => s.to_string(),
                None => continue,
            };

            debug!("Received KMS response, pending requests: {}", pending.len());

            // Resolve the first pending request (FIFO)
            if !pending.is_empty() {
                let (_, req) = pending.remove(0);
                let _ = req.tx.send(wrapped);
            } else {
                warn!("Received KMS response but no pending requests");
            }
        }
    }
}

/// KMS client for Webex end-to-end encryption.
pub struct KmsClient {
    token: String,
    device_url: String,
    user_id: String,
    encryption_service_url: String,
    http_do: FetchFn,

    kms_cluster: String,
    /// The 256-bit symmetric key derived from ECDH, used as CEK for dir+A256GCM.
    ephemeral_key: Option<[u8; 32]>,
    /// The kid (key URI) for the ephemeral key, included in JWE headers.
    ephemeral_key_kid: String,
    context_expiration: Option<Instant>,
    /// Cache of content encryption keys (key URI → raw 256-bit key bytes).
    key_cache: HashMap<String, [u8; 32]>,
    initialized: bool,

    /// Pending KMS requests waiting for Mercury responses (FIFO).
    pending_requests: Arc<Mutex<Vec<(String, PendingRequest)>>>,

    /// Circuit breaker state
    cb_state: CbState,
    /// Consecutive failure count
    cb_failures: u32,
    /// Time of last failure
    cb_last_failure: Option<Instant>,
}

impl KmsClient {
    pub fn new(
        http_do: FetchFn,
        token: &str,
        device_url: &str,
        user_id: &str,
        encryption_service_url: &str,
    ) -> Self {
        Self {
            token: token.to_string(),
            device_url: device_url.to_string(),
            user_id: user_id.to_string(),
            encryption_service_url: encryption_service_url.to_string(),
            http_do,
            kms_cluster: String::new(),
            ephemeral_key: None,
            ephemeral_key_kid: String::new(),
            context_expiration: None,
            key_cache: HashMap::new(),
            initialized: false,
            pending_requests: Arc::new(Mutex::new(Vec::new())),
            cb_state: CbState::Closed,
            cb_failures: 0,
            cb_last_failure: None,
        }
    }

    /// Get a KmsResponseHandler that can resolve pending requests from Mercury.
    ///
    /// The returned handler can be used without holding the KmsClient lock,
    /// preventing deadlocks during initialize() and get_key().
    pub fn response_handler(&self) -> KmsResponseHandler {
        KmsResponseHandler {
            pending_requests: self.pending_requests.clone(),
        }
    }

    /// Initialize KMS context with ECDH handshake.
    pub async fn initialize(&mut self) -> Result<(), WebexError> {
        info!("Initializing KMS client");

        // Step 1: Fetch KMS details
        let kms_details_url = format!("{}/kms/{}", self.encryption_service_url, self.user_id);

        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", self.token));

        let response = (self.http_do)(FetchRequest {
            url: kms_details_url,
            method: "GET".to_string(),
            headers,
            body: None,
        })
        .await
        .map_err(|e| WebexError::kms(format!("Failed to fetch KMS details: {e}")))?;

        if !response.ok {
            return Err(WebexError::kms(format!(
                "Failed to fetch KMS details: {}",
                response.status
            )));
        }

        let kms_details: Value = serde_json::from_slice(&response.body)
            .map_err(|e| WebexError::kms(format!("Failed to parse KMS details: {e}")))?;

        self.kms_cluster = kms_details["kmsCluster"]
            .as_str()
            .ok_or_else(|| WebexError::kms("Missing kmsCluster in KMS details"))?
            .to_string();

        // Validate KMS cluster URL — Webex returns kms:// scheme for this field
        validate_webex_url(&self.kms_cluster, "kms")
            .map_err(|e| WebexError::kms(format!("Invalid kmsCluster URL: {e}")))?;

        // Parse RSA public key (may be string or object)
        let rsa_jwk_value = match &kms_details["rsaPublicKey"] {
            Value::String(s) => serde_json::from_str::<Value>(s)
                .map_err(|e| WebexError::kms(format!("Failed to parse RSA public key string: {e}")))?,
            v @ Value::Object(_) => v.clone(),
            _ => return Err(WebexError::kms("Invalid rsaPublicKey format")),
        };

        // Step 2: Generate local ECDH keypair (P-256)
        let local_secret = p256::SecretKey::random(&mut rand::thread_rng());
        let local_public = local_secret.public_key();
        let local_public_point = local_public.to_encoded_point(false);

        let x_bytes = local_public_point.x().ok_or_else(|| WebexError::kms("Missing x coordinate"))?;
        let y_bytes = local_public_point.y().ok_or_else(|| WebexError::kms("Missing y coordinate"))?;

        let public_jwk_map = serde_json::json!({
            "kty": "EC",
            "crv": "P-256",
            "x": URL_SAFE_NO_PAD.encode(*x_bytes),
            "y": URL_SAFE_NO_PAD.encode(*y_bytes),
        });

        // Step 3: Build ECDH request body
        let request_id = Uuid::new_v4().to_string();
        let ecdh_request_body = serde_json::json!({
            "client": {
                "clientId": self.device_url,
                "credential": {
                    "userId": self.user_id,
                    "bearer": self.token,
                },
            },
            "method": "create",
            "uri": format!("{}/ecdhe", self.kms_cluster),
            "requestId": request_id,
            "jwk": public_jwk_map,
        });

        // Step 4: Wrap ECDH request with server RSA public key (JWE RSA-OAEP + A256GCM)
        let wrapped = jwe::encrypt_rsa_oaep_a256gcm(
            ecdh_request_body.to_string().as_bytes(),
            &rsa_jwk_value,
        )?;

        // Step 5: POST ECDH request and wait for Mercury response
        let wrapped_response = self.send_kms_request(&request_id, &wrapped).await?;

        // Step 6: Unwrap ECDH response (may be JWE encrypted with ECDH-ES or JWS signed)
        let response_body = jwe::unwrap_kms_response(
            &wrapped_response,
            &jwe::JweKey::EcdhPrivate(local_secret.clone()),
        )?;
        let response_data: Value = serde_json::from_slice(&response_body)
            .map_err(|e| WebexError::kms(format!("Failed to parse ECDH response: {e}")))?;

        // Step 7: Extract remote key and derive shared secret
        let remote_jwk_data = extract_jwk_from_response(&response_data)
            .ok_or_else(|| WebexError::kms("No key in ECDH response"))?;

        // Validate remote key type before attempting to parse
        let kty = remote_jwk_data.get("kty").and_then(|v| v.as_str()).unwrap_or("");
        let crv = remote_jwk_data.get("crv").and_then(|v| v.as_str()).unwrap_or("");
        if kty != "EC" || crv != "P-256" {
            return Err(WebexError::kms(format!(
                "Invalid remote key type: kty={}, crv={}", kty, crv
            )));
        }

        // Parse remote public key
        let remote_x = remote_jwk_data["x"]
            .as_str()
            .ok_or_else(|| WebexError::kms("Missing x in remote key"))?;
        let remote_y = remote_jwk_data["y"]
            .as_str()
            .ok_or_else(|| WebexError::kms("Missing y in remote key"))?;

        let remote_x_bytes = URL_SAFE_NO_PAD
            .decode(remote_x)
            .map_err(|e| WebexError::kms(format!("Failed to decode remote x: {e}")))?;
        let remote_y_bytes = URL_SAFE_NO_PAD
            .decode(remote_y)
            .map_err(|e| WebexError::kms(format!("Failed to decode remote y: {e}")))?;

        // Build uncompressed point: 0x04 || x || y
        let mut uncompressed = vec![0x04];
        uncompressed.extend_from_slice(&remote_x_bytes);
        uncompressed.extend_from_slice(&remote_y_bytes);

        let remote_public = PublicKey::from_sec1_bytes(&uncompressed)
            .map_err(|e| WebexError::kms(format!("Failed to parse remote public key: {e}")))?;

        // Perform ECDH
        let shared_secret = p256::ecdh::diffie_hellman(
            local_secret.to_nonzero_scalar(),
            remote_public.as_affine(),
        );

        // HKDF to derive 256-bit key
        let hkdf = hkdf::Hkdf::<sha2::Sha256>::new(None, shared_secret.raw_secret_bytes());
        let mut derived = [0u8; 32];
        hkdf.expand(&[], &mut derived)
            .map_err(|e| WebexError::kms(format!("HKDF derivation failed: {e}")))?;

        self.ephemeral_key = Some(derived);
        self.ephemeral_key_kid = extract_key_uri(&response_data).unwrap_or_default();
        self.initialized = true;

        // Set context expiration (default 1 hour)
        self.context_expiration = Some(Instant::now() + Duration::from_secs(3600));

        info!("KMS client initialized successfully");
        Ok(())
    }

    /// Retrieve an encryption key from KMS.
    pub async fn get_key(&mut self, key_uri: &str) -> Result<[u8; 32], WebexError> {
        // Check cache
        if let Some(cached) = self.key_cache.get(key_uri) {
            debug!("Cache hit for key: {key_uri}");
            return Ok(*cached);
        }

        // Check and enforce key cache size limit
        if self.key_cache.len() > MAX_KEY_CACHE_SIZE {
            warn!("Key cache exceeded size limit ({}), clearing cache", MAX_KEY_CACHE_SIZE);
            self.key_cache.clear();
        }

        // Check context expiration
        if self.is_context_expired() {
            info!("Context expired, re-initializing");
            self.initialize().await?;
        }

        // Check circuit breaker state
        if self.cb_state == CbState::Open {
            if self.cb_last_failure.map_or(true, |t| t.elapsed() >= CB_COOLDOWN) {
                self.cb_state = CbState::HalfOpen;
                info!("KMS circuit breaker entering half-open state");
            } else {
                return Err(WebexError::kms("KMS circuit breaker is open — skipping key fetch"));
            }
        }

        const MAX_KMS_ATTEMPTS: u32 = 2;
        for attempt in 1..=MAX_KMS_ATTEMPTS {
            if !self.initialized {
                return Err(WebexError::kms("KMS context not initialized"));
            }

            let ephemeral_key = self
                .ephemeral_key
                .ok_or_else(|| WebexError::kms("No ephemeral key"))?;

            // Build retrieve request
            let request_id = Uuid::new_v4().to_string();
            let retrieve_body = serde_json::json!({
                "client": {
                    "clientId": self.device_url,
                    "credential": {
                        "userId": self.user_id,
                        "bearer": self.token,
                    },
                },
                "method": "retrieve",
                "uri": key_uri,
                "requestId": request_id,
            });

            // Wrap with ephemeral key (dir + A256GCM — key is CEK directly)
            let wrapped = jwe::encrypt_dir_a256gcm(
                retrieve_body.to_string().as_bytes(),
                &ephemeral_key,
                &self.ephemeral_key_kid,
            )?;

            // POST and wait for Mercury response
            match self.send_kms_request(&request_id, &wrapped).await {
                Ok(wrapped_response) => {
                    // Unwrap response with ephemeral key (may be JWE or JWS)
                    let response_body = jwe::unwrap_kms_response(
                        &wrapped_response,
                        &jwe::JweKey::Symmetric(ephemeral_key),
                    )?;
                    let response_data: Value = serde_json::from_slice(&response_body)
                        .map_err(|e| WebexError::kms(format!("Failed to parse key response: {e}")))?;

                    // Extract content key
                    let key_jwk_data = extract_jwk_from_response(&response_data)
                        .ok_or_else(|| WebexError::kms("No key found in KMS response"))?;

                    // Extract the symmetric key bytes from the JWK
                    let k_b64 = key_jwk_data["k"]
                        .as_str()
                        .ok_or_else(|| WebexError::kms("Missing 'k' in content key JWK"))?;
                    let k_bytes = URL_SAFE_NO_PAD
                        .decode(k_b64)
                        .map_err(|e| WebexError::kms(format!("Failed to decode content key: {e}")))?;

                    let content_key: [u8; 32] = k_bytes
                        .try_into()
                        .map_err(|_| WebexError::kms("Content key is not 32 bytes"))?;

                    self.key_cache.insert(key_uri.to_string(), content_key);
                    self.cb_failures = 0;
                    if self.cb_state == CbState::HalfOpen {
                        self.cb_state = CbState::Closed;
                        info!("KMS circuit breaker closed — KMS recovered");
                    }
                    info!("Key retrieved and cached: {key_uri}");
                    return Ok(content_key);
                }
                Err(e) if attempt < MAX_KMS_ATTEMPTS && is_retryable_kms_error(&e) => {
                    warn!("KMS key fetch failed (attempt {}/{}), retrying in 1s: {}", attempt, MAX_KMS_ATTEMPTS, e);
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                Err(e) => {
                    self.cb_failures += 1;
                    self.cb_last_failure = Some(Instant::now());
                    if self.cb_failures >= CB_FAILURE_THRESHOLD {
                        self.cb_state = CbState::Open;
                        warn!("KMS circuit breaker opened after {} consecutive failures", self.cb_failures);
                    }
                    return Err(e);
                }
            }
        }

        Err(WebexError::kms("KMS key fetch failed after all retry attempts"))
    }

    /// Send a KMS request via HTTP and wait for the response via Mercury.
    async fn send_kms_request(
        &self,
        request_id: &str,
        wrapped: &str,
    ) -> Result<String, WebexError> {
        let (tx, rx) = oneshot::channel();

        // Register pending request with bound checking
        {
            let mut pending = self.pending_requests.lock().await;
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(WebexError::kms(format!(
                    "Too many pending KMS requests (max: {})",
                    MAX_PENDING_REQUESTS
                )));
            }
            pending.push((
                request_id.to_string(),
                PendingRequest { tx },
            ));
        }

        // POST the request
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", self.token));
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let body = serde_json::to_string(&serde_json::json!({
            "destination": self.kms_cluster,
            "kmsMessages": [wrapped],
        }))
        .map_err(|e| WebexError::kms(format!("Failed to serialize KMS request: {e}")))?;

        let http_response = (self.http_do)(FetchRequest {
            url: format!("{}/kms/messages", self.encryption_service_url),
            method: "POST".to_string(),
            headers,
            body: Some(body),
        })
        .await;

        match http_response {
            Ok(resp) if !resp.ok => {
                let status = resp.status;
                let body = String::from_utf8_lossy(&resp.body);
                let mut pending = self.pending_requests.lock().await;
                pending.retain(|(id, _)| id != request_id);
                return Err(WebexError::kms(format!(
                    "KMS HTTP request failed: {status} {body}"
                )));
            }
            Err(e) => {
                let mut pending = self.pending_requests.lock().await;
                pending.retain(|(id, _)| id != request_id);
                return Err(WebexError::kms(format!("KMS HTTP request failed: {e}")));
            }
            Ok(resp) => {
                debug!(
                    "KMS request {request_id} sent (HTTP {}), waiting for Mercury response...",
                    resp.status
                );
            }
        }

        // Wait for Mercury response with timeout
        match tokio::time::timeout(KMS_RESPONSE_TIMEOUT, rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err(WebexError::kms(format!(
                "KMS request {request_id} channel closed"
            ))),
            Err(_) => {
                let mut pending = self.pending_requests.lock().await;
                pending.retain(|(id, _)| id != request_id);
                Err(WebexError::kms(format!(
                    "KMS request {request_id} timed out after {}s",
                    KMS_RESPONSE_TIMEOUT.as_secs()
                )))
            }
        }
    }

    fn is_context_expired(&self) -> bool {
        if !self.initialized {
            return true;
        }
        match self.context_expiration {
            Some(exp) => {
                let with_buffer = exp - Duration::from_secs(30);
                Instant::now() > with_buffer
            }
            None => true,
        }
    }

    /// Whether the KMS client has been initialized.
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }
}

/// Check if a KMS error is retryable (transient failure).
fn is_retryable_kms_error(err: &WebexError) -> bool {
    let msg = err.to_string().to_lowercase();
    msg.contains("timed out") || msg.contains("http request failed")
}

/// Extract a JWK from the KMS response JSON.
fn extract_jwk_from_response(data: &Value) -> Option<Value> {
    // Try body.key.jwk
    if let Some(jwk) = data.pointer("/body/key/jwk") {
        if jwk.is_object() {
            return Some(jwk.clone());
        }
    }
    // Try body.key (as direct JWK)
    if let Some(key) = data.pointer("/body/key") {
        if key.is_object() {
            return Some(key.clone());
        }
    }
    // Try key.jwk
    if let Some(jwk) = data.pointer("/key/jwk") {
        if jwk.is_object() {
            return Some(jwk.clone());
        }
    }
    // Try key
    if let Some(key) = data.get("key") {
        if key.is_object() {
            return Some(key.clone());
        }
    }
    None
}

/// Extract the key URI from a KMS response JSON.
fn extract_key_uri(data: &Value) -> Option<String> {
    data.pointer("/body/key/uri")
        .or_else(|| data.pointer("/key/uri"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}
