# webex-message-handler

Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages — no Webex SDK required.

## Why?

- **The Webex JS SDK has unpatched vulnerabilities and ~300+ transitive dependencies**
- **Bots behind corporate firewalls need Hookbuster or public webhook endpoints**
- **This package extracts only the essential Mercury + KMS logic (~6 dependencies)**

## Install

```bash
npm install webex-message-handler
```

## Quick Start

```typescript
import { WebexMessageHandler, consoleLogger } from 'webex-message-handler';

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  logger: consoleLogger,
});

handler.on('message:created', (msg) => {
  console.log(`[${msg.personEmail}] ${msg.text}`);
  if (msg.html) {
    console.log(`  HTML: ${msg.html}`);
  }
});

handler.on('message:deleted', (data) => {
  console.log(`Message ${data.messageId} deleted by ${data.personId}`);
});

handler.on('connected', () => console.log('Connected to Webex'));
handler.on('disconnected', (reason) => console.log(`Disconnected: ${reason}`));
handler.on('reconnecting', (attempt) => console.log(`Reconnecting (attempt ${attempt})...`));
handler.on('error', (err) => console.error('Error:', err.message));

await handler.connect();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await handler.disconnect();
  process.exit(0);
});
```

See `examples/basic-bot.ts` for a complete working example.

## Self-Message Filtering

By default, the library automatically filters out messages sent by your bot, preventing infinite response loops. On `connect()`, it fetches the bot's person ID via `/people/me`, normalizes it to a raw UUID, and silently drops any messages where the sender matches.

If `/people/me` fails (e.g., invalid token, network error), `connect()` will throw rather than silently running without protection. This fail-closed behavior ensures your bot never runs without self-message filtering active.

```typescript
const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  logger: consoleLogger,
  // ignoreSelfMessages defaults to true — no config needed
});

handler.on('message:created', (msg) => {
  // This will NEVER fire for the bot's own messages
  console.log(`User said: ${msg.text}`);
});
```

To receive the bot's own messages (e.g., for auditing), explicitly disable filtering. **Only do this if you have your own loop prevention in place:**

```typescript
const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  ignoreSelfMessages: false, // WARNING: risk of message loops
});
```

## Important: Implementing Loop Detection

This library only handles the **receive side** of messaging — it decrypts incoming messages from the Mercury WebSocket. It has no visibility into messages your bot **sends** via the REST API. This means it cannot detect message loops on its own.

If your bot replies to incoming messages, you **must** implement loop detection in your wrapper code. Without it, a bug or misconfiguration could cause your bot to endlessly reply to its own messages. Webex enforces a server-side rate limit (approximately 11 consecutive messages before throttling), but that still results in spam before the cutoff.

**Recommended approach:** Track your bot's outgoing message rate. If it exceeds a threshold (e.g., 5 messages in 3 seconds to the same room), pause sending and log a warning.

The `ignoreSelfMessages` option (default: `true`) provides a first line of defense by filtering out messages sent by this bot's own identity. If the library cannot verify the bot's identity during `connect()` (e.g., `/people/me` API failure), connection will fail rather than silently running without protection. Set `ignoreSelfMessages: false` to opt out, but only if you have your own loop prevention in place.

## Proxy Support (Enterprise)

In native mode, a single undici `ProxyAgent` proxies both HTTP (`fetch()`) and the native `WebSocket`:

```typescript
import { WebexMessageHandler } from 'webex-message-handler';
import { ProxyAgent } from 'undici';

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  dispatcher: new ProxyAgent(process.env.HTTPS_PROXY!),
});

await handler.connect();
```

You can also read the proxy URL from standard environment variables:

```typescript
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  dispatcher: proxyUrl ? new ProxyAgent(proxyUrl) : undefined,
});
```

### Injected Mode (Full Control)

For advanced scenarios where you need complete control over HTTP and WebSocket networking:

```typescript
import { WebexMessageHandler } from 'webex-message-handler';
import { ProxyAgent } from 'undici';

const proxy = new ProxyAgent(process.env.HTTPS_PROXY!);

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  mode: 'injected',
  fetch: async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      dispatcher: proxy,
    });
    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
    };
  },
  webSocketFactory: (url) => {
    // Return any object implementing InjectedWebSocket
    // (send, close, readyState, on)
    return createYourCustomWebSocket(url);
  },
});
```

