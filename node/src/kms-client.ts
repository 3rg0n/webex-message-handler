import * as KMS from 'node-kms';
import * as jose from 'node-jose';
import type { JWK } from 'node-jose';
import { KmsError } from './errors.js';
import { Logger, noopLogger } from './logger.js';
import type { FetchRequest, FetchResponse } from './types.js';

type HttpDoFn = (request: FetchRequest) => Promise<FetchResponse>;

interface KmsClientConfig {
  token: string;
  deviceUrl: string;
  userId: string;
  encryptionServiceUrl: string;
  logger?: Logger;
  httpDo: HttpDoFn;
}

interface KmsDetailsResponse {
  kmsCluster: string;
  rsaPublicKey: string | Record<string, unknown>;
}

interface PendingRequest {
  resolve: (wrapped: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const KMS_RESPONSE_TIMEOUT = 30000;

export class KmsClient {
  private token: string;
  private deviceUrl: string;
  private userId: string;
  private encryptionServiceUrl: string;
  private logger: Logger;
  private httpDo: HttpDoFn;

  private context: KMS.Context | null = null;
  private kmsCluster: string = '';
  private keyCache: Map<string, JWK.Key> = new Map();
  private contextExpiration: Date | null = null;

  // Pending KMS requests waiting for responses via Mercury
  private pendingRequests: Map<string, PendingRequest> = new Map();

  // Mutex to serialize KMS requests and ensure FIFO is safe
  private _kmsRequestMutex: Promise<void> = Promise.resolve();

  constructor(config: KmsClientConfig) {
    this.token = config.token;
    this.deviceUrl = config.deviceUrl;
    this.userId = config.userId;
    this.encryptionServiceUrl = config.encryptionServiceUrl;
    this.logger = config.logger ?? noopLogger;
    this.httpDo = config.httpDo;
  }

  /**
   * Execute a function with the KMS request lock held.
   * This ensures only one KMS request is in-flight at a time, making FIFO safe.
   */
  private async _withKmsLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._kmsRequestMutex;
    let resolve: () => void;
    this._kmsRequestMutex = new Promise(r => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  /**
   * Handle a KMS response that arrived via Mercury WebSocket.
   * Called by the handler when a `encryption.kms_message` event is received.
   */
  handleKmsMessage(data: { kmsMessages?: string[]; encryption?: { kmsMessages?: string[] }; [key: string]: unknown }): void {
    // kmsMessages may be at data.kmsMessages or data.encryption.kmsMessages
    const kmsMessages = data.kmsMessages || data.encryption?.kmsMessages;
    if (!kmsMessages || !Array.isArray(kmsMessages)) {
      this.logger.debug('Received KMS message without kmsMessages array, keys: ' + Object.keys(data).join(', '));
      return;
    }

    for (const wrapped of kmsMessages) {
      // Try to peek at the requestId to match with pending requests.
      // The wrapped message is a JWE — we can't peek inside. But the
      // KMS protocol includes the requestId both in the encrypted payload
      // and sometimes in the outer envelope. Since we can only have one
      // pending ECDH request at a time during init, and key requests are
      // sequential, we resolve the oldest pending request.
      this.logger.debug(`Received KMS response, pending requests: ${this.pendingRequests.size}`);

      // Resolve the first pending request (FIFO order)
      const firstKey = this.pendingRequests.keys().next().value;
      if (firstKey !== undefined) {
        const pending = this.pendingRequests.get(firstKey);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(firstKey);
          pending.resolve(wrapped);
        }
      } else {
        this.logger.warn('Received KMS response but no pending requests');
      }
    }
  }

  async initialize(): Promise<void> {
    return this._withKmsLock(async () => {
      try {
        this.logger.info('Initializing KMS client');

        // Step 1: Fetch KMS details
        const kmsDetailsUrl = `${this.encryptionServiceUrl}/kms/${this.userId}`;
        const kmsDetailsResponse = await this.httpDo({
          url: kmsDetailsUrl,
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        });

        if (!kmsDetailsResponse.ok) {
          throw new KmsError(
            `Failed to fetch KMS details: ${kmsDetailsResponse.status}`
          );
        }

        const kmsDetails = (await kmsDetailsResponse.json()) as KmsDetailsResponse;
        this.kmsCluster = kmsDetails.kmsCluster;

        // Step 2: Create KMS Context
        const context = new KMS.Context();
        context.clientInfo = {
          clientId: this.deviceUrl,
          credential: {
            userId: this.userId,
            bearer: this.token,
          },
        };
        const rsaPublicKey = typeof kmsDetails.rsaPublicKey === 'string'
          ? JSON.parse(kmsDetails.rsaPublicKey)
          : kmsDetails.rsaPublicKey;
        context.serverInfo = {
          key: rsaPublicKey,
        };

        // Step 3: Generate local ephemeral ECDH keypair
        const localEcdhKey = await context.createECDHKey();
        context.ephemeralKey = localEcdhKey;

        // Step 4: Create ECDH request
        // The SDK calls localECDHKey.asKey() → jose JWK Key, then .toJSON() for just the public JWK
        const localJoseKey = await localEcdhKey.asKey();
        const publicJwk = localJoseKey.toJSON();

        const ecdhRequest = new KMS.Request({
          method: 'create',
          uri: `${this.kmsCluster}/ecdhe`,
        } as { method: string; uri: string });
        (ecdhRequest.body as Record<string, unknown>).jwk = publicJwk;
        await ecdhRequest.wrap(context, { serverKey: true });

        // Step 5: POST ECDH request and wait for response via Mercury
        const wrappedEcdhResponse = await this._sendKmsRequest(
          ecdhRequest.requestId,
          ecdhRequest.wrapped
        );

        // Step 6: Unwrap ECDH response and derive shared key
        const ecdhResponse = new KMS.Response(wrappedEcdhResponse);
        await ecdhResponse.unwrap(context);

        const remoteKey = ecdhResponse.body?.key;
        if (!remoteKey) {
          throw new KmsError('No key in ECDH response, body keys: ' + Object.keys(ecdhResponse.body || {}).join(', '));
        }

        // Validate remote ECDH public key (kty and crv can be at top level or nested in jwk)
        const keyToValidate = (remoteKey as unknown as Record<string, unknown>)?.jwk || remoteKey as unknown as Record<string, unknown>;
        const kty = (keyToValidate as Record<string, unknown>)?.kty;
        const crv = (keyToValidate as Record<string, unknown>)?.crv;
        if (kty !== 'EC' || crv !== 'P-256') {
          throw new KmsError(`Invalid KMS remote key: kty=${kty}, crv=${crv}`);
        }

        const sharedKey = await context.deriveEphemeralKey(remoteKey as unknown as Record<string, unknown>);
        context.ephemeralKey = sharedKey;

        // Step 7: Store context and expiration
        this.context = context;
        if (context.ephemeralKey?.expirationDate) {
          this.contextExpiration = context.ephemeralKey.expirationDate as unknown as Date;
        }

        this.logger.info('KMS client initialized successfully');
      } catch (error) {
        if (error instanceof KmsError) {
          throw error;
        }
        throw new KmsError(
          `KMS initialization failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async getKey(keyUri: string): Promise<JWK.Key> {
    try {
      // Check cache first (no lock needed)
      const cachedKey = this.keyCache.get(keyUri);
      if (cachedKey) {
        this.logger.debug(`Cache hit for key: ${keyUri}`);
        return cachedKey;
      }

      // Check if context is expired (requires re-initialization without lock first)
      if (this.isContextExpired()) {
        this.logger.info('Context expired, re-initializing');
        await this.initialize();
      }

      if (!this.context) {
        throw new KmsError('KMS context not initialized');
      }

      // Retrieve key with lock (context is now guaranteed to exist)
      return await this._withKmsLock(async () => {
        if (!this.context) {
          throw new KmsError('KMS context not initialized');
        }

        // Create and wrap retrieve request
        const request = new KMS.Request({
          method: 'retrieve',
          uri: keyUri,
        });
        await request.wrap(this.context);

        // POST and wait for response via Mercury
        const wrappedKeyResponse = await this._sendKmsRequest(
          request.requestId,
          request.wrapped
        );

        // Unwrap response
        const response = new KMS.Response(wrappedKeyResponse);
        await response.unwrap(this.context);

        const keyObject = response.body.key;
        if (!keyObject) {
          throw new KmsError('No key found in KMS response');
        }

        // Convert to jose key, cache, and return
        const joseKey = await jose.JWK.asKey(keyObject.jwk);
        this.keyCache.set(keyUri, joseKey);
        this.logger.info(`Key retrieved and cached: ${keyUri}`);
        return joseKey;
      });
    } catch (error) {
      if (error instanceof KmsError) {
        throw error;
      }
      throw new KmsError(
        `Failed to get key: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Send a KMS request via HTTP and wait for the response via Mercury.
   * Returns the wrapped response JWE string.
   */
  private async _sendKmsRequest(requestId: string, wrapped: string): Promise<string> {
    // Register a pending request that will be resolved by handleKmsMessage
    const responsePromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new KmsError(`KMS request ${requestId} timed out after ${KMS_RESPONSE_TIMEOUT}ms`));
      }, KMS_RESPONSE_TIMEOUT);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
    });

    // POST the request
    const httpResponse = await this.httpDo({
      url: `${this.encryptionServiceUrl}/kms/messages`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        destination: this.kmsCluster,
        kmsMessages: [wrapped],
      }),
    });

    if (!httpResponse.ok) {
      this.pendingRequests.delete(requestId);
      const errorBody = await httpResponse.text();
      throw new KmsError(
        `KMS HTTP request failed: ${httpResponse.status} ${errorBody}`
      );
    }

    this.logger.debug(`KMS request ${requestId} sent (HTTP ${httpResponse.status}), waiting for Mercury response...`);

    // Wait for the response to arrive via Mercury
    return responsePromise;
  }

  private isContextExpired(): boolean {
    if (!this.context || !this.contextExpiration) {
      return true;
    }

    const expirationWithBuffer = new Date(this.contextExpiration.getTime() - 30000);
    return new Date() > expirationWithBuffer;
  }
}
