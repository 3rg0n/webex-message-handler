# webex-message-handler

Lightweight Rust crate for receiving and decrypting Webex messages over the Mercury WebSocket, without the full Webex SDK.

## Features

- **Mercury WebSocket** — connects to Webex Mercury with auth, ping/pong heartbeat, and automatic reconnection with exponential backoff
- **KMS decryption** — ECDH P-256 key exchange + A256KW/A256GCM JWE decryption, all handled transparently
- **WDM device registration** — automatic device lifecycle management
- **Async Tokio** — built on `tokio` and `tokio-tungstenite` for high-performance async I/O
- **Structured logging** — uses the `tracing` ecosystem

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
webex-message-handler = { git = "https://github.com/ecopelan/webex-message-handler-rs" }
```

## Quick Start

```rust
use webex_message_handler::{WebexMessageHandler, Config, HandlerEvent};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let handler = WebexMessageHandler::new(Config {
        token: std::env::var("WEBEX_BOT_TOKEN")?,
        ..Default::default()
    })?;

    let mut rx = handler.take_event_rx().await.unwrap();
    handler.connect().await?;

    while let Some(event) = rx.recv().await {
        match event {
            HandlerEvent::MessageCreated(msg) => {
                println!("[{}] {}", msg.person_email, msg.text);
            }
            HandlerEvent::MessageUpdated(msg) => {
                println!("[EDIT] [{}] {}", msg.person_email, msg.text);
            }
            HandlerEvent::MessageDeleted(del) => {
                println!("Deleted: {}", del.message_id);
            }
            HandlerEvent::AttachmentActionCreated(action) => {
                println!("Card submitted by {}: {:?}", action.person_email, action.inputs);
            }
            HandlerEvent::RoomCreated(room) => {
                println!("Room {} created", room.room_id);
            }
            HandlerEvent::RoomUpdated(room) => {
                println!("Room {} updated", room.room_id);
            }
            HandlerEvent::MembershipCreated(membership) => {
                println!("Membership: {} {}", membership.action, membership.person_id);
            }
            HandlerEvent::Connected => println!("Connected"),
            HandlerEvent::Disconnected(reason) => println!("Disconnected: {reason}"),
            HandlerEvent::Reconnecting(attempt) => println!("Reconnecting ({attempt})..."),
            HandlerEvent::Error(err) => eprintln!("Error: {err}"),
        }
    }

    Ok(())
}
```

## Important: Implementing Loop Detection

This library only handles the **receive side** of messaging — it decrypts incoming messages from the Mercury WebSocket. It has no visibility into messages your bot **sends** via the REST API. This means it cannot detect message loops on its own.

If your bot replies to incoming messages, you **must** implement loop detection in your wrapper code. Without it, a bug or misconfiguration could cause your bot to endlessly reply to its own messages. Webex enforces a server-side rate limit (approximately 11 consecutive messages before throttling), but that still results in spam before the cutoff.

**Recommended approach:** Track your bot's outgoing message rate. If it exceeds a threshold (e.g., 5 messages in 3 seconds to the same room), pause sending and log a warning.

The `ignore_self_messages` option (default: `true`) provides a first line of defense by filtering out messages sent by this bot's own identity. If the library cannot verify the bot's identity during `connect()` (e.g., `/people/me` API failure), connection will fail rather than silently running without protection. Set `ignore_self_messages` to `false` to opt out, but only if you have your own loop prevention in place.

## Proxy Support (Enterprise)

For corporate environments behind a proxy, pass a configured `reqwest::Client`:

```rust
use webex_message_handler::{WebexMessageHandler, Config, HandlerEvent};
use reqwest::Proxy;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Configure proxy client
    let client = if let Ok(proxy_url) = std::env::var("HTTPS_PROXY") {
        reqwest::Client::builder()
            .proxy(Proxy::https(&proxy_url)?)
            .build()?
    } else {
        reqwest::Client::new()
    };

    let handler = WebexMessageHandler::new(Config {
        token: std::env::var("WEBEX_BOT_TOKEN")?,
        client: Some(client), // Pass configured client
        ..Default::default()
    })?;

    // ... rest of code
    Ok(())
}
```

Note: The `reqwest::Client` proxy configuration applies to HTTP traffic (device registration, KMS). The Mercury WebSocket (`tokio-tungstenite`) connects directly and does not read proxy environment variables. For full WebSocket proxy support, use injected mode with a custom `WebSocketFactory`.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `token` | `String` | (required) | Webex bot or user access token |
| `ignore_self_messages` | `bool` | `true` | Filter out messages sent by this bot |
| `client` | `Option<reqwest::Client>` | `None` | HTTP client for proxy support (creates default if None) |
| `ping_interval` | `f64` | `15.0` | Mercury ping interval in seconds |
| `pong_timeout` | `f64` | `14.0` | Pong response timeout in seconds |
| `reconnect_backoff_max` | `f64` | `32.0` | Max reconnect backoff in seconds |
| `max_reconnect_attempts` | `u32` | `10` | Max consecutive reconnection attempts |

## Events and Types

### `HandlerEvent`

```rust
enum HandlerEvent {
    MessageCreated(DecryptedMessage),
    MessageUpdated(DecryptedMessage),
    MessageDeleted(DeletedMessage),
    AttachmentActionCreated(AttachmentAction),
    RoomCreated(RoomActivity),
    RoomUpdated(RoomActivity),
    MembershipCreated(MembershipActivity),
    Connected,
    Disconnected(String),
    Reconnecting(u32),
    Error(String),
}
```

### `DecryptedMessage`

```rust
pub struct DecryptedMessage {
    pub id: String,
    pub parent_id: Option<String>,      // Parent activity UUID (threaded replies)
    pub room_id: String,
    pub person_id: String,
    pub person_email: String,
    pub text: String,
    pub html: Option<String>,
    pub created: String,
    pub room_type: Option<String>,       // "direct" or "group"
    pub mentioned_people: Vec<String>,   // Person UUIDs from <spark-mention> tags
    pub mentioned_groups: Vec<String>,   // e.g. ["all"] from group mentions
    pub files: Vec<String>,              // File attachment URLs
    pub raw: MercuryActivity,
}
```

### `AttachmentAction`

Emitted when a user submits an Adaptive Card.

```rust
pub struct AttachmentAction {
    pub id: String,
    pub message_id: String,              // Parent message containing the card
    pub person_id: String,
    pub person_email: String,
    pub room_id: String,
    pub inputs: Option<serde_json::Value>,  // Card form data
    pub created: String,
    pub raw: MercuryActivity,
}
```

### `RoomActivity`

Emitted for room lifecycle events.

```rust
pub struct RoomActivity {
    pub id: String,
    pub room_id: String,
    pub actor_id: String,    // Person who triggered the event
    pub action: String,      // "create" or "update"
    pub created: String,
    pub raw: MercuryActivity,
}
```

### `parse_mentions`

Extracts mentions from decrypted HTML. Called automatically during decryption — the results populate `DecryptedMessage.mentioned_people` and `DecryptedMessage.mentioned_groups`. Exported for standalone use.

```rust
use webex_message_handler::parse_mentions;

