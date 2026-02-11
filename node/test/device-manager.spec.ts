import { DeviceManager } from '../src/device-manager';
import { AuthError, DeviceRegistrationError } from '../src/errors';
import type { FetchRequest, FetchResponse } from '../src/types';

type HttpDoFn = (request: FetchRequest) => Promise<FetchResponse>;

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

  const createMockHttpDo = (responses: Array<Partial<FetchResponse>>): jest.MockedFunction<HttpDoFn> => {
    const mockFn = jest.fn() as jest.MockedFunction<HttpDoFn>;
    responses.forEach((response) => {
      mockFn.mockResolvedValueOnce({
        status: response.status ?? 200,
        ok: response.ok ?? true,
        json: response.json ?? (async () => ({})),
        text: response.text ?? (async () => ''),
      });
    });
    return mockFn;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should successfully register a device', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(mockHttpDo).toHaveBeenCalledWith({
        url: 'https://wdm-a.wbx2.com/wdm/api/v1/devices',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mockToken}`,
          'Content-Type': 'application/json',
        },
        body: expect.any(String),
      });

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
      const mockHttpDo = createMockHttpDo([
        {
          status: 401,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });

      await expect(deviceManager.register(mockToken)).rejects.toThrow(AuthError);
    });

    it('should throw DeviceRegistrationError on non-2xx response', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 400,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });

      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        'Failed to register device'
      );
    });

    it('should throw DeviceRegistrationError on fetch failure', async () => {
      const mockHttpDo = jest.fn().mockRejectedValueOnce(new Error('Network error')) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });

      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('refresh', () => {
    it('should successfully refresh device registration', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        {
          status: 200,
          ok: true,
          json: async () => ({
            ...mockWDMResponse,
            webSocketUrl: 'wss://mercury-new.example.com/socket',
          }),
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      await deviceManager.register(mockToken);
      const result = await deviceManager.refresh(mockToken);

      expect(mockHttpDo).toHaveBeenLastCalledWith({
        url: mockDeviceUrl,
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${mockToken}`,
          'Content-Type': 'application/json',
        },
        body: expect.any(String),
      });

      expect(result.webSocketUrl).toBe('wss://mercury-new.example.com/socket');
    });

    it('should throw DeviceRegistrationError if device not registered', async () => {
      const mockHttpDo = jest.fn() as jest.MockedFunction<HttpDoFn>;
      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        'Device not registered'
      );
    });

    it('should throw AuthError on 401 during refresh', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        {
          status: 401,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      await deviceManager.register(mockToken);

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        AuthError
      );
    });

    it('should throw DeviceRegistrationError on refresh failure', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        {
          status: 500,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      await deviceManager.register(mockToken);

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('unregister', () => {
    it('should successfully unregister device', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        {
          status: 204,
          ok: true,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      await deviceManager.register(mockToken);
      await deviceManager.unregister(mockToken);

      expect(mockHttpDo).toHaveBeenLastCalledWith({
        url: mockDeviceUrl,
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${mockToken}`,
          'Content-Type': 'application/json',
        },
      });
    });

    it('should throw DeviceRegistrationError if device not registered', async () => {
      const mockHttpDo = jest.fn() as jest.MockedFunction<HttpDoFn>;
      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        'Device not registered'
      );
    });

    it('should throw AuthError on 401 during unregister', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        {
          status: 401,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      await deviceManager.register(mockToken);

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        AuthError
      );
    });

    it('should throw DeviceRegistrationError on unregister failure', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        {
          status: 500,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      await deviceManager.register(mockToken);

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('service parsing', () => {
    it('should correctly handle empty services object', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => ({
            webSocketUrl: mockWebSocketUrl,
            url: mockDeviceUrl,
            userId: mockUserId,
            services: {},
          }),
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(result.services).toEqual({});
      expect(result.encryptionServiceUrl).toBe('');
    });

    it('should handle missing encryptionServiceUrl in services', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          status: 200,
          ok: true,
          json: async () => ({
            webSocketUrl: mockWebSocketUrl,
            url: mockDeviceUrl,
            userId: mockUserId,
            services: {
              messenger: 'https://messenger.example.com',
            },
          }),
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(result.services).toHaveProperty('messenger');
      expect(result.encryptionServiceUrl).toBe('');
    });
  });
});
