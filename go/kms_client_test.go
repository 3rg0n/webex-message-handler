package webexmessagehandler

import (
	"testing"

	"github.com/go-jose/go-jose/v4"
)

func TestNewKmsClient(t *testing.T) {
	kc := NewKmsClient(KmsClientConfig{
		Token:                "test-token",
		DeviceURL:            "https://device.example.com/123",
		UserID:               "user-123",
		EncryptionServiceURL: "https://encryption.example.com",
	})
	if kc == nil {
		t.Fatal("expected non-nil KmsClient")
	}
	if kc.token != "test-token" {
		t.Errorf("expected test-token, got %q", kc.token)
	}
	if kc.initialized {
		t.Error("expected not initialized")
	}
}

func TestKmsClientHandleKmsMessageEmpty(t *testing.T) {
	kc := NewKmsClient(KmsClientConfig{Logger: NoopLogger()})

	// No kmsMessages → no panic, no-op
	kc.HandleKmsMessage(map[string]interface{}{})
}

func TestKmsClientHandleKmsMessageFromEncryptionField(t *testing.T) {
	kc := NewKmsClient(KmsClientConfig{Logger: NoopLogger()})

	ch := make(chan string, 1)
	kc.mu.Lock()
	kc.pendingRequests["req-1"] = &pendingRequest{ch: ch}
	kc.mu.Unlock()

	data := map[string]interface{}{
		"encryption": map[string]interface{}{
			"kmsMessages": []interface{}{"response-payload"},
		},
	}
	kc.HandleKmsMessage(data)

	select {
	case msg := <-ch:
		if msg != "response-payload" {
			t.Errorf("expected response-payload, got %q", msg)
		}
	default:
		t.Error("expected pending request to be resolved")
	}
}

func TestKmsClientHandleKmsMessageDirectField(t *testing.T) {
	kc := NewKmsClient(KmsClientConfig{Logger: NoopLogger()})

	ch := make(chan string, 1)
	kc.mu.Lock()
	kc.pendingRequests["req-1"] = &pendingRequest{ch: ch}
	kc.mu.Unlock()

	data := map[string]interface{}{
		"kmsMessages": []interface{}{"direct-response"},
	}
	kc.HandleKmsMessage(data)

	select {
	case msg := <-ch:
		if msg != "direct-response" {
			t.Errorf("expected direct-response, got %q", msg)
		}
	default:
		t.Error("expected pending request to be resolved")
	}
}

func TestKmsClientHandleKmsMessageNoPending(t *testing.T) {
	kc := NewKmsClient(KmsClientConfig{Logger: NoopLogger()})

	// No pending requests — should not panic
	data := map[string]interface{}{
		"kmsMessages": []interface{}{"orphan-response"},
	}
	kc.HandleKmsMessage(data)
}

func TestExtractJWKFromResponseBodyKeyJwk(t *testing.T) {
	data := map[string]interface{}{
		"body": map[string]interface{}{
			"key": map[string]interface{}{
				"jwk": map[string]interface{}{
					"kty": "oct",
					"k":   "base64key",
				},
			},
		},
	}
	jwk := extractJWKFromResponse(data)
	if jwk == nil {
		t.Fatal("expected non-nil JWK")
	}
	if jwk["kty"] != "oct" {
		t.Errorf("expected oct, got %v", jwk["kty"])
	}
}

func TestExtractJWKFromResponseBodyKey(t *testing.T) {
	data := map[string]interface{}{
		"body": map[string]interface{}{
			"key": map[string]interface{}{
				"kty": "EC",
				"crv": "P-256",
			},
		},
	}
	jwk := extractJWKFromResponse(data)
	if jwk == nil {
		t.Fatal("expected non-nil JWK")
	}
	if jwk["kty"] != "EC" {
		t.Errorf("expected EC, got %v", jwk["kty"])
	}
}

func TestExtractJWKFromResponseKeyJwk(t *testing.T) {
	data := map[string]interface{}{
		"key": map[string]interface{}{
			"jwk": map[string]interface{}{
				"kty": "oct",
			},
		},
	}
	jwk := extractJWKFromResponse(data)
	if jwk == nil {
		t.Fatal("expected non-nil JWK")
	}
}

func TestExtractJWKFromResponseNone(t *testing.T) {
	data := map[string]interface{}{
		"status": 200,
	}
	jwk := extractJWKFromResponse(data)
	if jwk != nil {
		t.Errorf("expected nil, got %v", jwk)
	}
}

func TestExtractKeyURI(t *testing.T) {
	data := map[string]interface{}{
		"body": map[string]interface{}{
			"key": map[string]interface{}{
				"uri": "kms://example.com/keys/abc",
			},
		},
	}
	uri := extractKeyURI(data)
	if uri != "kms://example.com/keys/abc" {
		t.Errorf("expected kms://example.com/keys/abc, got %q", uri)
	}
}

func TestExtractKeyURIFallback(t *testing.T) {
	data := map[string]interface{}{
		"key": map[string]interface{}{
			"uri": "kms://example.com/keys/def",
		},
	}
	uri := extractKeyURI(data)
	if uri != "kms://example.com/keys/def" {
		t.Errorf("expected kms://example.com/keys/def, got %q", uri)
	}
}

func TestExtractKeyURIMissing(t *testing.T) {
	data := map[string]interface{}{}
	uri := extractKeyURI(data)
	if uri != "" {
		t.Errorf("expected empty, got %q", uri)
	}
}

func TestUnwrapKmsResponseJWS(t *testing.T) {
	// JWS has 3 parts: header.payload.signature
	// Construct a minimal JWS with base64url-encoded payload
	// "hello" in base64url = "aGVsbG8"
	token := "eyJhbGciOiJub25lIn0.aGVsbG8.signature"

	var dummyKey jose.JSONWebKey
	result, err := unwrapKmsResponse(token, dummyKey)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(result) != "hello" {
		t.Errorf("expected 'hello', got %q", string(result))
	}
}

func TestUnwrapKmsResponseInvalidParts(t *testing.T) {
	// 2 parts — invalid
	token := "part1.part2"
	var dummyKey jose.JSONWebKey
	_, err := unwrapKmsResponse(token, dummyKey)
	if err == nil {
		t.Fatal("expected error for invalid token format")
	}
}

func TestIsContextExpiredWhenNotInitialized(t *testing.T) {
	kc := NewKmsClient(KmsClientConfig{})
	if !kc.isContextExpired() {
		t.Error("expected expired when not initialized")
	}
}

func TestKmsClientKeyCache(t *testing.T) {
	kc := NewKmsClient(KmsClientConfig{Logger: NoopLogger()})
	if len(kc.keyCache) != 0 {
		t.Errorf("expected empty key cache, got %d entries", len(kc.keyCache))
	}
}
