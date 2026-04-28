package webexmessagehandler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// WebexMessageHandler receives and decrypts Webex messages over Mercury WebSocket.
type WebexMessageHandler struct {
	token      string
	logger     Logger
	httpClient *http.Client
	httpDo     fetchDoFn
	wsFactory  wsFactoryFn
	metricsCallback MetricsCallback

	deviceManager    *DeviceManager
	mercurySocket    *MercurySocket
	kmsClient        *KmsClient
	messageDecryptor *MessageDecryptor
	registration     *DeviceRegistration

	connected          bool
	connecting         bool
	ignoreSelfMessages bool
	botPersonID        string

	// Mutex to protect state fields accessed from multiple goroutines
	mu             sync.RWMutex
	activityCtx    context.Context
	activityCancel context.CancelFunc

	// Activity replay protection: maps activity ID to timestamp when last seen
	recentActivityIDs map[string]time.Time
	activityIDsMu     sync.Mutex

	// Event callbacks
	onMessageCreated          func(msg DecryptedMessage)
	onMessageUpdated          func(msg DecryptedMessage)
	onMessageDeleted          func(data DeletedMessage)
	onMembershipCreated       func(activity MembershipActivity)
	onAttachmentActionCreated func(action AttachmentAction)
	onRoomCreated             func(activity RoomActivity)
	onRoomUpdated             func(activity RoomActivity)
	onConnected               func()
	onDisconnected            func(reason string)
	onReconnecting            func(attempt int)
	onError                   func(err error)
}

// Internal adapter types (aliases for public types)
type fetchDoFn = FetchFunc
type wsFactoryFn = WebSocketFactory

// reportMetric sends a metrics event if callback is set.
func (h *WebexMessageHandler) reportMetric(name string, start time.Time, success bool, metadata map[string]string) {
	if h.metricsCallback != nil {
		h.metricsCallback(MetricsEvent{
			Name:       name,
			DurationMs: float64(time.Since(start).Milliseconds()),
			Success:    success,
			Metadata:   metadata,
		})
	}
}

