package webexmessagehandler

import (
	"context"
	"encoding/json"
	"testing"
)

func TestNewRequiresToken(t *testing.T) {
	_, err := New(Config{})
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestNewWithToken(t *testing.T) {
	h, err := New(Config{Token: "test-token"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h == nil {
		t.Fatal("expected non-nil handler")
	}
}

func TestConfigDefaults(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})
	status := h.Status()
	if status.Status != StatusDisconnected {
		t.Errorf("expected disconnected, got %s", status.Status)
	}
	if status.WebSocketOpen {
		t.Error("expected WebSocketOpen false")
	}
	if status.KmsInitialized {
		t.Error("expected KmsInitialized false")
	}
	if status.DeviceRegistered {
		t.Error("expected DeviceRegistered false")
	}
	if status.ReconnectAttempt != 0 {
		t.Errorf("expected ReconnectAttempt 0, got %d", status.ReconnectAttempt)
	}
}

func TestCustomConfigValues(t *testing.T) {
	h, err := New(Config{
		Token:                "test-token",
		PingInterval:         30,
		PongTimeout:          25,
		ReconnectBackoffMax:  60,
		MaxReconnectAttempts: 5,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h == nil {
		t.Fatal("expected non-nil handler")
	}
}

func TestNotConnectedInitially(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})
	if h.Connected() {
		t.Error("expected not connected initially")
	}
}

func TestStatusDisconnected(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})
	status := h.Status()
	if status.Status != StatusDisconnected {
		t.Errorf("expected disconnected, got %s", status.Status)
	}
}

func TestCallbackRegistration(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	h.OnMessageCreated(func(msg DecryptedMessage) {})
	if h.onMessageCreated == nil {
		t.Error("expected onMessageCreated callback to be set")
	}

	h.OnMessageDeleted(func(data DeletedMessage) {})
	if h.onMessageDeleted == nil {
		t.Error("expected onMessageDeleted callback to be set")
	}

	h.OnMembershipCreated(func(activity MembershipActivity) {})
	if h.onMembershipCreated == nil {
		t.Error("expected onMembershipCreated callback to be set")
	}

	h.OnConnected(func() {})
	if h.onConnected == nil {
		t.Error("expected onConnected callback to be set")
	}

	h.OnDisconnected(func(reason string) {})
	if h.onDisconnected == nil {
		t.Error("expected onDisconnected callback to be set")
	}

	h.OnReconnecting(func(attempt int) {})
	if h.onReconnecting == nil {
		t.Error("expected onReconnecting callback to be set")
	}

	h.OnError(func(err error) {})
	if h.onError == nil {
		t.Error("expected onError callback to be set")
	}
}

func TestInferRoomTypeDirect(t *testing.T) {
	activity := MercuryActivity{
		Target: MercuryTarget{
			Tags: []string{"ONE_ON_ONE"},
		},
	}
	if got := inferRoomType(activity); got != "direct" {
		t.Errorf("expected direct, got %q", got)
	}
}

func TestInferRoomTypeGroup(t *testing.T) {
	for _, tag := range []string{"TEAM", "LOCKED", "GROUP"} {
		activity := MercuryActivity{
			Target: MercuryTarget{
				Tags: []string{tag},
			},
		}
		if got := inferRoomType(activity); got != "group" {
			t.Errorf("expected group for tag %s, got %q", tag, got)
		}
	}
}

func TestInferRoomTypeEmpty(t *testing.T) {
	activity := MercuryActivity{
		Target: MercuryTarget{
			Tags: []string{"SOME_OTHER_TAG"},
		},
	}
	if got := inferRoomType(activity); got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
}

func TestInferRoomTypeNoTags(t *testing.T) {
	activity := MercuryActivity{}
	if got := inferRoomType(activity); got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
}

