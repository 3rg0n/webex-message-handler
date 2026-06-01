import { EventEmitter } from 'events';
import { WebexMessageHandler } from '../src/handler';
import type { MercuryActivity, DeviceRegistration } from '../src/types';

// Mock DeviceManager
const mockDeviceManager = {
  register: jest.fn(),
  refresh: jest.fn(),
  unregister: jest.fn(),
};

// Mock MercurySocket
class MockMercurySocket extends EventEmitter {
  connected = false;
  connect = jest.fn();
  disconnect = jest.fn();
}

// Mock KmsClient
const mockKmsClient = {
  initialize: jest.fn(),
};

// Mock MessageDecryptor
const mockMessageDecryptor = {
  decryptActivity: jest.fn(),
};

jest.mock('../src/device-manager', () => {
  return {
    DeviceManager: jest.fn(() => mockDeviceManager),
  };
});

jest.mock('../src/mercury-socket', () => {
  return {
    MercurySocket: jest.fn(() => new MockMercurySocket()),
  };
});

jest.mock('../src/kms-client', () => {
  return {
    KmsClient: jest.fn(() => mockKmsClient),
  };
});

jest.mock('../src/message-decryptor', () => {
  return {
    MessageDecryptor: jest.fn(() => mockMessageDecryptor),
  };
});

