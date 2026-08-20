package webexmessagehandler

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestParseObjectInputsEncryptedString(t *testing.T) {
	// Card-action inputs arrive as a JWE-encrypted string; parseObject must
	// capture it in InputsEncrypted (for later decryption), not drop it.
	raw := map[string]interface{}{
		"objectType": "submit",
		"inputs":     "eyJlbmMiOiJBMjU2R0NNIn0..abc.def.ghi",
	}
	obj := parseObject(raw)
	if obj.InputsEncrypted != "eyJlbmMiOiJBMjU2R0NNIn0..abc.def.ghi" {
		t.Errorf("expected InputsEncrypted to hold the JWE string, got %q", obj.InputsEncrypted)
	}
	if obj.Inputs != nil {
		t.Errorf("expected Inputs to be nil for an encrypted string, got %v", obj.Inputs)
	}
}

func TestParseObjectInputsPlaintextMap(t *testing.T) {
	// Defensive: a plaintext map still populates Inputs directly.
	raw := map[string]interface{}{
		"objectType": "submit",
		"inputs":     map[string]interface{}{"verdict": "up"},
	}
	obj := parseObject(raw)
	if obj.InputsEncrypted != "" {
		t.Errorf("expected InputsEncrypted empty for a map, got %q", obj.InputsEncrypted)
	}
	if obj.Inputs == nil || obj.Inputs["verdict"] != "up" {
		t.Errorf("expected Inputs map with verdict=up, got %v", obj.Inputs)
	}
}

func TestMercurySocketDefaults(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})
	if ms.pingInterval != 15*time.Second {
		t.Errorf("expected 15s ping interval, got %v", ms.pingInterval)
	}
	if ms.pongTimeout != 14*time.Second {
		t.Errorf("expected 14s pong timeout, got %v", ms.pongTimeout)
	}
	if ms.reconnectBackoffMax != 32*time.Second {
		t.Errorf("expected 32s reconnect backoff max, got %v", ms.reconnectBackoffMax)
	}
	if ms.maxReconnectAttempts != 10 {
		t.Errorf("expected 10 max reconnect attempts, got %d", ms.maxReconnectAttempts)
	}
	if ms.reconnectStability != 60*time.Second {
		t.Errorf("expected 60s reconnect stability window, got %v", ms.reconnectStability)
	}
}

func TestMercurySocketCustomConfig(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{
		PingInterval:         30 * time.Second,
		PongTimeout:          25 * time.Second,
		ReconnectBackoffMax:  60 * time.Second,
		MaxReconnectAttempts: 5,
		ReconnectStability:   90 * time.Second,
	})
	if ms.pingInterval != 30*time.Second {
		t.Errorf("expected 30s, got %v", ms.pingInterval)
	}
	if ms.pongTimeout != 25*time.Second {
		t.Errorf("expected 25s, got %v", ms.pongTimeout)
	}
	if ms.reconnectBackoffMax != 60*time.Second {
		t.Errorf("expected 60s, got %v", ms.reconnectBackoffMax)
	}
	if ms.maxReconnectAttempts != 5 {
		t.Errorf("expected 5, got %d", ms.maxReconnectAttempts)
	}
	if ms.reconnectStability != 90*time.Second {
		t.Errorf("expected 90s, got %v", ms.reconnectStability)
	}
}

func TestMercurySocketNotConnectedInitially(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})
	if ms.Connected() {
		t.Error("expected not connected initially")
	}
}

func TestMercurySocketReconnectAttemptsZero(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})
	if ms.CurrentReconnectAttempts() != 0 {
		t.Errorf("expected 0, got %d", ms.CurrentReconnectAttempts())
	}
}

func TestPrepareURL(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})
	url := ms.prepareURL("wss://mercury.example.com/v1/path")
	if url == "" {
		t.Fatal("expected non-empty URL")
	}
	// Should contain query parameters
	tests := []string{
		"outboundWireFormat=text",
		"bufferStates=true",
		"aliasHttpStatus=true",
		"clientTimestamp=",
	}
	for _, expected := range tests {
		found := false
		if len(url) > 0 {
			for i := 0; i <= len(url)-len(expected); i++ {
				if url[i:i+len(expected)] == expected {
					found = true
					break
				}
			}
		}
		if !found {
			t.Errorf("expected URL to contain %q, got %q", expected, url)
		}
	}
}

