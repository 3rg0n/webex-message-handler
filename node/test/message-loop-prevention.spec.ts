import { EventEmitter } from 'events';
import { WebexMessageHandler } from '../src/handler';
import type { MercuryActivity, DeviceRegistration } from '../src/types';

/**
 * Integration test for message loop prevention.
 *
 * Uses the same jest.mock pattern as handler.spec.ts to mock sub-components
 * (DeviceManager, MercurySocket, KmsClient, MessageDecryptor) while letting
 * the handler's REAL filtering logic (_handleActivity) run.
 *
 * This tests the actual handler code path, not a simulation.
 */

// /people/me returns base64-encoded Webex IDs:
//   "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9ib3QtdXVpZC0xMjM0" decodes to
//   "ciscospark://us/PEOPLE/bot-uuid-1234"
// Mercury wire format uses raw UUIDs as actor.id:
//   "bot-uuid-1234"
// The handler must normalize both to the raw UUID for comparison.
const BOT_WEBEX_ID = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9ib3QtdXVpZC0xMjM0'; // base64("ciscospark://us/PEOPLE/bot-uuid-1234")
const BOT_RAW_UUID = 'bot-uuid-1234'; // What Mercury uses as actor.id
const USER_RAW_UUID = 'user-uuid-5678'; // A different user's raw UUID
const SAFETY_LIMIT = 10;

// --- Mock sub-components (same pattern as handler.spec.ts) ---

const mockDeviceManager = {
  register: jest.fn(),
  refresh: jest.fn(),
  unregister: jest.fn(),
};

class MockMercurySocket extends EventEmitter {
  connected = false;
  currentReconnectAttempts = 0;
  connect = jest.fn();
  disconnect = jest.fn();
}

const mockKmsClient = {
  initialize: jest.fn(),
  handleKmsMessage: jest.fn(),
};

const mockMessageDecryptor = {
  decryptActivity: jest.fn(),
};

jest.mock('../src/device-manager', () => ({
  DeviceManager: jest.fn(() => mockDeviceManager),
}));

jest.mock('../src/mercury-socket', () => ({
  MercurySocket: jest.fn(() => new MockMercurySocket()),
}));

jest.mock('../src/kms-client', () => ({
  KmsClient: jest.fn(() => mockKmsClient),
}));

jest.mock('../src/message-decryptor', () => ({
  MessageDecryptor: jest.fn(() => mockMessageDecryptor),
}));

// --- Test data ---

const mockRegistration: DeviceRegistration = {
  webSocketUrl: 'wss://mercury.example.com/socket',
  deviceUrl: 'https://device.example.com',
  userId: 'user-123',
  services: {
    encryptionServiceUrl: 'https://encryption.example.com',
    messenger: 'https://messenger.example.com',
  },
  encryptionServiceUrl: 'https://encryption.example.com',
};

function createActivity(personId: string, text: string): MercuryActivity {
  return {
    id: `activity-${Date.now()}-${Math.random()}`,
    verb: 'post',
    actor: {
      id: personId,
      objectType: 'person',
      emailAddress: personId === BOT_RAW_UUID ? 'bot@webex.bot' : 'user@example.com',
    },
    object: {
      id: `comment-${Date.now()}`,
      objectType: 'comment',
      displayName: text,
      content: `<p>${text}</p>`,
    },
    target: {
      id: 'room-101',
      objectType: 'conversation',
      tags: ['GROUP'],
    },
    published: new Date().toISOString(),
  };
}

// --- Tests ---

