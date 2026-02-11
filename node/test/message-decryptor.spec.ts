import { MessageDecryptor } from '../src/message-decryptor';
import { DecryptionError } from '../src/errors';
import type { MercuryActivity } from '../src/types';
import encryptedActivityFixture from './fixtures/encrypted-activity.json' assert { type: 'json' };

// Mock KmsClient
const mockKmsClient = {
  getKey: jest.fn(),
};

// Mock node-jose
jest.mock('node-jose', () => {
  return {
    JWE: {
      createDecrypt: jest.fn(),
    },
  };
});

describe('MessageDecryptor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKmsClient.getKey.mockClear();
  });

  describe('decryptActivity', () => {
    it('should pass through activity without encryptionKeyUrl', async () => {
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'Hello World',
          content: '<p>Hello World</p>',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
      };

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      const result = await decryptor.decryptActivity(activity);

      expect(result).toEqual(activity);
      expect(mockKmsClient.getKey).not.toHaveBeenCalled();
    });

    it('should use encryptionKeyUrl from activity root', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-123';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        encryptionKeyUrl: keyUrl,
      };

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-display') })
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-content') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      const result = await decryptor.decryptActivity(activity);

      expect(mockKmsClient.getKey).toHaveBeenCalledWith(keyUrl);
      expect(result.object.displayName).toBe('decrypted-display');
      expect(result.object.content).toBe('decrypted-content');
    });

    it('should use encryptionKeyUrl from object', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-456';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
          encryptionKeyUrl: keyUrl,
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-display') })
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-content') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      const result = await decryptor.decryptActivity(activity);

      expect(mockKmsClient.getKey).toHaveBeenCalledWith(keyUrl);
      expect(result.object.displayName).toBe('decrypted-display');
    });

    it('should use encryptionKeyUrl from target', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-789';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
          encryptionKeyUrl: keyUrl,
        },
        published: '2024-01-01T00:00:00Z',
      };

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-display') })
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-content') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      await decryptor.decryptActivity(activity);

      expect(mockKmsClient.getKey).toHaveBeenCalledWith(keyUrl);
    });

    it('should return shallow copy and not mutate original', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-123';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        encryptionKeyUrl: keyUrl,
      };

      const originalDisplayName = activity.object.displayName;
      const originalContent = activity.object.content;

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-display') })
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-content') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      const result = await decryptor.decryptActivity(activity);

      // Original should not be mutated
      expect(activity.object.displayName).toBe(originalDisplayName);
      expect(activity.object.content).toBe(originalContent);

      // Result should be different object
      expect(result).not.toBe(activity);
      expect(result.object).not.toBe(activity.object);
      expect(result.object.displayName).toBe('decrypted-display');
      expect(result.object.content).toBe('decrypted-content');
    });

    it('should handle displayName decryption failure with warning', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-123';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        encryptionKeyUrl: keyUrl,
      };

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockRejectedValueOnce(new Error('Decryption failed'))
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-content') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };

      const decryptor = new MessageDecryptor({
        kmsClient: mockKmsClient as any,
        logger,
      });
      const result = await decryptor.decryptActivity(activity);

      // Should warn but not throw
      expect(logger.warn).toHaveBeenCalled();
      // displayName should remain encrypted
      expect(result.object.displayName).toBe('encrypted-display');
      // content should be decrypted
      expect(result.object.content).toBe('decrypted-content');
    });

    it('should handle content decryption failure with warning', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-123';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        encryptionKeyUrl: keyUrl,
      };

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-display') })
          .mockRejectedValueOnce(new Error('Content decryption failed')),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };

      const decryptor = new MessageDecryptor({
        kmsClient: mockKmsClient as any,
        logger,
      });
      const result = await decryptor.decryptActivity(activity);

      // Should warn but not throw
      expect(logger.warn).toHaveBeenCalled();
      // displayName should be decrypted
      expect(result.object.displayName).toBe('decrypted-display');
      // content should remain encrypted
      expect(result.object.content).toBe('encrypted-content');
    });

    it('should skip empty displayName', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-123';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: '',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        encryptionKeyUrl: keyUrl,
      };

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-content') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      const result = await decryptor.decryptActivity(activity);

      // decrypt should only be called once (for content)
      expect(mockDecryptor.decrypt).toHaveBeenCalledTimes(1);
      expect(result.object.displayName).toBe('');
    });

    it('should skip missing content', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-123';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        encryptionKeyUrl: keyUrl,
      };

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('decrypted-display') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      const result = await decryptor.decryptActivity(activity);

      // decrypt should only be called once (for displayName)
      expect(mockDecryptor.decrypt).toHaveBeenCalledTimes(1);
      expect(result.object.displayName).toBe('decrypted-display');
      expect(result.object.content).toBeUndefined();
    });

    it('should throw DecryptionError if KMS getKey fails', async () => {
      const keyUrl = 'https://kms.example.com/keys/key-123';
      const activity: MercuryActivity = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        encryptionKeyUrl: keyUrl,
      };

      mockKmsClient.getKey.mockRejectedValueOnce(new Error('Key not found'));

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });

      await expect(decryptor.decryptActivity(activity)).rejects.toThrow(
        DecryptionError
      );
    });

    it('should throw DecryptionError on unexpected error', async () => {
      const activity: any = {
        id: 'test-123',
        verb: 'post',
        actor: {
          id: 'actor-id',
          objectType: 'person',
          emailAddress: 'user@example.com',
        },
        object: {
          id: 'msg-id',
          objectType: 'comment',
          displayName: 'encrypted-display',
          content: 'encrypted-content',
        },
        target: {
          id: 'room-id',
          objectType: 'conversation',
          tags: ['GROUP'],
        },
        published: '2024-01-01T00:00:00Z',
        // Missing encryptionKeyUrl on purpose, but we'll make it an object that throws
        get encryptionKeyUrl() {
          throw new Error('Access denied');
        },
      };

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });

      await expect(decryptor.decryptActivity(activity)).rejects.toThrow(
        DecryptionError
      );
    });
  });

  describe('with fixture data', () => {
    it('should decrypt the encrypted activity fixture', async () => {
      const activity = encryptedActivityFixture as MercuryActivity;

      const mockKey = { kty: 'oct' };
      mockKmsClient.getKey.mockResolvedValueOnce(mockKey);

      const jose = require('node-jose');
      const mockDecryptor = {
        decrypt: jest
          .fn()
          .mockResolvedValueOnce({ payload: Buffer.from('Test Message') })
          .mockResolvedValueOnce({ payload: Buffer.from('<p>Test Message</p>') }),
      };
      jose.JWE.createDecrypt.mockReturnValue(mockDecryptor);

      const decryptor = new MessageDecryptor({ kmsClient: mockKmsClient as any });
      const result = await decryptor.decryptActivity(activity);

      expect(result.object.displayName).toBe('Test Message');
      expect(result.object.content).toBe('<p>Test Message</p>');
      expect(mockKmsClient.getKey).toHaveBeenCalledWith(
        'https://kms.example.com/keys/key-abc'
      );
    });
  });
});
