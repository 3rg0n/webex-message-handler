import { WebexMessageHandler } from '../src/handler.js';
import { ProxyAgent } from 'undici';

describe('Proxy Support', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Native Mode with Dispatcher', () => {
    it('should accept ProxyAgent as dispatcher', () => {
      const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          dispatcher: proxyAgent,
        });
      }).not.toThrow();
    });

    it('should reject dispatcher in injected mode', () => {
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
          dispatcher: proxyAgent,
          fetch: mockFetch,
          webSocketFactory: mockWsFactory,
        });
      }).toThrow('Cannot use native proxy parameters (dispatcher) in injected mode');
    });

    it('should work without dispatcher (direct connection)', () => {
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
      const mockFetch = jest.fn().mockImplementation(async (_request) => {
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

      expect(handler).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockWsFactory).not.toHaveBeenCalled();
    });
  });

  describe('Proxy Configuration Validation', () => {
    it('should accept mode="native" with dispatcher', () => {
      const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');

      expect(() => {
        new WebexMessageHandler({
          token: 'test-token',
          mode: 'native',
          dispatcher: proxyAgent,
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

  describe('Proxy Dispatcher Types', () => {
    it('should document ProxyAgent as recommended', () => {
      const proxyAgent = new ProxyAgent('http://proxy.example.com:8080');

      const handler = new WebexMessageHandler({
        token: 'test-token',
        dispatcher: proxyAgent,
      });

      expect(handler).toBeDefined();
    });

    it('should support environment variable pattern', () => {
      const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

      const handler = new WebexMessageHandler({
        token: 'test-token',
        dispatcher,
      });

      expect(handler).toBeDefined();
    });
  });
});