// New creates a new WebexMessageHandler.
func New(cfg Config) (*WebexMessageHandler, error) {
	if cfg.Token == "" {
		return nil, fmt.Errorf("WebexMessageHandler requires a non-empty token string")
	}

	// Validate networking mode configuration
	mode := cfg.Mode
	if mode == "" {
		mode = NetworkModeNative
	}
	if mode == NetworkModeInjected {
		if cfg.Fetch == nil || cfg.WebSocketFactory == nil {
			return nil, fmt.Errorf("injected mode requires both Fetch and WebSocketFactory")
		}
		if cfg.HTTPClient != nil {
			return nil, fmt.Errorf("cannot use native proxy parameters (HTTPClient) in injected mode")
		}
	} else if mode == NetworkModeNative {
		if cfg.Fetch != nil || cfg.WebSocketFactory != nil {
			return nil, fmt.Errorf("cannot provide Fetch/WebSocketFactory in native mode — set Mode to injected")
		}
	} else {
		return nil, fmt.Errorf("invalid mode %q — must be \"native\" or \"injected\"", mode)
	}

	logger := cfg.Logger
	if logger == nil {
		logger = NoopLogger()
	}

	pingInterval := 15 * time.Second
	if cfg.PingInterval > 0 {
		pingInterval = time.Duration(cfg.PingInterval * float64(time.Second))
	}
	pongTimeout := 14 * time.Second
	if cfg.PongTimeout > 0 {
		pongTimeout = time.Duration(cfg.PongTimeout * float64(time.Second))
	}
	reconnectBackoffMax := 32 * time.Second
	if cfg.ReconnectBackoffMax > 0 {
		reconnectBackoffMax = time.Duration(cfg.ReconnectBackoffMax * float64(time.Second))
	}
	maxReconnectAttempts := 10
	if cfg.MaxReconnectAttempts > 0 {
		maxReconnectAttempts = cfg.MaxReconnectAttempts
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	ignoreSelf := true
	if cfg.IgnoreSelfMessages != nil {
		ignoreSelf = *cfg.IgnoreSelfMessages
	}

	h := &WebexMessageHandler{
		token:              cfg.Token,
		logger:             logger,
		httpClient:         httpClient,
		ignoreSelfMessages: ignoreSelf,
		metricsCallback:    cfg.MetricsCallback,
		recentActivityIDs:  make(map[string]time.Time),
	}

	// Create adapters based on mode
	if mode == NetworkModeNative {
		h.httpDo = createNativeHTTPAdapter(httpClient)
		h.wsFactory = createNativeWSAdapter(httpClient)
	} else {
		// injected mode
		h.httpDo = cfg.Fetch
		h.wsFactory = cfg.WebSocketFactory
	}

	h.deviceManager = NewDeviceManager(logger, h.httpDo)
	h.mercurySocket = NewMercurySocket(MercurySocketConfig{
		Logger:               logger,
		WSFactory:            h.wsFactory,
		PingInterval:         pingInterval,
		PongTimeout:          pongTimeout,
		ReconnectBackoffMax:  reconnectBackoffMax,
		MaxReconnectAttempts: maxReconnectAttempts,
	})

	h.setupMercuryListeners()
	return h, nil
}

// createNativeHTTPAdapter creates an HTTP adapter using native net/http.
func createNativeHTTPAdapter(client *http.Client) fetchDoFn {
	return func(ctx context.Context, req FetchRequest) (*FetchResponse, error) {
		var body io.Reader
		if req.Body != "" {
			body = strings.NewReader(req.Body)
		}

		httpReq, err := http.NewRequestWithContext(ctx, req.Method, req.URL, body)
		if err != nil {
			return nil, err
		}
		for k, v := range req.Headers {
			httpReq.Header.Set(k, v)
		}

		resp, err := client.Do(httpReq)
		if err != nil {
			return nil, err
		}

		return &FetchResponse{
			Status: resp.StatusCode,
			OK:     resp.StatusCode >= 200 && resp.StatusCode < 300,
			Body:   resp.Body,
		}, nil
	}
}

// createNativeWSAdapter creates a WebSocket adapter using gorilla/websocket.
func createNativeWSAdapter(client *http.Client) wsFactoryFn {
	return func(ctx context.Context, url string) (WebSocket, error) {
		// Will be implemented when refactoring MercurySocket
		return newNativeWebSocket(ctx, url, client)
	}
}

// OnMessageCreated sets the callback for new messages.
func (h *WebexMessageHandler) OnMessageCreated(fn func(msg DecryptedMessage)) {
	h.onMessageCreated = fn
}

// OnMessageUpdated sets the callback for edited messages.
func (h *WebexMessageHandler) OnMessageUpdated(fn func(msg DecryptedMessage)) {
	h.onMessageUpdated = fn
}

// OnMessageDeleted sets the callback for deleted messages.
func (h *WebexMessageHandler) OnMessageDeleted(fn func(data DeletedMessage)) {
	h.onMessageDeleted = fn
}

// OnMembershipCreated sets the callback for membership events.
func (h *WebexMessageHandler) OnMembershipCreated(fn func(activity MembershipActivity)) {
	h.onMembershipCreated = fn
}

// OnAttachmentActionCreated sets the callback for adaptive card submissions.
func (h *WebexMessageHandler) OnAttachmentActionCreated(fn func(action AttachmentAction)) {
	h.onAttachmentActionCreated = fn
}

// OnRoomCreated sets the callback for room creation events.
func (h *WebexMessageHandler) OnRoomCreated(fn func(activity RoomActivity)) {
	h.onRoomCreated = fn
}

// OnRoomUpdated sets the callback for room update events.
func (h *WebexMessageHandler) OnRoomUpdated(fn func(activity RoomActivity)) {
	h.onRoomUpdated = fn
}

// OnConnected sets the callback for connection events.
func (h *WebexMessageHandler) OnConnected(fn func()) {
	h.onConnected = fn
}

// OnDisconnected sets the callback for disconnection events.
func (h *WebexMessageHandler) OnDisconnected(fn func(reason string)) {
	h.onDisconnected = fn
}

// OnReconnecting sets the callback for reconnection events.
func (h *WebexMessageHandler) OnReconnecting(fn func(attempt int)) {
	h.onReconnecting = fn
}

// OnError sets the callback for error events.
func (h *WebexMessageHandler) OnError(fn func(err error)) {
	h.onError = fn
}

// Connect establishes the full connection pipeline.
func (h *WebexMessageHandler) Connect(ctx context.Context) error {
	h.mu.Lock()
	if h.connecting {
		h.mu.Unlock()
		return fmt.Errorf("connect() already in progress")
	}
	if h.connected {
		h.mu.Unlock()
		return fmt.Errorf("already connected. Call Disconnect() first, or use Reconnect()")
	}

	h.logger.Info("Connecting to Webex...")
	h.connecting = true
	h.mu.Unlock()

	connectStart := time.Now()

	// Step 1: Register device
	reg, err := h.deviceManager.Register(ctx, h.token)
	if err != nil {
		h.mu.Lock()
		h.connecting = false
		h.mu.Unlock()
		h.reportMetric("connect", connectStart, false, nil)
		return err
	}

	h.mu.Lock()
	h.registration = reg
	h.mu.Unlock()
	h.logger.Info("Device registered")

	// Step 1.5: Fetch bot person info if self-message filtering is enabled
	if h.ignoreSelfMessages {
		if err := h.fetchBotPersonID(ctx); err != nil {
			h.mu.Lock()
			h.connecting = false
			h.mu.Unlock()
			h.reportMetric("connect", connectStart, false, nil)
			return err
		}
	}

	// Step 2: Create KMS client
	h.mu.Lock()
	h.kmsClient = NewKmsClient(KmsClientConfig{
		Token:                h.token,
		DeviceURL:            reg.DeviceURL,
		UserID:               reg.UserID,
		EncryptionServiceURL: reg.EncryptionServiceURL,
		Logger:               h.logger,
		HTTPDo:               h.httpDo,
	})
	h.mu.Unlock()

	// Step 3: Connect Mercury (KMS responses arrive here)
	if err := h.mercurySocket.Connect(ctx, reg.WebSocketURL, h.token); err != nil {
		h.mu.Lock()
		h.connecting = false
		h.mu.Unlock()
		h.reportMetric("connect", connectStart, false, nil)
		return err
	}
	h.logger.Info("Mercury connected")

	// Step 4: Initialize KMS (ECDH handshake)
	h.mu.RLock()
	kmsClient := h.kmsClient
	h.mu.RUnlock()
	if err := kmsClient.Initialize(ctx); err != nil {
		h.mu.Lock()
		h.connecting = false
		h.mu.Unlock()
		h.reportMetric("connect", connectStart, false, nil)
		return err
	}
	h.logger.Info("KMS initialized")

	// Step 5: Create message decryptor and initialize activity context
	h.mu.Lock()
	h.messageDecryptor = NewMessageDecryptor(kmsClient, h.logger)
	h.activityCtx, h.activityCancel = context.WithCancel(context.Background())

	h.connecting = false
	h.connected = true
	h.mu.Unlock()

	h.logger.Info("Connected to Webex")
	h.reportMetric("connect", connectStart, true, nil)
	if h.onConnected != nil {
		h.onConnected()
	}

	return nil
}

// Disconnect tears down the connection cleanly.
func (h *WebexMessageHandler) Disconnect(ctx context.Context) error {
	h.logger.Info("Disconnecting from Webex...")

	h.mu.Lock()
	h.connected = false
	if h.activityCancel != nil {
		h.activityCancel()
	}
	h.mu.Unlock()

	h.mercurySocket.Disconnect()

	h.mu.RLock()
	reg := h.registration
	h.mu.RUnlock()

	if reg != nil {
		if err := h.deviceManager.Unregister(ctx, h.token); err != nil {
			h.logger.Warn(fmt.Sprintf("Failed to unregister device: %v", err))
		} else {
			h.logger.Info("Device unregistered")
		}
	}

	h.mu.Lock()
	h.registration = nil
	h.kmsClient = nil
	h.messageDecryptor = nil
	h.botPersonID = ""
	h.mu.Unlock()

	return nil
}

// Reconnect updates the access token and re-establishes the connection.
func (h *WebexMessageHandler) Reconnect(ctx context.Context, newToken string) error {
	if newToken == "" {
		return fmt.Errorf("Reconnect() requires a non-empty token string")
	}

	h.logger.Info("Reconnecting with new token...")
	if err := h.Disconnect(ctx); err != nil {
		return err
	}
	h.token = newToken
	return h.Connect(ctx)
}

// Connected returns whether the handler is fully connected.
func (h *WebexMessageHandler) Connected() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connected && h.mercurySocket.Connected()
}

