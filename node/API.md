# webex-message-handler API Reference

Lightweight, standalone package for receiving and decrypting Webex messages over a persistent WebSocket. No full Webex SDK required — just provide a bot token.

## Installation

```bash
npm install webex-message-handler
```

## Quick Start

```typescript
import { WebexMessageHandler, consoleLogger } from 'webex-message-handler';

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  logger: consoleLogger, // optional, silent by default
});

handler.on('message:created', (message) => {
  console.log(`[${message.personEmail}] ${message.text}`);
});

handler.on('error', (err) => console.error('Error:', err));

await handler.connect();
```

---

## Public API Surface

The `WebexMessageHandler` class has five methods and one getter. This is the complete public interface a wrapper needs:

| Method | Purpose |
|---|---|
| `connect()` | Start the connection (device registration, WebSocket, KMS handshake). |
| `disconnect()` | Tear down the connection cleanly. |
| `reconnect(newToken)` | Update the token and re-establish everything from scratch. |
| `status()` | Health check — returns structured connection state of all subsystems. |
| `connected` | Quick boolean: is the handler connected and WebSocket open? |
| `on(event, callback)` | Subscribe to events (`message:created`, `disconnected`, etc.). |

---

## WebexMessageHandler

### Constructor

```typescript
new WebexMessageHandler(config: WebexMessageHandlerConfig)
```

