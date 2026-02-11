import { DeviceManager } from '../src/device-manager';
import { AuthError, DeviceRegistrationError } from '../src/errors';

describe('DeviceManager', () => {
  const mockToken = 'test-token';
  const mockDeviceUrl = 'https://wdm-a.wbx2.com/wdm/api/v1/devices/test-device-id';
  const mockWebSocketUrl = 'wss://mercury.example.com/socket';
  const mockUserId = 'user-123';

  const mockWDMResponse = {
    webSocketUrl: mockWebSocketUrl,
    url: mockDeviceUrl,
    userId: mockUserId,
    services: {
      encryptionServiceUrl: 'https://encryption.example.com',
      messenger: 'https://messenger.example.com',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should successfully register a device', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockWDMResponse),
      });
      global.fetch = mockFetch;

      const deviceManager = new DeviceManager();
      const result = await deviceManager.register(mockToken);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://wdm-a.wbx2.com/wdm/api/v1/devices',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockToken}`,
            'Content-Type': 'application/json',
          }),
        })
      );

      expect(result).toEqual(
        expect.objectContaining({
          webSocketUrl: mockWebSocketUrl,
          deviceUrl: mockDeviceUrl,
          userId: mockUserId,
          encryptionServiceUrl: 'https://encryption.example.com',
        })
      );
      expect(result.services).toHaveProperty('encryptionServiceUrl', 'https://encryption.example.com');
      expect(result.services).toHaveProperty('messenger', 'https://messenger.example.com');
    });

    it('should throw AuthError on 401 response', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        status: 401,
        ok: false,
      });
      global.fetch = mockFetch;

      const deviceManager = new DeviceManager();

      await expect(deviceManager.register(mockToken)).rejects.toThrow(AuthError);
    });

    it('should throw DeviceRegistrationError on non-2xx response', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        status: 400,
        ok: false,
      });
      global.fetch = mockFetch;

      const deviceManager = new DeviceManager();

      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        'Failed to register device'
      );
    });

    it('should throw DeviceRegistrationError on fetch failure', async () => {
      const mockFetch = jest.fn().mockRejectedValueOnce(new Error('Network error'));
      global.fetch = mockFetch;

      const deviceManager = new DeviceManager();

      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('refresh', () => {
    it('should successfully refresh device registration', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // First call: register
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockWDMResponse),
      });

      // Second call: refresh
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          ...mockWDMResponse,
          webSocketUrl: 'wss://mercury-new.example.com/socket',
        }),
      });

      const deviceManager = new DeviceManager();
      await deviceManager.register(mockToken);
      const result = await deviceManager.refresh(mockToken);

      expect(mockFetch).toHaveBeenLastCalledWith(
        mockDeviceUrl,
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockToken}`,
          }),
        })
      );

      expect(result.webSocketUrl).toBe('wss://mercury-new.example.com/socket');
    });

    it('should throw DeviceRegistrationError if device not registered', async () => {
      const deviceManager = new DeviceManager();

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        'Device not registered'
      );
    });

    it('should throw AuthError on 401 during refresh', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // First call: register
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockWDMResponse),
      });

      // Second call: refresh with 401
      mockFetch.mockResolvedValueOnce({
        status: 401,
        ok: false,
      });

      const deviceManager = new DeviceManager();
      await deviceManager.register(mockToken);

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        AuthError
      );
    });

    it('should throw DeviceRegistrationError on refresh failure', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // First call: register
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockWDMResponse),
      });

      // Second call: refresh with error
      mockFetch.mockResolvedValueOnce({
        status: 500,
        ok: false,
      });

      const deviceManager = new DeviceManager();
      await deviceManager.register(mockToken);

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('unregister', () => {
    it('should successfully unregister device', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // First call: register
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockWDMResponse),
      });

      // Second call: unregister
      mockFetch.mockResolvedValueOnce({
        status: 204,
        ok: true,
      });

      const deviceManager = new DeviceManager();
      await deviceManager.register(mockToken);
      await deviceManager.unregister(mockToken);

      expect(mockFetch).toHaveBeenLastCalledWith(
        mockDeviceUrl,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockToken}`,
          }),
        })
      );
    });

    it('should throw DeviceRegistrationError if device not registered', async () => {
      const deviceManager = new DeviceManager();

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        'Device not registered'
      );
    });

    it('should throw AuthError on 401 during unregister', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // First call: register
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockWDMResponse),
      });

      // Second call: unregister with 401
      mockFetch.mockResolvedValueOnce({
        status: 401,
        ok: false,
      });

      const deviceManager = new DeviceManager();
      await deviceManager.register(mockToken);

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        AuthError
      );
    });

    it('should throw DeviceRegistrationError on unregister failure', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // First call: register
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockWDMResponse),
      });

      // Second call: unregister with error
      mockFetch.mockResolvedValueOnce({
        status: 500,
        ok: false,
      });

      const deviceManager = new DeviceManager();
      await deviceManager.register(mockToken);

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('service parsing', () => {
    it('should correctly handle empty services object', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          webSocketUrl: mockWebSocketUrl,
          url: mockDeviceUrl,
          userId: mockUserId,
          services: {},
        }),
      });
      global.fetch = mockFetch;

      const deviceManager = new DeviceManager();
      const result = await deviceManager.register(mockToken);

      expect(result.services).toEqual({});
      expect(result.encryptionServiceUrl).toBe('');
    });

    it('should handle missing encryptionServiceUrl in services', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValueOnce({
          webSocketUrl: mockWebSocketUrl,
          url: mockDeviceUrl,
          userId: mockUserId,
          services: {
            messenger: 'https://messenger.example.com',
          },
        }),
      });
      global.fetch = mockFetch;

      const deviceManager = new DeviceManager();
      const result = await deviceManager.register(mockToken);

      expect(result.services).toHaveProperty('messenger');
      expect(result.encryptionServiceUrl).toBe('');
    });
  });
});
