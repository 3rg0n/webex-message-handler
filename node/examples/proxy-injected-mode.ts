/**
 * Example: Using injected mode with corporate proxy
 *
 * This example demonstrates how to route ALL traffic (HTTP + WebSocket)
 * through a corporate proxy when using injected mode.
 *
 * Key points:
 * - HTTP requests use undici's ProxyAgent via 'dispatcher' option
 * - WebSocket connections use HttpsProxyAgent via 'agent' option
 * - Both are required for complete proxy support
 */

import { WebexMessageHandler, consoleLogger } from 'webex-message-handler';
import { ProxyAgent } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

const token = process.env.WEBEX_BOT_TOKEN;
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

if (!token) {
  console.error('Error: WEBEX_BOT_TOKEN environment variable required');
  process.exit(1);
}

if (!proxyUrl) {
  console.error('Error: HTTPS_PROXY or HTTP_PROXY environment variable required');
  process.exit(1);
}

console.log(`Using proxy: ${proxyUrl}\n`);

// Create proxy agents
const httpProxyAgent = new ProxyAgent(proxyUrl);
const wsProxyAgent = new HttpsProxyAgent(proxyUrl);

// Create handler with injected networking
const handler = new WebexMessageHandler({
  token,
  mode: 'injected',
  logger: consoleLogger,

  // Custom fetch function with proxy support
  fetch: async (request) => {
    console.log(`[FETCH] ${request.method} ${request.url}`);

    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      dispatcher: httpProxyAgent, // Route HTTP through proxy
    });

    return {
      status: response.status,
      ok: response.ok,
      json: () => response.json(),
      text: () => response.text(),
    };
  },

  // Custom WebSocket factory with proxy support
  webSocketFactory: (url) => {
    console.log(`[WS] Connecting to ${url}`);

    // CRITICAL: ws library requires 'agent' option for proxy support
    // Without this, WebSocket will bypass the proxy and attempt direct connection
    return new WebSocket(url, {
      agent: wsProxyAgent, // Route WebSocket through proxy
    });
  },
});

// Event handlers
handler.on('connected', () => {
  console.log('\n✅ Connected to Webex via proxy!');
});

handler.on('message:created', (message) => {
  console.log(`\n📨 Message from ${message.personEmail}:`);
  console.log(`   ${message.text}`);
});

handler.on('error', (error) => {
  console.error('\n❌ Error:', error.message);
});

handler.on('disconnected', (reason) => {
  console.log(`\n🔌 Disconnected: ${reason}`);
});

// Connect
console.log('Connecting to Webex...\n');
handler.connect().catch((error) => {
  console.error('Failed to connect:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down...');
  await handler.disconnect();
  process.exit(0);
});
