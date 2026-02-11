import type { Logger } from './logger.js';

// --- Configuration ---

export interface WebexMessageHandlerConfig {
  token: string;
  logger?: Logger;
  /** Ping interval in ms (default: 15000) */
  pingInterval?: number;
  /** Pong timeout in ms (default: 14000) */
  pongTimeout?: number;
  /** Max reconnect backoff in ms (default: 32000) */
  reconnectBackoffMax?: number;
  /** Max reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
}

// --- Device Registration ---

export interface DeviceRegistration {
  /** The Mercury WebSocket URL */
  webSocketUrl: string;
  /** The device URL (used as clientId for KMS) */
  deviceUrl: string;
  /** The bot's user ID */
  userId: string;
  /** Service catalog from WDM */
  services: Record<string, string>;
  /** Encryption service URL extracted from services */
  encryptionServiceUrl: string;
}

// --- Mercury Activity ---

export interface MercuryActor {
  id: string;
  objectType: string;
  emailAddress?: string;
}

export interface MercuryObject {
  id: string;
  objectType: string;
  displayName?: string;
  content?: string;
  encryptionKeyUrl?: string;
}

export interface MercuryTarget {
  id: string;
  objectType: string;
  encryptionKeyUrl?: string;
  tags?: string[];
}

export interface MercuryActivity {
  id: string;
  verb: string;
  actor: MercuryActor;
  object: MercuryObject;
  target: MercuryTarget;
  published: string;
  encryptionKeyUrl?: string;
}

export interface MercuryEnvelope {
  id: string;
  data: {
    eventType: string;
    activity: MercuryActivity;
  };
  timestamp: number;
  trackingId: string;
  sequenceNumber?: number;
}

// --- Decrypted Output ---

export interface DecryptedMessage {
  id: string;
  roomId: string;
  personId: string;
  personEmail: string;
  text: string;
  html?: string;
  created: string;
  roomType?: string;
  raw: MercuryActivity;
}

export interface DeletedMessage {
  messageId: string;
  roomId: string;
  personId: string;
}

// --- Status ---

export type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

export interface HandlerStatus {
  /** Overall connection state. */
  status: ConnectionStatus;
  /** Whether the WebSocket is currently open. */
  webSocketOpen: boolean;
  /** Whether the KMS encryption context is initialized. */
  kmsInitialized: boolean;
  /** Whether the device is registered with WDM. */
  deviceRegistered: boolean;
  /** Current auto-reconnect attempt number (0 if not reconnecting). */
  reconnectAttempt: number;
}

// --- Events ---

export interface WebexMessageHandlerEvents {
  'message:created': (msg: DecryptedMessage) => void;
  'message:deleted': (data: DeletedMessage) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  reconnecting: (attempt: number) => void;
  error: (err: Error) => void;
}
