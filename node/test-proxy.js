// Simple test to validate proxy functionality
import { WebexMessageHandler, consoleLogger } from './dist/index.js';
import { ProxyAgent } from 'undici';

const token = process.env.WEBEX_BOT_TOKEN;
if (!token) {
  console.error('Error: WEBEX_BOT_TOKEN environment variable not set');
  process.exit(1);
}

const proxyUrl = process.env.HTTPS_PROXY || 'http://localhost:8080';
console.log(`\n=== Webex Proxy Test ===`);
console.log(`Using proxy: ${proxyUrl}\n`);

const handler = new WebexMessageHandler({
  token,
  dispatcher: new ProxyAgent(proxyUrl),
  logger: consoleLogger,
});

handler.on('connected', () => {
  console.log('\n✅ Successfully connected through proxy!');
  console.log('   - Device registered');
  console.log('   - Mercury WebSocket connected');
  console.log('   - KMS initialized');
  setTimeout(() => {
    console.log('\n✅ Proxy validation complete - disconnecting...\n');
    handler.disconnect().then(() => process.exit(0));
  }, 3000);
});

handler.on('error', (err) => {
  console.error('\n❌ Connection error:', err.message);
  process.exit(1);
});

console.log('Connecting to Webex through proxy...');
handler.connect().catch((err) => {
  console.error('❌ Failed to connect:', err.message);
  process.exit(1);
});
