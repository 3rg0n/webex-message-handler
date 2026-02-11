# webex-message-handler API Reference

Lightweight, standalone package for receiving and decrypting Webex messages over a persistent WebSocket. No full Webex SDK required — just provide a bot token.

## Installation

```bash
pip install webex-message-handler
```

## Quick Start

```python
import asyncio
from webex_message_handler import WebexMessageHandler, WebexMessageHandlerConfig, console_logger

handler = WebexMessageHandler(
    WebexMessageHandlerConfig(token="YOUR_BOT_TOKEN", logger=console_logger)
)

@handler.on("message:created")
async def on_message(msg):
    print(f"[{msg.person_email}] {msg.text}")

handler.on("error", lambda err: print(f"Error: {err}"))

async def main():
    await handler.connect()

asyncio.run(main())
```

---

## Public API Surface

| Method | Purpose |
|---|---|
| `await connect()` | Start the connection (device registration, WebSocket, KMS handshake). |
| `await disconnect()` | Tear down the connection cleanly. |
| `await reconnect(new_token)` | Update the token and re-establish everything from scratch. |
| `status()` | Health check — returns structured connection state of all subsystems. |
| `connected` | Quick boolean: is the handler connected and WebSocket open? |
| `on(event, callback)` | Subscribe to events. Can also be used as `@handler.on(event)` decorator. |
| `off(event, callback)` | Unsubscribe from events. |

---

## WebexMessageHandler

### Constructor

```python
WebexMessageHandler(config: WebexMessageHandlerConfig)
```

**`WebexMessageHandlerConfig` fields:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `token` | `str` | Yes | — | Webex bot or user access token. |
| `logger` | `Logger` | No | silent | Logger implementation (`console_logger` provided). |
| `ping_interval` | `float` | No | `15.0` | WebSocket heartbeat ping interval in seconds. |
| `pong_timeout` | `float` | No | `14.0` | How long to wait for pong before triggering reconnect. |
| `reconnect_backoff_max` | `float` | No | `32.0` | Max backoff delay between reconnection attempts. |
| `max_reconnect_attempts` | `int` | No | `10` | Max consecutive reconnection attempts before giving up. |

### Methods

#### `await connect()`

Establishes the full connection pipeline:

1. Registers a virtual device with Webex WDM (Web Device Management)
2. Opens a Mercury WebSocket and authenticates
3. Performs KMS ECDH key exchange (for end-to-end message encryption)
4. Begins listening for encrypted messages, decrypting them automatically

```python
await handler.connect()
```

#### `await disconnect()`

Tears down the connection cleanly:

1. Closes the Mercury WebSocket (stops heartbeat, cancels auto-reconnection)
2. Unregisters the virtual device with WDM
3. Clears KMS context and decryption keys from memory

```python
await handler.disconnect()
```

#### `await reconnect(new_token: str)`

Updates the access token and re-establishes the connection from scratch.

```python
fresh_token = await my_auth_system.refresh_token()
await handler.reconnect(fresh_token)
```

#### `status() -> HandlerStatus`

Returns a structured health check of all connection subsystems.

```python
health = handler.status()
```

**`HandlerStatus` fields:**

| Field | Type | Description |
|---|---|---|
| `status` | `ConnectionStatus` | `'connected'`, `'connecting'`, `'reconnecting'`, or `'disconnected'`. |
| `web_socket_open` | `bool` | Whether the Mercury WebSocket is currently open. |
| `kms_initialized` | `bool` | Whether the KMS encryption context has been established. |
| `device_registered` | `bool` | Whether a virtual device is registered with WDM. |
| `reconnect_attempt` | `int` | Current auto-reconnect attempt number (`0` if not reconnecting). |

#### `connected: bool` (property)

Quick boolean shorthand. Returns `True` only when fully connected.

### Events

Subscribe with `handler.on(event, callback)` or `@handler.on(event)` decorator. Remove with `handler.off(event, callback)`.

#### `'message:created'`

```python
@handler.on("message:created")
async def on_message(msg: DecryptedMessage):
    msg.id            # str — unique message ID
    msg.room_id       # str — conversation/room ID
    msg.person_id     # str — sender's Webex user ID
    msg.person_email  # str — sender's email address
    msg.text          # str — decrypted plain text
    msg.html          # str | None — decrypted HTML content
    msg.created       # str — ISO 8601 timestamp
    msg.room_type     # 'direct' | 'group' | None
    msg.raw           # MercuryActivity — full decrypted activity
```

