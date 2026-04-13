//! Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages.
//!
//! This crate provides a minimal, standalone way to receive and decrypt Webex
//! messages over the Mercury WebSocket, without the full Webex SDK.
//!
//! # Example
//!
//! ```rust,no_run
//! use webex_message_handler::{WebexMessageHandler, Config, HandlerEvent};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let handler = WebexMessageHandler::new(Config {
//!         token: std::env::var("WEBEX_BOT_TOKEN")?,
//!         ..Default::default()
//!     })?;
//!
//!     let mut rx = handler.take_event_rx().await.unwrap();
//!
//!     handler.connect().await?;
//!
//!     while let Some(event) = rx.recv().await {
//!         match event {
//!             HandlerEvent::MessageCreated(msg) => {
//!                 println!("[{}] {}", msg.person_email, msg.text);
//!             }
//!             _ => {}
//!         }
//!     }
//!
//!     Ok(())
//! }
//! ```

pub mod device_manager;
pub mod errors;
pub mod handler;
pub mod id_utils;
pub mod jwe;
pub mod kms_client;
pub mod mention_parser;
pub mod mercury_socket;
pub mod message_decryptor;
pub mod types;
pub mod url_validation;

// Re-export primary public API
pub use errors::WebexError;
pub use handler::{HandlerEvent, WebexMessageHandler};
pub use id_utils::{to_rest_id, from_rest_id};
pub use mention_parser::{parse_mentions, ParsedMentions};
pub use types::{
    AttachmentAction, Config, ConnectionStatus, DecryptedMessage, DeletedMessage,
    DeviceRegistration, FetchFn, FetchRequest, FetchResponse, HandlerStatus, InjectedWebSocket,
    MembershipActivity, MercuryActivity, MercuryActor, MercuryObject, MercuryParent,
    MercuryTarget, NetworkMode, RoomActivity, WebSocketFactory,
};
