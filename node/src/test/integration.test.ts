/**
 * Integration test: Send a message via REST API and receive it via Mercury WebSocket.
 *
 * This test verifies the entire pipeline:
 * 1. Device registration (WDM)
 * 2. Mercury WebSocket connection
 * 3. KMS initialization (ECDH handshake)
 * 4. Message send (REST API)
 * 5. Message receive (Mercury)
 * 6. Message decryption (KMS)
 *
 * Run with: WEBEX_BOT_TOKEN=your_token npm run test:integration
 */

import { WebexMessageHandler } from '../index.js';

const TIMEOUT_MS = 30000; // 30 seconds

interface WebexPerson {
  id: string;
  emails: string[];
  displayName: string;
}

async function integrationTest(): Promise<void> {
  const receiverToken = process.env.WEBEX_BOT_TOKEN;
  if (!receiverToken) {
    throw new Error('WEBEX_BOT_TOKEN environment variable is required (bot that receives messages)');
  }

  const senderToken = process.env.WEBEX_BOT_TOKEN_TEST;
  if (!senderToken) {
    throw new Error('WEBEX_BOT_TOKEN_TEST environment variable is required (bot that sends test message)');
  }

  console.log('🚀 Starting integration test...\n');

  // Create handler with receiver bot
  const handler = new WebexMessageHandler({ token: receiverToken });

  // Unique test message
  const testMessage = `Integration test ${Date.now()}`;
  let receivedMessage = false;
  let receivedText = '';

  handler.on('message:created', (msg) => {
    console.log(`📨 Received message: "${msg.text}" from ${msg.personEmail}`);
    if (msg.text === testMessage) {
      receivedMessage = true;
      receivedText = msg.text;
    }
  });

  handler.on('connected', () => {
    console.log('✅ Connected to Mercury');
  });

  handler.on('error', (err) => {
    console.error('❌ Handler error:', err);
  });

  try {
    // Step 1: Connect to Mercury
    console.log('1️⃣  Connecting to Mercury...');
    await handler.connect();

    // Step 2: Get receiver bot's email
    console.log('2️⃣  Fetching bot identities...');
    const receiverResponse = await fetch('https://webexapis.com/v1/people/me', {
      headers: { Authorization: `Bearer ${receiverToken}` }
    });
    const senderResponse = await fetch('https://webexapis.com/v1/people/me', {
      headers: { Authorization: `Bearer ${senderToken}` }
    });

    if (!receiverResponse.ok || !senderResponse.ok) {
      throw new Error('Failed to get bot identities');
    }

    const receiver = await receiverResponse.json() as WebexPerson;
    const sender = await senderResponse.json() as WebexPerson;
    console.log(`   Receiver: ${receiver.displayName} (${receiver.emails[0]})`);
    console.log(`   Sender: ${sender.displayName} (${sender.emails[0]})`);

    // Step 3: Send message FROM sender bot TO receiver bot
    console.log(`3️⃣  Sending test message: "${testMessage}"`);
    const sendResponse = await fetch('https://webexapis.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${senderToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        toPersonEmail: receiver.emails[0],
        text: testMessage
      })
    });

    if (!sendResponse.ok) {
      const errorBody = await sendResponse.text();
      throw new Error(`Failed to send message: ${sendResponse.status} ${errorBody}`);
    }

    const sentMessage = await sendResponse.json() as { id: string };
    console.log(`   Message sent (ID: ${sentMessage.id})`);

    // Step 4: Wait for message to arrive via Mercury
    console.log('4️⃣  Waiting for message to arrive via Mercury...');
    const startTime = Date.now();
    while (!receivedMessage && (Date.now() - startTime) < TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Step 5: Verify result
    console.log('\n📊 Test Results:');
    if (receivedMessage) {
      console.log('✅ PASSED - Message received and decrypted successfully');
      console.log(`   Expected: "${testMessage}"`);
      console.log(`   Received: "${receivedText}"`);
    } else {
      console.error('❌ FAILED - Message not received within timeout');
      throw new Error('Integration test failed: message not received');
    }

  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await handler.disconnect();
    console.log('✅ Disconnected\n');
  }
}

// Run the test
integrationTest()
  .then(() => {
    console.log('✅ Integration test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Integration test failed:', error);
    process.exit(1);
  });
