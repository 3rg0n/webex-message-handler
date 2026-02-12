package webexmessagehandler

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"golang.org/x/crypto/hkdf"
)

const kmsResponseTimeout = 30 * time.Second

// KmsClient handles KMS ECDH key exchange and encryption key retrieval.
type KmsClient struct {
	token                string
	deviceURL            string
	userID               string
	encryptionServiceURL string
	logger               Logger
	httpDo               fetchDoFn

	kmsCluster        string
	ephemeralKey      *jose.JSONWebKey
	contextExpiration time.Time
	keyCache          map[string]*jose.JSONWebKey
	initialized       bool

	pendingRequests map[string]*pendingRequest
	mu              sync.Mutex
}

type pendingRequest struct {
	ch     chan string
	cancel context.CancelFunc
}

// KmsClientConfig holds the configuration for KmsClient.
type KmsClientConfig struct {
	Token                string
	DeviceURL            string
	UserID               string
	EncryptionServiceURL string
	Logger               Logger
	HTTPDo               fetchDoFn
}

// NewKmsClient creates a new KmsClient.
func NewKmsClient(cfg KmsClientConfig) *KmsClient {
	if cfg.Logger == nil {
		cfg.Logger = NoopLogger()
	}
	return &KmsClient{
		token:                cfg.Token,
		deviceURL:            cfg.DeviceURL,
		userID:               cfg.UserID,
		encryptionServiceURL: cfg.EncryptionServiceURL,
		logger:               cfg.Logger,
		httpDo:               cfg.HTTPDo,
		keyCache:             make(map[string]*jose.JSONWebKey),
		pendingRequests:      make(map[string]*pendingRequest),
	}
}

// HandleKmsMessage handles a KMS response that arrived via Mercury WebSocket.
func (kc *KmsClient) HandleKmsMessage(data map[string]interface{}) {
	var kmsMessages []interface{}

	if msgs, ok := data["kmsMessages"].([]interface{}); ok {
		kmsMessages = msgs
	} else if enc, ok := data["encryption"].(map[string]interface{}); ok {
		if msgs, ok := enc["kmsMessages"].([]interface{}); ok {
			kmsMessages = msgs
		}
	}

	if len(kmsMessages) == 0 {
		kc.logger.Debug("Received KMS message without kmsMessages array")
		return
	}

	kc.mu.Lock()
	defer kc.mu.Unlock()

	for _, rawMsg := range kmsMessages {
		wrapped, ok := rawMsg.(string)
		if !ok {
			continue
		}

		kc.logger.Debug(fmt.Sprintf("Received KMS response, pending requests: %d", len(kc.pendingRequests)))

		// Resolve the first pending request (FIFO — iterate map)
		for id, pending := range kc.pendingRequests {
			select {
			case pending.ch <- wrapped:
			default:
			}
			delete(kc.pendingRequests, id)
			break
		}
	}
}

