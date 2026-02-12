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
            HandlerEvent::MessageDeleted(del) => {
                println!("Deleted: {}", del.message_id);
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

Note: The `reqwest::Client` proxy applies to HTTP traffic (device registration, KMS). WebSocket (Mercury) connections via `tokio-tungstenite` connect directly and do not route through the proxy. For full WebSocket proxy support, use injected mode with a custom `WebSocketFactory`.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `token` | `String` | (required) | Webex bot or user access token |
| `client` | `Option<reqwest::Client>` | `None` | HTTP client for proxy support (creates default if None) |
| `ping_interval` | `f64` | `15.0` | Mercury ping interval in seconds |
| `pong_timeout` | `f64` | `14.0` | Pong response timeout in seconds |
| `reconnect_backoff_max` | `f64` | `32.0` | Max reconnect backoff in seconds |
| `max_reconnect_attempts` | `u32` | `10` | Max consecutive reconnection attempts |

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