// Status returns a structured health check of all connection subsystems.
func (h *WebexMessageHandler) Status() HandlerStatus {
	reconnectAttempt := h.mercurySocket.CurrentReconnectAttempts()

	h.mu.RLock()
	defer h.mu.RUnlock()

	var status ConnectionStatus
	switch {
	case h.connected && h.mercurySocket.Connected():
		status = StatusConnected
	case h.connecting:
		status = StatusConnecting
	case reconnectAttempt > 0:
		status = StatusReconnecting
	default:
		status = StatusDisconnected
	}

	return HandlerStatus{
		Status:           status,
		WebSocketOpen:    h.mercurySocket.Connected(),
		KmsInitialized:   h.kmsClient != nil,
		DeviceRegistered: h.registration != nil,
		ReconnectAttempt: reconnectAttempt,
	}
}

func (h *WebexMessageHandler) fetchBotPersonID(ctx context.Context) error {
	h.logger.Debug("Fetching bot person info for self-message filtering")
	resp, err := h.httpDo(ctx, FetchRequest{
		URL:    "https://webexapis.com/v1/people/me",
		Method: "GET",
		Headers: map[string]string{
			"Authorization": "Bearer " + h.token,
			"Content-Type":  "application/json",
		},
	})
	if err != nil {
		return fmt.Errorf("failed to fetch bot identity for self-message filtering: %w. "+
			"Set IgnoreSelfMessages to false to skip this check (not recommended — may cause message loops)", err)
	}
	defer resp.Body.Close()

	if !resp.OK {
		return fmt.Errorf("failed to fetch bot identity for self-message filtering: HTTP %d. "+
			"Set IgnoreSelfMessages to false to skip this check (not recommended — may cause message loops)", resp.Status)
	}

	var result struct {
		ID string `json:"id"`
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read bot identity response: %w", err)
	}

	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("failed to parse bot identity response: %w", err)
	}

	personID := extractPersonUUID(result.ID)
	h.mu.Lock()
	h.botPersonID = personID
	h.mu.Unlock()
	h.logger.Info(fmt.Sprintf("Bot person ID cached for self-message filtering: %s", personID))
	return nil
}

