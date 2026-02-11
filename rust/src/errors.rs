//! Error types for webex-message-handler.

use thiserror::Error;

/// Base error type for all webex-message-handler errors.
#[derive(Error, Debug)]
pub enum WebexError {
    /// Token is invalid, expired, or unauthorized.
    #[error("AUTH_ERROR: {0}")]
    Auth(String),

    /// WDM device registration/refresh/unregister failed.
    #[error("DEVICE_REGISTRATION_ERROR: {message}")]
    DeviceRegistration {
        message: String,
        status_code: Option<u16>,
    },

    /// WebSocket connection to Mercury failed.
    #[error("MERCURY_CONNECTION_ERROR: {message}")]
    MercuryConnection {
        message: String,
        close_code: Option<u16>,
    },

    /// KMS key exchange or key retrieval failed.
    #[error("KMS_ERROR: {0}")]
    Kms(String),

    /// Message decryption failed.
    #[error("DECRYPTION_ERROR: {0}")]
    Decryption(String),

    /// Generic internal error.
    #[error("{0}")]
    Internal(String),
}

impl WebexError {
    pub fn auth(msg: impl Into<String>) -> Self {
        Self::Auth(msg.into())
    }

    pub fn device_registration(msg: impl Into<String>, status_code: Option<u16>) -> Self {
        Self::DeviceRegistration {
            message: msg.into(),
            status_code,
        }
    }

    pub fn mercury_connection(msg: impl Into<String>, close_code: Option<u16>) -> Self {
        Self::MercuryConnection {
            message: msg.into(),
            close_code,
        }
    }

    pub fn kms(msg: impl Into<String>) -> Self {
        Self::Kms(msg.into())
    }

    pub fn decryption(msg: impl Into<String>) -> Self {
        Self::Decryption(msg.into())
    }

    /// Returns the error code string.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Auth(_) => "AUTH_ERROR",
            Self::DeviceRegistration { .. } => "DEVICE_REGISTRATION_ERROR",
            Self::MercuryConnection { .. } => "MERCURY_CONNECTION_ERROR",
            Self::Kms(_) => "KMS_ERROR",
            Self::Decryption(_) => "DECRYPTION_ERROR",
            Self::Internal(_) => "INTERNAL_ERROR",
        }
    }
}

pub type Result<T> = std::result::Result<T, WebexError>;