#### `'message:deleted'`

```python
@handler.on("message:deleted")
def on_deleted(data: DeletedMessage):
    data.message_id  # str — ID of the deleted message
    data.room_id     # str — conversation/room ID
    data.person_id   # str — who deleted it
```

#### `'connected'`

```python
@handler.on("connected")
def on_connected():
    print("Ready to receive messages")
```

#### `'disconnected'`

| Reason | Meaning | Action |
|---|---|---|
| `'client'` | You called `disconnect()`. | None — intentional. |
| `'auth-failed'` | Token is invalid or expired (code 4401). | Call `reconnect(new_token)`. |
| `'permanent-failure'` | Server rejected permanently (code 4400/4403). | Investigate. |
| `'max-attempts-exceeded'` | Auto-reconnect gave up. | Call `reconnect(new_token)`. |
| `'manual'` | WebSocket closed, reconnection disabled. | None. |

#### `'reconnecting'`

```python
@handler.on("reconnecting")
def on_reconnecting(attempt: int):
    print(f"Reconnect attempt {attempt}...")
```

#### `'error'`

```python
@handler.on("error")
def on_error(err: Exception):
    print(f"Handler error: {err}")
```

---

## Logger Interface

Any object with `debug`, `info`, `warning`, and `error` methods works. Python's `logging.Logger` is directly compatible.

```python
import logging
logger = logging.getLogger("my_bot")
handler = WebexMessageHandler(WebexMessageHandlerConfig(token="...", logger=logger))
```

**Built-in loggers:**

| Export | Behavior |
|---|---|
| `noop_logger` | Silent. All methods are no-ops. This is the default. |
| `console_logger` | Logs via `logging.getLogger("webex_message_handler")`. |

---

## Error Classes

All errors extend `WebexError` which extends `Exception`. Each has a `.code` string.

| Class | `.code` | When |
|---|---|---|
| `AuthError` | `AUTH_ERROR` | Token is invalid, expired, or unauthorized. |
| `DeviceRegistrationError` | `DEVICE_REGISTRATION_ERROR` | WDM operations failed. Has `.status_code`. |
| `MercuryConnectionError` | `MERCURY_CONNECTION_ERROR` | WebSocket connection failed. Has `.close_code`. |
| `KmsError` | `KMS_ERROR` | KMS key exchange or key retrieval failed. |
| `DecryptionError` | `DECRYPTION_ERROR` | Message decryption failed. |

```python
from webex_message_handler import AuthError, KmsError

@handler.on("error")
def on_error(err):
    if isinstance(err, AuthError):
        # token issue — reconnect with fresh token
        pass
    elif isinstance(err, KmsError):
        # KMS issue — will auto-recover on reconnect
        pass
```

---

## Type Exports

All types are dataclasses:

```python
from webex_message_handler import (
    WebexMessageHandlerConfig,
    DeviceRegistration,
    MercuryActor,
    MercuryObject,
    MercuryTarget,
    MercuryActivity,
    MercuryEnvelope,
    DecryptedMessage,
    DeletedMessage,
    HandlerStatus,
    ConnectionStatus,
)
```

---

## Connection Lifecycle

```
    +-----------+       +----------+       +----------+       +---------+
    |  register |  -->  | Mercury  |  -->  |   KMS    |  -->  |  ready  |
    |  device   |       | connect  |       |  ECDH    |       |         |
    +-----------+       +----------+       +----------+       +---------+
         |                   |                  |                  |
         |              heartbeat           encrypts           emits:
         |              ping/pong           messages        message:created
         |                   |                  |           message:deleted
         |                   v                  |                  |
         |            (connection drop)         |                  |
         |                   |                  |                  |
         |                   v                  v                  |
         |             +-----------+    +------------+            |
         |             | auto      |--> | re-init    |----------->+
         |             | reconnect |    | KMS + WDM  |
         |             +-----------+    +------------+
         |
    reconnect(new_token) --> disconnect() --> connect() with new token
```

---

## Notes for Implementers

- **Async throughout**: All I/O uses `asyncio` + `aiohttp`. Run inside an async context.
- **Memory**: Encryption keys are cached. On auto-reconnect, the key cache is preserved.
- **One instance per token**: Each instance registers its own virtual device.
- **No outbound messaging**: This package only *receives* messages. To send messages, use the Webex REST API.
- **Heartbeat**: Ping every `ping_interval` seconds. Pong timeout triggers auto-reconnect.