func (h *WebexMessageHandler) setupMercuryListeners() {
	// Forward KMS messages
	h.mercurySocket.OnKmsResponse(func(data map[string]interface{}) {
		if h.kmsClient != nil {
			h.kmsClient.HandleKmsMessage(data)
		}
	})

	// Handle activities
	h.mercurySocket.OnActivity(func(activity MercuryActivity) {
		go func() {
			h.mu.RLock()
			activityCtx := h.activityCtx
			h.mu.RUnlock()
			if activityCtx == nil {
				activityCtx = context.Background()
			}
			if err := h.handleActivity(activityCtx, activity); err != nil {
				h.logger.Error(fmt.Sprintf("Error handling activity: %v", err))
				if h.onError != nil {
					h.onError(err)
				}
			}
		}()
	})

	// Handle Mercury reconnection
	h.mercurySocket.OnConnected(func() {
		go h.onMercuryReconnect()
	})

	// Forward disconnected
	h.mercurySocket.OnDisconnected(func(reason string) {
		h.mu.Lock()
		h.connected = false
		h.mu.Unlock()
		if h.onDisconnected != nil {
			h.onDisconnected(reason)
		}
	})

	// Forward reconnecting
	h.mercurySocket.OnReconnecting(func(attempt int) {
		if h.onReconnecting != nil {
			h.onReconnecting(attempt)
		}
	})

	// Forward errors
	h.mercurySocket.OnError(func(err error) {
		if h.onError != nil {
			h.onError(err)
		}
	})
}