func TestIsConnectionReady(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})

	tests := []struct {
		name     string
		message  map[string]interface{}
		expected bool
	}{
		{
			name: "buffer_state",
			message: map[string]interface{}{
				"data": map[string]interface{}{
					"eventType": "mercury.buffer_state",
				},
			},
			expected: true,
		},
		{
			name: "registration_status",
			message: map[string]interface{}{
				"data": map[string]interface{}{
					"eventType": "mercury.registration_status",
				},
			},
			expected: true,
		},
		{
			name: "other_event",
			message: map[string]interface{}{
				"data": map[string]interface{}{
					"eventType": "conversation.activity",
				},
			},
			expected: false,
		},
		{
			name:     "no_data",
			message:  map[string]interface{}{},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ms.isConnectionReadyMessage(tt.message)
			if got != tt.expected {
				t.Errorf("expected %v, got %v", tt.expected, got)
			}
		})
	}
}

func TestParseActivity(t *testing.T) {
	raw := map[string]interface{}{
		"id":   "act-123",
		"verb": "post",
		"actor": map[string]interface{}{
			"id":           "person-1",
			"objectType":   "person",
			"emailAddress": "test@example.com",
		},
		"object": map[string]interface{}{
			"id":               "msg-1",
			"objectType":       "comment",
			"displayName":      "hello",
			"content":          "<p>hello</p>",
			"encryptionKeyUrl": "kms://keys/1",
		},
		"target": map[string]interface{}{
			"id":               "room-1",
			"objectType":       "conversation",
			"encryptionKeyUrl": "kms://keys/2",
			"tags":             []interface{}{"ONE_ON_ONE"},
		},
		"published":        "2024-01-01T00:00:00Z",
		"encryptionKeyUrl": "kms://keys/3",
	}

	activity := parseActivity(raw)

	if activity.ID != "act-123" {
		t.Errorf("expected act-123, got %q", activity.ID)
	}
	if activity.Verb != "post" {
		t.Errorf("expected post, got %q", activity.Verb)
	}
	if activity.Actor.ID != "person-1" {
		t.Errorf("expected person-1, got %q", activity.Actor.ID)
	}
	if activity.Actor.EmailAddress != "test@example.com" {
		t.Errorf("expected test@example.com, got %q", activity.Actor.EmailAddress)
	}
	if activity.Object.DisplayName != "hello" {
		t.Errorf("expected hello, got %q", activity.Object.DisplayName)
	}
	if activity.Object.EncryptionKeyURL != "kms://keys/1" {
		t.Errorf("expected kms://keys/1, got %q", activity.Object.EncryptionKeyURL)
	}
	if activity.Target.Tags[0] != "ONE_ON_ONE" {
		t.Errorf("expected ONE_ON_ONE, got %q", activity.Target.Tags[0])
	}
	if activity.EncryptionKeyURL != "kms://keys/3" {
		t.Errorf("expected kms://keys/3, got %q", activity.EncryptionKeyURL)
	}
}

func TestParseActivityMissingFields(t *testing.T) {
	raw := map[string]interface{}{
		"id":   "act-456",
		"verb": "delete",
	}

	activity := parseActivity(raw)
	if activity.ID != "act-456" {
		t.Errorf("expected act-456, got %q", activity.ID)
	}
	if activity.Actor.ID != "" {
		t.Errorf("expected empty actor ID, got %q", activity.Actor.ID)
	}
	if activity.Object.ID != "" {
		t.Errorf("expected empty object ID, got %q", activity.Object.ID)
	}
	if activity.Target.Tags != nil {
		t.Errorf("expected nil tags, got %v", activity.Target.Tags)
	}
}

func TestHandlePong(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})
	ms.pendingPongID = "pong-123"

	ms.handlePong(map[string]interface{}{"id": "pong-123"})
	if ms.pendingPongID != "" {
		t.Error("expected pendingPongID to be cleared")
	}
}

func TestHandlePongMismatch(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})
	ms.pendingPongID = "pong-123"

	ms.handlePong(map[string]interface{}{"id": "pong-456"})
	if ms.pendingPongID != "pong-123" {
		t.Error("expected pendingPongID to remain unchanged")
	}
}

