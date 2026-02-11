# webex-message-handler

Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages — no Webex SDK required.

Available in four languages with identical functionality:

| Language | Directory | Tests |
|----------|-----------|-------|
| Node.js / TypeScript | [`node/`](node/) | 25 passing |
| Python | [`python/`](python/) | 41 passing |
| Go | [`go/`](go/) | 68 passing |
| Rust | [`rust/`](rust/) | 12 passing |

## Why?

- **The Webex JS SDK has unpatched vulnerabilities and ~300+ transitive dependencies**
- **Bots behind corporate firewalls need Hookbuster or public webhook endpoints**
- **These packages extract only the essential Mercury + KMS logic with minimal dependencies**

## Architecture

All four implementations follow the same architecture:

```
┌─────────────────────────────────────────────────┐
│         WebexMessageHandler                     │
│  (Main event emitter & lifecycle manager)       │
└────────────────┬────────────────────────────────┘
                 │
    ┌────────────┼────────────┬────────────────┐
    │            │            │                │
    v            v            v                v
┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐
│ Device   │ │ Mercury │ │ KMS      │ │ Message      │
│ Manager  │ │ Socket  │ │ Client   │ │ Decryptor    │
│          │ │         │ │          │ │              │
│ WDM      │ │ WS      │ │ ECDH     │ │ JWE          │
│ register │ │ ping/   │ │ key      │ │ A256KW/dir   │
│ refresh  │ │ pong    │ │ fetch    │ │ A256GCM      │
└──────────┘ └─────────┘ └──────────┘ └──────────────┘
```

### Data Flow

1. **Device Registration** — Registers a device via the WDM API
2. **Mercury Connection** — Opens a WebSocket to Mercury with token auth and heartbeat pings
3. **Encrypted Activity** — Mercury delivers encrypted activity objects for new messages
4. **Key Retrieval** — Fetches decryption key from KMS via ECDH-encrypted channel
5. **Decryption & Emission** — Decrypts message (JWE A256GCM) and emits event

## Quick Start

Each language directory has its own README with install instructions and usage examples. Here's a taste of each:

### Node.js / TypeScript

```typescript
import { WebexMessageHandler } from 'webex-message-handler';

const handler = new WebexMessageHandler({ token: process.env.WEBEX_BOT_TOKEN! });
handler.on('message:created', (msg) => console.log(`[${msg.personEmail}] ${msg.text}`));
await handler.connect();
```

### Python

```python
from webex_message_handler import WebexMessageHandler

handler = WebexMessageHandler(token=os.environ["WEBEX_BOT_TOKEN"])

@handler.on("message:created")
async def on_message(msg):
    print(f"[{msg.person_email}] {msg.text}")

await handler.connect()
```

### Go

```go
handler, _ := webexmessagehandler.New(webexmessagehandler.Config{
    Token: os.Getenv("WEBEX_BOT_TOKEN"),
})
handler.OnMessageCreated(func(msg webexmessagehandler.DecryptedMessage) {
    fmt.Printf("[%s] %s\n", msg.PersonEmail, msg.Text)
})
handler.Connect(ctx)
```

### Rust

```rust
let handler = WebexMessageHandler::new(Config {
    token: std::env::var("WEBEX_BOT_TOKEN")?,
    ..Default::default()
})?;

// Events arrive via tokio mpsc channel
let mut rx = handler.take_event_rx().await.unwrap();
handler.connect().await?;

while let Some(event) = rx.recv().await {
    match event {
        WebexEvent::MessageCreated(msg) => {
            println!("[{}] {}", msg.person_email, msg.text);
        }
        _ => {}
    }
}
```

## API Reference

Each language has a detailed API reference in its directory:

- [Node.js API](node/API.md)
- [Python API](python/API.md)
- [Go API](go/API.md)
- [Rust API](rust/API.md)

## License

MIT