func (h *WebexMessageHandler) handleActivity(ctx context.Context, activity MercuryActivity) error {
	// Activity replay protection: check for duplicate activity ID
	h.activityIDsMu.Lock()
	if lastSeen, exists := h.recentActivityIDs[activity.ID]; exists {
		h.activityIDsMu.Unlock()
		h.logger.Warn(fmt.Sprintf("Duplicate activity ID detected: %s (last seen at %v), skipping", activity.ID, lastSeen))
		return nil
	}
	h.recentActivityIDs[activity.ID] = time.Now()

	// Clean up entries older than 5 minutes (every 100 activities)
	if len(h.recentActivityIDs)%100 == 0 {
		cutoff := time.Now().Add(-5 * time.Minute)
		for id, timestamp := range h.recentActivityIDs {
			if timestamp.Before(cutoff) {
				delete(h.recentActivityIDs, id)
			}
		}
	}
	h.activityIDsMu.Unlock()

	// message:created or message:updated.
	// Normal text messages: verb=post/update + objectType=comment.
	// File-share messages (with or without accompanying text): verb=share +
	// objectType=comment. Webex Mercury uses a different verb to signal that
	// the activity carries file URLs; without this branch, every attachment
	// message would be dropped silently.
	if (activity.Verb == "post" || activity.Verb == "update" || activity.Verb == "share") && activity.Object.ObjectType == "comment" {
		h.mu.RLock()
		messageDecryptor := h.messageDecryptor
		h.mu.RUnlock()

		if messageDecryptor == nil {
			h.logger.Warn("Received activity but decryptor not initialized")
			return nil
		}

		decryptStart := time.Now()
		decrypted, err := messageDecryptor.DecryptActivity(ctx, activity)
		if err != nil {
			h.reportMetric("decrypt", decryptStart, false, nil)
			return err
		}
		h.reportMetric("decrypt", decryptStart, true, nil)

		var parentID string
		if decrypted.Parent != nil {
			parentID = decrypted.Parent.ID
		}

		mentions := ParseMentions(decrypted.Object.Content)

		msg := DecryptedMessage{
			ID:              decrypted.ID,
			ParentID:        parentID,
			MentionedPeople: mentions.MentionedPeople,
			MentionedGroups: mentions.MentionedGroups,
			RoomID:          decrypted.Target.ID,
			PersonID:        decrypted.Actor.ID,
			PersonEmail:     decrypted.Actor.EmailAddress,
			Text:            decrypted.Object.DisplayName,
			HTML:            decrypted.Object.Content,
			Created:         decrypted.Published,
			RoomType:        inferRoomType(decrypted),
			Files:           decrypted.Object.Files,
			Raw:             &decrypted,
		}

		// Filter self-messages if enabled
		h.mu.RLock()
		shouldFilterSelf := h.ignoreSelfMessages
		botPersonID := h.botPersonID
		h.mu.RUnlock()

		if shouldFilterSelf && botPersonID != "" && extractPersonUUID(msg.PersonID) == botPersonID {
			h.logger.Debug(fmt.Sprintf("Ignoring self-message from bot (%s)", botPersonID))
			return nil
		}

		if activity.Verb == "update" {
			if h.onMessageUpdated != nil {
				h.onMessageUpdated(msg)
			}
		} else {
			if h.onMessageCreated != nil {
				h.onMessageCreated(msg)
			}
		}
		return nil
	}

	// message:deleted — verb=delete + objectType=activity
	if activity.Verb == "delete" && activity.Object.ObjectType == "activity" {
		if h.onMessageDeleted != nil {
			h.onMessageDeleted(DeletedMessage{
				MessageID: activity.Object.ID,
				RoomID:    activity.Target.ID,
				PersonID:  activity.Actor.ID,
			})
		}
		return nil
	}

	// membership:created — membership verbs + objectType=person
	if activity.Object.ObjectType == "person" &&
		(activity.Verb == "add" || activity.Verb == "leave" ||
			activity.Verb == "assignModerator" || activity.Verb == "unassignModerator") {
		if h.onMembershipCreated != nil {
			activityCopy := activity
			h.onMembershipCreated(MembershipActivity{
				ID:       activity.ID,
				ActorID:  activity.Actor.ID,
				PersonID: activity.Object.ID,
				RoomID:   activity.Target.ID,
				Action:   activity.Verb,
				Created:  activity.Published,
				RoomType: inferRoomType(activity),
				Raw:      &activityCopy,
			})
		}
		return nil
	}

	// attachmentAction:created — verb=cardAction + objectType=submit
	if activity.Verb == "cardAction" && activity.Object.ObjectType == "submit" {
		if h.onAttachmentActionCreated != nil {
			var parentID string
			if activity.Parent != nil {
				parentID = activity.Parent.ID
			}
			activityCopy := activity
			h.onAttachmentActionCreated(AttachmentAction{
				ID:          activity.ID,
				MessageID:   parentID,
				PersonID:    activity.Actor.ID,
				PersonEmail: activity.Actor.EmailAddress,
				RoomID:      activity.Target.ID,
				Inputs:      activity.Object.Inputs,
				Created:     activity.Published,
				Raw:         &activityCopy,
			})
		}
		return nil
	}

	// room:created or room:updated — verb=create/update + object.objectType=conversation
	if (activity.Verb == "create" || activity.Verb == "update") && activity.Object.ObjectType == "conversation" {
		activityCopy := activity
		action := "updated"
		if activity.Verb == "create" {
			action = "created"
		}
		ra := RoomActivity{
			ID:      activity.ID,
			RoomID:  activity.Target.ID,
			ActorID: activity.Actor.ID,
			Action:  action,
			Created: activity.Published,
			Raw:     &activityCopy,
		}
		if activity.Verb == "create" {
			if h.onRoomCreated != nil {
				h.onRoomCreated(ra)
			}
		} else {
			if h.onRoomUpdated != nil {
				h.onRoomUpdated(ra)
			}
		}
		return nil
	}

	return nil
}

