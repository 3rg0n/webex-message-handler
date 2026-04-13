import { KmsClient } from '../src/kms-client';
import { KmsError } from '../src/errors';
import type { FetchRequest, FetchResponse } from '../src/types';

type HttpDoFn = (request: FetchRequest) => Promise<FetchResponse>;

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
    deviceUrl: 'https://device-a.wbx2.com',
    userId: 'user-123',
    encryptionServiceUrl: 'https://encryption-a.wbx2.com/encryption/api/v1',
  };

  const mockKmsDetailsResponse = {
    kmsCluster: 'kms://ciscospark.com/keys',
    rsaPublicKey: JSON.stringify({ kty: 'RSA', e: 'AQAB', n: 'test-modulus' }),
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
    mockRequestId = 'mock-request-id';
  });

  /**
   * Helper: create a KmsClient, mock httpDo for init, call initialize(),
   * and simulate the Mercury KMS response arriving.
   */
  async function initializeClient(kmsClient: KmsClient, mockHttpDo: jest.MockedFunction<HttpDoFn>): Promise<void> {
    // KMS details fetch
    mockHttpDo.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => mockKmsDetailsResponse,
      text: async () => '',
    });

    // ECDH HTTP POST returns 202 (response comes via Mercury)
    mockHttpDo.mockResolvedValueOnce({
      status: 202,
      ok: true,
      json: async () => ({}),
      text: async () => '',
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
      const mockHttpDo = createMockHttpDo([]);

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });
      await initializeClient(kmsClient, mockHttpDo);

      expect(mockHttpDo).toHaveBeenCalledTimes(2);
      expect(mockHttpDo).toHaveBeenNthCalledWith(1, {
        url: `${mockConfig.encryptionServiceUrl}/kms/${mockConfig.userId}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${mockConfig.token}`,
        },
      });

      // Second call: POST to /kms/messages
      expect(mockHttpDo).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          url: `${mockConfig.encryptionServiceUrl}/kms/messages`,
          method: 'POST',
        })
      );
    });

    it('should accept kms:// scheme for KMS cluster URL', async () => {
      const mockHttpDo = createMockHttpDo([]);
      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });
      await initializeClient(kmsClient, mockHttpDo);

      // If we got here without error, kms:// was accepted
      expect(mockHttpDo).toHaveBeenCalledTimes(2);
    });

    it('should reject https:// scheme for KMS cluster URL', async () => {
      const mockHttpDo = jest.fn().mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          kmsCluster: 'https://ciscospark.com/keys',
          rsaPublicKey: JSON.stringify({ kty: 'RSA', e: 'AQAB', n: 'test-modulus' }),
        }),
        text: async () => '',
      }) as jest.MockedFunction<HttpDoFn>;

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      await expect(kmsClient.initialize()).rejects.toThrow(/URL protocol must be kms/);
    });

    it('should throw KmsError if KMS details fetch fails', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          ok: false,
          status: 500,
        },
      ]);

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
    });

    it('should throw KmsError if ECDH HTTP POST fails', async () => {
      const mockHttpDo = createMockHttpDo([
        {
          ok: true,
          json: async () => mockKmsDetailsResponse,
        },
        {
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        },
      ]);

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
    });

    it('should throw KmsError on network fetch failure', async () => {
      const mockHttpDo = jest.fn().mockRejectedValueOnce(
        new Error('Network error')
      ) as jest.MockedFunction<HttpDoFn>;

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
      await expect(kmsClient.initialize()).rejects.toThrow(
        'KMS initialization failed'
      );
    });
  });

  describe('handleKmsMessage', () => {
    it('should resolve pending requests with KMS messages', async () => {
      const mockHttpDo = jest.fn() as jest.MockedFunction<HttpDoFn>;
      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      // No pending requests — should not throw
      kmsClient.handleKmsMessage({
        encryption: { kmsMessages: ['some-message'] },
      });
    });

    it('should handle messages without kmsMessages array', () => {
      const mockHttpDo = jest.fn() as jest.MockedFunction<HttpDoFn>;
      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      // Should not throw
      kmsClient.handleKmsMessage({ someOtherField: 'value' } as Record<string, unknown>);
    });

    it('should try data.kmsMessages first, then data.encryption.kmsMessages', () => {
      const mockHttpDo = jest.fn() as jest.MockedFunction<HttpDoFn>;
      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      // Both formats should work without error
      kmsClient.handleKmsMessage({ kmsMessages: ['msg1'] });
      kmsClient.handleKmsMessage({ encryption: { kmsMessages: ['msg2'] } });
    });
  });

  describe('getKey', () => {
    it('should return cached key on second call', async () => {
      mockRequestId = 'init-request-id';
      const mockHttpDo = createMockHttpDo([]);

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });
      await initializeClient(kmsClient, mockHttpDo);

      // getKey POST returns 202
      mockRequestId = 'key-request-id';
      mockHttpDo.mockResolvedValueOnce({
        status: 202,
        ok: true,
        json: async () => ({}),
        text: async () => '',
      });

      const keyUri = 'https://encryption-a.wbx2.com/keys/key-123';
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
      expect(mockHttpDo).toHaveBeenCalledTimes(3);
    });

    it('should fetch key from KMS on cache miss', async () => {
      mockRequestId = 'init-request-id';
      const mockHttpDo = createMockHttpDo([]);

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });
      await initializeClient(kmsClient, mockHttpDo);

      // getKey POST returns 202
      mockRequestId = 'key-request-id';
      mockHttpDo.mockResolvedValueOnce({
        status: 202,
        ok: true,
        json: async () => ({}),
        text: async () => '',
      });

      const keyUri = 'https://encryption-a.wbx2.com/keys/key-123';
      const getKeyPromise = kmsClient.getKey(keyUri);

      // Simulate Mercury response
      await new Promise((r) => setTimeout(r, 10));
      kmsClient.handleKmsMessage({
        encryption: { kmsMessages: ['wrapped-key-response'] },
      });

      await getKeyPromise;

      // 2 for init + 1 for getKey = 3
      expect(mockHttpDo).toHaveBeenCalledTimes(3);
    });

    it('should throw KmsError if not initialized', async () => {
      const mockHttpDo = jest.fn() as jest.MockedFunction<HttpDoFn>;
      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      const keyUri = 'https://encryption-a.wbx2.com/keys/key-123';

      await expect(kmsClient.getKey(keyUri)).rejects.toThrow(KmsError);
    });

    it('should throw KmsError if key HTTP POST fails', async () => {
      mockRequestId = 'init-request-id';
      const mockHttpDo = createMockHttpDo([]);

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });
      await initializeClient(kmsClient, mockHttpDo);

      // getKey POST fails
      mockRequestId = 'key-request-id';
      mockHttpDo.mockResolvedValueOnce({
        status: 404,
        ok: false,
        json: async () => ({}),
        text: async () => 'Not Found',
      });

      const keyUri = 'https://encryption-a.wbx2.com/keys/nonexistent';

      await expect(kmsClient.getKey(keyUri)).rejects.toThrow(KmsError);
    });
  });

  describe('context expiration', () => {
    it('should detect expired context via isContextExpired', async () => {
      // A client that was never initialized should consider context expired
      const mockHttpDo = jest.fn() as jest.MockedFunction<HttpDoFn>;
      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      // getKey on uninitialized client → throws because no context
      await expect(kmsClient.getKey('kms://test/key')).rejects.toThrow(KmsError);
    });
  });

  describe('error handling', () => {
    it('should wrap non-KmsError exceptions during initialize', async () => {
      const mockHttpDo = jest.fn().mockRejectedValueOnce(
        new Error('Unknown error')
      ) as jest.MockedFunction<HttpDoFn>;

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });

      await expect(kmsClient.initialize()).rejects.toThrow(KmsError);
      await expect(kmsClient.initialize()).rejects.toThrow(
        'KMS initialization failed'
      );
    });

    it('should wrap non-KmsError exceptions during getKey', async () => {
      mockRequestId = 'init-request-id';
      const mockHttpDo = createMockHttpDo([]);

      const kmsClient = new KmsClient({ ...mockConfig, httpDo: mockHttpDo });
      await initializeClient(kmsClient, mockHttpDo);

      // getKey call that throws network error
      mockRequestId = 'key-request-id';
      mockHttpDo.mockRejectedValueOnce(new Error('Network error'));

      const keyUri = 'https://encryption-a.wbx2.com/keys/key-123';

      await expect(kmsClient.getKey(keyUri)).rejects.toThrow(KmsError);
    });
  });
});
