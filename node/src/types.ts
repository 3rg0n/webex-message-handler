import type { Logger } from './logger.js';

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
  /**
   * Optional undici Dispatcher for native mode proxy support (HTTP + WebSocket).
   * A single `ProxyAgent` proxies both `fetch()` and the native `WebSocket`.
   * Example: `new ProxyAgent('http://proxy:8080')`
   */
  dispatcher?: object;
  /** Custom fetch function for all HTTP requests (injected mode) */
  fetch?: FetchFunction;
  /** Custom WebSocket factory (injected mode) */
  webSocketFactory?: WebSocketFactory;
  /** Automatically filter out messages sent by this bot to prevent loops (default: true) */
  ignoreSelfMessages?: boolean;
  /** Ping interval in ms (default: 15000) */
  pingInterval?: number;
  /** Pong timeout in ms (default: 14000) */
  pongTimeout?: number;
  /** Max reconnect backoff in ms (default: 32000) */
  reconnectBackoffMax?: number;
  /** Max reconnect attempts before giving up (default: 10) */
  maxReconnectAttempts?: number;
  /**
   * How long a connection must hold in ms before the reconnect-attempt counter
   * resets (default: 60000). Without this window a flap storm — connections
   * that succeed and then drop seconds later — zeroes the counter every cycle,
   * so `maxReconnectAttempts` never trips and the handler retries forever.
   */
  reconnectStabilityWindow?: number;
  /** Optional metrics callback for timing events (no overhead if not set) */
  metricsCallback?: MetricsCallback;
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
  /** Card form input values (present on cardAction/submit activities). May be encrypted on wire. */
  inputs?: string | Record<string, unknown>;
  /** File URLs attached to the message (present on file-share messages). */
  files?: string[];
}

export interface MercuryTarget {
  id: string;
  objectType: string;
  encryptionKeyUrl?: string;
  tags?: string[];
}

export interface MercuryParent {
  id: string;
  type: string;
}

export interface MercuryActivity {
  id: string;
  /** Full Conversation-service activity URL, when present on the raw activity. */
  url?: string;
  verb: string;
  actor: MercuryActor;
  object: MercuryObject;
  target: MercuryTarget;
  published: string;
  encryptionKeyUrl?: string;
  parent?: MercuryParent;
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
  /** Mercury activity UUID. Works as parentId for threaded replies. */
  id: string;
  /**
   * Full Conversation-service activity URL, when present on the raw Mercury
   * activity (e.g. for an outbound "acknowledge" read-receipt). Undefined if
   * Mercury did not include it.
   */
  url?: string;
  /** Parent activity UUID for threaded replies. Undefined if not a thread reply. */
  parentId?: string;
  roomId: string;
  personId: string;
  personEmail: string;
  text: string;
  html?: string;
  created: string;
  roomType?: string;
  /** Person UUIDs mentioned via @mention in the message. */
  mentionedPeople: string[];
  /** Group mention types (e.g. "all") in the message. */
  mentionedGroups: string[];
  /** File URLs attached to the message. Empty if no files. */
  files: string[];
  raw: MercuryActivity;
}

export interface DeletedMessage {
  messageId: string;
  roomId: string;
  personId: string;
}

export interface MembershipActivity {
  /** Activity ID. */
  id: string;
  /** ID of the person who performed the action. */
  actorId: string;
  /** ID of the member affected. */
  personId: string;
  /** Conversation/space ID. */
  roomId: string;
  /** Membership action: "add", "leave", "assignModerator", or "unassignModerator". */
  action: string;
  /** ISO 8601 timestamp. */
  created: string;
  /** "direct", "group", or undefined. */
  roomType?: string;
  /** Full raw activity for advanced use. */
  raw: MercuryActivity;
}

export interface AttachmentAction {
  /** Activity ID. */
  id: string;
  /** ID of the message the card was attached to. */
  messageId: string;
  /** ID of the person who submitted the card. */
  personId: string;
  /** Email of the person who submitted the card. */
  personEmail: string;
  /** Conversation/space ID. */
  roomId: string;
  /** Card form input values. */
  inputs: Record<string, unknown>;
  /** ISO 8601 timestamp. */
  created: string;
  /** Full raw activity for advanced use. */
  raw: MercuryActivity;
}

export interface RoomActivity {
  /** Activity ID. */
  id: string;
  /** Conversation/space ID. */
  roomId: string;
  /** ID of the person who performed the action. */
  actorId: string;
  /** Room action: "created" or "updated". */
  action: string;
  /** ISO 8601 timestamp. */
  created: string;
  /** Full raw activity for advanced use. */
  raw: MercuryActivity;
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

// --- Metrics ---

export interface MetricsEvent {
  /** Metric name: "connect", "kms_fetch", or "decrypt". */
  name: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Whether the operation succeeded. */
  success: boolean;
  /** Optional context metadata (e.g., key URI for kms_fetch). */
  metadata?: Record<string, string>;
}

export type MetricsCallback = (event: MetricsEvent) => void;

// --- Events ---

export interface WebexMessageHandlerEvents {
  'message:created': (msg: DecryptedMessage) => void;
  'message:updated': (msg: DecryptedMessage) => void;
  'message:deleted': (data: DeletedMessage) => void;
  'membership:created': (activity: MembershipActivity) => void;
  'attachmentAction:created': (action: AttachmentAction) => void;
  'room:created': (activity: RoomActivity) => void;
  'room:updated': (activity: RoomActivity) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  reconnecting: (attempt: number) => void;
  error: (err: Error) => void;
}
