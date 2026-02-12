# webex-message-handler

Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages — no Webex SDK required.

Python port of the [TypeScript webex-message-handler](https://github.com/ecopelan/webex-message-handler).

## Why?

- **The Webex Python SDK has heavy dependencies and limited WebSocket support**
- **Bots behind corporate firewalls need persistent connections, not webhooks**
- **This package extracts only the essential Mercury + KMS logic (~2 dependencies)**

## Install

```bash
pip install webex-message-handler
```

## Quick Start

```python
import asyncio
from webex_message_handler import WebexMessageHandler, WebexMessageHandlerConfig, console_logger

handler = WebexMessageHandler(
    WebexMessageHandlerConfig(
        token="YOUR_BOT_TOKEN",
        logger=console_logger,
    )
)

@handler.on("message:created")
async def on_message(msg):
    print(f"[{msg.person_email}] {msg.text}")
    if msg.html:
        print(f"  HTML: {msg.html}")

@handler.on("message:deleted")
def on_deleted(data):
    print(f"Message {data.message_id} deleted by {data.person_id}")

@handler.on("connected")
def on_connected():
    print("Connected to Webex")

@handler.on("disconnected")
def on_disconnected(reason):
    print(f"Disconnected: {reason}")

@handler.on("reconnecting")
def on_reconnecting(attempt):
    print(f"Reconnecting (attempt {attempt})...")

@handler.on("error")
def on_error(err):
    print(f"Error: {err}")

async def main():
    await handler.connect()
    # Keep running until interrupted
    try:
        await asyncio.Event().wait()
    finally:
        await handler.disconnect()

asyncio.run(main())
```

See `examples/basic_bot.py` for a complete working example.

## Important: Implementing Loop Detection

This library only handles the **receive side** of messaging — it decrypts incoming messages from the Mercury WebSocket. It has no visibility into messages your bot **sends** via the REST API. This means it cannot detect message loops on its own.

If your bot replies to incoming messages, you **must** implement loop detection in your wrapper code. Without it, a bug or misconfiguration could cause your bot to endlessly reply to its own messages. Webex enforces a server-side rate limit (approximately 11 consecutive messages before throttling), but that still results in spam before the cutoff.

**Recommended approach:** Track your bot's outgoing message rate. If it exceeds a threshold (e.g., 5 messages in 3 seconds to the same room), pause sending and log a warning.

The `ignore_self_messages` option (default: `True`) provides a first line of defense by filtering out messages sent by this bot's own identity. If the library cannot verify the bot's identity during `connect()` (e.g., `/people/me` API failure), connection will fail rather than silently running without protection. Set `ignore_self_messages=False` to opt out, but only if you have your own loop prevention in place.

## Proxy Support (Enterprise)

For corporate environments behind a proxy, pass a configured connector:

```python
import aiohttp
from aiohttp_socks import ProxyConnector

# Using HTTP/HTTPS proxy
connector = ProxyConnector.from_url(
    "http://proxy.example.com:8080"
)

handler = WebexMessageHandler(
    WebexMessageHandlerConfig(
        token="YOUR_BOT_TOKEN",
        connector=connector,  # Pass configured connector
        logger=console_logger,
    )
)

await handler.connect()
```

Or using environment variables:

```python
import os
import aiohttp
from aiohttp_socks import ProxyConnector

proxy_url = os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")
connector = ProxyConnector.from_url(proxy_url) if proxy_url else None

handler = WebexMessageHandler(
    WebexMessageHandlerConfig(
        token=os.getenv("WEBEX_BOT_TOKEN"),
        connector=connector,
        logger=console_logger,
    )
)
```

Requires: `pip install aiohttp-socks[asyncio]`

## API Reference

### `WebexMessageHandler`

Main class for receiving and decrypting Webex messages.

#### Constructor

```python
WebexMessageHandler(config: WebexMessageHandlerConfig)
```

**Configuration options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `str` | required | Webex bot access token |
| `logger` | `Logger` | noop | Custom logger (`console_logger` provided) |
| `ignore_self_messages` | `bool` | `True` | Filter out messages sent by this bot |
| `connector` | `aiohttp.BaseConnector` | `None` | HTTP/HTTPS connector for proxy support |
| `ping_interval` | `float` | `15.0` | Mercury ping interval (seconds) |
| `pong_timeout` | `float` | `14.0` | Pong response timeout (seconds) |
| `reconnect_backoff_max` | `float` | `32.0` | Max reconnect backoff (seconds) |
| `max_reconnect_attempts` | `int` | `10` | Max reconnect attempts |

#### Methods

- **`await connect()`** — Connects to Webex (registers device, initializes KMS, opens Mercury WebSocket)
- **`await disconnect()`** — Gracefully disconnects (closes WebSocket, unregisters device)
- **`await reconnect(new_token)`** — Update token and re-establish connection
- **`status()`** — Returns `HandlerStatus` health check
- **`connected`** — `bool` property: whether currently connected

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `message:created` | `DecryptedMessage` | New message received and decrypted |
| `message:deleted` | `DeletedMessage` | Message was deleted |
| `connected` | — | Connected/reconnected to Mercury |
| `disconnected` | `reason: str` | Disconnected from Mercury |
| `reconnecting` | `attempt: int` | Attempting to reconnect |
| `error` | `Exception` | Error occurred |

### `DecryptedMessage`

```python
@dataclass
class DecryptedMessage:
    id: str
    room_id: str
    person_id: str
    person_email: str
    text: str
    created: str
    html: str | None
    room_type: str | None   # "direct" | "group"
    raw: MercuryActivity | None
```

## Architecture

```
WebexMessageHandler (orchestrator)
├── DeviceManager  — WDM registration
├── MercurySocket  — WebSocket + ping/pong + reconnect
├── KmsClient      — ECDH handshake + key retrieval
└── MessageDecryptor — JWE decryption
```

## License

MIT
