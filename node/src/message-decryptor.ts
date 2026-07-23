import * as jose from 'node-jose';
import { KmsClient } from './kms-client.js';
import { Logger, noopLogger } from './logger.js';
import { MercuryActivity } from './types.js';
import { DecryptionError } from './errors.js';

export class MessageDecryptor {
  private kmsClient: KmsClient;
  private logger: Logger;

  constructor({ kmsClient, logger }: { kmsClient: KmsClient; logger?: Logger }) {
    this.kmsClient = kmsClient;
    this.logger = logger || noopLogger;
  }

  async decryptActivity(activity: MercuryActivity): Promise<MercuryActivity> {
    try {
      // Get encryptionKeyUrl from one of three possible locations
      const encryptionKeyUrl =
        activity.encryptionKeyUrl ||
        activity.object.encryptionKeyUrl ||
        activity.target.encryptionKeyUrl;

      // If no key URL, activity is not encrypted
      if (!encryptionKeyUrl) {
        return activity;
      }

      // Fetch the key from KMS
      let key: jose.JWK.Key;
      try {
        key = await this.kmsClient.getKey(encryptionKeyUrl);
      } catch (error) {
        throw new DecryptionError(
          `Failed to fetch encryption key from ${encryptionKeyUrl}: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Create a shallow copy of the activity with decrypted object
      const decryptedActivity: MercuryActivity = {
        ...activity,
        object: { ...activity.object },
      };

      // Decrypt displayName if it exists and is a non-empty string
      if (decryptedActivity.object.displayName && typeof decryptedActivity.object.displayName === 'string' && decryptedActivity.object.displayName.length > 0) {
        try {
          const result = await jose.JWE.createDecrypt(key).decrypt(decryptedActivity.object.displayName);
          decryptedActivity.object.displayName = result.payload.toString('utf8');
        } catch (error) {
          this.logger.warn(
            `Failed to decrypt displayName in activity ${activity.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Decrypt content if it exists and is a non-empty string
      if (decryptedActivity.object.content && typeof decryptedActivity.object.content === 'string' && decryptedActivity.object.content.length > 0) {
        try {
          const result = await jose.JWE.createDecrypt(key).decrypt(decryptedActivity.object.content);
          decryptedActivity.object.content = result.payload.toString('utf8');
        } catch (error) {
          this.logger.warn(
            `Failed to decrypt content in activity ${activity.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Decrypt inputs if it exists and is a non-empty string (JWE-encrypted card action inputs)
      if (decryptedActivity.object.inputs && typeof decryptedActivity.object.inputs === 'string' && decryptedActivity.object.inputs.length > 0) {
        try {
          const result = await jose.JWE.createDecrypt(key).decrypt(decryptedActivity.object.inputs);
          const plaintextInputs = result.payload.toString('utf8');
          decryptedActivity.object.inputs = JSON.parse(plaintextInputs);
        } catch (error) {
          this.logger.warn(
            `Failed to decrypt inputs in activity ${activity.id}: ${error instanceof Error ? error.message : String(error)}`
          );
          // On decrypt failure, leave inputs as encrypted string (will be handled as empty in handler)
        }
      }

      return decryptedActivity;
    } catch (error) {
      // Re-throw DecryptionError as-is, wrap other errors
      if (error instanceof DecryptionError) {
        throw error;
      }
      throw new DecryptionError(
        `Error decrypting activity ${activity.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