func TestHasEventType(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{})

	msg := map[string]interface{}{
		"data": map[string]interface{}{
			"eventType": "conversation.activity",
		},
	}
	if !ms.hasEventType(msg) {
		t.Error("expected hasEventType true")
	}

	msg2 := map[string]interface{}{"type": "pong"}
	if ms.hasEventType(msg2) {
		t.Error("expected hasEventType false for pong")
	}
}

// The stability window exists because reconnectAttempts = 0 used to fire the
// instant a reconnect succeeded. A flap storm — connections that come up and
// drop seconds later — zeroed the counter every cycle, so maxReconnectAttempts
// never tripped and the socket retried forever instead of reporting
// max-attempts-exceeded for a supervisor to act on. Mirrors
// python/tests/test_mercury_socket.py::TestFlapStormTripsMaxAttempts.

func TestStabilityWindowResetsAttempts(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{ReconnectStability: 50 * time.Millisecond})
	ms.mu.Lock()
	ms.reconnectAttempts = 2
	ms.mu.Unlock()

	ms.scheduleAttemptsReset()

	// Before the window elapses the counter is untouched.
	time.Sleep(10 * time.Millisecond)
	if got := ms.CurrentReconnectAttempts(); got != 2 {
		t.Fatalf("expected attempts preserved before the window, got %d", got)
	}

	// After it, the counter clears.
	deadline := time.Now().Add(2 * time.Second)
	for ms.CurrentReconnectAttempts() != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := ms.CurrentReconnectAttempts(); got != 0 {
		t.Fatalf("expected attempts cleared after the window, got %d", got)
	}
}

func TestFlapBeforeStabilityPreservesAttempts(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{ReconnectStability: 5 * time.Second})
	ms.mu.Lock()
	ms.reconnectAttempts = 4
	ms.mu.Unlock()
	ms.scheduleAttemptsReset()

	// shouldReconnect stays false, so handleClose takes the "manual" branch and
	// does not spawn a reconnect. The stability cancel runs either way.
	ms.handleClose(websocket.StatusNormalClosure, "flap")

	if got := ms.CurrentReconnectAttempts(); got != 4 {
		t.Errorf("expected attempts preserved across a flap, got %d", got)
	}
	ms.mu.RLock()
	timer := ms.stabilityTimer
	ms.mu.RUnlock()
	if timer != nil {
		t.Error("expected the pending stability reset to be cancelled")
	}
}

func TestFlapStormAccumulatesAttempts(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{
		MaxReconnectAttempts: 3,
		ReconnectStability:   time.Hour, // never fires within this test
	})
	ms.setShouldReconnect(false)

	// Each cycle is what reconnect() does on a successful attempt, followed by
	// the drop that arrives before the window elapses.
	for cycle := 1; cycle <= 3; cycle++ {
		ms.mu.Lock()
		ms.reconnectAttempts++
		ms.mu.Unlock()
		ms.scheduleAttemptsReset()
		ms.handleClose(websocket.StatusNormalClosure, "flap")

		if got := ms.CurrentReconnectAttempts(); got != cycle {
			t.Fatalf("cycle %d: expected attempts to accumulate to %d, got %d", cycle, cycle, got)
		}
	}
}

func TestReconnectTripsMaxAttempts(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{
		MaxReconnectAttempts: 3,
		ReconnectBackoffMax:  time.Millisecond, // keeps the backoff sleeps short
		ReconnectStability:   time.Hour,
		WSFactory: func(_ context.Context, _ string) (WebSocket, error) {
			return nil, errors.New("dial refused")
		},
	})
	ms.baseURL = "wss://mercury.example.com/socket"
	ms.token = "tok"
	ms.setShouldReconnect(true)

	var mu sync.Mutex
	var reasons []string
	ms.OnDisconnected(func(reason string) {
		mu.Lock()
		reasons = append(reasons, reason)
		mu.Unlock()
	})

	ms.reconnect(context.Background())

	if got := ms.CurrentReconnectAttempts(); got != 3 {
		t.Errorf("expected the counter to stop at the 3-attempt cap, got %d", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(reasons) != 1 || reasons[0] != "max-attempts-exceeded" {
		t.Errorf("expected one max-attempts-exceeded disconnect, got %v", reasons)
	}
}
