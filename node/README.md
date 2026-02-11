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

## Proxy Support (Enterprise)

For corporate environments behind a proxy, pass a configured agent:

```typescript
import { WebexMessageHandler } from 'webex-message-handler';
import { ProxyAgent } from 'undici';

const agent = process.env.HTTPS_PROXY
  ? new ProxyAgent(process.env.HTTPS_PROXY)
  : undefined;

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  agent, // Pass configured agent for proxy support
});

await handler.connect();
```

**Recommended:** Use undici's `ProxyAgent` for best compatibility with Node.js v18+ native `fetch()`. While `https-proxy-agent` may work, undici's `ProxyAgent` provides more reliable proxy support since Node.js fetch uses undici internally.

The library accepts any `http.Agent`, `https.Agent`, or undici `Dispatcher`, allowing you to use any proxy library or custom agent configuration.

### Advanced: Proxy with Injected Mode

For maximum control over proxy configuration (e.g., different proxies for HTTP vs WebSocket, custom logging), use injected mode:

```typescript
import { WebexMessageHandler } from 'webex-message-handler';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

const proxyUrl = process.env.HTTPS_PROXY!;
const httpProxy = new ProxyAgent(proxyUrl);
const wsProxy = new HttpsProxyAgent(proxyUrl);

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  mode: 'injected',
  fetch: async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      dispatcher: httpProxy, // HTTP via proxy
    });
    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
    };
  },
  webSocketFactory: (url) => {
    // CRITICAL: ws library needs 'agent' option for proxy
    return new WebSocket(url, { agent: wsProxy });
  },
});

await handler.connect();
```

> **Important:** WebSocket connections require an `agent` option to route through a proxy. The `ws` library will bypass proxies without this configuration.

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
| `agent` | `http.Agent \| https.Agent` | undefined | HTTP/HTTPS agent for proxy support |
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
