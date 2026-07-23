package webexmessagehandler

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"testing"

	"github.com/go-jose/go-jose/v4"
)

// seedKey installs a raw symmetric content key into the KMS client's cache so
// decryption tests can run without a live KMS handshake.
func seedKey(kc *KmsClient, keyURI string, raw []byte) {
	jwk := &jose.JSONWebKey{Key: raw, KeyID: keyURI, Algorithm: string(jose.DIRECT)}
	kc.mu.Lock()
	kc.keyCache[keyURI] = jwk
	kc.mu.Unlock()
}

// encryptJWEDir encrypts plaintext under a raw 256-bit key using dir/A256GCM —
// the same scheme Webex uses for card-action inputs.
func encryptJWEDir(t *testing.T, raw, plaintext []byte) string {
	t.Helper()
	enc, err := jose.NewEncrypter(
		jose.A256GCM,
		jose.Recipient{Algorithm: jose.DIRECT, Key: raw},
		nil,
	)
	if err != nil {
		t.Fatalf("new encrypter: %v", err)
	}
	obj, err := enc.Encrypt(plaintext)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	compact, err := obj.CompactSerialize()
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	return compact
}

func TestDecryptActivityDecryptsCardActionInputs(t *testing.T) {
	const keyURI = "kms://example.com/keys/card"
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("rand: %v", err)
	}

	inputsJSON, _ := json.Marshal(map[string]interface{}{
		"card_action":       "answer_feedback",
		"response_event_id": "evt-123",
		"verdict":           "up",
	})
	encryptedInputs := encryptJWEDir(t, raw, inputsJSON)

	kc := uninitializedKmsClient()
	seedKey(kc, keyURI, raw)
	md := NewMessageDecryptor(kc, NoopLogger())

	activity := MercuryActivity{
		ID:               "card-act-1",
		Verb:             "cardAction",
		EncryptionKeyURL: keyURI,
		Object: MercuryObject{
			ObjectType:      "submit",
			InputsEncrypted: encryptedInputs,
		},
	}

	result, err := md.DecryptActivity(context.Background(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Object.Inputs == nil {
		t.Fatal("expected Inputs to be populated, got nil")
	}
	if got := result.Object.Inputs["card_action"]; got != "answer_feedback" {
		t.Errorf("card_action: expected %q, got %v", "answer_feedback", got)
	}
	if got := result.Object.Inputs["verdict"]; got != "up" {
		t.Errorf("verdict: expected %q, got %v", "up", got)
	}
	if got := result.Object.Inputs["response_event_id"]; got != "evt-123" {
		t.Errorf("response_event_id: expected %q, got %v", "evt-123", got)
	}
}

// uninitializedKmsClient returns a KmsClient that isn't initialized,
// so GetKey will return a KmsError rather than nil-pointer panic.
func uninitializedKmsClient() *KmsClient {
	return NewKmsClient(KmsClientConfig{
		Logger: NoopLogger(),
		HTTPDo: createTestHTTPAdapter(nil),
	})
}

func TestDecryptActivityPassthroughNoEncryptionKeyURL(t *testing.T) {
	md := NewMessageDecryptor(nil, NoopLogger())

	activity := MercuryActivity{
		ID:   "act-1",
		Verb: "post",
		Object: MercuryObject{
			DisplayName: "plain text",
			Content:     "<p>plain text</p>",
		},
	}

	result, err := md.DecryptActivity(context.Background(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Object.DisplayName != "plain text" {
		t.Errorf("expected 'plain text', got %q", result.Object.DisplayName)
	}
	if result.Object.Content != "<p>plain text</p>" {
		t.Errorf("expected '<p>plain text</p>', got %q", result.Object.Content)
	}
}

func TestDecryptActivityUsesRootEncryptionKeyURL(t *testing.T) {
	activity := MercuryActivity{
		EncryptionKeyURL: "kms://example.com/keys/1",
		Object: MercuryObject{
			DisplayName: "encrypted-display",
		},
	}

	md := NewMessageDecryptor(uninitializedKmsClient(), NoopLogger())
	_, err := md.DecryptActivity(context.Background(), activity)
	// Should fail because kmsClient is not initialized
	if err == nil {
		t.Fatal("expected error when kmsClient is uninitialized and encryption key URL is present")
	}
}

func TestDecryptActivityUsesObjectEncryptionKeyURL(t *testing.T) {
	activity := MercuryActivity{
		Object: MercuryObject{
			EncryptionKeyURL: "kms://example.com/keys/2",
			DisplayName:      "encrypted-display",
		},
	}

	md := NewMessageDecryptor(uninitializedKmsClient(), NoopLogger())
	_, err := md.DecryptActivity(context.Background(), activity)
	if err == nil {
		t.Fatal("expected error when kmsClient is uninitialized and encryption key URL is present")
	}
}

func TestDecryptActivityUsesTargetEncryptionKeyURL(t *testing.T) {
	activity := MercuryActivity{
		Target: MercuryTarget{
			EncryptionKeyURL: "kms://example.com/keys/3",
		},
		Object: MercuryObject{
			DisplayName: "encrypted-display",
		},
	}

	md := NewMessageDecryptor(uninitializedKmsClient(), NoopLogger())
	_, err := md.DecryptActivity(context.Background(), activity)
	if err == nil {
		t.Fatal("expected error when kmsClient is uninitialized and encryption key URL is present")
	}
}

func TestDecryptActivityDoesNotMutateOriginal(t *testing.T) {
	md := NewMessageDecryptor(nil, NoopLogger())

	activity := MercuryActivity{
		Object: MercuryObject{
			DisplayName: "original",
		},
	}

	result, _ := md.DecryptActivity(context.Background(), activity)
	// Go structs are passed by value, so result is a copy
	result.Object.DisplayName = "modified"

	if activity.Object.DisplayName != "original" {
		t.Errorf("expected original to be unchanged, got %q", activity.Object.DisplayName)
	}
}
