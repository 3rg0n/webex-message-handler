import { WebexMessageHandler } from '../src/handler.js';
import type { PersonInfo, MercuryActivity } from '../src/types.js';

/**
 * Tests for ignoreSelfMessages filtering logic.
 *
 * These tests mock the decryption layer and test that the handler correctly
 * filters out bot's own messages when ignoreSelfMessages is enabled.
 *
 * This validates the ACTUAL filtering bug discovered in production:
 * - Bot sends message → Mercury echoes it back → Bot processes it again → Loop!
 */
describe('Self-Message Filtering (Real Bug Test)', () => {
  const BOT_PERSON_ID = 'bot-123';
  const USER_PERSON_ID = 'user-456';
  const ROOM_ID = 'room-789';

  // Helper to create mock decrypted activity
  const createMockActivity = (personId: string, text: string): any => ({
    verb: 'post',
    object: {
      objectType: 'comment',
      id: `msg-${Date.now()}-${Math.random()}`,
      displayName: text,
      content: `<p>${text}</p>`,
    },
    actor: {
      id: personId,
      emailAddress: personId === BOT_PERSON_ID ? 'bot@webex.bot' : 'user@example.com',
    },
    target: {
      id: ROOM_ID,
      tags: [],
    },
    published: new Date().toISOString(),
  });

  it('should process ALL messages (user + bot) when ignoreSelfMessages is FALSE', async () => {
    const messagesReceived: string[] = [];
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
            webSocketUrl: 'wss://mercury.wbx2.com/ws',
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
          json: async () => ({ jwk: { kty: 'oct', k: 'dGVzdC1rZXk' } }),
          text: async () => '',
        };
      }

      // Should NOT call /people/me when ignoreSelfMessages is false
      if (url.includes('/people/me')) {
        throw new Error('/people/me should not be called when ignoreSelfMessages is false');
      }

      return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
    });

    const mockWsFactory = jest.fn((url: string) => ({
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1,
      on: jest.fn((event: string, handler: any) => {
        if (event === 'open') {
          setTimeout(() => handler(), 10);
        }
      }),
    }));

    const handler = new WebexMessageHandler({
      token: 'test-token',
      mode: 'injected',
      fetch: mockFetch,
      webSocketFactory: mockWsFactory,
      ignoreSelfMessages: false, // ❌ NO FILTERING
    });

    handler.on('message:created', (msg) => {
      messagesReceived.push(`${msg.personId}: ${msg.text}`);
    });

    await handler.connect();

    // Mock the MessageDecryptor to return test activities
    if (handler['messageDecryptor']) {
      const originalDecrypt = handler['messageDecryptor'].decryptActivity.bind(
        handler['messageDecryptor']
      );

      handler['messageDecryptor'].decryptActivity = jest.fn(async (activity: MercuryActivity) => {
        // Return mock decrypted activities based on input
        // In real world, these would be encrypted, but we bypass that
        return activity as any;
      });
    }

    // Simulate receiving messages from Mercury (mix of user and bot messages)
    await handler['_handleActivity'](createMockActivity(USER_PERSON_ID, 'User message 1'));
    await handler['_handleActivity'](createMockActivity(BOT_PERSON_ID, 'Bot response 1'));
    await handler['_handleActivity'](createMockActivity(BOT_PERSON_ID, 'Bot response 2'));
    await handler['_handleActivity'](createMockActivity(USER_PERSON_ID, 'User message 2'));
    await handler['_handleActivity'](createMockActivity(BOT_PERSON_ID, 'Bot response 3'));

    await handler.disconnect();

    // WITHOUT filtering: ALL messages processed (this is the bug!)
    console.log('\n❌ WITHOUT ignoreSelfMessages - processes EVERYTHING:');
    messagesReceived.forEach((msg, i) => console.log(`  ${i + 1}. ${msg}`));

    expect(messagesReceived.length).toBe(5);
    expect(messagesReceived[0]).toContain(USER_PERSON_ID);
    expect(messagesReceived[1]).toContain(BOT_PERSON_ID); // Bot processed its own message!
    expect(messagesReceived[2]).toContain(BOT_PERSON_ID); // Bot processed its own message!
    expect(messagesReceived[3]).toContain(USER_PERSON_ID);
    expect(messagesReceived[4]).toContain(BOT_PERSON_ID); // Bot processed its own message!
  }, 10000);

  it('should filter bot messages when ignoreSelfMessages is TRUE', async () => {
    const messagesReceived: string[] = [];
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
            webSocketUrl: 'wss://mercury.wbx2.com/ws',
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
          json: async () => ({ jwk: { kty: 'oct', k: 'dGVzdC1rZXk' } }),
          text: async () => '',
        };
      }

      // SHOULD call /people/me when ignoreSelfMessages is true
      if (url.includes('/people/me')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            id: BOT_PERSON_ID,
            emails: ['bot@webex.bot'],
            displayName: 'Test Bot',
            type: 'bot',
          } as PersonInfo),
          text: async () => '',
        };
      }

      return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
    });

    const mockWsFactory = jest.fn((url: string) => ({
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1,
      on: jest.fn((event: string, handler: any) => {
        if (event === 'open') {
          setTimeout(() => handler(), 10);
        }
      }),
    }));

    const handler = new WebexMessageHandler({
      token: 'test-token',
      mode: 'injected',
      fetch: mockFetch,
      webSocketFactory: mockWsFactory,
      ignoreSelfMessages: true, // ✅ FILTERING ENABLED
    });

    handler.on('message:created', (msg) => {
      messagesReceived.push(`${msg.personId}: ${msg.text}`);
    });

    await handler.connect();

    // Verify /people/me was called and bot ID cached
    const peopleMeCalls = mockFetch.mock.calls.filter(call =>
      call[0].url.includes('/people/me')
    );
    expect(peopleMeCalls.length).toBe(1);
    expect(handler['botPersonId']).toBe(BOT_PERSON_ID);

    // Mock the MessageDecryptor
    if (handler['messageDecryptor']) {
      handler['messageDecryptor'].decryptActivity = jest.fn(async (activity: MercuryActivity) => {
        return activity as any;
      });
    }

    // Simulate same message stream as before
    await handler['_handleActivity'](createMockActivity(USER_PERSON_ID, 'User message 1'));
    await handler['_handleActivity'](createMockActivity(BOT_PERSON_ID, 'Bot response 1'));
    await handler['_handleActivity'](createMockActivity(BOT_PERSON_ID, 'Bot response 2'));
    await handler['_handleActivity'](createMockActivity(USER_PERSON_ID, 'User message 2'));
    await handler['_handleActivity'](createMockActivity(BOT_PERSON_ID, 'Bot response 3'));

    await handler.disconnect();

    // WITH filtering: only USER messages processed (fix works!)
    console.log('\n✅ WITH ignoreSelfMessages - filters bot messages:');
    messagesReceived.forEach((msg, i) => console.log(`  ${i + 1}. ${msg}`));

    expect(messagesReceived.length).toBe(2);
    expect(messagesReceived[0]).toContain(USER_PERSON_ID);
    expect(messagesReceived[0]).toContain('User message 1');
    expect(messagesReceived[1]).toContain(USER_PERSON_ID);
    expect(messagesReceived[1]).toContain('User message 2');

    // Verify NO bot messages were emitted
    messagesReceived.forEach(msg => {
      expect(msg).not.toContain(BOT_PERSON_ID);
    });
  }, 10000);

  it('should demonstrate the runaway loop scenario', async () => {
    console.log('\n🔄 SIMULATING RUNAWAY LOOP SCENARIO:');
    console.log('   User sends: "Hello"');
    console.log('   Bot receives → Responds: "Hi there!"');
    console.log('   Mercury echoes bot response back to bot');
    console.log('   WITHOUT filtering: Bot receives own message → Responds again...');
    console.log('   WITH filtering: Bot ignores own message → Loop prevented!');

    // This is a documentation test showing the problem
    expect(true).toBe(true);
  });
});
