//! Pure-Rust JWE compact serialization (RFC 7516) for the algorithms used by Webex KMS.
#![allow(deprecated)] // aes-gcm Nonce::from_slice uses deprecated generic-array API
//!
//! Supported algorithms:
//! - RSA-OAEP + A256GCM  (encrypt only — initial ECDH handshake)
//! - A256KW + A256GCM     (encrypt + decrypt — key retrieval, message decryption)
//! - ECDH-ES + A256GCM    (decrypt only — ECDH handshake response)
//! - ECDH-ES+A256KW + A256GCM (decrypt only — ECDH handshake response variant)

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use aes_kw::Kek;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::PublicKey;
use rand::RngCore;
use rsa::{Oaep, RsaPublicKey};
use serde_json::Value;
use sha1::Sha1;

use crate::errors::WebexError;

/// Encrypt plaintext using RSA-OAEP + A256GCM and return JWE compact serialization.
pub fn encrypt_rsa_oaep_a256gcm(
    plaintext: &[u8],
    rsa_jwk: &Value,
) -> Result<String, WebexError> {
    // Parse RSA public key from JWK
    let rsa_key = parse_rsa_public_key(rsa_jwk)?;

    // Generate random CEK (32 bytes for A256GCM)
    let mut cek = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut cek);

    // Generate random IV (12 bytes)
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);

    // Build protected header (include kid if present so KMS can identify the decryption key)
    let mut header = serde_json::json!({"alg": "RSA-OAEP", "enc": "A256GCM"});
    if let Some(kid) = rsa_jwk.get("kid").and_then(|v| v.as_str()) {
        header["kid"] = Value::String(kid.to_string());
    }
    let header_b64 = URL_SAFE_NO_PAD.encode(header.to_string().as_bytes());

    // Encrypt CEK with RSA-OAEP (SHA-1 per RFC 7518 "RSA-OAEP")
    let padding = Oaep::new::<Sha1>();
    let encrypted_key = rsa_key
        .encrypt(&mut rand::thread_rng(), padding, &cek)
        .map_err(|e| WebexError::kms(format!("RSA-OAEP encryption failed: {e}")))?;

    // Encrypt plaintext with A256GCM
    let cipher = Aes256Gcm::new_from_slice(&cek)
        .map_err(|e| WebexError::kms(format!("AES-GCM key init failed: {e}")))?;
    let nonce = Nonce::from_slice(&iv);
    let aad = header_b64.as_bytes();
    let ciphertext_with_tag = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|e| WebexError::kms(format!("AES-GCM encryption failed: {e}")))?;

    // Split ciphertext and tag (last 16 bytes are the tag)
    let (ciphertext, tag) = ciphertext_with_tag.split_at(ciphertext_with_tag.len() - 16);

    // JWE compact: header.encrypted_key.iv.ciphertext.tag
    Ok(format!(
        "{}.{}.{}.{}.{}",
        header_b64,
        URL_SAFE_NO_PAD.encode(&encrypted_key),
        URL_SAFE_NO_PAD.encode(iv),
        URL_SAFE_NO_PAD.encode(ciphertext),
        URL_SAFE_NO_PAD.encode(tag),
    ))
}

/// Encrypt plaintext using dir + A256GCM (direct encryption — key is CEK).
pub fn encrypt_dir_a256gcm(
    plaintext: &[u8],
    cek: &[u8; 32],
    kid: &str,
) -> Result<String, WebexError> {
    // Generate random IV (12 bytes)
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);

    // Build protected header
    let mut header = serde_json::json!({"alg": "dir", "enc": "A256GCM"});
    if !kid.is_empty() {
        header["kid"] = Value::String(kid.to_string());
    }
    let header_b64 = URL_SAFE_NO_PAD.encode(header.to_string().as_bytes());

    // Encrypt plaintext with A256GCM using the key directly as CEK
    let cipher = Aes256Gcm::new_from_slice(cek)
        .map_err(|e| WebexError::kms(format!("AES-GCM key init failed: {e}")))?;
    let nonce = Nonce::from_slice(&iv);
    let aad = header_b64.as_bytes();
    let ciphertext_with_tag = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|e| WebexError::kms(format!("AES-GCM encryption failed: {e}")))?;

    let (ciphertext, tag) = ciphertext_with_tag.split_at(ciphertext_with_tag.len() - 16);

    // JWE compact with dir: header . "" . iv . ciphertext . tag (empty encrypted key)
    Ok(format!(
        "{}.{}.{}.{}.{}",
        header_b64,
        "",  // empty encrypted key for dir
        URL_SAFE_NO_PAD.encode(iv),
        URL_SAFE_NO_PAD.encode(ciphertext),
        URL_SAFE_NO_PAD.encode(tag),
    ))
}