## API Reference

### `WebexMessageHandler`

Main class for receiving and decrypting Webex messages.

#### Constructor

```typescript
new WebexMessageHandler(config: WebexMessageHandlerConfig)
```

**Configuration options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `token` | `string` | required | Webex bot access token |
| `logger` | `Logger` | noop | Custom logger (`consoleLogger` provided) |
| `ignoreSelfMessages` | `boolean` | `true` | Filter out messages sent by this bot |
| `dispatcher` | `object` (undici `Dispatcher`) | undefined | Proxy dispatcher for native mode (e.g., `ProxyAgent`) |
| `pingInterval` | `number` | `15000` | Mercury ping interval (ms) |
| `pongTimeout` | `number` | `14000` | Pong response timeout (ms) |
| `reconnectBackoffMax` | `number` | `32000` | Max reconnect backoff (ms) |
| `maxReconnectAttempts` | `number` | `10` | Max reconnect attempts |

#### Methods

- **`connect(): Promise<void>`** — Connects to Webex (registers device, initializes KMS, opens Mercury WebSocket)
- **`disconnect(): Promise<void>`** — Gracefully disconnects (closes WebSocket, unregisters device)

#### Properties

- **`connected: boolean`** — Whether currently connected to Mercury

#### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `message:created` | `DecryptedMessage` | New message received and decrypted |
| `message:deleted` | `{ messageId, roomId, personId }` | Message was deleted |
| `connected` | — | Connected/reconnected to Mercury |
| `disconnected` | `reason: string` | Disconnected from Mercury |
| `reconnecting` | `attempt: number` | Attempting to reconnect |
| `error` | `Error` | Error occurred |

### `DecryptedMessage`

Shape of decrypted messages:

```typescript
{
  id: string;
  roomId: string;
  personId: string;
  personEmail: string;
  text: string;
  html?: string;
  created: string;
  roomType?: string;
  raw: MercuryActivity;
}
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│         WebexMessageHandler                     │
│  (Main event emitter & lifecycle manager)      │
└────────────────┬────────────────────────────────┘
                 │
    ┌────────────┼────────────┬────────────────┐
    │            │            │                │
    v            v            v                v
┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐
│ Device   │ │ Mercury │ │ KMS      │ │ Message      │
│ Manager  │ │ Socket  │ │ Client   │ │ Decryptor    │
│          │ │         │ │          │ │              │
│ • WDM    │ │ • WS    │ │ • ECDH   │ │ • JWE        │
│ • Auth   │ │ • Ping/ │ │ • Key    │ │ • AES-GCM    │
│ • Reg    │ │   Pong  │ │   Fetch  │ │ • Plaintext  │
└──────────┘ └─────────┘ └──────────┘ └──────────────┘
```

## How It Works

The package follows a 5-step data flow for receiving and decrypting messages:

1. **Device Registration** — Registers a device via the WDM API and obtains a device ID
2. **Mercury Connection** — Opens a WebSocket connection to Mercury with token authentication and periodic heartbeat pings
3. **Encrypted Activity** — Mercury sends encrypted activity objects when new messages arrive
4. **Key Retrieval** — Fetches the decryption key from KMS via an ECDH-encrypted channel
5. **Decryption & Emission** — Decrypts the message using JWE and emits a `message:created` event

## Advanced: Individual Components

For advanced use cases, individual components are also exported:

- **`DeviceManager`** — Device registration and lifecycle
- **`MercurySocket`** — WebSocket connection and message reception
- **`KmsClient`** — Key management service integration
- **`MessageDecryptor`** — JWE decryption logic

## Comparison

| Feature | webex-message-handler | Webex JS SDK | Hookbuster |
|---------|----------------------|--------------|------------|
| Dependencies | ~6 | ~300+ | Full SDK |
| Vulnerabilities | 0 known | Multiple unpatched | Inherits SDK |
| Message receive | Yes | Yes | Yes |
| Message send | No (use REST API) | Yes | No |
| Webhook required | No | No | No |
| Binary size | ~50KB | ~5MB+ | ~5MB+ |

## License

Apache-2.0
