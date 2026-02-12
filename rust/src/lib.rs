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
pub mod jwe;
pub mod kms_client;
pub mod mercury_socket;
pub mod message_decryptor;
pub mod types;

// Re-export primary public API
pub use errors::WebexError;
pub use handler::{HandlerEvent, WebexMessageHandler};
pub use types::{
    Config, ConnectionStatus, DecryptedMessage, DeletedMessage, DeviceRegistration, FetchFn,
    FetchRequest, FetchResponse, HandlerStatus, InjectedWebSocket, MembershipActivity,
    MercuryActivity, MercuryActor, MercuryObject, MercuryTarget, NetworkMode, WebSocketFactory,
};
