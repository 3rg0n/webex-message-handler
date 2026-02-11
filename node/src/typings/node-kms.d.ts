declare module 'node-kms' {
  import type { JWK } from 'node-jose';

  interface ClientInfo {
    clientId: string;
    credential: {
      userId: string;
      bearer: string;
    };
  }

  interface ServerInfo {
    key: JWK.Key | Record<string, unknown>;
  }

  class KeyObject {
    constructor(input?: unknown);
    uri: string;
    jwk: Record<string, unknown>;
    userId: string;
    clientId: string;
    createDate?: Date;
    expirationDate?: Date;
    bindDate?: Date;
    resourceUri: string;
    asKey(): Promise<JWK.Key>;
    toJSON(): Record<string, unknown>;
    static fromObject(rep: unknown): KeyObject;
  }

  class Context {
    clientInfo: ClientInfo;
    serverInfo: ServerInfo;
    ephemeralKey: KeyObject | null;
    requestId(): string;
    createECDHKey(): Promise<KeyObject>;
    deriveEphemeralKey(remoteKey: Record<string, unknown>): Promise<KeyObject>;
  }

  interface RequestBody {
    method?: string;
    uri?: string;
    client?: ClientInfo;
    requestId?: string;
    ephemeralKey?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface RequestInput {
    method: string;
    uri: string;
  }

  interface WrapOptions {
    serverKey?: boolean;
    requestId?: string;
    contentAlg?: string;
  }

  class Request {
    constructor(input?: RequestInput);
    body: RequestBody;
    requestId: string;
    uri: string;
    method: string;
    wrapped: string;
    wrap(ctx: Context, opts?: WrapOptions): Promise<string>;
  }

  interface ResponseBody {
    status: number;
    reason?: string;
    key?: KeyObject;
    keys?: KeyObject[];
    [key: string]: unknown;
  }

  class Response {
    constructor(input?: unknown);
    body: ResponseBody;
    requestId: string;
    status: number;
    reason?: string;
    wrapped: string;
    unwrap(ctx: Context): Promise<Response>;
  }
}
