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

@handler.on("message:updated")
async def on_updated(msg):
    print(f"[EDIT] [{msg.person_email}] {msg.text}")

@handler.on("attachmentAction:created")
def on_card(action):
    print(f"Card submitted by {action.person_email}: {action.inputs}")

@handler.on("room:updated")
def on_room_updated(room):
    print(f"Room {room.room_id} updated by {room.actor_id}")

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

## Threading & Message IDs

Mercury uses raw activity UUIDs while the Webex REST API uses base64-encoded IDs. Use the conversion utilities to bridge them:

```python
from webex_message_handler import to_rest_id, from_rest_id

@handler.on("message:created")
async def on_message(msg):
    # Convert Mercury UUID to REST API ID for GET requests
    rest_id = to_rest_id(msg.id, "MESSAGE")

    # Thread replies: msg.parent_id contains the parent activity UUID
    if msg.parent_id:
        # Use msg.parent_id as parentId in POST /v1/messages
        pass
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
| `message:updated` | `DecryptedMessage` | Message was edited and re-decrypted |
| `attachmentAction:created` | `AttachmentAction` | Adaptive Card submitted |
| `room:created` | `RoomActivity` | New room/space created |
| `room:updated` | `RoomActivity` | Room/space updated |
| `membership:created` | `MembershipActivity` | Member added/removed or moderator changed |
| `connected` | — | Connected/reconnected to Mercury |
| `disconnected` | `reason: str` | Disconnected from Mercury |
| `reconnecting` | `attempt: int` | Attempting to reconnect |
| `error` | `Exception` | Error occurred |

### `DecryptedMessage`

```python
@dataclass
class DecryptedMessage:
    id: str
    parent_id: str | None   # Parent activity UUID (threaded replies)
    room_id: str
    person_id: str
    person_email: str
    text: str
    created: str
    html: str | None
    room_type: str | None        # "direct" | "group"
    mentioned_people: list[str]  # Person UUIDs from <spark-mention> tags
    mentioned_groups: list[str]  # e.g. ["all"] from group mentions
    files: list[str]             # File attachment URLs
    raw: MercuryActivity | None
```

### `AttachmentAction`

Emitted when a user submits an Adaptive Card.

```python
@dataclass
class AttachmentAction:
    id: str               # Activity UUID
    message_id: str       # Parent message containing the card
    person_id: str        # Person who submitted
    person_email: str
    room_id: str
    inputs: dict[str, Any]  # Card form data
    created: str
    raw: MercuryActivity
```

### `RoomActivity`

Emitted for room lifecycle events.

```python
@dataclass
class RoomActivity:
    id: str             # Activity UUID
    room_id: str
    actor_id: str       # Person who triggered the event
    action: str         # "create" or "update"
    created: str
    raw: MercuryActivity
```

### `parse_mentions(html)`

Extracts mentions from decrypted HTML. Called automatically during decryption — the results populate `DecryptedMessage.mentioned_people` and `DecryptedMessage.mentioned_groups`. Exported for standalone use.

```python
from webex_message_handler import parse_mentions

result = parse_mentions(msg.html)
# result.mentioned_people: ["uuid-1", "uuid-2"]
# result.mentioned_groups: ["all"]
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
