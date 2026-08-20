# API Reference — webex-message-handler (Rust)

## WebexMessageHandler

The main orchestrator that manages device registration, Mercury WebSocket, KMS encryption, and message decryption.

### Construction

```rust
use webex_message_handler::{WebexMessageHandler, Config};

let handler = WebexMessageHandler::new(Config {
    token: "your-bot-token".to_string(),
    ping_interval: 15.0,        // seconds (default)
    pong_timeout: 14.0,         // seconds (default)
    reconnect_backoff_max: 32.0, // seconds (default)
    max_reconnect_attempts: 10,  // default
    reconnect_stability_seconds: 60.0, // seconds (default)
})?;
```

### Methods

#### `take_event_rx() -> Option<UnboundedReceiver<HandlerEvent>>`

Takes the event receiver channel. Can only be called once. Call before `connect()`.

```rust
let mut rx = handler.take_event_rx().await.unwrap();
```

#### `connect() -> Result<(), WebexError>`

Establishes the full connection pipeline:
1. Registers device with WDM
2. Creates KMS client
3. Connects Mercury WebSocket
4. Performs KMS ECDH handshake
5. Emits `HandlerEvent::Connected`

```rust
handler.connect().await?;
```

#### `disconnect()`

Tears down the connection: closes Mercury WebSocket, unregisters device from WDM.

```rust
handler.disconnect().await;
```

#### `reconnect(new_token: &str) -> Result<(), WebexError>`

Disconnects and reconnects with a new access token. Use when the token has been refreshed externally.

```rust
handler.reconnect("new-token").await?;
```

#### `connected() -> bool`

Returns whether the handler is fully connected (handler connected AND WebSocket open).

```rust
if handler.connected().await {
    println!("Connected");
}
```

#### `status() -> HandlerStatus`

Returns a structured health check of all connection subsystems.

```rust
let status = handler.status().await;
println!("Status: {}", status.status);
```

---

## HandlerEvent

Events emitted via the event channel.

```rust
enum HandlerEvent {
    MessageCreated(DecryptedMessage),
    MessageDeleted(DeletedMessage),
    Connected,
    Disconnected(String),
    Reconnecting(u32),
    Error(String),
}
```

### MessageCreated

Fired when a new message is received and successfully decrypted.

### MessageDeleted

Fired when a message is deleted.

### Connected

Fired on initial connection and on successful reconnection.

### Disconnected(reason)

Fired when disconnected. Reason values:
- `"client"` — manual disconnect
- `"auth-failed"` — Mercury authorization failed (4401)
- `"permanent-failure"` — Mercury permanent failure (4400, 4403)
- `"max-attempts-exceeded"` — reconnection limit reached
- `"reconnect-needed"` — temporary disconnect, reconnection pending

On `"reconnect-needed"`, call `connect()` again. `connect()` does not clear the
reconnect-attempt counter, so repeated short-lived connections still add up and
eventually give you `"max-attempts-exceeded"`. The counter clears once a
connection holds for `reconnect_stability_seconds`.

### Reconnecting(attempt)

Fired when a reconnection attempt begins.

### Error(message)

Fired on errors (WebSocket errors, KMS errors, decryption errors).

---

## Types

### Config

```rust
pub struct Config {
    pub token: String,
    pub ping_interval: f64,         // default: 15.0
    pub pong_timeout: f64,          // default: 14.0
    pub reconnect_backoff_max: f64, // default: 32.0
    pub max_reconnect_attempts: u32, // default: 10
    pub reconnect_stability_seconds: f64, // default: 60.0
}
```

### DecryptedMessage

```rust
pub struct DecryptedMessage {
    pub id: String,
    pub room_id: String,
    pub person_id: String,
    pub person_email: String,
    pub text: String,
    pub html: Option<String>,
    pub created: String,
    pub room_type: Option<String>,  // "direct", "group", or None
    pub raw: MercuryActivity,
}
```

### DeletedMessage

```rust
pub struct DeletedMessage {
    pub message_id: String,
    pub room_id: String,
    pub person_id: String,
}
```

### HandlerStatus

```rust
pub struct HandlerStatus {
    pub status: ConnectionStatus,
    pub web_socket_open: bool,
    pub kms_initialized: bool,
    pub device_registered: bool,
    pub reconnect_attempt: u32,
}
```

### ConnectionStatus

```rust
pub enum ConnectionStatus {
    Connected,
    Connecting,
    Reconnecting,
    Disconnected,
}
```

### MercuryActivity

```rust
pub struct MercuryActivity {
    pub id: String,
    pub verb: String,
    pub actor: MercuryActor,
    pub object: MercuryObject,
    pub target: MercuryTarget,
    pub published: String,
    pub encryption_key_url: Option<String>,
}
```

---

## Errors

All errors are variants of `WebexError`:

| Variant | Code | Description |
|---|---|---|
| `Auth` | `AUTH_ERROR` | Token is invalid or expired |
| `DeviceRegistration` | `DEVICE_REGISTRATION_ERROR` | WDM registration/refresh/unregister failed |
| `MercuryConnection` | `MERCURY_CONNECTION_ERROR` | WebSocket connection to Mercury failed |
| `Kms` | `KMS_ERROR` | KMS key exchange or retrieval failed |
| `Decryption` | `DECRYPTION_ERROR` | Message decryption failed |
| `Internal` | `INTERNAL_ERROR` | Generic internal error |

All methods return `Result<T, WebexError>`.
