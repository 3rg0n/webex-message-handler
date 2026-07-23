import { EventEmitter } from 'events';
import { WebSocket as UndiciWebSocket, type Dispatcher } from 'undici';
import type {
  WebexMessageHandlerConfig,
  WebexMessageHandlerEvents,
  DeviceRegistration,
  MercuryActivity,
  DecryptedMessage,
  MembershipActivity,
  AttachmentAction,
  RoomActivity,
  HandlerStatus,
  ConnectionStatus,
  FetchRequest,
  FetchResponse,
  InjectedWebSocket,
  PersonInfo,
  MetricsCallback,
} from './types.js';
import { DeviceManager } from './device-manager.js';
import { MercurySocket } from './mercury-socket.js';
import { KmsClient } from './kms-client.js';
import { MessageDecryptor } from './message-decryptor.js';
import { parseMentions } from './mention-parser.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';

// Internal adapter types
type HttpDoFn = (request: FetchRequest) => Promise<FetchResponse>;
type WsFactoryFn = (url: string) => InjectedWebSocket;

/**
 * Extract the UUID from a Webex person ID.
 *
 * Webex REST API returns base64-encoded IDs like:
 *   "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9mYjUx..." → "ciscospark://us/PEOPLE/fb51254f-..."
 *
 * Mercury wire format uses raw UUIDs:
 *   "fb51254f-3b37-4e50-aa04-45744c2effc7"
 *
 * This function normalizes both formats to the raw UUID for comparison.
 */
function extractPersonUuid(id: string): string {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf-8');
    if (decoded.startsWith('ciscospark://')) {
      const uuid = decoded.split('/').pop();
      if (uuid) return uuid;
    }
  } catch {
    // Not base64 — treat as raw UUID
  }
  return id;
}