/// Encrypt plaintext using A256KW + A256GCM and return JWE compact serialization.
pub fn encrypt_a256kw_a256gcm(
    plaintext: &[u8],
    wrapping_key: &[u8; 32],
) -> Result<String, WebexError> {
    // Generate random CEK (32 bytes)
    let mut cek = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut cek);

    // Generate random IV (12 bytes)
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);

    // Build protected header
    let header = serde_json::json!({"alg": "A256KW", "enc": "A256GCM"});
    let header_b64 = URL_SAFE_NO_PAD.encode(header.to_string().as_bytes());

    // AES Key Wrap the CEK
    let kek = Kek::from(*wrapping_key);
    let mut wrapped_key = vec![0u8; cek.len() + 8]; // wrapped key is 8 bytes longer
    kek.wrap(&cek, &mut wrapped_key)
        .map_err(|e| WebexError::kms(format!("AES key wrap failed: {e}")))?;

    // Encrypt plaintext with A256GCM
    let cipher = Aes256Gcm::new_from_slice(&cek)
        .map_err(|e| WebexError::kms(format!("AES-GCM key init failed: {e}")))?;
    let nonce = Nonce::from_slice(&iv);
    let aad = header_b64.as_bytes();
    let ciphertext_with_tag = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|e| WebexError::kms(format!("AES-GCM encryption failed: {e}")))?;

    let (ciphertext, tag) = ciphertext_with_tag.split_at(ciphertext_with_tag.len() - 16);

    Ok(format!(
        "{}.{}.{}.{}.{}",
        header_b64,
        URL_SAFE_NO_PAD.encode(&wrapped_key),
        URL_SAFE_NO_PAD.encode(iv),
        URL_SAFE_NO_PAD.encode(ciphertext),
        URL_SAFE_NO_PAD.encode(tag),
    ))
}

/// Decrypt a JWE compact serialization token using A256KW + A256GCM.
pub fn decrypt_a256kw_a256gcm(
    token: &str,
    wrapping_key: &[u8; 32],
) -> Result<Vec<u8>, WebexError> {
    let parts = parse_jwe_compact(token)?;

    // AES Key Unwrap to get CEK
    let kek = Kek::from(*wrapping_key);
    let mut cek = vec![0u8; parts.encrypted_key.len() - 8];
    kek.unwrap(&parts.encrypted_key, &mut cek)
        .map_err(|e| WebexError::kms(format!("AES key unwrap failed: {e}")))?;

    // Decrypt with A256GCM
    decrypt_a256gcm(&cek, &parts.iv, &parts.ciphertext, &parts.tag, &parts.header_b64)
}

/// Decrypt a JWE compact serialization token using dir + A256GCM (direct key).
pub fn decrypt_dir_a256gcm(
    token: &str,
    cek: &[u8; 32],
) -> Result<Vec<u8>, WebexError> {
    let parts = parse_jwe_compact(token)?;

    // With "dir", the encrypted_key part should be empty — the provided key IS the CEK
    decrypt_a256gcm(cek, &parts.iv, &parts.ciphertext, &parts.tag, &parts.header_b64)
}