describe('Message Loop Prevention (Real Handler Integration)', () => {
  // Mock global fetch for /people/me (used by _fetchBotPersonId)
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeviceManager.register.mockResolvedValue(mockRegistration);
    mockDeviceManager.unregister.mockResolvedValue(undefined);
    mockKmsClient.initialize.mockResolvedValue(undefined);
    // Decryptor passes activity through (simulates successful decryption)
    mockMessageDecryptor.decryptActivity.mockImplementation((activity) =>
      Promise.resolve(activity)
    );
    // Mock fetch for /people/me — returns base64-encoded Webex ID (like the real API)
    global.fetch = jest.fn(async (url: any) => {
      if (String(url).includes('/people/me')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            id: BOT_WEBEX_ID, // base64-encoded, NOT the raw UUID Mercury uses
            emails: ['bot@webex.bot'],
            displayName: 'Test Bot',
            type: 'bot',
          }),
          text: async () => '',
        } as any;
      }
      return originalFetch(url);
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('WITHOUT ignoreSelfMessages: bot processes its own messages (loop)', async () => {
    const handler = new WebexMessageHandler({ token: 'test-token', ignoreSelfMessages: false });
    await handler.connect();

    const mercury = handler['mercurySocket'] as unknown as MockMercurySocket;
    const messagesReceived: Array<{ personId: string; text: string }> = [];

    // Persistent listener: bot ALWAYS responds to ANY message
    handler.on('message:created', (msg) => {
      messagesReceived.push({ personId: msg.personId, text: msg.text });

      // Bot "responds" — Mercury echoes it back with raw UUID (as real Mercury does)
      if (messagesReceived.length < SAFETY_LIMIT) {
        const botEcho = createActivity(BOT_RAW_UUID, `Bot reply #${messagesReceived.length}`);
        mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(botEcho);
        mercury.emit('activity', botEcho);
      }
    });

    // User sends initial message (raw UUID from Mercury)
    const userMsg = createActivity(USER_RAW_UUID, 'Hello bot');
    mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(userMsg);
    mercury.emit('activity', userMsg);

    // Let the event loop process all messages
    await new Promise(resolve => setTimeout(resolve, 100));
    await handler.disconnect();

    // Without filtering: Bot processed its own echo messages, creating a loop
    expect(messagesReceived.length).toBe(SAFETY_LIMIT);
    expect(messagesReceived[0].personId).toBe(USER_RAW_UUID);
    expect(messagesReceived[0].text).toBe('Hello bot');

    // All subsequent messages are from the bot itself (the loop!)
    for (let i = 1; i < messagesReceived.length; i++) {
      expect(messagesReceived[i].personId).toBe(BOT_RAW_UUID);
    }
  });

  it('WITH ignoreSelfMessages: bot ignores its own messages despite ID format mismatch', async () => {
    const handler = new WebexMessageHandler({
      token: 'test-token',
      ignoreSelfMessages: true,
    });
    await handler.connect();

    // Verify /people/me was called and bot ID was normalized to raw UUID
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/people/me'),
      expect.anything()
    );
    // extractPersonUuid normalizes the base64 Webex ID to the raw UUID
    expect(handler['botPersonId']).toBe(BOT_RAW_UUID);

    const mercury = handler['mercurySocket'] as unknown as MockMercurySocket;
    const messagesReceived: Array<{ personId: string; text: string }> = [];

    // Same persistent listener: bot ALWAYS responds to ANY message
    handler.on('message:created', (msg) => {
      messagesReceived.push({ personId: msg.personId, text: msg.text });

      // Bot "responds" — Mercury echoes it back with raw UUID (as real Mercury does)
      const botEcho = createActivity(BOT_RAW_UUID, `Bot reply #${messagesReceived.length}`);
      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(botEcho);
      mercury.emit('activity', botEcho);
    });

    // User sends initial message (raw UUID from Mercury)
    const userMsg = createActivity(USER_RAW_UUID, 'Hello bot');
    mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(userMsg);
    mercury.emit('activity', userMsg);

    // Let the event loop process
    await new Promise(resolve => setTimeout(resolve, 100));
    await handler.disconnect();

    // FIX: Bot only processed the user's message, ignored its own echo
    // even though /people/me returned base64-encoded ID and Mercury uses raw UUID
    expect(messagesReceived.length).toBe(1);
    expect(messagesReceived[0].personId).toBe(USER_RAW_UUID);
    expect(messagesReceived[0].text).toBe('Hello bot');
  });

  it('WITH ignoreSelfMessages: multiple user messages work, bot echoes filtered', async () => {
    const handler = new WebexMessageHandler({
      token: 'test-token',
      ignoreSelfMessages: true,
    });
    await handler.connect();

    const mercury = handler['mercurySocket'] as unknown as MockMercurySocket;
    const messagesReceived: Array<{ personId: string; text: string }> = [];

    handler.on('message:created', (msg) => {
      messagesReceived.push({ personId: msg.personId, text: msg.text });

      // Bot responds to every message — Mercury echoes back with raw UUID
      const botEcho = createActivity(BOT_RAW_UUID, `Reply to: ${msg.text}`);
      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(botEcho);
      mercury.emit('activity', botEcho);
    });

    // 3 different users send messages (raw UUIDs from Mercury)
    for (const text of ['Hello', 'How are you?', 'Goodbye']) {
      const msg = createActivity(USER_RAW_UUID, text);
      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(msg);
      mercury.emit('activity', msg);
      await new Promise(resolve => setImmediate(resolve));
    }

    await new Promise(resolve => setTimeout(resolve, 100));
    await handler.disconnect();

    // Only user messages were processed (3), all bot echoes filtered
    expect(messagesReceived.length).toBe(3);
    expect(messagesReceived[0].text).toBe('Hello');
    expect(messagesReceived[1].text).toBe('How are you?');
    expect(messagesReceived[2].text).toBe('Goodbye');
    messagesReceived.forEach(msg => {
      expect(msg.personId).toBe(USER_RAW_UUID);
    });
  });

  it('WITHOUT ignoreSelfMessages: /people/me is NOT called', async () => {
    const handler = new WebexMessageHandler({ token: 'test-token', ignoreSelfMessages: false });
    await handler.connect();

    // /people/me should never be called
    const fetchCalls = (global.fetch as jest.Mock).mock.calls;
    const peopleMeCalls = fetchCalls.filter((call: any[]) =>
      String(call[0]).includes('/people/me')
    );
    expect(peopleMeCalls.length).toBe(0);
    expect(handler['botPersonId']).toBeNull();

    await handler.disconnect();
  });

  it('/people/me failure degrades gracefully (no filtering, no crash)', async () => {
    // Override fetch to fail for /people/me
    global.fetch = jest.fn(async () => ({
      status: 500,
      ok: false,
      json: async () => ({ message: 'Internal Server Error' }),
      text: async () => 'Internal Server Error',
    })) as any;

    const handler = new WebexMessageHandler({
      token: 'test-token',
      ignoreSelfMessages: true,
    });

    // Should not throw even though /people/me fails
    await handler.connect();

    // Bot person ID not cached — filtering won't work
    expect(handler['botPersonId']).toBeNull();

    const mercury = handler['mercurySocket'] as unknown as MockMercurySocket;
    const messagesReceived: string[] = [];

    handler.on('message:created', (msg) => {
      messagesReceived.push(msg.personId);
    });

    // Bot message comes in — without cached ID, filtering can't work
    const botMsg = createActivity(BOT_RAW_UUID, 'Bot message');
    mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(botMsg);
    mercury.emit('activity', botMsg);

    await new Promise(resolve => setImmediate(resolve));
    await handler.disconnect();

    // Message was NOT filtered (graceful degradation)
    expect(messagesReceived.length).toBe(1);
    expect(messagesReceived[0]).toBe(BOT_RAW_UUID);
  });
});