let result = parse_mentions(msg.html.as_deref());
// result.mentioned_people: ["uuid-1", "uuid-2"]
// result.mentioned_groups: ["all"]
```

## Threading & Message IDs

Mercury uses raw activity UUIDs while the Webex REST API uses base64-encoded IDs. Use the conversion utilities to bridge them:

```rust
use webex_message_handler::{to_rest_id, from_rest_id};

// Convert Mercury UUID to REST API ID for GET requests
let rest_id = to_rest_id(&msg.id, "MESSAGE");

// Thread replies: msg.parent_id contains the parent activity UUID
if let Some(parent) = &msg.parent_id {
    // Use parent directly as parentId in POST /v1/messages
}
```

Resource types: `"MESSAGE"`, `"PEOPLE"`, `"ROOM"`.

## Delivery Guarantees

This library provides **at-most-once** delivery semantics:

- Mercury WebSocket acknowledges messages at the protocol level on receipt, before decryption or consumer delivery.
- If decryption fails (e.g., KMS outage) or your callback throws an error, the message is **not redelivered**.
- Mercury does not support application-level ACK/NACK — this is an inherent constraint of the Webex platform.

**For consumers requiring stronger guarantees:**

- Wrap your callback with a persistent queue (e.g., database, Redis, or message broker) to ensure processing completes.
- Use the `error` event to detect and log decryption failures.
- The KMS circuit breaker (v0.6.9+) prevents 30-second stalls during KMS outages by failing fast after 3 consecutive failures.

## API

See [API.md](API.md) for the full API reference.

## Architecture

```
WebexMessageHandler (orchestrator)
  ├── DeviceManager        — WDM register/refresh/unregister
  ├── MercurySocket        — WebSocket + auth + heartbeat + reconnect
  ├── KmsClient            — ECDH handshake + key retrieval
  └── MessageDecryptor     — JWE A256KW+A256GCM decryption
```

## Running the Example

```bash
WEBEX_BOT_TOKEN=your_token_here cargo run --example basic_bot
```

## License

MIT