/// Decrypt a JWE message, auto-detecting "dir" vs "A256KW" from the header.
pub fn decrypt_message_jwe(
    token: &str,
    key: &[u8; 32],
) -> Result<Vec<u8>, WebexError> {
    let parts = parse_jwe_compact(token)?;

    // Parse the header to detect algorithm
    let header_json: Value = serde_json::from_slice(&parts.header_bytes)
        .map_err(|e| WebexError::kms(format!("Failed to parse JWE header: {e}")))?;
    let alg = header_json
        .get("alg")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match alg {
        "dir" => {
            // Direct: key IS the CEK
            decrypt_a256gcm(key, &parts.iv, &parts.ciphertext, &parts.tag, &parts.header_b64)
        }
        "A256KW" => {
            // Key wrapping: unwrap CEK first
            let kek = Kek::from(*key);
            let mut cek = vec![0u8; parts.encrypted_key.len() - 8];
            kek.unwrap(&parts.encrypted_key, &mut cek)
                .map_err(|e| WebexError::kms(format!("AES key unwrap failed: {e}")))?;
            decrypt_a256gcm(&cek, &parts.iv, &parts.ciphertext, &parts.tag, &parts.header_b64)
        }
        _ => Err(WebexError::kms(format!(
            "Unsupported message JWE algorithm: {alg}"
        ))),
    }
}

/// Decrypt a JWE compact serialization token encrypted with ECDH-ES (or ECDH-ES+A256KW).
///
/// The JWE header contains `epk` (the server's ephemeral public key).
/// We use our local private key + the server's epk to derive the decryption key.
pub fn decrypt_ecdh_es(
    token: &str,
    local_private_key: &p256::SecretKey,
) -> Result<Vec<u8>, WebexError> {
    let parts = parse_jwe_compact(token)?;

    // Parse the protected header to get the algorithm and epk
    let header_json: Value = serde_json::from_slice(&parts.header_bytes)
        .map_err(|e| WebexError::kms(format!("Failed to parse JWE header: {e}")))?;

    let alg = header_json
        .get("alg")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let enc = header_json
        .get("enc")
        .and_then(|v| v.as_str())
        .unwrap_or("A256GCM");

    // Extract the server's ephemeral public key from the header
    let epk = header_json
        .get("epk")
        .ok_or_else(|| WebexError::kms("No epk in ECDH-ES JWE header"))?;

    let server_public = parse_ec_public_key(epk)?;

    // Perform ECDH
    let shared_secret = p256::ecdh::diffie_hellman(
        local_private_key.to_nonzero_scalar(),
        server_public.as_affine(),
    );

    // Extract apu and apv from header (optional)
    let apu = header_json
        .get("apu")
        .and_then(|v| v.as_str())
        .map(|s| URL_SAFE_NO_PAD.decode(s).unwrap_or_default())
        .unwrap_or_default();
    let apv = header_json
        .get("apv")
        .and_then(|v| v.as_str())
        .map(|s| URL_SAFE_NO_PAD.decode(s).unwrap_or_default())
        .unwrap_or_default();

    match alg {
        "ECDH-ES" => {
            // Direct key agreement — derive CEK directly
            let key_len = enc_key_length(enc);
            let cek = concat_kdf(
                shared_secret.raw_secret_bytes(),
                enc, // for direct, algorithm ID is the enc algorithm
                &apu,
                &apv,
                (key_len * 8) as u32,
            )?;

            decrypt_a256gcm(&cek, &parts.iv, &parts.ciphertext, &parts.tag, &parts.header_b64)
        }
        "ECDH-ES+A256KW" => {
            // Key agreement with key wrapping — derive KEK, then unwrap CEK
            let kek_bytes = concat_kdf(
                shared_secret.raw_secret_bytes(),
                "A256KW",
                &apu,
                &apv,
                256,
            )?;

            let kek_arr: [u8; 32] = kek_bytes
                .try_into()
                .map_err(|_| WebexError::kms("Derived KEK is not 32 bytes"))?;
            let kek = Kek::from(kek_arr);

            let mut cek = vec![0u8; parts.encrypted_key.len() - 8];
            kek.unwrap(&parts.encrypted_key, &mut cek)
                .map_err(|e| WebexError::kms(format!("ECDH-ES+A256KW unwrap failed: {e}")))?;

            decrypt_a256gcm(&cek, &parts.iv, &parts.ciphertext, &parts.tag, &parts.header_b64)
        }
        _ => Err(WebexError::kms(format!("Unsupported ECDH algorithm: {alg}"))),
    }
}