// Initialize performs the ECDH handshake with KMS.
func (kc *KmsClient) Initialize(ctx context.Context) error {
	kc.logger.Info("Initializing KMS client")

	// Step 1: Fetch KMS details
	kmsDetailsURL := fmt.Sprintf("%s/kms/%s", kc.encryptionServiceURL, kc.userID)

	resp, err := kc.httpDo(ctx, FetchRequest{
		URL:    kmsDetailsURL,
		Method: http.MethodGet,
		Headers: map[string]string{
			"Authorization": "Bearer " + kc.token,
		},
	})
	if err != nil {
		return NewKmsErrorWithCause("Failed to fetch KMS details", err)
	}
	defer resp.Body.Close()

	if !resp.OK {
		return NewKmsError(fmt.Sprintf("Failed to fetch KMS details: %d", resp.Status))
	}

	var kmsDetails struct {
		KmsCluster   string          `json:"kmsCluster"`
		RsaPublicKey json.RawMessage `json:"rsaPublicKey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&kmsDetails); err != nil {
		return NewKmsErrorWithCause("Failed to parse KMS details", err)
	}
	kc.kmsCluster = kmsDetails.KmsCluster

	// Parse RSA public key (may be string or object)
	var rsaJWK jose.JSONWebKey
	rsaRaw := kmsDetails.RsaPublicKey
	// Try parsing as string first (JSON-encoded JWK)
	var rsaStr string
	if err := json.Unmarshal(rsaRaw, &rsaStr); err == nil {
		rsaRaw = json.RawMessage(rsaStr)
	}
	if err := rsaJWK.UnmarshalJSON(rsaRaw); err != nil {
		return NewKmsErrorWithCause("Failed to parse RSA public key", err)
	}

	// Step 2: Generate local ECDH keypair (P-256)
	localKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return NewKmsErrorWithCause("Failed to generate ECDH key", err)
	}

	localJWK := jose.JSONWebKey{Key: localKey, Algorithm: string(jose.ECDH_ES)}
	publicJWK := jose.JSONWebKey{Key: &localKey.PublicKey, Algorithm: string(jose.ECDH_ES)}

	// Step 3: Build ECDH request
	requestID := uuid.New().String()
	publicBytes, _ := publicJWK.MarshalJSON()
	var publicJWKMap map[string]interface{}
	json.Unmarshal(publicBytes, &publicJWKMap)

	ecdhRequestBody := map[string]interface{}{
		"client": map[string]interface{}{
			"clientId": kc.deviceURL,
			"credential": map[string]string{
				"userId": kc.userID,
				"bearer": kc.token,
			},
		},
		"method":    "create",
		"uri":       kc.kmsCluster + "/ecdhe",
		"requestId": requestID,
		"jwk":       publicJWKMap,
	}

	// Step 4: Wrap with RSA key (JWE RSA-OAEP + A256GCM)
	plaintext, _ := json.Marshal(ecdhRequestBody)
	encrypter, err := jose.NewEncrypter(jose.A256GCM, jose.Recipient{Algorithm: jose.RSA_OAEP, Key: &rsaJWK}, nil)
	if err != nil {
		return NewKmsErrorWithCause("Failed to create JWE encrypter", err)
	}
	jweObj, err := encrypter.Encrypt(plaintext)
	if err != nil {
		return NewKmsErrorWithCause("Failed to encrypt ECDH request", err)
	}
	wrapped, err := jweObj.CompactSerialize()
	if err != nil {
		return NewKmsErrorWithCause("Failed to serialize ECDH request", err)
	}

	// Step 5: POST and wait for Mercury response
	wrappedResponse, err := kc.sendKmsRequest(ctx, requestID, wrapped)
	if err != nil {
		return err
	}

	// Step 6: Unwrap ECDH response (may be JWE or JWS)
	responseBytes, err := unwrapKmsResponse(wrappedResponse, localJWK)
	if err != nil {
		return err
	}

	var responseData map[string]interface{}
	if err := json.Unmarshal(responseBytes, &responseData); err != nil {
		return NewKmsErrorWithCause("Failed to parse ECDH response body", err)
	}

	// Step 7: Extract remote key and derive shared secret
	remoteJWKData := extractJWKFromResponse(responseData)
	if remoteJWKData == nil {
		return NewKmsError("No key in ECDH response")
	}

	remoteJWKBytes, _ := json.Marshal(remoteJWKData)
	var remoteJWK jose.JSONWebKey
	if err := remoteJWK.UnmarshalJSON(remoteJWKBytes); err != nil {
		return NewKmsErrorWithCause("Failed to parse remote ECDH key", err)
	}

	// Extract remote key URI for kid
	remoteKeyURI := extractKeyURI(responseData)

	// Derive shared key
	sharedKey, err := deriveSharedKey(localKey, remoteJWK)
	if err != nil {
		return NewKmsErrorWithCause("Failed to derive shared key", err)
	}
	sharedKey.KeyID = remoteKeyURI

	kc.ephemeralKey = sharedKey
	kc.initialized = true

	// Set context expiration
	kc.contextExpiration = time.Now().Add(1 * time.Hour)
	if body, ok := responseData["body"].(map[string]interface{}); ok {
		if key, ok := body["key"].(map[string]interface{}); ok {
			if exp, ok := key["expirationDate"].(string); ok {
				if t, err := time.Parse(time.RFC3339, exp); err == nil {
					kc.contextExpiration = t
				}
			}
		}
	}

	kc.logger.Info("KMS client initialized successfully")
	return nil
}

// GetKey retrieves an encryption key from KMS.
func (kc *KmsClient) GetKey(ctx context.Context, keyURI string) (*jose.JSONWebKey, error) {
	// Check cache
	kc.mu.Lock()
	if cached, ok := kc.keyCache[keyURI]; ok {
		kc.mu.Unlock()
		kc.logger.Debug(fmt.Sprintf("Cache hit for key: %s", keyURI))
		return cached, nil
	}
	kc.mu.Unlock()

	// Check context expiration
	if kc.isContextExpired() {
		kc.logger.Info("Context expired, re-initializing")
		if err := kc.Initialize(ctx); err != nil {
			return nil, err
		}
	}

	if !kc.initialized || kc.ephemeralKey == nil {
		return nil, NewKmsError("KMS context not initialized")
	}

	// Build retrieve request
	requestID := uuid.New().String()
	retrieveBody := map[string]interface{}{
		"client": map[string]interface{}{
			"clientId": kc.deviceURL,
			"credential": map[string]string{
				"userId": kc.userID,
				"bearer": kc.token,
			},
		},
		"method":    "retrieve",
		"uri":       keyURI,
		"requestId": requestID,
	}

	// Wrap with ephemeral key (dir + A256GCM — key is CEK directly)
	plaintext, _ := json.Marshal(retrieveBody)
	encrypter, err := jose.NewEncrypter(jose.A256GCM, jose.Recipient{Algorithm: jose.DIRECT, Key: kc.ephemeralKey.Key}, (&jose.EncrypterOptions{}).WithHeader("kid", kc.ephemeralKey.KeyID))
	if err != nil {
		return nil, NewKmsErrorWithCause("Failed to create JWE encrypter for key retrieval", err)
	}
	jweObj, err := encrypter.Encrypt(plaintext)
	if err != nil {
		return nil, NewKmsErrorWithCause("Failed to encrypt key retrieval request", err)
	}
	wrapped, err := jweObj.CompactSerialize()
	if err != nil {
		return nil, NewKmsErrorWithCause("Failed to serialize key retrieval request", err)
	}

	// POST and wait for Mercury response
	wrappedResponse, err := kc.sendKmsRequest(ctx, requestID, wrapped)
	if err != nil {
		return nil, err
	}

	// Unwrap response (may be JWE or JWS)
	responseBytes, err := unwrapKmsResponse(wrappedResponse, *kc.ephemeralKey)
	if err != nil {
		return nil, err
	}

	var responseData map[string]interface{}
	if err := json.Unmarshal(responseBytes, &responseData); err != nil {
		return nil, NewKmsErrorWithCause("Failed to parse key response body", err)
	}

	// Extract content key
	keyJWKData := extractJWKFromResponse(responseData)
	if keyJWKData == nil {
		return nil, NewKmsError("No key found in KMS response")
	}

	keyJWKBytes, _ := json.Marshal(keyJWKData)
	var contentKey jose.JSONWebKey
	if err := contentKey.UnmarshalJSON(keyJWKBytes); err != nil {
		return nil, NewKmsErrorWithCause("Failed to parse content key", err)
	}

	kc.mu.Lock()
	kc.keyCache[keyURI] = &contentKey
	kc.mu.Unlock()

	kc.logger.Info(fmt.Sprintf("Key retrieved and cached: %s", keyURI))
	return &contentKey, nil
}

func (kc *KmsClient) sendKmsRequest(ctx context.Context, requestID, wrapped string) (string, error) {
	ch := make(chan string, 1)
	reqCtx, cancel := context.WithTimeout(ctx, kmsResponseTimeout)

	kc.mu.Lock()
	kc.pendingRequests[requestID] = &pendingRequest{ch: ch, cancel: cancel}
	kc.mu.Unlock()

	// POST the request
	body, _ := json.Marshal(map[string]interface{}{
		"destination": kc.kmsCluster,
		"kmsMessages": []string{wrapped},
	})

	httpResp, err := kc.httpDo(reqCtx, FetchRequest{
		URL:    kc.encryptionServiceURL + "/kms/messages",
		Method: http.MethodPost,
		Headers: map[string]string{
			"Authorization": "Bearer " + kc.token,
			"Content-Type":  "application/json",
		},
		Body: string(body),
	})
	if err != nil {
		cancel()
		kc.mu.Lock()
		delete(kc.pendingRequests, requestID)
		kc.mu.Unlock()
		return "", NewKmsErrorWithCause("KMS HTTP request failed", err)
	}
	io.Copy(io.Discard, httpResp.Body)
	httpResp.Body.Close()

	if !httpResp.OK {
		cancel()
		kc.mu.Lock()
		delete(kc.pendingRequests, requestID)
		kc.mu.Unlock()
		return "", NewKmsError(fmt.Sprintf("KMS HTTP request failed: %d", httpResp.Status))
	}

	kc.logger.Debug(fmt.Sprintf("KMS request %s sent (HTTP %d), waiting for Mercury response...", requestID, httpResp.Status))

	// Wait for Mercury response
	select {
	case response := <-ch:
		cancel()
		return response, nil
	case <-reqCtx.Done():
		kc.mu.Lock()
		delete(kc.pendingRequests, requestID)
		kc.mu.Unlock()
		return "", NewKmsError(fmt.Sprintf("KMS request %s timed out", requestID))
	}
}

func (kc *KmsClient) isContextExpired() bool {
	if !kc.initialized || kc.contextExpiration.IsZero() {
		return true
	}
	return time.Now().After(kc.contextExpiration.Add(-30 * time.Second))
}

func extractJWKFromResponse(data map[string]interface{}) map[string]interface{} {
	// Try body.key.jwk
	if body, ok := data["body"].(map[string]interface{}); ok {
		if key, ok := body["key"].(map[string]interface{}); ok {
			if jwk, ok := key["jwk"].(map[string]interface{}); ok {
				return jwk
			}
			return key
		}
	}
	// Try key.jwk
	if key, ok := data["key"].(map[string]interface{}); ok {
		if jwk, ok := key["jwk"].(map[string]interface{}); ok {
			return jwk
		}
		return key
	}
	return nil
}

func extractKeyURI(data map[string]interface{}) string {
	if body, ok := data["body"].(map[string]interface{}); ok {
		if key, ok := body["key"].(map[string]interface{}); ok {
			if uri, ok := key["uri"].(string); ok {
				return uri
			}
		}
	}
	if key, ok := data["key"].(map[string]interface{}); ok {
		if uri, ok := key["uri"].(string); ok {
			return uri
		}
	}
	return ""
}

// unwrapKmsResponse handles both JWE (encrypted) and JWS (signed) KMS responses.
// KMS returns JWE (5 parts) for some responses and JWS (3 parts) for others (e.g., ECDH handshake).
func unwrapKmsResponse(wrapped string, key jose.JSONWebKey) ([]byte, error) {
	parts := strings.Split(wrapped, ".")
	switch len(parts) {
	case 5:
		// JWE compact: header.encrypted_key.iv.ciphertext.tag
		jweObj, err := jose.ParseEncrypted(wrapped,
			[]jose.KeyAlgorithm{jose.ECDH_ES, jose.ECDH_ES_A256KW, jose.A256KW, jose.DIRECT},
			[]jose.ContentEncryption{jose.A256GCM, jose.A128GCM})
		if err != nil {
			return nil, NewKmsErrorWithCause("Failed to parse KMS response JWE", err)
		}
		plaintext, err := jweObj.Decrypt(key.Key)
		if err != nil {
			return nil, NewKmsErrorWithCause("Failed to decrypt KMS response", err)
		}
		return plaintext, nil
	case 3:
		// JWS compact: header.payload.signature — extract payload
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil, NewKmsErrorWithCause("Failed to decode JWS payload", err)
		}
		return payload, nil
	default:
		return nil, NewKmsError(fmt.Sprintf("Invalid KMS response format: expected 3 or 5 parts, got %d", len(parts)))
	}
}

func deriveSharedKey(localKey *ecdsa.PrivateKey, remoteJWK jose.JSONWebKey) (*jose.JSONWebKey, error) {
	remotePub, ok := remoteJWK.Key.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("remote key is not an ECDSA public key")
	}

	// Convert to crypto/ecdh keys for ECDH exchange
	localECDH, err := localKey.ECDH()
	if err != nil {
		return nil, fmt.Errorf("failed to convert local key to ECDH: %w", err)
	}

	remoteECDH, err := remotePub.ECDH()
	if err != nil {
		return nil, fmt.Errorf("failed to convert remote key to ECDH: %w", err)
	}

	// Perform ECDH
	sharedSecret, err := localECDH.ECDH(remoteECDH)
	if err != nil {
		return nil, fmt.Errorf("ECDH exchange failed: %w", err)
	}

	// HKDF to derive 256-bit key
	hkdfReader := hkdf.New(sha256.New, sharedSecret, nil, nil)
	derived := make([]byte, 32)
	if _, err := io.ReadFull(hkdfReader, derived); err != nil {
		return nil, fmt.Errorf("HKDF derivation failed: %w", err)
	}

	return &jose.JSONWebKey{
		Key:       derived,
		Algorithm: string(jose.A256KW),
	}, nil
}
