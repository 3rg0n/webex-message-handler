//! Data types for webex-message-handler.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Networking mode for the handler.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NetworkMode {
    /// Use built-in HTTP and WebSocket libraries (default).
    #[default]
    Native,
    /// Use provided fetch and WebSocket factory functions.
    Injected,
}

/// HTTP request for injected fetch function.
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
}

/// HTTP response from injected fetch function.
pub struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    pub body: Vec<u8>,
}

/// Custom fetch function for injected mode.
pub type FetchFn = Arc<
    dyn Fn(FetchRequest) -> Pin<Box<dyn Future<Output = Result<FetchResponse, Box<dyn std::error::Error + Send + Sync>>> + Send>>
        + Send
        + Sync,
>;

/// Boxed future result alias to reduce type complexity.
type BoxFutureResult<'a, T> = Pin<Box<dyn Future<Output = Result<T, Box<dyn std::error::Error + Send + Sync>>> + Send + 'a>>;

/// WebSocket interface for injected mode.
pub trait InjectedWebSocket: Send + Sync {
    fn send(&self, data: String) -> BoxFutureResult<'_, ()>;
    fn receive(&self) -> BoxFutureResult<'_, String>;
    fn close(&self) -> BoxFutureResult<'_, ()>;
}

/// WebSocket factory for injected mode.
pub type WebSocketFactory = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<Box<dyn InjectedWebSocket>, Box<dyn std::error::Error + Send + Sync>>> + Send>>
        + Send
        + Sync,
>;

/// Configuration for WebexMessageHandler.
#[derive(Clone)]
pub struct Config {
    /// Webex bot or user access token (required).
    pub token: String,

    /// Networking mode: Native or Injected (default: Native).
    pub mode: NetworkMode,

    /// Optional HTTP client for proxy support (native mode only).
    /// If None, a default client will be created.
    pub client: Option<reqwest::Client>,

    /// Custom fetch function for all HTTP requests (injected mode).
    pub fetch: Option<FetchFn>,

    /// Custom WebSocket factory (injected mode).
    pub web_socket_factory: Option<WebSocketFactory>,

    /// Mercury ping interval in seconds (default: 15).
    pub ping_interval: f64,

    /// Pong response timeout in seconds (default: 14).
    pub pong_timeout: f64,

    /// Max reconnect backoff in seconds (default: 32).
    pub reconnect_backoff_max: f64,

    /// Max consecutive reconnection attempts (default: 10).
    pub max_reconnect_attempts: u32,

    /// Automatically filter out messages sent by this bot to prevent loops (default: true).
    pub ignore_self_messages: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            token: String::new(),
            mode: NetworkMode::Native,
            client: None,
            fetch: None,
            web_socket_factory: None,
            ping_interval: 15.0,
            pong_timeout: 14.0,
            reconnect_backoff_max: 32.0,
            max_reconnect_attempts: 10,
            ignore_self_messages: true,
        }
    }
}

/// Result of WDM device registration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRegistration {
    /// Mercury WebSocket URL.
    #[serde(rename = "webSocketUrl")]
    pub web_socket_url: String,

    /// Device URL (used as clientId for KMS).
    #[serde(rename = "url")]
    pub device_url: String,

    /// Bot's user ID.
    #[serde(rename = "userId")]
    pub user_id: String,

    /// Service catalog from WDM.
    #[serde(default)]
    pub services: HashMap<String, String>,

    /// Encryption service URL extracted from services.
    #[serde(skip)]
    pub encryption_service_url: String,
}

/// Actor in a Mercury activity.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MercuryActor {
    #[serde(default)]
    pub id: String,

    #[serde(rename = "objectType", default)]
    pub object_type: String,

    #[serde(rename = "emailAddress", default)]
    pub email_address: Option<String>,
}

