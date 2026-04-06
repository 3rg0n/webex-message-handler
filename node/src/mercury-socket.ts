import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { MercuryEnvelope, MercuryActivity, InjectedWebSocket } from './types.js';
import { AuthError, MercuryConnectionError } from './errors.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';

const WS_OPEN = 1;

type WsFactoryFn = (url: string) => InjectedWebSocket;

interface MercuryWireMessage {
  id?: string;
  type?: string;
  data?: {
    eventType?: string;
    activity?: MercuryActivity;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface MercurySocketOptions {
  logger?: Logger;
  wsFactory: WsFactoryFn;
  pingInterval?: number;
  pongTimeout?: number;
  reconnectBackoffMax?: number;
  maxReconnectAttempts?: number;
}

export class MercurySocket extends EventEmitter {
  private ws: InjectedWebSocket | null = null;
  private logger: Logger;
  private wsFactory: WsFactoryFn;
  private pingInterval: number;
  private pongTimeout: number;
  private reconnectBackoffMax: number;
  private maxReconnectAttempts: number;
  private pingIntervalHandle: NodeJS.Timeout | null = null;
  private pongTimeoutHandle: NodeJS.Timeout | null = null;
  private pendingPongId: string | null = null;
  private shouldReconnect: boolean = true;
  private reconnectAttempts: number = 0;
  private token: string | null = null;
  private baseUrl: string | null = null;
  private connectionReady: boolean = false;

  constructor(options: MercurySocketOptions) {
    super();
    this.logger = options.logger || noopLogger;
    this.wsFactory = options.wsFactory;
    this.pingInterval = options.pingInterval || 15000;
    this.pongTimeout = options.pongTimeout || 14000;
    this.reconnectBackoffMax = options.reconnectBackoffMax || 32000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
  }

  async connect(url: string, token: string): Promise<void> {
    this.token = token;
    this.baseUrl = url;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;

    return this._connectInternal();
  }

  private async _connectInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const preparedUrl = this._prepareUrl(this.baseUrl!);
        this.logger.debug(`Connecting to Mercury at ${preparedUrl}`);

        this.ws = this.wsFactory(preparedUrl);
        let settled = false;

        this.ws.on('open', () => {
          this.logger.debug('WebSocket opened, sending authorization');
          const authMessage = JSON.stringify({
            id: uuidv4(),
            type: 'authorization',
            data: { token: `Bearer ${this.token}` },
          });
          this.ws!.send(authMessage);
        });

        this.ws.on('message', (rawData: string) => {
          try {
            this.logger.debug('WS message received (' + rawData.length + ' bytes)');

            // Validate message size (max 1MB)
            if (typeof rawData === 'string' && rawData.length > 1_048_576) {
              this.logger.warn(`Dropping oversized Mercury message (${rawData.length} bytes)`);
              return;
            }

            const message = JSON.parse(rawData) as MercuryWireMessage;
            this._handleMessage(message);

            // Resolve the connect() promise once Mercury signals readiness
            if (!this.connectionReady && this._isConnectionReady(message)) {
              this.connectionReady = true;
              this.logger.debug('Mercury connection ready');
              this._startPingLoop();
              settled = true;
              resolve();
            }
          } catch (error) {
            this.logger.error('Error parsing Mercury message:', error);
          }
        });

        this.ws.on('error', (error: Error) => {
          this.logger.error('WebSocket error:', error);
          if (!settled) {
            settled = true;
            reject(
              new MercuryConnectionError('Failed to connect to Mercury socket')
            );
          } else {
            this.emit('error', error);
          }
        });

        this.ws.on('close', (code: number, reason: string) => {
          if (!settled) {
            settled = true;
            reject(
              new MercuryConnectionError(
                `WebSocket closed during setup (code ${code})`,
                code
              )
            );
          }
          this._handleClose(code, reason);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private _prepareUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    url.searchParams.set('outboundWireFormat', 'text');
    url.searchParams.set('bufferStates', 'true');
    url.searchParams.set('aliasHttpStatus', 'true');
    url.searchParams.set('clientTimestamp', Date.now().toString());
    return url.toString();
  }

  private _isConnectionReady(message: MercuryWireMessage): boolean {
    const eventType = message.data?.eventType;
    if (!eventType) return false;
    return (
      eventType.includes('mercury.buffer_state') ||
      eventType.includes('mercury.registration_status')
    );
  }

  private _startPingLoop(): void {
    this.pingIntervalHandle = setInterval(() => {
      if (this.ws && this.ws.readyState === WS_OPEN) {
        this.pendingPongId = uuidv4();
        const pingMessage = JSON.stringify({
          id: this.pendingPongId,
          type: 'ping',
        });
        this.ws.send(pingMessage);
        this.logger.debug(`Sent ping: ${this.pendingPongId}`);

        // Clear any previous pong timeout before setting a new one
        if (this.pongTimeoutHandle) {
          clearTimeout(this.pongTimeoutHandle);
          this.pongTimeoutHandle = null;
        }

        // Set timeout for pong response
        this.pongTimeoutHandle = setTimeout(() => {
          this.logger.warn(
            `Pong timeout for ping ${this.pendingPongId}, reconnecting`
          );
          this.pendingPongId = null;
          this._closeWebSocket();
          this._reconnect();
        }, this.pongTimeout);
      }
    }, this.pingInterval);
  }

  private _handleMessage(message: MercuryWireMessage): void {
    try {
      if (message.type === 'pong') {
        this._handlePong(message);
      } else if (message.data?.eventType) {
        this._handleActivityEnvelope(message as unknown as MercuryEnvelope);
      } else if (message.type === 'shutdown') {
        this.logger.info('Received shutdown message from Mercury');
        this._handleShutdown();
      } else {
        this.logger.debug('Unhandled Mercury message type: ' + (message.type || 'none') + ', keys: ' + Object.keys(message).join(', '));
      }
    } catch (error) {
      this.logger.error('Error handling Mercury message:', error);
    }
  }

  private _handlePong(message: MercuryWireMessage): void {
    if (this.pendingPongId && message.id === this.pendingPongId) {
      this.logger.debug(`Received pong: ${message.id}`);
      this.pendingPongId = null;
      if (this.pongTimeoutHandle) {
        clearTimeout(this.pongTimeoutHandle);
        this.pongTimeoutHandle = null;
      }
    }
  }

  private _handleActivityEnvelope(message: MercuryEnvelope): void {
    const eventType = message.data?.eventType;
    this.logger.debug(`Mercury eventType: ${eventType}`);

    // Send ACK
    const ackMessage = JSON.stringify({
      messageId: message.id,
      type: 'ack',
    });
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(ackMessage);
    }

    // Emit KMS messages for encryption key exchange
    if (eventType && eventType.startsWith('encryption.')) {
      this.logger.debug(`Emitting kms:response for eventType: ${eventType}`);
      this.emit('kms:response', message.data);
      return;
    }

    // Emit activity if it's a conversation activity
    if (
      eventType === 'conversation.activity' &&
      message.data?.activity
    ) {
      this.logger.debug(
        `Emitting activity: ${message.data.activity.id}`
      );
      this.emit('activity', message.data.activity as MercuryActivity);
    }
  }

  private _handleShutdown(): void {
    // Make-before-break: connect new socket before closing old
    this._reconnect();
  }

  private _handleClose(code: number, reason: string): void {
    this.logger.info(`WebSocket closed with code ${code}: ${reason}`);
    this._stopPingLoop();
    this.connectionReady = false;

    // Handle specific close codes
    if (code === 4401) {
      // NotAuthorized
      this.logger.error('Mercury authorization failed');
      this.shouldReconnect = false;
      this.emit('error', new AuthError('Mercury authorization failed'));
      this.emit('disconnected', 'auth-failed');
      return;
    }

    if (code === 4400 || code === 4403) {
      // Permanent failure
      this.logger.error(`Mercury permanent failure (code ${code})`);
      this.shouldReconnect = false;
      this.emit(
        'error',
        new MercuryConnectionError(
          `Mercury permanent failure (code ${code})`,
          code
        )
      );
      this.emit('disconnected', 'permanent-failure');
      return;
    }

    // Normal disconnect or network error - try to reconnect
    if (this.shouldReconnect) {
      this.logger.info(`Preparing to reconnect after close (code ${code}, reason: ${reason})`);
      this._reconnect();
    } else {
      this.emit('disconnected', 'manual');
    }
  }

  private _reconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`
      );
      this.shouldReconnect = false;
      this.emit('disconnected', 'max-attempts-exceeded');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectBackoffMax
    );

    this.logger.info(
      `Reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`
    );
    this.emit('reconnecting', this.reconnectAttempts);

    setTimeout(() => {
      if (!this.shouldReconnect) {
        return;
      }

      this._connectInternal()
        .then(() => {
          this.logger.info('Successfully reconnected to Mercury');
          this.reconnectAttempts = 0;
          this.emit('connected');
        })
        .catch((error) => {
          this.logger.error('Reconnection failed:', error);
          if (this.shouldReconnect) {
            this._reconnect();
          }
        });
    }, delay);
  }

  private _stopPingLoop(): void {
    if (this.pingIntervalHandle) {
      clearInterval(this.pingIntervalHandle);
      this.pingIntervalHandle = null;
    }
    if (this.pongTimeoutHandle) {
      clearTimeout(this.pongTimeoutHandle);
      this.pongTimeoutHandle = null;
    }
    this.pendingPongId = null;
  }

  private _closeWebSocket(): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.close(1000);
    }
  }

  async disconnect(): Promise<void> {
    this.logger.info('Disconnecting from Mercury');
    this.shouldReconnect = false;
    this._stopPingLoop();
    this._closeWebSocket();
    this.ws = null;
    this.connectionReady = false;
    this.emit('disconnected', 'client');
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  get currentReconnectAttempts(): number {
    return this.reconnectAttempts;
  }
}