/** Wraps native WebSocket (EventTarget API) into InjectedWebSocket (.on() API) */
function wrapNativeWebSocket(url: string, dispatcher?: Dispatcher): InjectedWebSocket {
  const ws = new UndiciWebSocket(url, { dispatcher });
  return {
    get readyState() { return ws.readyState; },
    send(data: string) { ws.send(data); },
    close(code?: number) { ws.close(code); },
    on(event: string, listener: (...args: unknown[]) => void) {
      switch (event) {
        case 'open':
          ws.addEventListener('open', () => listener());
          break;
        case 'message':
          ws.addEventListener('message', (e) => listener(e.data));
          break;
        case 'close':
          ws.addEventListener('close', (e) => listener(e.code, e.reason));
          break;
        case 'error':
          ws.addEventListener('error', (e) => {
            const message = 'message' in e ? String(e.message) : 'WebSocket error';
            listener(new Error(message));
          });
          break;
      }
    },
  } as InjectedWebSocket;
}

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
  private httpDo: HttpDoFn;
  private wsFactory: WsFactoryFn;
  private metricsCallback?: MetricsCallback;
  private deviceManager: DeviceManager;
  private mercurySocket: MercurySocket;
  private kmsClient: KmsClient | null = null;
  private messageDecryptor: MessageDecryptor | null = null;
  private registration: DeviceRegistration | null = null;
  private _connected = false;
  private _connecting = false;
  private ignoreSelfMessages: boolean;
  private botPersonId: string | null = null;
  private recentActivityIds = new Map<string, number>();

  constructor(config: WebexMessageHandlerConfig) {
    super();

    if (!config.token || typeof config.token !== 'string') {
      throw new Error('WebexMessageHandler requires a non-empty token string');
    }

    // Validate networking mode configuration
    const mode = config.mode ?? 'native';
    if (mode === 'injected') {
      if (!config.fetch || !config.webSocketFactory) {
        throw new Error('Injected mode requires both "fetch" and "webSocketFactory"');
      }
      if (config.dispatcher) {
        throw new Error('Cannot use native proxy parameters (dispatcher) in injected mode');
      }
    } else if (mode === 'native') {
      if (config.fetch || config.webSocketFactory) {
        throw new Error('Cannot provide fetch/webSocketFactory in native mode — set mode to "injected"');
      }
    } else {
      throw new Error(`Invalid mode "${mode}" — must be "native" or "injected"`);
    }

    this.token = config.token;
    this.logger = config.logger ?? noopLogger;
    this.ignoreSelfMessages = config.ignoreSelfMessages ?? true;
    this.metricsCallback = config.metricsCallback;

    // Create adapters based on mode
    if (mode === 'native') {
      this.httpDo = this._createNativeHttpAdapter(config.dispatcher as Dispatcher | undefined);
      this.wsFactory = this._createNativeWsAdapter(config.dispatcher as Dispatcher | undefined);
    } else {
      // injected mode - use provided fetch and webSocketFactory
      this.httpDo = config.fetch!; // Already validated in mode check
      this.wsFactory = config.webSocketFactory!; // Already validated in mode check
    }

    this.deviceManager = new DeviceManager({
      logger: this.logger,
      httpDo: this.httpDo,
    });
    this.mercurySocket = new MercurySocket({
      logger: this.logger,
      wsFactory: this.wsFactory,
      pingInterval: config.pingInterval,
      pongTimeout: config.pongTimeout,
      reconnectBackoffMax: config.reconnectBackoffMax,
      maxReconnectAttempts: config.maxReconnectAttempts,
    });

    this._setupMercuryListeners();
  }

  private _reportMetric(name: string, startTime: number, success: boolean, metadata?: Record<string, string>): void {
    if (this.metricsCallback) {
      this.metricsCallback({
        name,
        durationMs: Date.now() - startTime,
        success,
        metadata,
      });
    }
  }

  private _createNativeHttpAdapter(dispatcher?: Dispatcher): HttpDoFn {
    return async (request: FetchRequest): Promise<FetchResponse> => {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        // @ts-expect-error - dispatcher is an undici option for Node.js fetch
        dispatcher,
      });

      return {
        status: response.status,
        ok: response.ok,
        json: () => response.json(),
        text: () => response.text(),
      };
    };
  }

  private _createNativeWsAdapter(dispatcher?: Dispatcher): WsFactoryFn {
    return (url: string): InjectedWebSocket => {
      return wrapNativeWebSocket(url, dispatcher);
    };
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

    const connectStart = Date.now();
    try {
      // Step 1: Register device with WDM
      this.registration = await this.deviceManager.register(this.token);
      this.logger.info('Device registered');

      // Step 1.5: Fetch bot's person info if self-message filtering is enabled
      if (this.ignoreSelfMessages) {
        await this._fetchBotPersonId();
      }

      // Step 2: Create KMS client (needs device info but don't init yet — needs Mercury)
      this.kmsClient = new KmsClient({
        token: this.token,
        deviceUrl: this.registration.deviceUrl,
        userId: this.registration.userId,
        encryptionServiceUrl: this.registration.encryptionServiceUrl,
        logger: this.logger,
        httpDo: this.httpDo,
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
      this._reportMetric('connect', connectStart, true);
      this.emit('connected');
    } catch (error) {
      this._connecting = false;
      this._reportMetric('connect', connectStart, false);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Webex...');
    this._connected = false;

    // Clean up Mercury event listeners
    this.mercurySocket.removeAllListeners();

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
    this.botPersonId = null;
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

  /**
   * Returns a read-only copy of the WDM registration obtained at connect time,
   * or null if not yet connected.
   *
   * This library stays inbound-only — it does not make outbound calls. This
   * accessor exists so wrapper code can perform its own outbound calls (e.g. a
   * Conversation-service read-receipt) using the service catalog the library
   * already holds. Resolve outbound URLs from `services` rather than hardcoding
   * cluster hostnames, which vary across clusters and orgs.
   *
   * The returned value is a copy: mutating it does not affect internal state.
   */
  deviceRegistration(): DeviceRegistration | null {
    if (!this.registration) {
      return null;
    }
    return {
      ...this.registration,
      services: { ...this.registration.services },
    };
  }

  /**
   * Returns the URL for a named WDM service from the registration's service
   * catalog (e.g. "conversationServiceUrl"), or undefined if not yet connected
   * or the service is unknown.
   *
   * Use this to discover outbound service base URLs instead of hardcoding
   * cluster hostnames. See {@link deviceRegistration} for the broader rationale.
   */
  serviceUrl(name: string): string | undefined {
    return this.registration?.services[name];
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
    // Activity replay protection
    const activityId = activity.id;
    if (this.recentActivityIds.has(activityId)) {
      this.logger.warn(`Duplicate activity detected, ignoring: ${activityId}`);
      return;
    }
    this.recentActivityIds.set(activityId, Date.now());

    // Sweep old entries (every 100 activities, remove entries older than 5 minutes)
    if (this.recentActivityIds.size % 100 === 0) {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      for (const [id, timestamp] of this.recentActivityIds.entries()) {
        if (timestamp < fiveMinutesAgo) {
          this.recentActivityIds.delete(id);
        }
      }
    }

    // message:created or message:updated — verb=post/update + objectType=comment
    if (
      (activity.verb === 'post' || activity.verb === 'update') &&
      activity.object?.objectType === 'comment'
    ) {
      if (!this.messageDecryptor) {
        this.logger.warn('Received activity but decryptor not initialized');
        return;
      }

      const decryptStart = Date.now();
      let decrypted;
      try {
        decrypted = await this.messageDecryptor.decryptActivity(activity);
        this._reportMetric('decrypt', decryptStart, true);
      } catch (err) {
        this._reportMetric('decrypt', decryptStart, false);
        throw err;
      }

      const mentions = parseMentions(decrypted.object.content);
      const message: DecryptedMessage = {
        id: decrypted.id,
        url: decrypted.url,
        parentId: decrypted.parent?.id,
        roomId: decrypted.target.id,
        personId: decrypted.actor.id,
        personEmail: decrypted.actor.emailAddress ?? '',
        text: decrypted.object.displayName ?? '',
        html: decrypted.object.content,
        created: decrypted.published,
        roomType: this._inferRoomType(decrypted),
        mentionedPeople: mentions.mentionedPeople,
        mentionedGroups: mentions.mentionedGroups,
        files: decrypted.object.files ?? [],
        raw: decrypted,
      };

      // Filter self-messages if enabled
      if (this.ignoreSelfMessages && this.botPersonId && extractPersonUuid(message.personId) === this.botPersonId) {
        this.logger.debug(`Ignoring self-message from bot (${this.botPersonId})`);
        return;
      }

      const eventName = activity.verb === 'update' ? 'message:updated' : 'message:created';
      this.emit(eventName, message);
      return;
    }

    // message:deleted — verb=delete + objectType=activity
    if (
      activity.verb === 'delete' &&
      activity.object?.objectType === 'activity'
    ) {
      this.logger.info(`Message deleted: ${activity.object.id} in room ${activity.target.id}`);
      this.emit('message:deleted', {
        messageId: activity.object.id,
        roomId: activity.target.id,
        personId: activity.actor.id,
      });
      return;
    }

    // membership:created — membership verbs + objectType=person
    const membershipVerbs = ['add', 'leave', 'assignModerator', 'unassignModerator'];
    if (
      membershipVerbs.includes(activity.verb) &&
      activity.object?.objectType === 'person'
    ) {
      const membershipActivity: MembershipActivity = {
        id: activity.id,
        actorId: activity.actor.id,
        personId: activity.object.id,
        roomId: activity.target.id,
        action: activity.verb,
        created: activity.published,
        roomType: this._inferRoomType(activity),
        raw: activity,
      };
      this.emit('membership:created', membershipActivity);
      return;
    }

    // attachmentAction:created — verb=cardAction + objectType=submit
    if (
      activity.verb === 'cardAction' &&
      activity.object?.objectType === 'submit'
    ) {
      let decryptedActivity = activity;

      // Decrypt the activity to handle encrypted inputs
      if (this.messageDecryptor) {
        try {
          decryptedActivity = await this.messageDecryptor.decryptActivity(activity);
        } catch (error) {
          this.logger.warn(
            `Failed to decrypt card-action inputs in activity ${activity.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          // Fall through with unencrypted activity; inputs will be empty object
        }
      }

      // Extract inputs, handling the case where it might still be encrypted (on decrypt failure) or a plaintext object
      let inputs: Record<string, unknown> = {};
      if (decryptedActivity.object.inputs && typeof decryptedActivity.object.inputs === 'object') {
        inputs = decryptedActivity.object.inputs as Record<string, unknown>;
      }

      const attachmentAction: AttachmentAction = {
        id: decryptedActivity.id,
        messageId: decryptedActivity.parent?.id ?? '',
        personId: decryptedActivity.actor.id,
        personEmail: decryptedActivity.actor.emailAddress ?? '',
        roomId: decryptedActivity.target.id,
        inputs,
        created: decryptedActivity.published,
        raw: decryptedActivity,
      };
      this.emit('attachmentAction:created', attachmentAction);
      return;
    }

    // room:created or room:updated — verb=create/update + object.objectType=conversation
    if (
      (activity.verb === 'create' || activity.verb === 'update') &&
      activity.object?.objectType === 'conversation'
    ) {
      const roomActivity: RoomActivity = {
        id: activity.id,
        roomId: activity.target.id,
        actorId: activity.actor.id,
        action: activity.verb === 'create' ? 'created' : 'updated',
        created: activity.published,
        raw: activity,
      };
      const eventName = activity.verb === 'create' ? 'room:created' : 'room:updated';
      this.emit(eventName, roomActivity);
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

  private async _fetchBotPersonId(): Promise<void> {
    this.logger.debug('Fetching bot person info for self-message filtering');

    const response = await this.httpDo({
      url: 'https://webexapis.com/v1/people/me',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch bot identity for self-message filtering: HTTP ${response.status}. ` +
        'Set ignoreSelfMessages: false to skip this check (not recommended — may cause message loops).'
      );
    }

    const personInfo = await response.json() as PersonInfo;
    this.botPersonId = extractPersonUuid(personInfo.id);
    this.logger.info(`Bot person ID cached for self-message filtering: ${this.botPersonId}`);
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