/// Object in a Mercury activity.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MercuryObject {
    #[serde(default)]
    pub id: String,

    #[serde(rename = "objectType", default)]
    pub object_type: String,

    #[serde(rename = "displayName", default)]
    pub display_name: Option<String>,

    #[serde(default)]
    pub content: Option<String>,

    #[serde(rename = "encryptionKeyUrl", default)]
    pub encryption_key_url: Option<String>,
}

/// Target in a Mercury activity.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MercuryTarget {
    #[serde(default)]
    pub id: String,

    #[serde(rename = "objectType", default)]
    pub object_type: String,

    #[serde(rename = "encryptionKeyUrl", default)]
    pub encryption_key_url: Option<String>,

    #[serde(default)]
    pub tags: Vec<String>,
}

/// Parent activity reference for threaded replies.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MercuryParent {
    #[serde(default)]
    pub id: String,

    #[serde(rename = "type", default)]
    pub parent_type: String,
}

/// A Mercury conversation activity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MercuryActivity {
    #[serde(default)]
    pub id: String,

    #[serde(default)]
    pub verb: String,

    #[serde(default)]
    pub actor: MercuryActor,

    #[serde(default)]
    pub object: MercuryObject,

    #[serde(default)]
    pub target: MercuryTarget,

    #[serde(default)]
    pub published: String,

    #[serde(rename = "encryptionKeyUrl", default)]
    pub encryption_key_url: Option<String>,

    #[serde(default)]
    pub parent: Option<MercuryParent>,
}

/// A decrypted Webex message.
#[derive(Debug, Clone)]
pub struct DecryptedMessage {
    /// Mercury activity UUID. Works as parentId for threaded replies.
    pub id: String,

    /// Parent activity UUID for threaded replies. None if not a thread reply.
    pub parent_id: Option<String>,

    /// Conversation/space ID.
    pub room_id: String,

    /// Sender's user ID.
    pub person_id: String,

    /// Sender's email address.
    pub person_email: String,

    /// Decrypted plain text.
    pub text: String,

    /// Decrypted HTML content (rich text messages).
    pub html: Option<String>,

    /// ISO 8601 timestamp.
    pub created: String,

    /// "direct", "group", or None.
    pub room_type: Option<String>,

    /// Full decrypted activity for advanced use.
    pub raw: MercuryActivity,
}

/// A deleted Webex message notification.
#[derive(Debug, Clone)]
pub struct DeletedMessage {
    pub message_id: String,
    pub room_id: String,
    pub person_id: String,
}

/// A membership activity from Mercury.
#[derive(Debug, Clone)]
pub struct MembershipActivity {
    /// Activity ID.
    pub id: String,

    /// ID of the person who performed the action.
    pub actor_id: String,

    /// ID of the member affected.
    pub person_id: String,

    /// Conversation/space ID.
    pub room_id: String,

    /// Membership action: "add", "leave", "assignModerator", or "unassignModerator".
    pub action: String,

    /// ISO 8601 timestamp.
    pub created: String,

    /// "direct", "group", or None.
    pub room_type: Option<String>,

    /// Full raw activity for advanced use.
    pub raw: MercuryActivity,
}

/// Overall connection state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Connected,
    Connecting,
    Reconnecting,
    Disconnected,
}

impl std::fmt::Display for ConnectionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connected => write!(f, "connected"),
            Self::Connecting => write!(f, "connecting"),
            Self::Reconnecting => write!(f, "reconnecting"),
            Self::Disconnected => write!(f, "disconnected"),
        }
    }
}

/// Structured health check of all connection subsystems.
#[derive(Debug, Clone)]
pub struct HandlerStatus {
    /// Overall connection state.
    pub status: ConnectionStatus,

    /// Whether the Mercury WebSocket is currently open.
    pub web_socket_open: bool,

    /// Whether the KMS encryption context has been established.
    pub kms_initialized: bool,

    /// Whether the device is registered with WDM.
    pub device_registered: bool,

    /// Current auto-reconnect attempt number (0 if not reconnecting).
    pub reconnect_attempt: u32,
}