func TestHandleActivityMessageCreated(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	var received DecryptedMessage
	h.OnMessageCreated(func(msg DecryptedMessage) {
		received = msg
	})

	// Create a mock message decryptor that passes through
	h.messageDecryptor = &MessageDecryptor{
		kmsClient: nil,
		logger:    NoopLogger(),
	}

	activity := MercuryActivity{
		ID:   "act-1",
		Verb: "post",
		Actor: MercuryActor{
			ID:           "person-1",
			ObjectType:   "person",
			EmailAddress: "test@example.com",
		},
		Object: MercuryObject{
			ID:          "msg-1",
			ObjectType:  "comment",
			DisplayName: "hello",
			Content:     "<p>hello</p>",
		},
		Target: MercuryTarget{
			ID:         "room-1",
			ObjectType: "conversation",
			Tags:       []string{"ONE_ON_ONE"},
		},
		Published: "2024-01-01T00:00:00.000Z",
	}

	// No encryptionKeyUrl means decryptor will pass through
	err := h.handleActivity(context.TODO(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if received.ID != "act-1" {
		t.Errorf("expected act-1, got %q", received.ID)
	}
	if received.RoomID != "room-1" {
		t.Errorf("expected room-1, got %q", received.RoomID)
	}
	if received.PersonID != "person-1" {
		t.Errorf("expected person-1, got %q", received.PersonID)
	}
	if received.PersonEmail != "test@example.com" {
		t.Errorf("expected test@example.com, got %q", received.PersonEmail)
	}
	if received.Text != "hello" {
		t.Errorf("expected hello, got %q", received.Text)
	}
	if received.HTML != "<p>hello</p>" {
		t.Errorf("expected <p>hello</p>, got %q", received.HTML)
	}
	if received.RoomType != "direct" {
		t.Errorf("expected direct, got %q", received.RoomType)
	}
	if received.Created != "2024-01-01T00:00:00.000Z" {
		t.Errorf("expected 2024-01-01T00:00:00.000Z, got %q", received.Created)
	}
}

func TestHandleActivityThreadedReply(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	var received DecryptedMessage
	h.OnMessageCreated(func(msg DecryptedMessage) {
		received = msg
	})

	h.messageDecryptor = &MessageDecryptor{
		kmsClient: nil,
		logger:    NoopLogger(),
	}

	activity := MercuryActivity{
		ID:   "reply-1",
		Verb: "post",
		Actor: MercuryActor{
			ID:           "person-1",
			ObjectType:   "person",
			EmailAddress: "test@example.com",
		},
		Object: MercuryObject{
			ID:          "obj-1",
			ObjectType:  "comment",
			DisplayName: "reply text",
		},
		Target: MercuryTarget{
			ID:         "room-1",
			ObjectType: "conversation",
		},
		Published: "2024-01-01T00:00:00.000Z",
		Parent: &MercuryParent{
			ID:   "parent-activity-uuid",
			Type: "reply",
		},
	}

	err := h.handleActivity(context.TODO(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if received.ID != "reply-1" {
		t.Errorf("expected reply-1, got %q", received.ID)
	}
	if received.ParentID != "parent-activity-uuid" {
		t.Errorf("expected parent-activity-uuid, got %q", received.ParentID)
	}
}

func TestHandleActivityMessageDeleted(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	var received DeletedMessage
	h.OnMessageDeleted(func(data DeletedMessage) {
		received = data
	})

	activity := MercuryActivity{
		ID:   "act-1",
		Verb: "delete",
		Actor: MercuryActor{
			ID: "person-1",
		},
		Object: MercuryObject{
			ID:         "msg-1",
			ObjectType: "activity",
		},
		Target: MercuryTarget{
			ID: "room-1",
		},
	}

	err := h.handleActivity(context.TODO(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if received.MessageID != "msg-1" {
		t.Errorf("expected msg-1, got %q", received.MessageID)
	}
	if received.RoomID != "room-1" {
		t.Errorf("expected room-1, got %q", received.RoomID)
	}
	if received.PersonID != "person-1" {
		t.Errorf("expected person-1, got %q", received.PersonID)
	}
}

func TestHandleActivityMembershipCreated(t *testing.T) {
	verbs := []string{"add", "leave", "assignModerator", "unassignModerator"}
	for _, verb := range verbs {
		t.Run(verb, func(t *testing.T) {
			h, _ := New(Config{Token: "test-token"})

			var received MembershipActivity
			h.OnMembershipCreated(func(a MembershipActivity) {
				received = a
			})

			activity := MercuryActivity{
				ID:   "membership-1",
				Verb: verb,
				Actor: MercuryActor{
					ID:         "admin-1",
					ObjectType: "person",
				},
				Object: MercuryObject{
					ID:         "member-1",
					ObjectType: "person",
				},
				Target: MercuryTarget{
					ID:         "room-1",
					ObjectType: "conversation",
					Tags:       []string{"GROUP"},
				},
				Published: "2024-01-01T00:00:00.000Z",
			}

			err := h.handleActivity(context.TODO(), activity)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if received.ID != "membership-1" {
				t.Errorf("expected membership-1, got %q", received.ID)
			}
			if received.ActorID != "admin-1" {
				t.Errorf("expected admin-1, got %q", received.ActorID)
			}
			if received.PersonID != "member-1" {
				t.Errorf("expected member-1, got %q", received.PersonID)
			}
			if received.RoomID != "room-1" {
				t.Errorf("expected room-1, got %q", received.RoomID)
			}
			if received.Action != verb {
				t.Errorf("expected %q, got %q", verb, received.Action)
			}
			if received.Created != "2024-01-01T00:00:00.000Z" {
				t.Errorf("expected 2024-01-01T00:00:00.000Z, got %q", received.Created)
			}
			if received.RoomType != "group" {
				t.Errorf("expected group, got %q", received.RoomType)
			}
			if received.Raw == nil {
				t.Error("expected non-nil Raw")
			}
		})
	}
}

func TestHandleActivityMembershipNotTriggeredForNonPersonObject(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	called := false
	h.OnMembershipCreated(func(a MembershipActivity) {
		called = true
	})

	activity := MercuryActivity{
		Verb: "add",
		Object: MercuryObject{
			ObjectType: "comment",
		},
	}

	err := h.handleActivity(context.TODO(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Error("callback should not have been called for non-person objectType")
	}
}

func TestHandleActivityMembershipNotTriggeredForNonMembershipVerb(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	called := false
	h.OnMembershipCreated(func(a MembershipActivity) {
		called = true
	})

	activity := MercuryActivity{
		Verb: "post",
		Object: MercuryObject{
			ObjectType: "person",
		},
	}

	err := h.handleActivity(context.TODO(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Error("callback should not have been called for non-membership verb")
	}
}

func TestHandleActivityIgnoresNonMessage(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	called := false
	h.OnMessageCreated(func(msg DecryptedMessage) {
		called = true
	})

	// verb=add is not post or delete
	activity := MercuryActivity{
		Verb: "add",
		Object: MercuryObject{
			ObjectType: "comment",
		},
	}

	err := h.handleActivity(context.TODO(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Error("callback should not have been called for non-post verb")
	}
}

func TestHandleActivityIgnoresPostNonComment(t *testing.T) {
	h, _ := New(Config{Token: "test-token"})

	called := false
	h.OnMessageCreated(func(msg DecryptedMessage) {
		called = true
	})

	// verb=post but objectType=activity (not comment)
	activity := MercuryActivity{
		Verb: "post",
		Object: MercuryObject{
			ObjectType: "activity",
		},
	}

	err := h.handleActivity(context.TODO(), activity)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called {
		t.Error("callback should not have been called for non-comment objectType")
	}
}

func TestConnectionStatusValues(t *testing.T) {
	tests := []struct {
		status ConnectionStatus
		want   string
	}{
		{StatusConnected, "connected"},
		{StatusConnecting, "connecting"},
		{StatusReconnecting, "reconnecting"},
		{StatusDisconnected, "disconnected"},
	}

	for _, tt := range tests {
		if got := string(tt.status); got != tt.want {
			t.Errorf("ConnectionStatus %q: got %q, want %q", tt.status, got, tt.want)
		}
	}
}

func TestMercuryActivityJSONDeserialization(t *testing.T) {
	raw := `{
		"id": "activity-123",
		"verb": "post",
		"actor": {
			"id": "actor-id",
			"objectType": "person",
			"emailAddress": "test@example.com"
		},
		"object": {
			"id": "object-id",
			"objectType": "comment",
			"displayName": "Hello",
			"content": "<p>Hello</p>"
		},
		"target": {
			"id": "target-id",
			"objectType": "conversation",
			"tags": ["ONE_ON_ONE"]
		},
		"published": "2024-01-01T00:00:00.000Z"
	}`

	var activity MercuryActivity
	if err := json.Unmarshal([]byte(raw), &activity); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if activity.ID != "activity-123" {
		t.Errorf("expected activity-123, got %q", activity.ID)
	}
	if activity.Verb != "post" {
		t.Errorf("expected post, got %q", activity.Verb)
	}
	if activity.Actor.ID != "actor-id" {
		t.Errorf("expected actor-id, got %q", activity.Actor.ID)
	}
	if activity.Actor.EmailAddress != "test@example.com" {
		t.Errorf("expected test@example.com, got %q", activity.Actor.EmailAddress)
	}
	if activity.Object.DisplayName != "Hello" {
		t.Errorf("expected Hello, got %q", activity.Object.DisplayName)
	}
	if activity.Object.Content != "<p>Hello</p>" {
		t.Errorf("expected <p>Hello</p>, got %q", activity.Object.Content)
	}
	if len(activity.Target.Tags) != 1 || activity.Target.Tags[0] != "ONE_ON_ONE" {
		t.Errorf("expected [ONE_ON_ONE], got %v", activity.Target.Tags)
	}
}

func TestMercuryActivityJSONPartialDeserialization(t *testing.T) {
	// Webex may omit optional fields
	raw := `{
		"id": "activity-456",
		"verb": "delete",
		"actor": {"id": "actor-id"},
		"object": {"id": "object-id", "objectType": "activity"},
		"target": {"id": "target-id"}
	}`

	var activity MercuryActivity
	if err := json.Unmarshal([]byte(raw), &activity); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if activity.ID != "activity-456" {
		t.Errorf("expected activity-456, got %q", activity.ID)
	}
	if activity.Actor.EmailAddress != "" {
		t.Errorf("expected empty email, got %q", activity.Actor.EmailAddress)
	}
	if activity.Object.DisplayName != "" {
		t.Errorf("expected empty displayName, got %q", activity.Object.DisplayName)
	}
	if activity.Target.Tags != nil {
		t.Errorf("expected nil tags, got %v", activity.Target.Tags)
	}
}

func TestDeletedMessageConstruction(t *testing.T) {
	msg := DeletedMessage{
		MessageID: "msg-1",
		RoomID:    "room-1",
		PersonID:  "person-1",
	}
	if msg.MessageID != "msg-1" {
		t.Errorf("expected msg-1, got %q", msg.MessageID)
	}
	if msg.RoomID != "room-1" {
		t.Errorf("expected room-1, got %q", msg.RoomID)
	}
	if msg.PersonID != "person-1" {
		t.Errorf("expected person-1, got %q", msg.PersonID)
	}
}

func TestHandlerStatusConstruction(t *testing.T) {
	status := HandlerStatus{
		Status:           StatusConnected,
		WebSocketOpen:    true,
		KmsInitialized:   true,
		DeviceRegistered: true,
		ReconnectAttempt: 0,
	}
	if status.Status != StatusConnected {
		t.Errorf("expected connected, got %s", status.Status)
	}
	if !status.WebSocketOpen {
		t.Error("expected WebSocketOpen true")
	}
}
