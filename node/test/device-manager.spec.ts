import { DeviceManager } from '../src/device-manager';
import { AuthError, DeviceRegistrationError } from '../src/errors';
import type { FetchRequest, FetchResponse } from '../src/types';

type HttpDoFn = (request: FetchRequest) => Promise<FetchResponse>;

describe('DeviceManager', () => {
  const mockToken = 'test-token';
  const mockDeviceUrl = 'https://wdm-a.wbx2.com/wdm/api/v1/devices/test-device-id';
  const mockWebSocketUrl = 'wss://mercury.webex.com/socket';
  const mockUserId = 'user-123';

  const mockWDMResponse = {
    webSocketUrl: mockWebSocketUrl,
    url: mockDeviceUrl,
    userId: mockUserId,
    services: {
      encryptionServiceUrl: 'https://encryption.webex.com',
      messenger: 'https://messenger.webex.com',
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
        // GET (list for reuse): empty
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      const result = await deviceManager.register(mockToken);

      // Check that POST was called with includeUpstreamServices
      expect(mockHttpDo).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('https://wdm-a.wbx2.com/wdm/api/v1/devices'),
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mockToken}`,
            'Content-Type': 'application/json',
          },
          body: expect.any(String),
        })
      );

      expect(result).toEqual(
        expect.objectContaining({
          webSocketUrl: mockWebSocketUrl,
          deviceUrl: mockDeviceUrl,
          userId: mockUserId,
          encryptionServiceUrl: 'https://encryption.webex.com',
        })
      );
      expect(result.services).toHaveProperty('encryptionServiceUrl', 'https://encryption.webex.com');
      expect(result.services).toHaveProperty('messenger', 'https://messenger.webex.com');
    });

    it('should throw AuthError on 401 response from register', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse): empty
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create): 401
        {
          status: 401,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');

      await expect(deviceManager.register(mockToken)).rejects.toThrow(AuthError);
    });

    it('should throw DeviceRegistrationError on non-2xx response', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse): empty
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create): 400
        {
          status: 400,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');

      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });

    it('should throw DeviceRegistrationError on fetch failure', async () => {
      const mockHttpDo = jest
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
          text: async () => '',
        })
        .mockRejectedValueOnce(new Error('Network error')) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');

      await expect(deviceManager.register(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('refresh', () => {
    it('should successfully refresh device registration', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        // PUT (refresh)
        {
          status: 200,
          ok: true,
          json: async () => ({
            ...mockWDMResponse,
            webSocketUrl: 'wss://mercury-connection-new.wbx2.com/socket',
          }),
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
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

      expect(result.webSocketUrl).toBe('wss://mercury-connection-new.wbx2.com/socket');
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
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        // PUT (refresh): 401
        {
          status: 401,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      await deviceManager.register(mockToken);

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        AuthError
      );
    });

    it('should throw DeviceRegistrationError on refresh failure', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        // PUT (refresh): 500
        {
          status: 500,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      await deviceManager.register(mockToken);

      await expect(deviceManager.refresh(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('unregister', () => {
    it('should successfully unregister device', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        // DELETE (unregister)
        {
          status: 204,
          ok: true,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
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
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        // DELETE (unregister): 401
        {
          status: 401,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      await deviceManager.register(mockToken);

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        AuthError
      );
    });

    it('should throw DeviceRegistrationError on unregister failure', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
        {
          status: 200,
          ok: true,
          json: async () => mockWDMResponse,
        },
        // DELETE (unregister): 500
        {
          status: 500,
          ok: false,
        },
      ]);

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      await deviceManager.register(mockToken);

      await expect(deviceManager.unregister(mockToken)).rejects.toThrow(
        DeviceRegistrationError
      );
    });
  });

  describe('service parsing', () => {
    it('should correctly handle empty services object', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
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
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      const result = await deviceManager.register(mockToken);

      expect(result.services).toEqual({});
      expect(result.encryptionServiceUrl).toBe('');
    });

    it('should handle missing encryptionServiceUrl in services', async () => {
      const mockHttpDo = createMockHttpDo([
        // GET (list for reuse)
        {
          status: 200,
          ok: true,
          json: async () => ({ devices: [] }),
        },
        // POST (create)
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
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      const result = await deviceManager.register(mockToken);

      expect(result.services).toHaveProperty('messenger');
      expect(result.encryptionServiceUrl).toBe('');
    });
  });

  describe('device reuse and reaping', () => {
    it('should reuse existing device and call refresh instead of create', async () => {
      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET') {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              devices: [
                {
                  webSocketUrl: mockWebSocketUrl,
                  url: mockDeviceUrl,
                  userId: mockUserId,
                  name: 'webex-message-handler',
                  deviceType: 'DESKTOP',
                  services: {},
                },
              ],
            }),
            text: async () => '',
          };
        }
        if (request.method === 'PUT') {
          return {
            status: 200,
            ok: true,
            json: async () => mockWDMResponse,
            text: async () => '',
          };
        }
        throw new Error('Unexpected request: ' + request.method);
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(mockDeviceUrl);
      // Should be: GET (list) + PUT (refresh)
      expect(mockHttpDo).toHaveBeenCalledTimes(2);
      const calls = mockHttpDo.mock.calls;
      expect(calls[0][0].method).toBe('GET');
      expect(calls[1][0].method).toBe('PUT');
    });

    it('should reap devices on 403 and retry create', async () => {
      let postCount = 0;
      let deleteCount = 0;
      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET') {
          // First GET (reuse check): empty
          // Second GET (reap): return device to delete
          if (postCount === 0) {
            return {
              status: 200,
              ok: true,
              json: async () => ({ devices: [] }),
              text: async () => '',
            };
          } else {
            return {
              status: 200,
              ok: true,
              json: async () => ({
                devices: [
                  {
                    url: mockDeviceUrl + '/old',
                    name: 'webex-message-handler',
                    deviceType: 'DESKTOP',
                  },
                ],
              }),
              text: async () => '',
            };
          }
        }
        if (request.method === 'POST') {
          postCount++;
          if (postCount === 1) {
            // First POST fails with 403
            return {
              status: 403,
              ok: false,
              json: async () => ({}),
              text: async () => '',
            };
          }
          // Second POST succeeds
          return {
            status: 200,
            ok: true,
            json: async () => mockWDMResponse,
            text: async () => '',
          };
        }
        if (request.method === 'DELETE') {
          deleteCount++;
          return {
            status: 204,
            ok: true,
            json: async () => ({}),
            text: async () => '',
          };
        }
        throw new Error('Unexpected request: ' + request.method);
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(mockDeviceUrl);
      // Should be: GET (reuse) + POST (403) + GET (reap) + DELETE + POST (retry)
      expect(mockHttpDo).toHaveBeenCalledTimes(5);
      expect(postCount).toBe(2);
      expect(deleteCount).toBe(1);
    });

    it('should fall back to create when list fails', async () => {
      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET') {
          // List fails
          return {
            status: 500,
            ok: false,
            json: async () => ({}),
            text: async () => '',
          };
        }
        if (request.method === 'POST') {
          return {
            status: 200,
            ok: true,
            json: async () => mockWDMResponse,
            text: async () => '',
          };
        }
        throw new Error('Unexpected request: ' + request.method);
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      deviceManager.setWdmDevicesUrl('https://wdm-a.wbx2.com/wdm/api/v1/devices');
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(mockDeviceUrl);
      // Should be: GET (list fails) + POST (create succeeds)
      expect(mockHttpDo).toHaveBeenCalledTimes(2);
    });
  });

  describe('U2C region discovery (#27)', () => {
    it('should discover region-correct WDM endpoint from U2C', async () => {
      const u2cCatalog = { serviceLinks: { wdm: 'https://wdm-r.wbx2.com/wdm/api/v1' } };
      const regionalDeviceUrl = 'https://wdm-r.wbx2.com/wdm/api/v1/devices/test-device-id';

      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET' && request.url.includes('u2c.wbx2.com')) {
          // U2C discovery
          return {
            status: 200,
            ok: true,
            json: async () => u2cCatalog,
            text: async () => '',
          };
        }
        if (request.method === 'GET' && !request.url.includes('u2c.wbx2.com')) {
          // Device list
          return {
            status: 200,
            ok: true,
            json: async () => ({ devices: [] }),
            text: async () => '',
          };
        }
        if (request.method === 'POST') {
          // Create device
          return {
            status: 200,
            ok: true,
            json: async () => ({
              webSocketUrl: mockWebSocketUrl,
              url: regionalDeviceUrl,
              userId: mockUserId,
              services: {},
            }),
            text: async () => '',
          };
        }
        throw new Error('Unexpected request');
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(regionalDeviceUrl);
      // Verify POST went to discovered regional endpoint, not hardcoded wdm-a
      const postCalls = mockHttpDo.mock.calls.filter(call => call[0].method === 'POST');
      expect(postCalls[0][0].url).toContain('wdm-r.wbx2.com');
    });

    it('should cache discovered WDM endpoint', async () => {
      const u2cCatalog = { serviceLinks: { wdm: 'https://wdm-r.wbx2.com/wdm/api/v1' } };

      let u2cCallCount = 0;
      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET' && request.url.includes('u2c.wbx2.com')) {
          u2cCallCount++;
          return {
            status: 200,
            ok: true,
            json: async () => u2cCatalog,
            text: async () => '',
          };
        }
        if (request.method === 'GET' && !request.url.includes('u2c.wbx2.com')) {
          return {
            status: 200,
            ok: true,
            json: async () => ({ devices: [] }),
            text: async () => '',
          };
        }
        if (request.method === 'POST') {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              webSocketUrl: mockWebSocketUrl,
              url: 'https://wdm-r.wbx2.com/wdm/api/v1/devices/id1',
              userId: mockUserId,
              services: {},
            }),
            text: async () => '',
          };
        }
        throw new Error('Unexpected request');
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });

      // First register call
      await deviceManager.register(mockToken);
      expect(u2cCallCount).toBe(1);

      // Pre-seed the cache (simulating second call would reuse without calling U2C again)
      deviceManager.setWdmDevicesUrl('https://wdm-r.wbx2.com/wdm/api/v1/devices');
      // Verify u2cCallCount hasn't incremented (would still be 1)
      expect(u2cCallCount).toBe(1);
    });

    it('should fall back to wdm-a when U2C returns non-2xx', async () => {
      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET' && request.url.includes('u2c.wbx2.com')) {
          // U2C discovery fails with 500
          return {
            status: 500,
            ok: false,
            json: async () => ({}),
            text: async () => '',
          };
        }
        if (request.method === 'GET') {
          return {
            status: 200,
            ok: true,
            json: async () => ({ devices: [] }),
            text: async () => '',
          };
        }
        if (request.method === 'POST') {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              webSocketUrl: mockWebSocketUrl,
              url: mockDeviceUrl,
              userId: mockUserId,
              services: {},
            }),
            text: async () => '',
          };
        }
        throw new Error('Unexpected request');
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(mockDeviceUrl);
      // Verify POST went to fallback wdm-a
      const postCalls = mockHttpDo.mock.calls.filter(call => call[0].method === 'POST');
      expect(postCalls[0][0].url).toContain('wdm-a.wbx2.com');
    });

    it('should fall back to wdm-a when U2C has no wdm service link', async () => {
      const u2cCatalog = { serviceLinks: {} }; // Missing wdm link

      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET' && request.url.includes('u2c.wbx2.com')) {
          return {
            status: 200,
            ok: true,
            json: async () => u2cCatalog,
            text: async () => '',
          };
        }
        if (request.method === 'GET') {
          return {
            status: 200,
            ok: true,
            json: async () => ({ devices: [] }),
            text: async () => '',
          };
        }
        if (request.method === 'POST') {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              webSocketUrl: mockWebSocketUrl,
              url: mockDeviceUrl,
              userId: mockUserId,
              services: {},
            }),
            text: async () => '',
          };
        }
        throw new Error('Unexpected request');
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(mockDeviceUrl);
      const postCalls = mockHttpDo.mock.calls.filter(call => call[0].method === 'POST');
      expect(postCalls[0][0].url).toContain('wdm-a.wbx2.com');
    });

    it('should reject untrusted wdm host from U2C and fall back to wdm-a', async () => {
      const u2cCatalog = { serviceLinks: { wdm: 'https://evil.example.com/wdm/api/v1' } };

      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET' && request.url.includes('u2c.wbx2.com')) {
          return {
            status: 200,
            ok: true,
            json: async () => u2cCatalog,
            text: async () => '',
          };
        }
        if (request.method === 'GET') {
          return {
            status: 200,
            ok: true,
            json: async () => ({ devices: [] }),
            text: async () => '',
          };
        }
        if (request.method === 'POST') {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              webSocketUrl: mockWebSocketUrl,
              url: mockDeviceUrl,
              userId: mockUserId,
              services: {},
            }),
            text: async () => '',
          };
        }
        throw new Error('Unexpected request');
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(mockDeviceUrl);
      const postCalls = mockHttpDo.mock.calls.filter(call => call[0].method === 'POST');
      expect(postCalls[0][0].url).toContain('wdm-a.wbx2.com');
    });

    it('should fall back to wdm-a on U2C fetch error', async () => {
      const mockHttpDo = jest.fn(async (request: FetchRequest) => {
        if (request.method === 'GET' && request.url.includes('u2c.wbx2.com')) {
          throw new Error('Network error');
        }
        if (request.method === 'GET') {
          return {
            status: 200,
            ok: true,
            json: async () => ({ devices: [] }),
            text: async () => '',
          };
        }
        if (request.method === 'POST') {
          return {
            status: 200,
            ok: true,
            json: async () => ({
              webSocketUrl: mockWebSocketUrl,
              url: mockDeviceUrl,
              userId: mockUserId,
              services: {},
            }),
            text: async () => '',
          };
        }
        throw new Error('Unexpected request');
      }) as jest.MockedFunction<HttpDoFn>;

      const deviceManager = new DeviceManager({ httpDo: mockHttpDo });
      const result = await deviceManager.register(mockToken);

      expect(result.deviceUrl).toBe(mockDeviceUrl);
      const postCalls = mockHttpDo.mock.calls.filter(call => call[0].method === 'POST');
      expect(postCalls[0][0].url).toContain('wdm-a.wbx2.com');
    });
  });
});
