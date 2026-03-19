package webexmessagehandler

import (
	"testing"
	"time"
)

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
}

func TestMercurySocketCustomConfig(t *testing.T) {
	ms := NewMercurySocket(MercurySocketConfig{
		PingInterval:         30 * time.Second,
		PongTimeout:          25 * time.Second,
		ReconnectBackoffMax:  60 * time.Second,
		MaxReconnectAttempts: 5,
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
