import type { Logger } from './logger.js';
import type * as http from 'http';
import type * as https from 'https';

// --- Configuration ---

export type NetworkMode = 'native' | 'injected';

export interface FetchRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
}

export interface FetchResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFunction = (request: FetchRequest) => Promise<FetchResponse>;

export interface InjectedWebSocket {
  send(data: string): void;
  close(code?: number): void;
  readonly readyState: number;
  on(event: 'message', listener: (data: string) => void): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'close', listener: (code: number, reason: string) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export type WebSocketFactory = (url: string) => InjectedWebSocket;

export interface WebexMessageHandlerConfig {
  token: string;
  logger?: Logger;
  /** Networking mode: 'native' uses built-in fetch/WebSocket, 'injected' uses provided functions */
  mode?: NetworkMode;
  /** Optional HTTP/HTTPS agent for proxy support (native mode only) */
  agent?: http.Agent | https.Agent;
  /** Custom fetch function for all HTTP requests (injected mode) */
  fetch?: FetchFunction;
  /** Custom WebSocket factory (injected mode) */
  webSocketFactory?: WebSocketFactory;
  /** Automatically filter out messages sent by this bot to prevent loops (default: false) */
  ignoreSelfMessages?: boolean;
  /** Ping interval in ms (default: 15000) */
  pingInterval?: number;
  /** Pong timeout in ms (default: 14000) */
  pongTimeout?: number;
  /** Max reconnect backoff in ms (default: 32000) */
  reconnectBackoffMax?: number;
  /** Max reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
}

// --- Person Info ---

export interface PersonInfo {
  /** Person's unique ID */
  id: string;
  /** Person's email address */
  emails: string[];
  /** Person's display name */
  displayName: string;
  /** Person type (person or bot) */
  type: 'person' | 'bot';
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
