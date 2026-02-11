import { EventEmitter } from 'events';
import type * as http from 'http';
import type * as https from 'https';
import type {
  WebexMessageHandlerConfig,
  WebexMessageHandlerEvents,
  DeviceRegistration,
  MercuryActivity,
  DecryptedMessage,
  HandlerStatus,
  ConnectionStatus,
} from './types.js';
import { DeviceManager } from './device-manager.js';
import { MercurySocket } from './mercury-socket.js';
import { KmsClient } from './kms-client.js';
import { MessageDecryptor } from './message-decryptor.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';

export interface TypedEventEmitter<T> {
  on<K extends keyof T>(event: K, listener: T[K]): this;
  emit<K extends keyof T>(event: K, ...args: Parameters<T[K] extends (...a: infer P) => unknown ? (...a: P) => unknown : never>): boolean;
  off<K extends keyof T>(event: K, listener: T[K]): this;
  once<K extends keyof T>(event: K, listener: T[K]): this;
  removeAllListeners<K extends keyof T>(event?: K): this;
}

export class WebexMessageHandler
  extends EventEmitter
  implements TypedEventEmitter<WebexMessageHandlerEvents>
{
  private token: string;
  private logger: Logger;
  private agent: http.Agent | https.Agent | undefined;
  private deviceManager: DeviceManager;
  private mercurySocket: MercurySocket;
  private kmsClient: KmsClient | null = null;
  private messageDecryptor: MessageDecryptor | null = null;
  private registration: DeviceRegistration | null = null;
  private _connected = false;
  private _connecting = false;

  constructor(config: WebexMessageHandlerConfig) {
    super();

    if (!config.token || typeof config.token !== 'string') {
      throw new Error('WebexMessageHandler requires a non-empty token string');
    }

    this.token = config.token;
    this.logger = config.logger ?? noopLogger;
    this.agent = config.agent;

    this.deviceManager = new DeviceManager({
      logger: this.logger,
      agent: this.agent,
    });
    this.mercurySocket = new MercurySocket({
      logger: this.logger,
      agent: this.agent,
      pingInterval: config.pingInterval,
      pongTimeout: config.pongTimeout,
      reconnectBackoffMax: config.reconnectBackoffMax,
      maxReconnectAttempts: config.maxReconnectAttempts,
    });

    this._setupMercuryListeners();
  }

  async connect(): Promise<void> {
    if (this._connecting) {
      throw new Error('connect() already in progress');
    }
    if (this._connected) {
      throw new Error('Already connected. Call disconnect() first, or use reconnect(newToken).');
    }

    this.logger.info('Connecting to Webex...');
    this._connecting = true;

    try {
      // Step 1: Register device with WDM
      this.registration = await this.deviceManager.register(this.token);
      this.logger.info('Device registered');

      // Step 2: Create KMS client (needs device info but don't init yet — needs Mercury)
      this.kmsClient = new KmsClient({
        token: this.token,
        deviceUrl: this.registration.deviceUrl,
        userId: this.registration.userId,
        encryptionServiceUrl: this.registration.encryptionServiceUrl,
        logger: this.logger,
        agent: this.agent,
      });

      // Step 3: Connect Mercury WebSocket FIRST (KMS responses arrive here)
      await this.mercurySocket.connect(
        this.registration.webSocketUrl,
        this.token
      );
      this.logger.info('Mercury connected');

      // Step 4: Now initialize KMS (ECDH handshake — response comes via Mercury)
      await this.kmsClient.initialize();
      this.logger.info('KMS initialized');

      // Step 5: Create message decryptor
      this.messageDecryptor = new MessageDecryptor({
        kmsClient: this.kmsClient,
        logger: this.logger,
      });

      this._connecting = false;
      this._connected = true;
      this.logger.info('Connected to Webex');
      this.emit('connected');
    } catch (error) {
      this._connecting = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Webex...');
    this._connected = false;

    await this.mercurySocket.disconnect();

    if (this.registration) {
      try {
        await this.deviceManager.unregister(this.token);
        this.logger.info('Device unregistered');
      } catch (error) {
        this.logger.warn(
          `Failed to unregister device: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.registration = null;
    this.kmsClient = null;
    this.messageDecryptor = null;
  }

  /**
   * Update the access token and re-establish the connection.
   * Tears down the existing connection (device, WebSocket, KMS) and
   * reconnects from scratch with the new token.
   *
   * Call this when the token has been refreshed externally (e.g. OAuth
   * token rotation) and the bot needs to keep running.
   */
  async reconnect(newToken: string): Promise<void> {
    if (!newToken || typeof newToken !== 'string') {
      throw new Error('reconnect() requires a non-empty token string');
    }

    this.logger.info('Reconnecting with new token...');

    // Tear down existing connection
    await this.disconnect();

    // Store new token and connect fresh
    this.token = newToken;
    await this.connect();
  }

  get connected(): boolean {
    return this._connected && this.mercurySocket.connected;
  }

  /**
   * Returns a structured health check of all connection subsystems.
   * Use this to determine whether the handler is healthy, connecting,
   * reconnecting, or fully disconnected.
   */
  status(): HandlerStatus {
    const reconnectAttempt = this.mercurySocket.currentReconnectAttempts;

    let status: ConnectionStatus;
    if (this._connected && this.mercurySocket.connected) {
      status = 'connected';
    } else if (this._connecting) {
      status = 'connecting';
    } else if (reconnectAttempt > 0) {
      status = 'reconnecting';
    } else {
      status = 'disconnected';
    }

    return {
      status,
      webSocketOpen: this.mercurySocket.connected,
      kmsInitialized: this.kmsClient !== null,
      deviceRegistered: this.registration !== null,
      reconnectAttempt,
    };
  }

  private _setupMercuryListeners(): void {
    // Forward KMS messages from Mercury to the KMS client
    this.mercurySocket.on('kms:response', (data: Record<string, unknown>) => {
      if (this.kmsClient) {
        this.kmsClient.handleKmsMessage(data as { kmsMessages?: string[] });
      }
    });

    this.mercurySocket.on(
      'activity',
      (activity: MercuryActivity) => {
        this._handleActivity(activity).catch((error) => {
          this.logger.error('Error handling activity:', error);
          this.emit('error', error instanceof Error ? error : new Error(String(error)));
        });
      }
    );

    this.mercurySocket.on('connected', () => {
      // Reconnection happened — refresh device and KMS context
      this._onReconnect().catch((error) => {
        this.logger.error('Error during reconnection refresh:', error);
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      });
    });

    this.mercurySocket.on('disconnected', (reason: string) => {
      this._connected = false;
      this.emit('disconnected', reason);
    });

    this.mercurySocket.on('reconnecting', (attempt: number) => {
      this.emit('reconnecting', attempt);
    });

    this.mercurySocket.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private async _handleActivity(activity: MercuryActivity): Promise<void> {
    // message:created — verb=post + objectType=comment
    if (
      activity.verb === 'post' &&
      activity.object?.objectType === 'comment'
    ) {
      if (!this.messageDecryptor) {
        this.logger.warn('Received activity but decryptor not initialized');
        return;
      }

      const decrypted = await this.messageDecryptor.decryptActivity(activity);
      const message: DecryptedMessage = {
        id: decrypted.object.id,
        roomId: decrypted.target.id,
        personId: decrypted.actor.id,
        personEmail: decrypted.actor.emailAddress ?? '',
        text: decrypted.object.displayName ?? '',
        html: decrypted.object.content,
        created: decrypted.published,
        roomType: this._inferRoomType(decrypted),
        raw: decrypted,
      };
      this.emit('message:created', message);
      return;
    }

    // message:deleted — verb=delete + objectType=activity
    if (
      activity.verb === 'delete' &&
      activity.object?.objectType === 'activity'
    ) {
      this.emit('message:deleted', {
        messageId: activity.object.id,
        roomId: activity.target.id,
        personId: activity.actor.id,
      });
      return;
    }
  }

  private _inferRoomType(activity: MercuryActivity): string | undefined {
    const tags = activity.target?.tags;
    if (!tags) return undefined;
    if (tags.includes('ONE_ON_ONE')) return 'direct';
    if (tags.includes('TEAM') || tags.includes('LOCKED') || tags.includes('GROUP')) return 'group';
    return undefined;
  }

  private async _onReconnect(): Promise<void> {
    this.logger.info('Mercury reconnected, refreshing device and KMS');

    try {
      if (this.registration) {
        this.registration = await this.deviceManager.refresh(this.token);
      }
    } catch (error) {
      this.logger.warn(`Device refresh on reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      if (this.kmsClient) {
        await this.kmsClient.initialize();
      }
    } catch (error) {
      this.logger.warn(`KMS re-init on reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    this._connected = true;
    this.emit('connected');
  }
}