/// Generic JWE decryption that auto-detects the algorithm from the header.
pub fn decrypt_jwe(token: &str, key: &JweKey) -> Result<Vec<u8>, WebexError> {
    match key {
        JweKey::Symmetric(k) => decrypt_message_jwe(token, k),
        JweKey::EcdhPrivate(k) => decrypt_ecdh_es(token, k),
    }
}

/// Unwrap a KMS response — may be JWE (encrypted, 5 parts) or JWS (signed, 3 parts).
/// For JWS, the payload is extracted directly (arrives over authenticated Mercury channel).
pub fn unwrap_kms_response(token: &str, key: &JweKey) -> Result<Vec<u8>, WebexError> {
    let dot_count = token.chars().filter(|&c| c == '.').count();
    match dot_count {
        4 => decrypt_jwe(token, key),
        2 => {
            // JWS compact: header.payload.signature — extract payload
            let parts: Vec<&str> = token.split('.').collect();
            URL_SAFE_NO_PAD
                .decode(parts[1])
                .map_err(|e| WebexError::kms(format!("Failed to decode JWS payload: {e}")))
        }
        _ => Err(WebexError::kms(format!(
            "Invalid KMS response format: expected 3 or 5 parts, got {} dots",
            dot_count
        ))),
    }
}

/// Key types for JWE decryption.
pub enum JweKey {
    /// A 256-bit symmetric key for A256KW.
    Symmetric([u8; 32]),
    /// An ECDH P-256 private key for ECDH-ES.
    EcdhPrivate(p256::SecretKey),
}

// ──────────────────────────── Internal helpers ────────────────────────────

struct JweParts {
    header_b64: String,
    header_bytes: Vec<u8>,
    encrypted_key: Vec<u8>,
    iv: Vec<u8>,
    ciphertext: Vec<u8>,
    tag: Vec<u8>,
}

fn parse_jwe_compact(token: &str) -> Result<JweParts, WebexError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 5 {
        return Err(WebexError::kms(format!(
            "Invalid JWE compact: expected 5 parts, got {}",
            parts.len()
        )));
    }

    let header_b64 = parts[0].to_string();
    let header_bytes = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|e| WebexError::kms(format!("Failed to decode JWE header: {e}")))?;
    let encrypted_key = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|e| WebexError::kms(format!("Failed to decode encrypted key: {e}")))?;
    let iv = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|e| WebexError::kms(format!("Failed to decode IV: {e}")))?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(parts[3])
        .map_err(|e| WebexError::kms(format!("Failed to decode ciphertext: {e}")))?;
    let tag = URL_SAFE_NO_PAD
        .decode(parts[4])
        .map_err(|e| WebexError::kms(format!("Failed to decode tag: {e}")))?;

    Ok(JweParts {
        header_b64,
        header_bytes,
        encrypted_key,
        iv,
        ciphertext,
        tag,
    })
}

fn decrypt_a256gcm(
    cek: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
    tag: &[u8],
    aad: &str,
) -> Result<Vec<u8>, WebexError> {
    let cipher = Aes256Gcm::new_from_slice(cek)
        .map_err(|e| WebexError::kms(format!("AES-GCM key init failed: {e}")))?;

    let nonce = Nonce::from_slice(iv);

    // Combine ciphertext and tag for aes-gcm
    let mut ct_with_tag = ciphertext.to_vec();
    ct_with_tag.extend_from_slice(tag);

    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &ct_with_tag,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| WebexError::kms(format!("AES-GCM decryption failed: {e}")))?;

    Ok(plaintext)
}