describe('WebexMessageHandler', () => {
  const mockToken = 'test-token';
  const mockDeviceRegistration: DeviceRegistration = {
    webSocketUrl: 'wss://mercury.example.com/socket',
    deviceUrl: 'https://device.example.com',
    userId: 'user-123',
    services: {
      encryptionServiceUrl: 'https://encryption.example.com',
      messenger: 'https://messenger.example.com',
    },
    encryptionServiceUrl: 'https://encryption.example.com',
  };

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDeviceManager.register.mockReset().mockResolvedValue(mockDeviceRegistration);
    mockDeviceManager.refresh.mockReset().mockResolvedValue(mockDeviceRegistration);
    mockDeviceManager.unregister.mockReset().mockResolvedValue(undefined);
    mockKmsClient.initialize.mockReset().mockResolvedValue(undefined);
    mockMessageDecryptor.decryptActivity.mockReset().mockImplementation((activity) =>
      Promise.resolve(activity)
    );

    // Mock global.fetch for /people/me (required by ignoreSelfMessages default: true)
    global.fetch = jest.fn(async (url: any, opts: any) => {
      if (String(url).includes('/people/me')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ id: 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9ib3QtaWQ', emails: ['bot@test.com'], displayName: 'Bot', type: 'bot' }),
          text: async () => '',
        };
      }
      return originalFetch(url, opts);
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('connect', () => {
    it('should call register, initialize, and connect in order', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });

      await handler.connect();

      expect(mockDeviceManager.register).toHaveBeenCalledWith(mockToken);
      expect(mockKmsClient.initialize).toHaveBeenCalled();
      expect(handler['mercurySocket'].connect).toHaveBeenCalledWith(
        mockDeviceRegistration.webSocketUrl,
        mockToken
      );
    });

    it('should emit connected event', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      const connectedListener = jest.fn();
      handler.on('connected', connectedListener);

      await handler.connect();

      expect(connectedListener).toHaveBeenCalled();
    });

    it('should set connected getter to true', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });

      expect(handler.connected).toBe(false);

      await handler.connect();

      // Set mercury connected to true
      (handler['mercurySocket'] as any).connected = true;

      expect(handler.connected).toBe(true);
    });

    it('should throw if registration fails', async () => {
      mockDeviceManager.register.mockRejectedValueOnce(
        new Error('Registration failed')
      );

      const handler = new WebexMessageHandler({ token: mockToken });

      await expect(handler.connect()).rejects.toThrow('Registration failed');
    });

    it('should throw if KMS initialization fails', async () => {
      mockKmsClient.initialize.mockRejectedValueOnce(
        new Error('KMS init failed')
      );

      const handler = new WebexMessageHandler({ token: mockToken });

      await expect(handler.connect()).rejects.toThrow('KMS init failed');
    });

    it('should throw if Mercury connection fails', async () => {
      const MercurySocket = require('../src/mercury-socket.js').MercurySocket as jest.Mock;
      const mockMercury = {
        connect: jest.fn().mockRejectedValueOnce(new Error('Connection failed')),
        disconnect: jest.fn(),
        on: jest.fn(),
        connected: false,
      };
      MercurySocket.mockReturnValueOnce(mockMercury);

      const handler = new WebexMessageHandler({ token: mockToken });

      await expect(handler.connect()).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect', () => {
    it('should call disconnect and unregister', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });

      await handler.connect();
      await handler.disconnect();

      expect(handler['mercurySocket'].disconnect).toHaveBeenCalled();
      expect(mockDeviceManager.unregister).toHaveBeenCalledWith(mockToken);
    });

    it('should emit disconnected event through Mercury', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      const disconnectListener = jest.fn();
      handler.on('disconnected', disconnectListener);

      await handler.connect();

      // Simulate Mercury disconnect
      const mercury = handler['mercurySocket'] as any;
      mercury.emit('disconnected', 'test-reason');

      expect(disconnectListener).toHaveBeenCalledWith('test-reason');
    });

    it('should set connected getter to false', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });

      await handler.connect();
      (handler['mercurySocket'] as any).connected = true;
      expect(handler.connected).toBe(true);

      await handler.disconnect();
      expect(handler.connected).toBe(false);
    });

    it('should not throw if unregister fails', async () => {
      mockDeviceManager.unregister.mockRejectedValueOnce(
        new Error('Unregister failed')
      );

      const handler = new WebexMessageHandler({ token: mockToken });

      await handler.connect();

      // Should not throw
      await handler.disconnect();

      expect(mockDeviceManager.unregister).toHaveBeenCalled();
    });

    it('should set registration to null after disconnect', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });

      await handler.connect();
      expect(handler['registration']).not.toBeNull();

      await handler.disconnect();
      expect(handler['registration']).toBeNull();
    });
  });

  describe('message handling', () => {
    it('should emit message:created for post+comment activity', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
          displayName: 'Test Message',
          content: '<p>Test Message</p>',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-123',
          roomId: 'room-101',
          personId: 'person-456',
          personEmail: 'user@example.com',
          text: 'Test Message',
          html: '<p>Test Message</p>',
          created: '2024-01-01T00:00:00Z',
          roomType: 'group',
        })
      );
    });

    it('should emit message:deleted for delete+activity', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const deleteListener = jest.fn();
      handler.on('message:deleted', deleteListener);

      const activity: MercuryActivity = {
        id: 'delete-event-123',
        verb: 'delete',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-789',
          objectType: 'activity',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:01Z',
      };

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(deleteListener).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-789',
          roomId: 'room-101',
          personId: 'person-456',
        })
      );
    });

    it('should infer room type as direct for ONE_ON_ONE', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
          displayName: 'Hello',
          content: '<p>Hello</p>',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
          tags: ['ONE_ON_ONE'],
        },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({
          roomType: 'direct',
        })
      );
    });

    it('should infer room type as group for TEAM', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
          displayName: 'Hello',
          content: '<p>Hello</p>',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
          tags: ['TEAM'],
        },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({
          roomType: 'group',
        })
      );
    });

    it('should handle undefined displayName', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
          content: '<p>Hello</p>',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '',
        })
      );
    });

    it('should include raw activity in message', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
          displayName: 'Test',
          content: '<p>Test</p>',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({
          raw: activity,
        })
      );
    });
  });

  describe('error forwarding', () => {
    it('should forward Mercury error events', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const errorListener = jest.fn();
      handler.on('error', errorListener);

      const error = new Error('Mercury connection error');
      const mercury = handler['mercurySocket'] as any;
      mercury.emit('error', error);

      expect(errorListener).toHaveBeenCalledWith(error);
    });

    it('should emit error on activity handling failure', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const errorListener = jest.fn();
      handler.on('error', errorListener);

      mockMessageDecryptor.decryptActivity.mockRejectedValueOnce(
        new Error('Decryption failed')
      );

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
          displayName: 'Test',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      return new Promise(resolve => {
        setTimeout(() => {
          expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
          resolve(undefined);
        }, 50);
      });
    });
  });

  describe('reconnection handling', () => {
    it('should emit reconnecting event from Mercury', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const reconnectListener = jest.fn();
      handler.on('reconnecting', reconnectListener);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('reconnecting', 1);

      expect(reconnectListener).toHaveBeenCalledWith(1);
    });

    it('should refresh device on reconnection', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('connected');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockDeviceManager.refresh).toHaveBeenCalledWith(mockToken);
    });

    it('should re-initialize KMS on reconnection', async () => {
      mockDeviceManager.register.mockClear();
      mockKmsClient.initialize.mockClear();

      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      mockDeviceManager.register.mockClear();
      mockKmsClient.initialize.mockClear();

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('connected');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockKmsClient.initialize).toHaveBeenCalled();
    });

    it('should emit connected event on reconnection', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const connectedListener = jest.fn();
      handler.on('connected', connectedListener);

      connectedListener.mockClear(); // Clear from initial connect

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('connected');

      await new Promise(resolve => setImmediate(resolve));

      expect(connectedListener).toHaveBeenCalled();
    });

    it('should not throw on device refresh failure during reconnect', async () => {
      mockDeviceManager.refresh.mockRejectedValueOnce(
        new Error('Refresh failed')
      );

      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const mercury = handler['mercurySocket'] as any;

      // Should not throw
      mercury.emit('connected');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockDeviceManager.refresh).toHaveBeenCalled();
    });

    it('should not throw on KMS re-init failure during reconnect', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      mockKmsClient.initialize.mockRejectedValueOnce(
        new Error('KMS re-init failed')
      );

      const mercury = handler['mercurySocket'] as any;

      // Should not throw
      mercury.emit('connected');

      await new Promise(resolve => setImmediate(resolve));

      expect(mockKmsClient.initialize).toHaveBeenCalled();
    });
  });

  describe('connected getter', () => {
    it('should return true when both handler and mercury are connected', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });

      expect(handler.connected).toBe(false);

      await handler.connect();

      const mercury = handler['mercurySocket'] as MockMercurySocket;
      mercury.connected = true;

      expect(handler.connected).toBe(true);
    });

    it('should return false when handler is not connected', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });

      expect(handler.connected).toBe(false);
    });

    it('should return false when Mercury is not connected', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const mercury = handler['mercurySocket'] as MockMercurySocket;
      mercury.connected = false;

      expect(handler.connected).toBe(false);
    });
  });

  describe('deviceRegistration accessor', () => {
    it('should return null before connect', () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      expect(handler.deviceRegistration()).toBeNull();
      expect(handler.serviceUrl('encryptionServiceUrl')).toBeUndefined();
    });

    it('should return registration and resolve service URLs after connect', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const reg = handler.deviceRegistration();
      expect(reg).not.toBeNull();
      expect(reg?.userId).toBe('user-123');
      expect(reg?.services.encryptionServiceUrl).toBe('https://encryption.example.com');
      expect(handler.serviceUrl('messenger')).toBe('https://messenger.example.com');
      expect(handler.serviceUrl('nonexistent')).toBeUndefined();
    });

    it('should return a copy that does not leak into internal state', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const reg = handler.deviceRegistration()!;
      reg.services.encryptionServiceUrl = 'https://evil.example.com';
      reg.userId = 'tampered';

      const fresh = handler.deviceRegistration()!;
      expect(fresh.services.encryptionServiceUrl).toBe('https://encryption.example.com');
      expect(fresh.userId).toBe('user-123');
    });
  });

  describe('activity url propagation', () => {
    it('should propagate the raw activity url onto DecryptedMessage', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'msg-123',
        url: 'https://conv-a.wbx2.com/conversation/api/v1/activities/msg-123',
        verb: 'post',
        actor: { id: 'person-456', objectType: 'person', emailAddress: 'user@example.com' },
        object: { id: 'comment-789', objectType: 'comment', displayName: 'Hi', content: '<p>Hi</p>' },
        target: { id: 'room-101', objectType: 'conversation', tags: ['GROUP'] },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);
      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-123',
          url: 'https://conv-a.wbx2.com/conversation/api/v1/activities/msg-123',
        })
      );
    });
  });

  describe('constructor options', () => {
    it('should pass logger to components', async () => {
      const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      const handler = new WebexMessageHandler({
        token: mockToken,
        logger,
      });

      // Verify logger was passed (check via component initialization)
      expect(handler['logger']).toBe(logger);
    });

    it('should pass Mercury socket options', () => {
      const MercurySocket = require('../src/mercury-socket.js')
        .MercurySocket as jest.Mock;

      new WebexMessageHandler({
        token: mockToken,
        pingInterval: 30000,
        pongTimeout: 25000,
        reconnectBackoffMax: 60000,
        maxReconnectAttempts: 20,
      });

      expect(MercurySocket).toHaveBeenCalledWith(
        expect.objectContaining({
          pingInterval: 30000,
          pongTimeout: 25000,
          reconnectBackoffMax: 60000,
          maxReconnectAttempts: 20,
        })
      );
    });
  });

  describe('ignoring non-message activities', () => {
    it('should ignore activities with unrecognized verb types', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      const updateListener = jest.fn();
      const deleteListener = jest.fn();
      handler.on('message:created', messageListener);
      handler.on('message:updated', updateListener);
      handler.on('message:deleted', deleteListener);

      const activity: MercuryActivity = {
        id: 'activity-123',
        verb: 'acknowledge',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).not.toHaveBeenCalled();
      expect(updateListener).not.toHaveBeenCalled();
      expect(deleteListener).not.toHaveBeenCalled();
    });

    it('should ignore post activities with non-comment objectType', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'activity-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'file-789',
          objectType: 'file',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).not.toHaveBeenCalled();
    });
  });

  describe('membership handling', () => {
    const membershipVerbs = ['add', 'leave', 'assignModerator', 'unassignModerator'];

    for (const verb of membershipVerbs) {
      it(`should emit membership:created for verb=${verb} with objectType=person`, async () => {
        const handler = new WebexMessageHandler({ token: mockToken });
        await handler.connect();

        const membershipListener = jest.fn();
        handler.on('membership:created', membershipListener);

        const activity: MercuryActivity = {
          id: 'membership-event-123',
          verb,
          actor: {
            id: 'admin-456',
            objectType: 'person',
            emailAddress: 'admin@example.com',
          },
          object: {
            id: 'member-789',
            objectType: 'person',
          },
          target: {
            id: 'room-101',
            objectType: 'conversation',
            tags: ['GROUP'],
          },
          published: '2024-01-01T00:00:00Z',
        };

        const mercury = handler['mercurySocket'] as any;
        mercury.emit('activity', activity);

        await new Promise(resolve => setImmediate(resolve));

        expect(membershipListener).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'membership-event-123',
            actorId: 'admin-456',
            personId: 'member-789',
            roomId: 'room-101',
            action: verb,
            created: '2024-01-01T00:00:00Z',
            roomType: 'group',
          })
        );
      });
    }

    it('should not emit membership:created for non-membership verb with objectType=person', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const membershipListener = jest.fn();
      handler.on('membership:created', membershipListener);

      const activity: MercuryActivity = {
        id: 'activity-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
        },
        object: {
          id: 'person-789',
          objectType: 'person',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(membershipListener).not.toHaveBeenCalled();
    });

    it('should not emit membership:created for membership verb with non-person objectType', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const membershipListener = jest.fn();
      handler.on('membership:created', membershipListener);

      const activity: MercuryActivity = {
        id: 'activity-123',
        verb: 'add',
        actor: {
          id: 'person-456',
          objectType: 'person',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(membershipListener).not.toHaveBeenCalled();
    });

    it('should include raw activity in membership event', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const membershipListener = jest.fn();
      handler.on('membership:created', membershipListener);

      const activity: MercuryActivity = {
        id: 'membership-event-123',
        verb: 'add',
        actor: {
          id: 'admin-456',
          objectType: 'person',
        },
        object: {
          id: 'member-789',
          objectType: 'person',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(membershipListener).toHaveBeenCalledWith(
        expect.objectContaining({
          raw: activity,
        })
      );
    });
  });

  describe('edge cases', () => {
    it('should handle activity with missing optional fields', async () => {
      const handler = new WebexMessageHandler({ token: mockToken });
      await handler.connect();

      const messageListener = jest.fn();
      handler.on('message:created', messageListener);

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      mockMessageDecryptor.decryptActivity.mockResolvedValueOnce(activity);

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(messageListener).toHaveBeenCalledWith(
        expect.objectContaining({
          personEmail: '',
          text: '',
          html: undefined,
        })
      );
    });

    it('should warn and not throw if decryptor not initialized', async () => {
      const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      };

      const handler = new WebexMessageHandler({
        token: mockToken,
        logger,
      });

      // Manually set decryptor to null
      handler['messageDecryptor'] = null;

      const activity: MercuryActivity = {
        id: 'msg-123',
        verb: 'post',
        actor: {
          id: 'person-456',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'comment-789',
          objectType: 'comment',
          displayName: 'Test',
        },
        target: {
          id: 'room-101',
          objectType: 'conversation',
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mercury = handler['mercurySocket'] as any;
      mercury.emit('activity', activity);

      await new Promise(resolve => setImmediate(resolve));

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('mode validation', () => {
    it('should accept native mode with dispatcher', () => {
      const dispatcher = { keepAlive: true } as any;

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'native',
          dispatcher,
        });
      }).not.toThrow();
    });

    it('should accept default (native) mode without mode specified', () => {
      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
        });
      }).not.toThrow();
    });

    it('should accept injected mode with fetch and webSocketFactory', () => {
      const mockFetch = jest.fn();
      const mockWsFactory = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'injected',
          fetch: mockFetch as any,
          webSocketFactory: mockWsFactory as any,
        });
      }).not.toThrow();
    });

    it('should throw if injected mode is missing fetch', () => {
      const mockWsFactory = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'injected',
          webSocketFactory: mockWsFactory,
        } as any);
      }).toThrow('Injected mode requires both "fetch" and "webSocketFactory"');
    });

    it('should throw if injected mode is missing webSocketFactory', () => {
      const mockFetch = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'injected',
          fetch: mockFetch,
        } as any);
      }).toThrow('Injected mode requires both "fetch" and "webSocketFactory"');
    });

    it('should throw if injected mode has dispatcher parameter', () => {
      const mockFetch = jest.fn();
      const mockWsFactory = jest.fn();
      const dispatcher = { keepAlive: true } as any;

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'injected',
          fetch: mockFetch,
          webSocketFactory: mockWsFactory,
          dispatcher,
        });
      }).toThrow('Cannot use native proxy parameters (dispatcher) in injected mode');
    });

    it('should throw if native mode has fetch parameter', () => {
      const mockFetch = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'native',
          fetch: mockFetch,
        } as any);
      }).toThrow('Cannot provide fetch/webSocketFactory in native mode — set mode to "injected"');
    });

    it('should throw if native mode has webSocketFactory parameter', () => {
      const mockWsFactory = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'native',
          webSocketFactory: mockWsFactory,
        } as any);
      }).toThrow('Cannot provide fetch/webSocketFactory in native mode — set mode to "injected"');
    });

    it('should throw if default mode has fetch parameter', () => {
      const mockFetch = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          fetch: mockFetch,
        } as any);
      }).toThrow('Cannot provide fetch/webSocketFactory in native mode — set mode to "injected"');
    });

    it('should throw for invalid mode string', () => {
      expect(() => {
        new WebexMessageHandler({
          token: mockToken,
          mode: 'invalid' as any,
        });
      }).toThrow('Invalid mode "invalid" — must be "native" or "injected"');
    });
  });
});
