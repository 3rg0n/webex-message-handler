import { WebexMessageHandler } from '../src/handler.js';
import type { PersonInfo } from '../src/types.js';

/**
 * REAL integration test for message loop bug.
 *
 * This test simulates a real-world production scenario:
 * 1. Bot listens for ALL messages
 * 2. Bot ALWAYS responds to ANY message (persistent listener, not one-time)
 * 3. Mercury echoes bot's response back
 * 4. Bot receives its own response → responds again (LOOP!)
 *
 * Without ignoreSelfMessages: Runaway loop until safety limit
 * With ignoreSelfMessages: Only processes user messages
 */
describe('Runaway Loop Integration Test (Real Bug Reproduction)', () => {
  const BOT_PERSON_ID = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9ib3QtaWQ';
  const BOT_EMAIL = 'testbot@webex.bot';
  const USER_PERSON_ID = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS91c2VyLWlk';
  const USER_EMAIL = 'user@example.com';
  const ROOM_ID = 'Y2lzY29zcGFyazovL3VzL1JPT00vcm9vbS1pZA';
  const SAFETY_LIMIT = 10; // Prevent actual infinite loop in test

  // Helper to create encrypted activity (what Mercury sends)
  const createMercuryActivity = (personId: string, personEmail: string, text: string) => ({
    id: `activity-${Date.now()}-${Math.random()}`,
    verb: 'post',
    actor: {
      id: personId,
      emailAddress: personEmail,
      displayName: personId === BOT_PERSON_ID ? 'Test Bot' : 'Test User',
      entryUUID: personId,
      type: 'person',
    },
    object: {
      objectType: 'conversation',
      id: ROOM_ID,
      url: `https://api.ciscospark.com/v1/rooms/${ROOM_ID}`,
    },
    target: {
      id: ROOM_ID,
      objectType: 'conversation',
      url: `https://api.ciscospark.com/v1/rooms/${ROOM_ID}`,
      participants: { items: [] },
      tags: [],
      activities: { items: [] },
    },
    published: new Date().toISOString(),
    encryptionKeyUrl: 'https://encryption-a.wbx2.com/encryption/api/v1/keys/test-key',
  });

  // Helper to create encrypted message envelope
  const createMessageEnvelope = (personId: string, personEmail: string, text: string) => ({
    id: `envelope-${Date.now()}-${Math.random()}`,
    data: {
      eventType: 'conversation.activity',
      activity: createMercuryActivity(personId, personEmail, text),
    },
  });

  it('should demonstrate RUNAWAY LOOP without ignoreSelfMessages', async () => {
    const messagesProcessed: Array<{ personId: string; text: string }> = [];
    const messagesSent: string[] = [];
    let responseCount = 0;

    let mockWsInstance: any;
    let messageHandler: ((data: string) => void) | undefined;
    let deviceUrl = '';

    // Mock fetch for device registration, KMS, and /people/me
    const mockFetch = jest.fn(async (request) => {
      const url = request.url;

      if (url.includes('wdm/api/v1/devices') && request.method === 'POST') {
        deviceUrl = 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-123';
        return {
          status: 200,
          ok: true,
          json: async () => ({
            url: deviceUrl,
            webSocketUrl: 'wss://mercury-connection.wbx2.com/v1/device-123',
            servicesClusterMetadata: {
              encryptionServiceUrl: 'https://encryption-a.wbx2.com/encryption/api/v1',
            },
          }),
          text: async () => '',
        };
      }

      if (url === deviceUrl && request.method === 'PUT') {
        return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
      }

      // KMS - return mock decryption (we'll just pass text through)
      if (url.includes('/kms/')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            jwk: { kty: 'oct', k: 'dGVzdC1rZXktZGF0YQ' },
          }),
          text: async () => '',
        };
      }

      // /people/me - should NOT be called when ignoreSelfMessages is false
      if (url.includes('/people/me')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            id: BOT_PERSON_ID,
            emails: [BOT_EMAIL],
            displayName: 'Test Bot',
            type: 'bot',
          } as PersonInfo),
          text: async () => '',
        };
      }

      return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
    });

    // Mock WebSocket with message echoing
    const mockWsFactory = jest.fn((url: string) => {
      mockWsInstance = {
        send: jest.fn((data: string) => {
          // When bot "sends" a message (via Webex API in real world),
          // Mercury echoes it back as a new activity
          const sentMsg = `Bot auto-response ${++responseCount}`;
          messagesSent.push(sentMsg);

          // Safety: prevent actual infinite loop in test
          if (responseCount < SAFETY_LIMIT) {
            // Simulate Mercury echoing the bot's message back
            setTimeout(() => {
              if (messageHandler) {
                const botEcho = createMessageEnvelope(BOT_PERSON_ID, BOT_EMAIL, sentMsg);
                messageHandler(JSON.stringify(botEcho));
              }
            }, 5);
          }
        }),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn((event: string, handler: any) => {
          if (event === 'message') {
            messageHandler = handler;
          } else if (event === 'open') {
            setTimeout(() => handler(), 10);
          }
        }),
      };
      return mockWsInstance;
    });

    const handler = new WebexMessageHandler({
      token: 'test-token',
      mode: 'injected',
      fetch: mockFetch,
      webSocketFactory: mockWsFactory,
      ignoreSelfMessages: false, // ❌ BUG: Not filtering self-messages
    });

    // THIS IS THE KEY: Persistent listener that ALWAYS responds to ANY message
    // This is a common bot pattern that can cause loops
    handler.on('message:created', (msg) => {
      messagesProcessed.push({ personId: msg.personId, text: msg.text });

      // Bot ALWAYS responds (this is the pattern that causes loops)
      // In real world, this would be: await webex.messages.create(...)
      // Here we simulate it with ws.send which triggers Mercury echo
      mockWsInstance.send('response');
    });

    await handler.connect();
    await new Promise(resolve => setTimeout(resolve, 50)); // Wait for WS open

    // Verify /people/me was NOT called (ignoreSelfMessages is false)
    const peopleMeCalls = mockFetch.mock.calls.filter(call =>
      call[0].url.includes('/people/me')
    );
    expect(peopleMeCalls.length).toBe(0);

    // Simulate user message arriving
    if (messageHandler) {
      const userMsg = createMessageEnvelope(USER_PERSON_ID, USER_EMAIL, 'Hello bot');
      messageHandler(JSON.stringify(userMsg));
    }

    // Wait for loop to execute
    await new Promise(resolve => setTimeout(resolve, 300));

    await handler.disconnect();

    // BUG REPRODUCED: Bot processes its own messages repeatedly
    console.log('\n🚨 RUNAWAY LOOP DETECTED:');
    console.log(`Messages processed: ${messagesProcessed.length}`);
    console.log(`Auto-responses sent: ${messagesSent.length}`);
    console.log('\nMessage flow:');
    messagesProcessed.forEach((msg, i) => {
      const isBot = msg.personId === BOT_PERSON_ID;
      console.log(`  ${i + 1}. ${isBot ? '🤖 BOT' : '👤 USER'}: ${msg.text}`);
    });

    // WITHOUT ignoreSelfMessages: processes user message + all bot echoes
    expect(messagesProcessed.length).toBeGreaterThan(1);
    expect(messagesProcessed.length).toBe(SAFETY_LIMIT); // Hit safety limit

    // First message is from user
    expect(messagesProcessed[0].personId).toBe(USER_PERSON_ID);

    // All subsequent messages are from bot (the loop!)
    for (let i = 1; i < messagesProcessed.length; i++) {
      expect(messagesProcessed[i].personId).toBe(BOT_PERSON_ID);
    }

    expect(messagesSent.length).toBe(SAFETY_LIMIT);
  }, 15000);

  it('should PREVENT runaway loop with ignoreSelfMessages enabled', async () => {
    const messagesProcessed: Array<{ personId: string; text: string }> = [];
    const messagesSent: string[] = [];
    let responseCount = 0;

    let mockWsInstance: any;
    let messageHandler: ((data: string) => void) | undefined;
    let deviceUrl = '';

    const mockFetch = jest.fn(async (request) => {
      const url = request.url;

      if (url.includes('wdm/api/v1/devices') && request.method === 'POST') {
        deviceUrl = 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-123';
        return {
          status: 200,
          ok: true,
          json: async () => ({
            url: deviceUrl,
            webSocketUrl: 'wss://mercury-connection.wbx2.com/v1/device-123',
            servicesClusterMetadata: {
              encryptionServiceUrl: 'https://encryption-a.wbx2.com/encryption/api/v1',
            },
          }),
          text: async () => '',
        };
      }

      if (url === deviceUrl && request.method === 'PUT') {
        return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
      }

      if (url.includes('/kms/')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            jwk: { kty: 'oct', k: 'dGVzdC1rZXktZGF0YQ' },
          }),
          text: async () => '',
        };
      }

      // ✅ /people/me IS called when ignoreSelfMessages is true
      if (url.includes('/people/me')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            id: BOT_PERSON_ID,
            emails: [BOT_EMAIL],
            displayName: 'Test Bot',
            type: 'bot',
          } as PersonInfo),
          text: async () => '',
        };
      }

      return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
    });

    const mockWsFactory = jest.fn((url: string) => {
      mockWsInstance = {
        send: jest.fn((data: string) => {
          const sentMsg = `Bot auto-response ${++responseCount}`;
          messagesSent.push(sentMsg);

          // Mercury echoes bot's message back
          setTimeout(() => {
            if (messageHandler) {
              const botEcho = createMessageEnvelope(BOT_PERSON_ID, BOT_EMAIL, sentMsg);
              messageHandler(JSON.stringify(botEcho));
            }
          }, 5);
        }),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn((event: string, handler: any) => {
          if (event === 'message') {
            messageHandler = handler;
          } else if (event === 'open') {
            setTimeout(() => handler(), 10);
          }
        }),
      };
      return mockWsInstance;
    });

    const handler = new WebexMessageHandler({
      token: 'test-token',
      mode: 'injected',
      fetch: mockFetch,
      webSocketFactory: mockWsFactory,
      ignoreSelfMessages: true, // ✅ FIX: Filtering self-messages
    });

    // SAME listener as before: ALWAYS responds to ANY message
    handler.on('message:created', (msg) => {
      messagesProcessed.push({ personId: msg.personId, text: msg.text });
      mockWsInstance.send('response');
    });

    await handler.connect();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify /people/me WAS called to fetch bot ID
    const peopleMeCalls = mockFetch.mock.calls.filter(call =>
      call[0].url.includes('/people/me')
    );
    expect(peopleMeCalls.length).toBe(1);

    // Simulate user message arriving
    if (messageHandler) {
      const userMsg = createMessageEnvelope(USER_PERSON_ID, USER_EMAIL, 'Hello bot');
      messageHandler(JSON.stringify(userMsg));
    }

    // Wait to ensure no loop happens
    await new Promise(resolve => setTimeout(resolve, 300));

    await handler.disconnect();

    // FIX WORKS: Bot only processes user message, ignores its own echoes
    console.log('\n✅ LOOP PREVENTED:');
    console.log(`Messages processed: ${messagesProcessed.length}`);
    console.log(`Auto-responses sent: ${messagesSent.length}`);
    console.log('\nMessage flow:');
    messagesProcessed.forEach((msg, i) => {
      const isBot = msg.personId === BOT_PERSON_ID;
      console.log(`  ${i + 1}. ${isBot ? '🤖 BOT' : '👤 USER'}: ${msg.text}`);
    });

    // WITH ignoreSelfMessages: only processes the user message
    expect(messagesProcessed.length).toBe(1);
    expect(messagesProcessed[0].personId).toBe(USER_PERSON_ID);
    expect(messagesProcessed[0].text).toBe('Hello bot');

    // Bot sent one response, but didn't process its own echo
    expect(messagesSent.length).toBe(1);
  }, 15000);

  it('should show multiple user messages work correctly with filtering', async () => {
    const messagesProcessed: Array<{ personId: string; text: string }> = [];

    let mockWsInstance: any;
    let messageHandler: ((data: string) => void) | undefined;
    let deviceUrl = '';

    const mockFetch = jest.fn(async (request) => {
      const url = request.url;

      if (url.includes('wdm/api/v1/devices') && request.method === 'POST') {
        deviceUrl = 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-123';
        return {
          status: 200,
          ok: true,
          json: async () => ({
            url: deviceUrl,
            webSocketUrl: 'wss://mercury-connection.wbx2.com/v1/device-123',
            servicesClusterMetadata: {
              encryptionServiceUrl: 'https://encryption-a.wbx2.com/encryption/api/v1',
            },
          }),
          text: async () => '',
        };
      }

      if (url === deviceUrl && request.method === 'PUT') {
        return { status: 200, ok: true, json: async () => ({}), text: async () => '' };
      }

      if (url.includes('/kms/')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ jwk: { kty: 'oct', k: 'dGVzdC1rZXktZGF0YQ' } }),
          text: async () => '',
        };
      }

      if (url.includes('/people/me')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            id: BOT_PERSON_ID,
            emails: [BOT_EMAIL],
            displayName: 'Test Bot',
            type: 'bot',
          } as PersonInfo),
          text: async () => '',
        };
      }

      return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
    });

    const mockWsFactory = jest.fn((url: string) => {
      mockWsInstance = {
        send: jest.fn((data: string) => {
          // Echo bot's response back
          setTimeout(() => {
            if (messageHandler) {
              const botEcho = createMessageEnvelope(BOT_PERSON_ID, BOT_EMAIL, data);
              messageHandler(JSON.stringify(botEcho));
            }
          }, 5);
        }),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn((event: string, handler: any) => {
          if (event === 'message') {
            messageHandler = handler;
          } else if (event === 'open') {
            setTimeout(() => handler(), 10);
          }
        }),
      };
      return mockWsInstance;
    });

    const handler = new WebexMessageHandler({
      token: 'test-token',
      mode: 'injected',
      fetch: mockFetch,
      webSocketFactory: mockWsFactory,
      ignoreSelfMessages: true,
    });

    handler.on('message:created', (msg) => {
      messagesProcessed.push({ personId: msg.personId, text: msg.text });
      mockWsInstance.send(`Response to: ${msg.text}`);
    });

    await handler.connect();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Send multiple user messages
    if (messageHandler) {
      messageHandler(JSON.stringify(createMessageEnvelope(USER_PERSON_ID, USER_EMAIL, 'Message 1')));
      await new Promise(resolve => setTimeout(resolve, 20));

      messageHandler(JSON.stringify(createMessageEnvelope(USER_PERSON_ID, USER_EMAIL, 'Message 2')));
      await new Promise(resolve => setTimeout(resolve, 20));

      messageHandler(JSON.stringify(createMessageEnvelope(USER_PERSON_ID, USER_EMAIL, 'Message 3')));
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    await new Promise(resolve => setTimeout(resolve, 100));
    await handler.disconnect();

    // Should process exactly 3 user messages (bot echoes are filtered)
    expect(messagesProcessed.length).toBe(3);
    expect(messagesProcessed[0].text).toBe('Message 1');
    expect(messagesProcessed[1].text).toBe('Message 2');
    expect(messagesProcessed[2].text).toBe('Message 3');

    // All processed messages are from user
    messagesProcessed.forEach(msg => {
      expect(msg.personId).toBe(USER_PERSON_ID);
    });
  }, 15000);
});