**`WebexMessageHandlerConfig` fields:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `token` | `string` | Yes | — | Webex bot or user access token. |
| `mode` | `NetworkMode` | No | `'native'` | Networking mode: `'native'` or `'injected'`. See [Networking Modes](#networking-modes). |
| `agent` | `http.Agent \| https.Agent \| undici.Dispatcher` | No | — | **Native mode only**: Proxy agent for HTTP/HTTPS requests. Recommended: undici's `ProxyAgent` for Node.js v18+. |
| `fetch` | `FetchFunction` | Required for injected | — | **Injected mode only**: Custom fetch function for all HTTP requests. |
| `webSocketFactory` | `WebSocketFactory` | Required for injected | — | **Injected mode only**: Custom WebSocket factory function. |
| `logger` | `Logger` | No | silent | Logger implementation (`consoleLogger` provided). |
| `pingInterval` | `number` | No | `15000` | WebSocket heartbeat ping interval in ms. |
| `pongTimeout` | `number` | No | `14000` | How long to wait for pong before triggering reconnect. |
| `reconnectBackoffMax` | `number` | No | `32000` | Max backoff delay between reconnection attempts. |
| `maxReconnectAttempts` | `number` | No | `10` | Max consecutive reconnection attempts before giving up. |

### Networking Modes

The handler supports two networking modes controlled by the `mode` configuration field. The mode determines how the library makes HTTP requests and creates WebSocket connections.

#### Native Mode (Default)

Uses Node.js built-in `fetch` and `ws` library directly. Supports proxy configuration via the `agent` parameter.

**Basic usage:**
```typescript
const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
});
```

**With proxy:**
```typescript
import { ProxyAgent } from 'undici';

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  agent: new ProxyAgent('http://proxy.example.com:8080'),
});
```

> **Note:** Use undici's `ProxyAgent` for best compatibility with Node.js v18+ native `fetch()`. While `https-proxy-agent` may work, undici's `ProxyAgent` is more reliable since Node.js fetch uses undici internally.

#### Injected Mode

Provides complete control over networking by injecting custom fetch and WebSocket factory functions. Useful for:
- Mocking network calls in tests
- Logging/monitoring all requests
- Custom routing or load balancing
- Integration with non-standard networking layers

**Configuration validation:**
- When `mode: 'injected'`, BOTH `fetch` and `webSocketFactory` are required
- The `agent` parameter cannot be used with injected mode (conflict error)
- When `mode: 'native'`, `fetch` and `webSocketFactory` cannot be provided (conflict error)

**Type signatures:**
```typescript
type NetworkMode = 'native' | 'injected';

interface FetchRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
}

interface FetchResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type FetchFunction = (request: FetchRequest) => Promise<FetchResponse>;

interface InjectedWebSocket {
  send(data: string): void;
  close(code?: number): void;
  readonly readyState: number;
  on(event: 'message', listener: (data: string) => void): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'close', listener: (code: number, reason: string) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

type WebSocketFactory = (url: string) => InjectedWebSocket;
```

**Example with logging:**
```typescript
import WebSocket from 'ws';

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  mode: 'injected',
  fetch: async (request) => {
    console.log(`[HTTP] ${request.method} ${request.url}`);
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
    return new WebSocket(url) as any;
  },
});
```

**Example for testing:**
```typescript
// Mock fetch that returns canned responses
const mockFetch: FetchFunction = async (request) => {
  if (request.url.includes('/devices')) {
    return {
      status: 200,
      ok: true,
      json: async () => ({ deviceUrl: 'mock-device', userId: 'mock-user', ... }),
      text: async () => '',
    };
  }
  // ... handle other endpoints
};

// Mock WebSocket that doesn't actually connect
class MockWebSocket extends EventEmitter {
  send(data: string) { /* no-op */ }
  close() { /* no-op */ }
  readyState = 1;
}

const handler = new WebexMessageHandler({
  token: 'mock-token',
  mode: 'injected',
  fetch: mockFetch,
  webSocketFactory: (url) => new MockWebSocket() as any,
});
```

**Network call inventory:**

The library makes exactly 6 types of network calls:

| Component | Method | URL | Purpose |
|-----------|--------|-----|---------|
| DeviceManager | POST | `wdm-a.wbx2.com/wdm/api/v1/devices` | Register virtual device |
| DeviceManager | PUT | `{deviceUrl}` | Refresh device registration |
| DeviceManager | DELETE | `{deviceUrl}` | Unregister device |
| KmsClient | GET | `{encryptionServiceUrl}/kms/{userId}` | Fetch KMS cluster details |
| KmsClient | POST | `{encryptionServiceUrl}/kms/messages` | ECDH key exchange and key requests |
| MercurySocket | WebSocket | Mercury URL from device | Persistent message stream |

### Methods

#### `connect(): Promise<void>`

Establishes the full connection pipeline:

1. Registers a virtual device with Webex WDM (Web Device Management)
2. Opens a Mercury WebSocket and authenticates
3. Performs KMS ECDH key exchange (for end-to-end message encryption)
4. Begins listening for encrypted messages, decrypting them automatically

Resolves when the connection is fully established and ready to receive messages. Throws on failure (`AuthError`, `MercuryConnectionError`, `KmsError`).

```typescript
await handler.connect();
// handler.status() now returns { status: 'connected', ... }
```

#### `disconnect(): Promise<void>`

Tears down the connection cleanly:

1. Closes the Mercury WebSocket (stops heartbeat, cancels auto-reconnection)
2. Unregisters the virtual device with WDM
3. Clears KMS context and decryption keys from memory

After disconnect, the instance can be reconnected by calling `connect()` again or `reconnect(newToken)` with a fresh token.

```typescript
await handler.disconnect();
// handler.status() now returns { status: 'disconnected', ... }
```

#### `reconnect(newToken: string): Promise<void>`

Updates the access token and re-establishes the connection from scratch. Internally calls `disconnect()`, stores the new token, then calls `connect()`.

Use this when:
- The token has been refreshed externally (OAuth rotation)
- You receive a `'disconnected'` event with reason `'auth-failed'`
- You want to proactively rotate the token before it expires

```typescript
const freshToken = await myAuthSystem.refreshToken();
await handler.reconnect(freshToken);
// Fully reconnected with the new token
```

#### `status(): HandlerStatus`

Returns a structured health check of all connection subsystems. Use this to build monitoring, health endpoints, or decide whether to reconnect.

```typescript
const health = handler.status();
```

**`HandlerStatus` fields:**

| Field | Type | Description |
|---|---|---|
| `status` | `ConnectionStatus` | Overall state: `'connected'`, `'connecting'`, `'reconnecting'`, or `'disconnected'`. |
| `webSocketOpen` | `boolean` | Whether the Mercury WebSocket is currently open. |
| `kmsInitialized` | `boolean` | Whether the KMS encryption context has been established. |
| `deviceRegistered` | `boolean` | Whether a virtual device is registered with WDM. |
| `reconnectAttempt` | `number` | Current auto-reconnect attempt number (`0` if not reconnecting). |

**`ConnectionStatus` values:**

| Value | Meaning |
|---|---|
| `'connected'` | Fully operational. WebSocket is open, KMS is initialized, messages flowing. |
| `'connecting'` | Initial `connect()` call is in progress. |
| `'reconnecting'` | Auto-reconnect is in progress after a connection drop. |
| `'disconnected'` | Not connected. Either never connected, manually disconnected, or reconnect gave up. |

```typescript
// Health check endpoint example
app.get('/health', (req, res) => {
  const health = handler.status();
  const httpStatus = health.status === 'connected' ? 200 : 503;
  res.status(httpStatus).json(health);
});

// Wrapper decision logic
const health = handler.status();
if (health.status === 'disconnected') {
  // Not connected at all — need to connect or reconnect
  await handler.reconnect(await getToken());
} else if (health.status === 'reconnecting' && health.reconnectAttempt > 5) {
  // Auto-reconnect is struggling — maybe token expired
  await handler.reconnect(await refreshToken());
}
```

#### `connected: boolean` (getter)

Quick boolean shorthand. Returns `true` only when `status` would be `'connected'`.

```typescript
if (handler.connected) {
  // ready to receive messages
}
```

### Events

Subscribe with `handler.on(event, callback)`. Remove with `handler.off(event, callback)`.

#### `'message:created'`

Fired when a new message is received and decrypted.

```typescript
handler.on('message:created', (message: DecryptedMessage) => {
  message.id;          // string — unique message ID
  message.roomId;      // string — conversation/room ID
  message.personId;    // string — sender's Webex user ID
  message.personEmail; // string — sender's email address
  message.text;        // string — decrypted plain text of the message
  message.html;        // string | undefined — decrypted HTML content (rich text)
  message.created;     // string — ISO 8601 timestamp
  message.roomType;    // 'direct' | 'group' | undefined
  message.raw;         // MercuryActivity — the full decrypted activity object
});
```

#### `'message:deleted'`

Fired when a message is deleted.

```typescript
handler.on('message:deleted', (data: DeletedMessage) => {
  data.messageId; // string — ID of the deleted message
  data.roomId;    // string — conversation/room ID
  data.personId;  // string — who deleted it
});
```

#### `'connected'`

Fired when the connection is established (initial connect or after reconnection).

```typescript
handler.on('connected', () => {
  console.log('Ready to receive messages');
});
```

#### `'disconnected'`

Fired when the connection is lost. The `reason` string indicates why:

| Reason | Meaning | Action |
|---|---|---|
| `'client'` | You called `disconnect()`. | None — intentional. |
| `'auth-failed'` | Token is invalid or expired (WebSocket code 4401). | Call `reconnect(newToken)` with a fresh token. |
| `'permanent-failure'` | Server rejected the connection permanently (code 4400/4403). | Investigate — likely a configuration issue. |
| `'max-attempts-exceeded'` | Auto-reconnect gave up after max attempts. | Call `reconnect(newToken)` — token may have expired during retries. |
| `'manual'` | WebSocket closed and reconnection was disabled. | None — intentional. |

```typescript
handler.on('disconnected', async (reason: string) => {
  if (reason === 'auth-failed' || reason === 'max-attempts-exceeded') {
    const freshToken = await refreshMyToken();
    await handler.reconnect(freshToken);
  }
});
```

#### `'reconnecting'`

Fired when auto-reconnect is attempting. The `attempt` number starts at 1.

```typescript
handler.on('reconnecting', (attempt: number) => {
  console.log(`Reconnect attempt ${attempt}...`);
});
```

#### `'error'`

Fired on non-fatal errors (decryption failures, reconnect issues, etc.). The connection may still be alive.

```typescript
handler.on('error', (err: Error) => {
  console.error('Handler error:', err.message);
});
```

---

## Token Refresh Patterns

### Reactive: Refresh on Auth Failure

The simplest pattern. Wait for the connection to fail, then get a new token:

```typescript
handler.on('disconnected', async (reason) => {
  if (reason === 'auth-failed') {
    const freshToken = await myAuth.getToken();
    await handler.reconnect(freshToken);
  }
});
```

### Proactive: Rotate Before Expiry

If you know when the token expires, rotate it before the connection fails (avoids any message gap):

```typescript
setInterval(async () => {
  if (isTokenExpiringSoon()) {
    const freshToken = await refreshMyToken();
    await handler.reconnect(freshToken);
  }
}, 60_000);
```

### Factory Pattern: Token Provider

Pass a token-fetching function to your wrapper so it always has a way to get a fresh token:

```typescript
class MyBot {
  constructor(private getToken: () => Promise<string>) {}

  async start() {
    const token = await this.getToken();
    this.handler = new WebexMessageHandler({ token });

    this.handler.on('disconnected', async (reason) => {
      if (reason === 'auth-failed' || reason === 'max-attempts-exceeded') {
        const fresh = await this.getToken();
        await this.handler.reconnect(fresh);
      }
    });

    await this.handler.connect();
  }
}
```

---

## Logger Interface

```typescript
interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

**Built-in loggers:**

| Export | Behavior |
|---|---|
| `noopLogger` | Silent. All methods are no-ops. This is the default. |
| `consoleLogger` | Logs to `console.debug`, `console.info`, `console.warn`, `console.error`. |

Compatible with winston, pino, bunyan — pass the instance directly if it has these four methods, or wrap it.

---

## Error Classes

All errors extend `WebexError` which extends `Error`. Each has a `.code` string and `.name`.

| Class | `.code` | When |
|---|---|---|
| `AuthError` | `AUTH_ERROR` | Token is invalid, expired, or unauthorized. |
| `DeviceRegistrationError` | `DEVICE_REGISTRATION_ERROR` | WDM device registration/refresh/unregister failed. Has `.statusCode`. |
| `MercuryConnectionError` | `MERCURY_CONNECTION_ERROR` | WebSocket connection failed. Has `.closeCode`. |
| `KmsError` | `KMS_ERROR` | KMS key exchange or key retrieval failed. |
| `DecryptionError` | `DECRYPTION_ERROR` | Message decryption failed (bad key, corrupt ciphertext). |

```typescript
import { AuthError, KmsError } from 'webex-message-handler';

handler.on('error', (err) => {
  if (err instanceof AuthError) {
    // token issue — reconnect with fresh token
  } else if (err instanceof KmsError) {
    // KMS issue — will auto-recover on reconnect
  }
});
```

---

## Type Exports

All TypeScript types are exported:

```typescript
import type {
  // Config & events
  WebexMessageHandlerConfig,
  WebexMessageHandlerEvents,
  // Networking types (v0.3.0+)
  NetworkMode,
  FetchRequest,
  FetchResponse,
  FetchFunction,
  InjectedWebSocket,
  WebSocketFactory,
  // Status
  HandlerStatus,
  ConnectionStatus,
  // Message types
  DecryptedMessage,
  DeletedMessage,
  // Internal types (for advanced use)
  DeviceRegistration,
  MercuryActivity,
  MercuryActor,
  MercuryObject,
  MercuryTarget,
  MercuryEnvelope,
  // Logger
  Logger,
} from 'webex-message-handler';
```

### `DecryptedMessage`

```typescript
interface DecryptedMessage {
  id: string;          // Unique message ID
  roomId: string;      // Conversation/space ID
  personId: string;    // Sender's user ID
  personEmail: string; // Sender's email
  text: string;        // Decrypted plain text
  html?: string;       // Decrypted HTML (rich text messages)
  created: string;     // ISO 8601 timestamp
  roomType?: string;   // 'direct' | 'group' | undefined
  raw: MercuryActivity; // Full decrypted activity for advanced use
}
```

### `DeletedMessage`

```typescript
interface DeletedMessage {
  messageId: string; // ID of the deleted message
  roomId: string;    // Conversation/space ID
  personId: string;  // Who deleted it
}
```

### `HandlerStatus`

```typescript
type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

interface HandlerStatus {
  status: ConnectionStatus;   // Overall connection state
  webSocketOpen: boolean;     // Mercury WebSocket is open
  kmsInitialized: boolean;    // KMS encryption context is active
  deviceRegistered: boolean;  // Virtual device is registered with WDM
  reconnectAttempt: number;   // Current auto-reconnect attempt (0 if not reconnecting)
}
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
    reconnect(newToken) --> disconnect() --> connect() with new token
```

**Auto-reconnect** handles transient WebSocket drops automatically:
1. Exponential backoff (1s, 2s, 4s, ... up to `reconnectBackoffMax`)
2. Reconnect the WebSocket
3. Refresh the WDM device registration
4. Re-perform the KMS ECDH key exchange
5. Resume receiving messages

Auto-reconnect does **not** handle expired tokens. If the token expired, reconnect fails with `'auth-failed'` and you must call `reconnect(newToken)`.

---

## Complete Wrapper Example

A full wrapper with token refresh, health checks, graceful shutdown, and message routing:

```typescript
import {
  WebexMessageHandler,
  consoleLogger,
} from 'webex-message-handler';
import type {
  DecryptedMessage,
  HandlerStatus,
  Logger,
} from 'webex-message-handler';

interface BotOptions {
  /** Returns a valid access token. Called on start and on auth failure. */
  getToken: () => Promise<string>;
  /** Called for each incoming message. */
  onMessage: (message: DecryptedMessage) => void | Promise<void>;
  /** Optional logger. Defaults to consoleLogger. */
  logger?: Logger;
}

class WebexBot {
  private handler: WebexMessageHandler | null = null;
  private opts: BotOptions;
  private logger: Logger;

  constructor(opts: BotOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? consoleLogger;
  }

  /** Connect to Webex and start receiving messages. */
  async start(): Promise<void> {
    const token = await this.opts.getToken();

    this.handler = new WebexMessageHandler({
      token,
      logger: this.logger,
    });

    this.handler.on('message:created', async (msg) => {
      try {
        await this.opts.onMessage(msg);
      } catch (err) {
        this.logger.error('onMessage handler error:', err);
      }
    });

    this.handler.on('disconnected', async (reason) => {
      this.logger.warn(`Disconnected: ${reason}`);
      if (reason === 'auth-failed' || reason === 'max-attempts-exceeded') {
        try {
          const freshToken = await this.opts.getToken();
          await this.handler!.reconnect(freshToken);
        } catch (err) {
          this.logger.error('Token refresh/reconnect failed:', err);
        }
      }
    });

    this.handler.on('reconnecting', (attempt) => {
      this.logger.info(`Auto-reconnecting (attempt ${attempt})...`);
    });

    this.handler.on('connected', () => {
      this.logger.info('Connected and ready');
    });

    this.handler.on('error', (err) => {
      this.logger.error('Error:', err);
    });

    await this.handler.connect();
  }

  /** Disconnect cleanly. */
  async stop(): Promise<void> {
    if (this.handler) {
      await this.handler.disconnect();
      this.handler = null;
    }
  }

  /** Get connection health for monitoring. */
  health(): HandlerStatus | null {
    return this.handler?.status() ?? null;
  }
}

// --- Usage ---

const bot = new WebexBot({
  getToken: async () => process.env.WEBEX_BOT_TOKEN!,
  onMessage: (msg) => {
    console.log(`[${msg.personEmail}] ${msg.text}`);
  },
});

await bot.start();

// Health check
console.log(bot.health());
// { status: 'connected', webSocketOpen: true, kmsInitialized: true, deviceRegistered: true, reconnectAttempt: 0 }

// Graceful shutdown
process.on('SIGINT', async () => {
  await bot.stop();
  process.exit(0);
});
```

---

## Notes for Implementers

- **Thread safety**: Single-threaded (Node.js event loop). No mutexes needed.
- **Memory**: Encryption keys are cached in memory. On auto-reconnect, the key cache is preserved. On `reconnect(newToken)`, a fresh KMS context is created but cached keys for already-seen conversations are reused.
- **One instance per token**: Each instance registers its own virtual device. Multiple instances with the same token each receive all messages independently.
- **Message ordering**: Mercury guarantees per-conversation ordering.
- **No outbound messaging**: This package only *receives* messages. To send messages, use the Webex REST API directly (`POST https://webexapis.com/v1/messages`).
- **Dual format**: Ships as both CommonJS and ESM. `require()` and `import` both work.
- **Heartbeat**: The WebSocket sends a ping every `pingInterval` ms. If no pong arrives within `pongTimeout` ms, the connection is considered dead and auto-reconnect triggers. This keeps the connection alive through NAT timeouts and load balancer idle timeouts.
