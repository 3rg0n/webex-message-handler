package webexmessagehandler

import (
	"context"
	"testing"
)

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
