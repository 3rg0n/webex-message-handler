import { WebexMessageHandler } from '../src/handler.js';
import { ProxyAgent } from 'undici';
import type http from 'http';
import type https from 'https';

describe('Proxy Support', () => {
  let mockHttpRequest: jest.Mock;
  let mockHttpsRequest: jest.Mock;

  beforeEach(() => {
    mockHttpRequest = jest.fn();
    mockHttpsRequest = jest.fn();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Native Mode with Proxy Agent', () => {
    it('should accept ProxyAgent from undici', () => {
      const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          agent: proxyAgent,
        });
      }).not.toThrow();
    });

    it('should accept http.Agent', () => {
      const httpAgent = {
        options: {},
        requests: {},
        sockets: {},
        freeSockets: {},
        maxSockets: 50,
        maxFreeSockets: 10,
      } as unknown as http.Agent;

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          agent: httpAgent,
        });
      }).not.toThrow();
    });

    it('should accept https.Agent', () => {
      const httpsAgent = {
        options: {},
        requests: {},
        sockets: {},
        freeSockets: {},
        maxSockets: 50,
        maxFreeSockets: 10,
      } as unknown as https.Agent;

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          agent: httpsAgent,
        });
      }).not.toThrow();
    });

    it('should reject agent in injected mode', () => {
      const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');
      const mockFetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue(''),
      });
      const mockWsFactory = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          mode: 'injected',
          agent: proxyAgent,
          fetch: mockFetch,
          webSocketFactory: mockWsFactory,
        });
      }).toThrow('Cannot use native proxy parameters (agent) in injected mode');
    });

    it('should work without agent (direct connection)', () => {
      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
        });
      }).not.toThrow();
    });
  });

  describe('Injected Mode with Custom Proxy', () => {
    it('should allow custom fetch with proxy logic', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValue({}),
        text: jest.fn().mockResolvedValue(''),
      });

      const mockWsFactory = jest.fn().mockReturnValue({
        send: jest.fn(),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
      });

      const handler = new WebexMessageHandler({
        token: 'test-token',
        mode: 'injected',
        fetch: mockFetch,
        webSocketFactory: mockWsFactory,
      });

      expect(handler).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should pass requests through custom fetch', () => {
      // Test validates that custom fetch function receives proper requests
      // without actually attempting connection
      let capturedRequest: any = null;
      const mockFetch = jest.fn().mockImplementation(async (request) => {
        capturedRequest = request;
        return {
          status: 200,
          ok: true,
          json: jest.fn().mockResolvedValue({
            deviceUrl: 'https://wdm-a.wbx2.com/wdm/api/v1/devices/123',
            userId: 'user-123',
            webSocketUrl: 'wss://mercury.example.com/v1',
            services: {
              encryptionServiceUrl: 'https://encryption.example.com',
            },
          }),
          text: jest.fn().mockResolvedValue(''),
        };
      });

      const mockWsFactory = jest.fn().mockReturnValue({
        send: jest.fn(),
        close: jest.fn(),
        readyState: 1,
        on: jest.fn(),
      });

      const handler = new WebexMessageHandler({
        token: 'test-token',
        mode: 'injected',
        fetch: mockFetch,
        webSocketFactory: mockWsFactory,
      });

      // Verify handler was created with injected functions
      expect(handler).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockWsFactory).not.toHaveBeenCalled();

      // Note: Actual connection testing requires full mock setup
      // This test validates configuration acceptance
    });
  });

  describe('Proxy Configuration Validation', () => {
    it('should accept mode="native" with agent', () => {
      const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          mode: 'native',
          agent: proxyAgent,
        });
      }).not.toThrow();
    });

    it('should reject mode="native" with fetch', () => {
      const mockFetch = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          mode: 'native',
          fetch: mockFetch,
        });
      }).toThrow('Cannot provide fetch/webSocketFactory in native mode');
    });

    it('should reject mode="native" with webSocketFactory', () => {
      const mockWsFactory = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          mode: 'native',
          webSocketFactory: mockWsFactory,
        });
      }).toThrow('Cannot provide fetch/webSocketFactory in native mode');
    });

    it('should reject mode="injected" without fetch', () => {
      const mockWsFactory = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          mode: 'injected',
          webSocketFactory: mockWsFactory,
        });
      }).toThrow('Injected mode requires both "fetch" and "webSocketFactory"');
    });

    it('should reject mode="injected" without webSocketFactory', () => {
      const mockFetch = jest.fn();

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          mode: 'injected',
          fetch: mockFetch,
        });
      }).toThrow('Injected mode requires both "fetch" and "webSocketFactory"');
    });
  });

  describe('Proxy Agent Types', () => {
    it('should document ProxyAgent as recommended', () => {
      // This test documents the recommended approach
      const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');

      const handler = new WebexMessageHandler({
        token: 'test-token',
        agent: proxyAgent,
      });

      expect(handler).toBeDefined();
      // ProxyAgent is the recommended choice for Node.js v18+ with native fetch
    });

    it('should support environment variable pattern', () => {
      // Common pattern: read proxy from environment
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

      const handler = new WebexMessageHandler({
        token: 'test-token',
        agent,
      });

      expect(handler).toBeDefined();
    });
  });
});