// extractPersonUUID normalizes a Webex person ID to a raw UUID.
//
// The Webex REST API returns base64-encoded IDs like:
//
//	"Y2lzY29zcGFyazovL3VzL1BFT1BMRS9mYjUx..." → "ciscospark://us/PEOPLE/fb51254f-..."
//
// Mercury wire format uses raw UUIDs:
//
//	"fb51254f-3b37-4e50-aa04-45744c2effc7"
//
// This function normalizes both formats to the raw UUID for comparison.
func extractPersonUUID(id string) string {
	decoded, err := base64.StdEncoding.DecodeString(id)
	if err != nil {
		// Try URL-safe or no-padding variants
		decoded, err = base64.RawStdEncoding.DecodeString(id)
		if err != nil {
			return id // Not base64 — treat as raw UUID
		}
	}
	s := string(decoded)
	if strings.HasPrefix(s, "ciscospark://") {
		parts := strings.Split(s, "/")
		if uuid := parts[len(parts)-1]; uuid != "" {
			return uuid
		}
	}
	return id
}

func inferRoomType(activity MercuryActivity) string {
	tags := activity.Target.Tags
	for _, tag := range tags {
		if tag == "ONE_ON_ONE" {
			return "direct"
		}
	}
	for _, tag := range tags {
		if tag == "TEAM" || tag == "LOCKED" || tag == "GROUP" {
			return "group"
		}
	}
	return ""
}

func (h *WebexMessageHandler) onMercuryReconnect() {
	h.logger.Info("Mercury reconnected, refreshing device and KMS")
	ctx := context.Background()

	h.mu.RLock()
	reg := h.registration
	kmsClient := h.kmsClient
	h.mu.RUnlock()

	if reg != nil {
		newReg, err := h.deviceManager.Refresh(ctx, h.token)
		if err != nil {
			h.logger.Warn(fmt.Sprintf("Device refresh on reconnect failed: %v", err))
		} else {
			h.mu.Lock()
			h.registration = newReg
			h.mu.Unlock()
		}
	}

	if kmsClient != nil {
		if err := kmsClient.Initialize(ctx); err != nil {
			h.logger.Warn(fmt.Sprintf("KMS re-init on reconnect failed: %v", err))
		}
	}

	h.mu.Lock()
	h.connected = true
	h.mu.Unlock()

	if h.onConnected != nil {
		h.onConnected()
	}
}