/// Concat KDF (NIST SP 800-56A, used by JWE ECDH-ES per RFC 7518 §4.6.2).
fn concat_kdf(
    shared_secret: &[u8],
    algorithm_id: &str,
    apu: &[u8],
    apv: &[u8],
    key_data_len_bits: u32,
) -> Result<Vec<u8>, WebexError> {
    use sha2::{Digest, Sha256};

    let key_data_len = (key_data_len_bits / 8) as usize;
    let reps = key_data_len.div_ceil(32); // ceil(keyDataLen / hashLen)

    let mut derived = Vec::with_capacity(key_data_len);

    for counter in 1..=reps as u32 {
        let mut hasher = Sha256::new();
        hasher.update(counter.to_be_bytes());
        hasher.update(shared_secret);

        // OtherInfo = AlgorithmID || PartyUInfo || PartyVInfo || SuppPubInfo
        // AlgorithmID: length(4 bytes) || value
        hasher.update((algorithm_id.len() as u32).to_be_bytes());
        hasher.update(algorithm_id.as_bytes());

        // PartyUInfo: length(4 bytes) || value
        hasher.update((apu.len() as u32).to_be_bytes());
        hasher.update(apu);

        // PartyVInfo: length(4 bytes) || value
        hasher.update((apv.len() as u32).to_be_bytes());
        hasher.update(apv);

        // SuppPubInfo: key length in bits (4 bytes big-endian)
        hasher.update(key_data_len_bits.to_be_bytes());

        derived.extend_from_slice(&hasher.finalize());
    }

    derived.truncate(key_data_len);
    Ok(derived)
}

fn enc_key_length(enc: &str) -> usize {
    match enc {
        "A128GCM" => 16,
        "A192GCM" => 24,
        "A256GCM" => 32,
        "A128CBC-HS256" => 32,
        "A256CBC-HS512" => 64,
        _ => 32, // default to 256-bit
    }
}

fn parse_rsa_public_key(jwk: &Value) -> Result<RsaPublicKey, WebexError> {
    let n = jwk
        .get("n")
        .and_then(|v| v.as_str())
        .ok_or_else(|| WebexError::kms("Missing 'n' in RSA JWK"))?;
    let e = jwk
        .get("e")
        .and_then(|v| v.as_str())
        .ok_or_else(|| WebexError::kms("Missing 'e' in RSA JWK"))?;

    let n_bytes = URL_SAFE_NO_PAD
        .decode(n)
        .map_err(|e| WebexError::kms(format!("Failed to decode RSA n: {e}")))?;
    let e_bytes = URL_SAFE_NO_PAD
        .decode(e)
        .map_err(|e| WebexError::kms(format!("Failed to decode RSA e: {e}")))?;

    let n_uint = rsa::BigUint::from_bytes_be(&n_bytes);
    let e_uint = rsa::BigUint::from_bytes_be(&e_bytes);

    RsaPublicKey::new(n_uint, e_uint)
        .map_err(|e| WebexError::kms(format!("Invalid RSA public key: {e}")))
}

fn parse_ec_public_key(jwk: &Value) -> Result<PublicKey, WebexError> {
    let x = jwk
        .get("x")
        .and_then(|v| v.as_str())
        .ok_or_else(|| WebexError::kms("Missing 'x' in EC JWK"))?;
    let y = jwk
        .get("y")
        .and_then(|v| v.as_str())
        .ok_or_else(|| WebexError::kms("Missing 'y' in EC JWK"))?;

    let x_bytes = URL_SAFE_NO_PAD
        .decode(x)
        .map_err(|e| WebexError::kms(format!("Failed to decode EC x: {e}")))?;
    let y_bytes = URL_SAFE_NO_PAD
        .decode(y)
        .map_err(|e| WebexError::kms(format!("Failed to decode EC y: {e}")))?;

    // Build uncompressed point: 0x04 || x || y
    let mut uncompressed = vec![0x04];
    uncompressed.extend_from_slice(&x_bytes);
    uncompressed.extend_from_slice(&y_bytes);

    PublicKey::from_sec1_bytes(&uncompressed)
        .map_err(|e| WebexError::kms(format!("Invalid EC public key: {e}")))
}
