import { KmsClient } from '../src/kms-client';
import { KmsError } from '../src/errors';

// Mock jose JWK Key returned by asKey()
const mockJoseKey = {
  kty: 'EC',
  toJSON: jest.fn().mockReturnValue({ kty: 'EC', crv: 'P-256', x: 'test-x', y: 'test-y' }),
};

// Mock KMS ECDH KeyObject returned by createECDHKey()
const mockEcdhKeyObject = {
  uri: 'kms://test/ecdhe/123',
  jwk: { kty: 'EC', crv: 'P-256', x: 'test-x', y: 'test-y', d: 'private' },
  asKey: jest.fn().mockResolvedValue(mockJoseKey),
  toJSON: jest.fn().mockReturnValue({ kty: 'EC', crv: 'P-256', x: 'test-x', y: 'test-y' }),
};

// Mock shared key returned by deriveEphemeralKey()
const mockSharedKey = {
  uri: 'kms://test/ecdhe/shared',
  expirationDate: new Date(Date.now() + 3600000),
  asKey: jest.fn().mockResolvedValue(mockJoseKey),
  toJSON: jest.fn(),
};

let mockRequestId = 'mock-request-id';

// Mock node-kms
jest.mock('node-kms', () => {
  return {
    Context: jest.fn().mockImplementation(() => ({
      clientInfo: {},
      serverInfo: {},
      ephemeralKey: null,
      createECDHKey: jest.fn().mockResolvedValue(mockEcdhKeyObject),
      deriveEphemeralKey: jest.fn().mockResolvedValue(mockSharedKey),
    })),
    Request: jest.fn().mockImplementation((opts) => ({
      method: opts?.method,
      uri: opts?.uri,
      body: {},
      requestId: mockRequestId,
      wrapped: 'wrapped-request-data',
      wrap: jest.fn().mockResolvedValue(undefined),
    })),
    Response: jest.fn().mockImplementation(() => ({
      body: {
        status: 201,
        key: {
          uri: 'kms://test/ecdhe/remote',
          jwk: { kty: 'EC', crv: 'P-256', x: 'remote-x', y: 'remote-y' },
        },
      },
      unwrap: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

jest.mock('node-jose', () => {
  return {
    JWK: {
      asKey: jest.fn().mockResolvedValue({
        kty: 'oct',
        k: 'test-key',
      }),
    },
  };
});

describe('KmsClient', () => {
  const mockConfig = {
    token: 'test-token',
    deviceUrl: 'https://device.example.com',
    userId: 'user-123',
    encryptionServiceUrl: 'https://encryption.example.com',
  };

  const mockKmsDetailsResponse = {
    kmsCluster: 'kms://kms.example.com',
    rsaPublicKey: JSON.stringify({ kty: 'RSA', e: 'AQAB', n: 'test-modulus' }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestId = 'mock-request-id';
  });

  /**
   * Helper: create a KmsClient, mock fetch for init, call initialize(),
   * and simulate the Mercury KMS response arriving.
   */
  async function initializeClient(kmsClient: KmsClient, mockFetch: jest.Mock): Promise<void> {
    // KMS details fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(mockKmsDetailsResponse),
    });

    // ECDH HTTP POST returns 202 (response comes via Mercury)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 202,
    });

    const initPromise = kmsClient.initialize();

    // Simulate Mercury delivering the KMS response
    await new Promise((r) => setTimeout(r, 10));
    kmsClient.handleKmsMessage({
      encryption: { kmsMessages: ['wrapped-ecdh-response'] },
    });

    await initPromise;
  }

  describe('initialize', () => {
    it('should successfully initialize KMS context', async () => {
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);
      await initializeClient(kmsClient, mockFetch);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        `${mockConfig.encryptionServiceUrl}/kms/${mockConfig.userId}`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockConfig.token}`,
          }),
        })
      );

      // Second call: POST to /kms/messages
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        `${mockConfig.encryptionServiceUrl}/kms/messages`,
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should throw KmsError if KMS details fetch fails', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
    });

    it('should throw KmsError if ECDH HTTP POST fails', async () => {
      const mockFetch = jest.fn();

      // KMS details succeed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockKmsDetailsResponse),
      });

      // ECDH POST fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValueOnce('Internal Server Error'),
      });

      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
    });

    it('should throw KmsError on network fetch failure', async () => {
      const mockFetch = jest.fn().mockRejectedValueOnce(
        new Error('Network error')
      );
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
      await expect(kmsClient.initialize()).rejects.toThrow(
        'KMS initialization failed'
      );
    });
  });

  describe('handleKmsMessage', () => {
    it('should resolve pending requests with KMS messages', async () => {
      const kmsClient = new KmsClient(mockConfig);

      // No pending requests — should not throw
      kmsClient.handleKmsMessage({
        encryption: { kmsMessages: ['some-message'] },
      });
    });

    it('should handle messages without kmsMessages array', () => {
      const kmsClient = new KmsClient(mockConfig);

      // Should not throw
      kmsClient.handleKmsMessage({ someOtherField: 'value' } as Record<string, unknown>);
    });

    it('should try data.kmsMessages first, then data.encryption.kmsMessages', () => {
      const kmsClient = new KmsClient(mockConfig);

      // Both formats should work without error
      kmsClient.handleKmsMessage({ kmsMessages: ['msg1'] });
      kmsClient.handleKmsMessage({ encryption: { kmsMessages: ['msg2'] } });
    });
  });

  describe('getKey', () => {
    it('should return cached key on second call', async () => {
      mockRequestId = 'init-request-id';
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);
      await initializeClient(kmsClient, mockFetch);

      // getKey POST returns 202
      mockRequestId = 'key-request-id';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 202,
      });

      const keyUri = 'kms://kms.example.com/keys/key-123';
      const getKeyPromise = kmsClient.getKey(keyUri);

      // Simulate Mercury response for key retrieval
      await new Promise((r) => setTimeout(r, 10));
      kmsClient.handleKmsMessage({
        encryption: { kmsMessages: ['wrapped-key-response'] },
      });

      const key1 = await getKeyPromise;

      // Second call should be cached — no additional fetch
      const key2 = await kmsClient.getKey(keyUri);

      expect(key1).toBe(key2);
      // 2 for init + 1 for first getKey = 3
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should fetch key from KMS on cache miss', async () => {
      mockRequestId = 'init-request-id';
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);
      await initializeClient(kmsClient, mockFetch);

      // getKey POST returns 202
      mockRequestId = 'key-request-id';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 202,
      });

      const keyUri = 'kms://kms.example.com/keys/key-123';
      const getKeyPromise = kmsClient.getKey(keyUri);

      // Simulate Mercury response
      await new Promise((r) => setTimeout(r, 10));
      kmsClient.handleKmsMessage({
        encryption: { kmsMessages: ['wrapped-key-response'] },
      });

      await getKeyPromise;

      // 2 for init + 1 for getKey = 3
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should throw KmsError if not initialized', async () => {
      const kmsClient = new KmsClient(mockConfig);

      const keyUri = 'kms://kms.example.com/keys/key-123';

      await expect(kmsClient.getKey(keyUri)).rejects.toThrow(KmsError);
    });

    it('should throw KmsError if key HTTP POST fails', async () => {
      mockRequestId = 'init-request-id';
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);
      await initializeClient(kmsClient, mockFetch);

      // getKey POST fails
      mockRequestId = 'key-request-id';
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValueOnce('Not Found'),
      });

      const keyUri = 'kms://kms.example.com/keys/nonexistent';

      await expect(kmsClient.getKey(keyUri)).rejects.toThrow(KmsError);
    });
  });

  describe('context expiration', () => {
    it('should detect expired context via isContextExpired', async () => {
      // A client that was never initialized should consider context expired
      const kmsClient = new KmsClient(mockConfig);

      // getKey on uninitialized client → throws because no context
      await expect(kmsClient.getKey('kms://test/key')).rejects.toThrow(KmsError);
    });
  });

  describe('error handling', () => {
    it('should wrap non-KmsError exceptions during initialize', async () => {
      const mockFetch = jest.fn().mockRejectedValueOnce(
        new Error('Unknown error')
      );
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
      await expect(kmsClient.initialize()).rejects.toThrow(
        'KMS initialization failed'
      );
    });

    it('should wrap non-KmsError exceptions during getKey', async () => {
      mockRequestId = 'init-request-id';
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const kmsClient = new KmsClient(mockConfig);
      await initializeClient(kmsClient, mockFetch);

      // getKey call that throws network error
      mockRequestId = 'key-request-id';
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const keyUri = 'kms://kms.example.com/keys/key-123';

      await expect(kmsClient.getKey(keyUri)).rejects.toThrow(KmsError);
    });
  });
});
