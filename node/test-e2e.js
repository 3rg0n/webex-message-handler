/**
 * Live end-to-end integration test.
 *
 * Verifies the entire pipeline:
 * 1. Device registration (WDM)
 * 2. Mercury WebSocket connection
 * 3. KMS initialization (ECDH handshake)
 * 4. Message send (REST API)
 * 5. Message receive (Mercury)
 * 6. Message decryption (KMS)
 *
 * Run with: node --env-file=../.env test-e2e.js
 * Requires: WEBEX_BOT_TOKEN (receiver) and WEBEX_BOT_TOKEN_TEST (sender)
 */
import { WebexMessageHandler, consoleLogger } from './dist/index.js';

const TIMEOUT_MS = 30_000;

const receiverToken = process.env.WEBEX_BOT_TOKEN;
const senderToken = process.env.WEBEX_BOT_TOKEN_TEST;

if (!receiverToken) {
  console.error('Error: WEBEX_BOT_TOKEN environment variable not set');
  process.exit(1);
}
if (!senderToken) {
  console.error('Error: WEBEX_BOT_TOKEN_TEST environment variable not set');
  process.exit(1);
}

console.log('\n=== Webex E2E Integration Test (Node.js) ===\n');

const handler = new WebexMessageHandler({
  token: receiverToken,
  logger: consoleLogger,
});

const testMessage = `Integration test ${Date.now()}`;

// Set up message listener BEFORE connecting (so we don't miss events)
const messagePromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`Timeout: message not received within ${TIMEOUT_MS}ms`));
  }, TIMEOUT_MS);

  handler.on('message:created', (msg) => {
    console.log(`   Received: "${msg.text}" from ${msg.personEmail}`);
    if (msg.text === testMessage) {
      clearTimeout(timer);
      resolve(msg);
    }
  });

  handler.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
});

// Step 1: Connect
console.log('1. Connecting to Mercury...');
await handler.connect();

// Step 2: Get bot identities
console.log('2. Fetching bot identities...');
const [receiverRes, senderRes] = await Promise.all([
  fetch('https://webexapis.com/v1/people/me', {
    headers: { Authorization: `Bearer ${receiverToken}` },
  }),
  fetch('https://webexapis.com/v1/people/me', {
    headers: { Authorization: `Bearer ${senderToken}` },
  }),
]);

const receiver = await receiverRes.json();
const sender = await senderRes.json();
console.log(`   Receiver: ${receiver.displayName} (${receiver.emails[0]})`);
console.log(`   Sender: ${sender.displayName} (${sender.emails[0]})`);

// Step 3: Send message from sender to receiver
console.log(`3. Sending test message: "${testMessage}"`);
const sendRes = await fetch('https://webexapis.com/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${senderToken}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    toPersonEmail: receiver.emails[0],
    text: testMessage,
  }),
});
const sentMsg = await sendRes.json();
console.log(`   Message sent (ID: ${sentMsg.id})`);

// Step 4: Wait for message via Mercury
console.log('4. Waiting for message to arrive via Mercury...');
const received = await messagePromise;

// Step 5: Verify
console.log('\nTest Results:');
if (received.text === testMessage) {
  console.log('PASSED - Message received and decrypted successfully');
  console.log(`   Expected: "${testMessage}"`);
  console.log(`   Received: "${received.text}"`);
} else {
  console.log('FAILED - Message mismatch');
  process.exit(1);
}

// Cleanup
console.log('\nCleaning up...');
await handler.disconnect();
console.log('Disconnected. Test complete.\n');
process.exit(0);
