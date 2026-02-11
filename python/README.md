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
