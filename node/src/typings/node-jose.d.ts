declare module 'node-jose' {
  export namespace JWK {
    interface Key {
      kty: string;
      kid: string;
      length: number;
      toJSON(isPrivate?: boolean): Record<string, unknown>;
    }

    function asKey(
      input: Record<string, unknown> | string | Buffer,
      form?: string
    ): Promise<Key>;
  }

  export namespace JWE {
    interface DecryptResult {
      payload: Buffer;
      protected: Record<string, unknown>;
      header: Record<string, unknown>;
    }

    interface Decryptor {
      decrypt(input: string): Promise<DecryptResult>;
    }

    function createDecrypt(key: JWK.Key): Decryptor;
  }
}
