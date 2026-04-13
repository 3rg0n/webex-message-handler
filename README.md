# webex-message-handler

Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages — no Webex SDK required.

Available in four languages with identical functionality:

| Language | Directory | Tests |
|----------|-----------|-------|
| Node.js / TypeScript | [`node/`](node/) | 136 passing |
| Python | [`python/`](python/) | 64 passing |
| Go | [`go/`](go/) | 76 passing |
| Rust | [`rust/`](rust/) | 32 passing |

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

## OAuth Integration Tokens

The library accepts any valid Webex access token — bot tokens and OAuth integration tokens work identically. The library does not implement the OAuth authorization flow itself; your application handles token acquisition and refresh. When a token expires, the library emits an `error` event with an `AuthError` and a `disconnected` event with reason `"auth-failed"`, then stops reconnecting. Use `reconnect(newToken)` to resume with a fresh token.

### Node.js

```typescript
const handler = new WebexMessageHandler({ token: currentAccessToken });

handler.on('error', async (err) => {
  if (err.name === 'AuthError') {
    const freshToken = await myOAuthClient.refresh();
    await handler.reconnect(freshToken);
  }
});

await handler.connect();
```

### Python

```python
handler = WebexMessageHandler(token=current_access_token)

@handler.on("error")
async def on_error(err):
    if isinstance(err, AuthError):
        fresh_token = await my_oauth_client.refresh()
        await handler.reconnect(fresh_token)

await handler.connect()
```

### Go

```go
handler, _ := webexmessagehandler.New(webexmessagehandler.Config{
    Token: currentAccessToken,
})
handler.OnError(func(err error) {
    var authErr *webexmessagehandler.AuthError
    if errors.As(err, &authErr) {
        freshToken := myOAuthClient.Refresh()
        handler.Reconnect(ctx, freshToken)
    }
})
handler.Connect(ctx)
```

### Rust

```rust
let handler = WebexMessageHandler::new(Config {
    token: current_access_token,
    ..Default::default()
})?;

let mut rx = handler.take_event_rx().await.unwrap();
handler.connect().await?;

while let Some(event) = rx.recv().await {
    match event {
        WebexEvent::Error(msg) if msg.contains("authorization") => {
            let fresh_token = my_oauth_client.refresh().await?;
            handler.reconnect(&fresh_token).await?;
        }
        WebexEvent::MessageCreated(msg) => { /* ... */ }
        _ => {}
    }
}
```

## Threading & Message IDs

### Mercury vs REST API IDs

Mercury WebSocket events use raw activity UUIDs (e.g. `"abc-123-def"`). The Webex REST API uses base64-encoded URIs (e.g. `"Y2lzY29zcGFyazovL3VzL01FU1N..."`). The library provides conversion utilities in all four languages:

| Function | Description |
|----------|-------------|
| `toRestId(uuid, type)` | Convert Mercury UUID to REST API ID |
| `fromRestId(restId)` | Convert REST API ID back to UUID |

Resource types: `"MESSAGE"`, `"PEOPLE"`, `"ROOM"`.

**Node.js:**
```typescript
import { toRestId, fromRestId } from 'webex-message-handler';

handler.on('message:created', (msg) => {
  const restMessageId = toRestId(msg.id, 'MESSAGE');
  // Use restMessageId with GET /v1/messages/{id}

  const restRoomId = toRestId(msg.roomId, 'ROOM');
  // Use restRoomId with the REST API
});
```

**Python:**
```python
from webex_message_handler import to_rest_id, from_rest_id

@handler.on("message:created")
async def on_message(msg):
    rest_id = to_rest_id(msg.id, "MESSAGE")
    # Use rest_id with GET /v1/messages/{id}
```

**Go:**
```go
restID := webexmessagehandler.ToRestID(msg.ID, "MESSAGE")
uuid, err := webexmessagehandler.FromRestID(restID)
```

**Rust:**
```rust
use webex_message_handler::{to_rest_id, from_rest_id};

let rest_id = to_rest_id(&msg.id, "MESSAGE");
let uuid = from_rest_id(&rest_id).unwrap();
```

### Threaded Replies (parentId)

When a message is a reply in a thread, `DecryptedMessage` includes a `parentId` field containing the parent activity UUID. Use this with the REST API to reply in the same thread or fetch the parent message:

```typescript
handler.on('message:created', async (msg) => {
  if (msg.parentId) {
    // This is a threaded reply — fetch parent or reply in thread
    const parentRestId = toRestId(msg.parentId, 'MESSAGE');
    // GET /v1/messages/{parentRestId} to read the parent
    // POST /v1/messages { parentId: msg.parentId } to reply in thread
  }
});
```

The `parentId` is `undefined`/`None`/empty when the message is not part of a thread.

## Networking & Proxy Support

All implementations support two networking modes:

### Native Mode (Default)

Uses the language's built-in HTTP/WebSocket libraries with optional proxy configuration via agent/connector parameters.

**Node.js:**
```typescript
import { ProxyAgent } from 'undici';

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  agent: new ProxyAgent('http://proxy.example.com:8080'),
});
```

> **Note:** Node.js v18+ uses undici for native `fetch()`. While `https-proxy-agent` may work, undici's `ProxyAgent` is the recommended choice for best compatibility.

**Python:**
```python
import aiohttp

connector = aiohttp.TCPConnector(proxy='http://proxy.example.com:8080')
handler = WebexMessageHandler(token=os.environ["WEBEX_BOT_TOKEN"], connector=connector)
```

**Go:**
```go
proxyURL, _ := url.Parse("http://proxy.example.com:8080")
httpClient := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}

handler, _ := webexmessagehandler.New(webexmessagehandler.Config{
    Token: os.Getenv("WEBEX_BOT_TOKEN"),
    HTTPClient: httpClient,
})
```

**Rust:**
```rust
let client = reqwest::Client::builder()
    .proxy(reqwest::Proxy::all("http://proxy.example.com:8080")?)
    .build()?;

let handler = WebexMessageHandler::new(Config {
    token: std::env::var("WEBEX_BOT_TOKEN")?,
    client: Some(client),
    ..Default::default()
})?;
```

### Injected Mode (v0.3.0+)

Provides complete control over all network operations by injecting custom fetch functions and WebSocket factories. Useful for testing, logging, mocking, or routing through custom networking layers.

**Node.js:**
```typescript
const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  mode: 'injected',
  fetch: async (request) => {
    console.log(`[FETCH] ${request.method} ${request.url}`);
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
    };
  },
  webSocketFactory: (url) => {
    console.log(`[WS] Connecting to ${url}`);
    return new WebSocket(url);
  },
});
```

**With proxy support:**
```typescript
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

const proxyUrl = 'http://proxy.example.com:8080';
const httpProxyAgent = new ProxyAgent(proxyUrl);
const wsProxyAgent = new HttpsProxyAgent(proxyUrl);

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  mode: 'injected',
  fetch: async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      dispatcher: httpProxyAgent, // HTTP requests via proxy
    });
    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
    };
  },
  webSocketFactory: (url) => {
    return new WebSocket(url, { agent: wsProxyAgent }); // WebSocket via proxy
  },
});
```

> **Important:** WebSocket connections require an `agent` option to use a proxy. Simply passing the proxy URL is not sufficient.

See language-specific API docs for Python, Go, and Rust injected mode examples.

## API Reference

Each language has a detailed API reference in its directory:

- [Node.js API](node/API.md)
- [Python API](python/API.md)
- [Go API](go/API.md)
- [Rust API](rust/API.md)

## License

MIT
