package webexmessagehandler

import (
	"context"
	"fmt"

	"github.com/go-jose/go-jose/v4"
)

// MessageDecryptor decrypts encrypted Webex message activities using KMS keys.
type MessageDecryptor struct {
	kmsClient *KmsClient
	logger    Logger
}

// NewMessageDecryptor creates a new MessageDecryptor.
func NewMessageDecryptor(kmsClient *KmsClient, logger Logger) *MessageDecryptor {
	if logger == nil {
		logger = NoopLogger()
	}
	return &MessageDecryptor{kmsClient: kmsClient, logger: logger}
}

// DecryptActivity decrypts an encrypted Mercury activity.
// Returns a copy with decrypted DisplayName and Content fields.
// If the activity is not encrypted (no EncryptionKeyURL), returns as-is.
func (md *MessageDecryptor) DecryptActivity(ctx context.Context, activity MercuryActivity) (MercuryActivity, error) {
	// Locate encryption key URL
	encryptionKeyURL := activity.EncryptionKeyURL
	if encryptionKeyURL == "" {
		encryptionKeyURL = activity.Object.EncryptionKeyURL
	}
	if encryptionKeyURL == "" {
		encryptionKeyURL = activity.Target.EncryptionKeyURL
	}

	// Not encrypted
	if encryptionKeyURL == "" {
		return activity, nil
	}

	// Fetch the key from KMS
	key, err := md.kmsClient.GetKey(ctx, encryptionKeyURL)
	if err != nil {
		return activity, NewDecryptionErrorWithCause(
			fmt.Sprintf("Failed to fetch encryption key from %s", encryptionKeyURL), err,
		)
	}

	// Copy activity (value type, so already a copy)
	decrypted := activity

	// Decrypt displayName
	if decrypted.Object.DisplayName != "" {
		plaintext, err := decryptJWE(decrypted.Object.DisplayName, key)
		if err != nil {
			md.logger.Warn(fmt.Sprintf("Failed to decrypt displayName in activity %s: %v", activity.ID, err))
		} else {
			decrypted.Object.DisplayName = string(plaintext)
		}
	}

	// Decrypt content
	if decrypted.Object.Content != "" {
		plaintext, err := decryptJWE(decrypted.Object.Content, key)
		if err != nil {
			md.logger.Warn(fmt.Sprintf("Failed to decrypt content in activity %s: %v", activity.ID, err))
		} else {
			decrypted.Object.Content = string(plaintext)
		}
	}

	return decrypted, nil
}

func decryptJWE(token string, key *jose.JSONWebKey) ([]byte, error) {
	// Webex messages may use "dir" (direct CEK) or "A256KW" (key wrapping)
	jweObj, err := jose.ParseEncrypted(token, []jose.KeyAlgorithm{jose.DIRECT, jose.A256KW}, []jose.ContentEncryption{jose.A256GCM})
	if err != nil {
		return nil, fmt.Errorf("failed to parse JWE: %w", err)
	}
	plaintext, err := jweObj.Decrypt(key.Key)
	if err != nil {
		return nil, fmt.Errorf("failed to decrypt JWE: %w", err)
	}
	return plaintext, nil
}
