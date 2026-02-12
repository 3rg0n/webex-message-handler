/**
 * Live end-to-end integration test (bidirectional).
 *
 * Verifies the entire pipeline including self-message filtering:
 * 1. Device registration (WDM)
 * 2. Mercury WebSocket connection
 * 3. KMS initialization (ECDH handshake)
 * 4. Message send (REST API) from sender bot
 * 5. Message receive + decrypt (Mercury) on receiver bot
 * 6. Receiver REPLIES via REST API (exercises self-message filtering)
 * 7. Verify receiver does NOT process its own reply (ignoreSelfMessages)
 *
 * If self-message filtering is broken, the receiver will loop on its own
 * replies and the test will fail with a loop detection error.
 *
 * Run with: node --env-file=../.env test-e2e.js
 * Requires: WEBEX_BOT_TOKEN (receiver) and WEBEX_BOT_TOKEN_TEST (sender)
 */
import { WebexMessageHandler, consoleLogger } from './dist/index.js';

const TIMEOUT_MS = 30_000;
const LOOP_LIMIT = 3; // If we see this many messages, self-filtering is broken

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

console.log('\n=== Webex E2E Integration Test (Node.js — Bidirectional) ===\n');

const handler = new WebexMessageHandler({
  token: receiverToken,
  logger: consoleLogger,
  // ignoreSelfMessages defaults to true — the whole point of this test
});

const testMessage = `E2E test ${Date.now()}`;
const replyPrefix = 'Echo: ';
let messageCount = 0;
let receivedOriginal = false;
let replySent = false;

// Set up message listener BEFORE connecting (so we don't miss events)
const testPromise = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    if (receivedOriginal && replySent) {
      // Timeout after reply sent and no loop detected — that's a PASS
      resolve('ok');
    } else {
      reject(new Error(`Timeout: message not received within ${TIMEOUT_MS}ms`));
    }
  }, TIMEOUT_MS);

  handler.on('message:created', async (msg) => {
    messageCount++;
    console.log(`   [${messageCount}] Received: "${msg.text}" from ${msg.personEmail}`);

    // Loop detection: if we get more than LOOP_LIMIT messages, filtering is broken
    if (messageCount >= LOOP_LIMIT) {
      clearTimeout(timer);
      reject(new Error(
        `LOOP DETECTED: Received ${messageCount} messages — self-message filtering is broken. ` +
        `The receiver is processing its own replies.`
      ));
      return;
    }

    // First message should be the sender's test message
    if (msg.text === testMessage && !receivedOriginal) {
      receivedOriginal = true;
      console.log('   -> Original message received, sending reply...');

      // Receiver replies via REST API — this is the critical part.
      // Mercury will echo this back. If ignoreSelfMessages works,
      // the handler will silently drop it. If broken, we loop.
      try {
        const res = await fetch('https://webexapis.com/v1/messages', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${receiverToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            roomId: msg.roomId,
            text: `${replyPrefix}${msg.text}`,
          }),
        });
        if (!res.ok) {
          clearTimeout(timer);
          reject(new Error(`Failed to send reply: HTTP ${res.status}`));
          return;
        }
        replySent = true;
        console.log('   -> Reply sent. Waiting to confirm self-message is filtered...');

        // Wait a few seconds — if no loop fires, self-filtering works
        setTimeout(() => {
          clearTimeout(timer);
          resolve('ok');
        }, 5000);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
      return;
    }

    // If we receive the reply text, self-filtering is broken
    if (msg.text.startsWith(replyPrefix)) {
      clearTimeout(timer);
      reject(new Error(
        `SELF-MESSAGE NOT FILTERED: Receiver processed its own reply "${msg.text}". ` +
        `ignoreSelfMessages is not working.`
      ));
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
console.log(`   Sender:   ${sender.displayName} (${sender.emails[0]})`);

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

// Step 4: Wait for bidirectional exchange
console.log('4. Waiting for receive + reply + self-filter verification...');

try {
  await testPromise;

  console.log('\n=== Test Results ===');
  console.log(`   Messages processed by handler: ${messageCount}`);
  console.log(`   Original received: ${receivedOriginal}`);
  console.log(`   Reply sent: ${replySent}`);
  console.log(`   Self-message filtered: ${messageCount === 1 ? 'YES' : 'NO'}`);

  if (messageCount === 1 && receivedOriginal && replySent) {
    console.log('\nPASSED - Bidirectional messaging works, self-messages filtered correctly');
  } else {
    console.log('\nFAILED - Unexpected state');
    process.exit(1);
  }
} catch (err) {
  console.error(`\nFAILED - ${err.message}`);
  process.exit(1);
} finally {
  console.log('\nCleaning up...');
  await handler.disconnect();
  console.log('Disconnected. Test complete.\n');
  process.exit(0);
}
