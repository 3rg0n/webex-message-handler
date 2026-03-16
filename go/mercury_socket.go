package webexmessagehandler

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"
)

// MercurySocket manages the Mercury WebSocket connection.
type MercurySocket struct {
	logger               Logger
	wsFactory            wsFactoryFn
	pingInterval         time.Duration
	pongTimeout          time.Duration
	reconnectBackoffMax  time.Duration
	maxReconnectAttempts int

	conn              *websocket.Conn
	token             string
	baseURL           string
	connectionReady   bool
	shouldReconnect   bool
	reconnecting      bool
	reconnectAttempts int
	pendingPongID     string

	mu       sync.RWMutex
	cancelFn context.CancelFunc

	// Event callbacks
	onConnected    func()
	onDisconnected func(reason string)
	onReconnecting func(attempt int)
	onActivity     func(activity MercuryActivity)
	onKmsResponse  func(data map[string]interface{})
	onError        func(err error)
}

// MercurySocketConfig holds options for MercurySocket.
type MercurySocketConfig struct {
	Logger               Logger
	WSFactory            wsFactoryFn
	PingInterval         time.Duration
	PongTimeout          time.Duration
	ReconnectBackoffMax  time.Duration
	MaxReconnectAttempts int
}

// NewMercurySocket creates a new MercurySocket.
func NewMercurySocket(cfg MercurySocketConfig) *MercurySocket {
	if cfg.Logger == nil {
		cfg.Logger = NoopLogger()
	}
	if cfg.PingInterval == 0 {
		cfg.PingInterval = 15 * time.Second
	}
	if cfg.PongTimeout == 0 {
		cfg.PongTimeout = 14 * time.Second
	}
	if cfg.ReconnectBackoffMax == 0 {
		cfg.ReconnectBackoffMax = 32 * time.Second
	}
	if cfg.MaxReconnectAttempts == 0 {
		cfg.MaxReconnectAttempts = 10
	}

	return &MercurySocket{
		logger:               cfg.Logger,
		wsFactory:            cfg.WSFactory,
		pingInterval:         cfg.PingInterval,
		pongTimeout:          cfg.PongTimeout,
		reconnectBackoffMax:  cfg.ReconnectBackoffMax,
		maxReconnectAttempts: cfg.MaxReconnectAttempts,
	}
}

// OnConnected sets the connected event callback.
func (ms *MercurySocket) OnConnected(fn func()) { ms.onConnected = fn }

// OnDisconnected sets the disconnected event callback.
func (ms *MercurySocket) OnDisconnected(fn func(reason string)) { ms.onDisconnected = fn }

// OnReconnecting sets the reconnecting event callback.
func (ms *MercurySocket) OnReconnecting(fn func(attempt int)) { ms.onReconnecting = fn }

// OnActivity sets the activity event callback.
func (ms *MercurySocket) OnActivity(fn func(activity MercuryActivity)) { ms.onActivity = fn }

// OnKmsResponse sets the kms:response event callback.
func (ms *MercurySocket) OnKmsResponse(fn func(data map[string]interface{})) { ms.onKmsResponse = fn }

// OnError sets the error event callback.
func (ms *MercurySocket) OnError(fn func(err error)) { ms.onError = fn }

// Connect connects to Mercury WebSocket.
func (ms *MercurySocket) Connect(ctx context.Context, wsURL, token string) error {
	ms.token = token
	ms.baseURL = wsURL
	ms.shouldReconnect = true
	ms.reconnectAttempts = 0
	return ms.connectInternal(ctx)
}

func (ms *MercurySocket) connectInternal(ctx context.Context) error {
	preparedURL := ms.prepareURL(ms.baseURL)
	ms.logger.Debug(fmt.Sprintf("Connecting to Mercury at %s", preparedURL))

	ms.connectionReady = false

	connCtx, cancel := context.WithCancel(ctx)
	ms.cancelFn = cancel

	ws, err := ms.wsFactory(connCtx, preparedURL)
	if err != nil {
		cancel()
		return NewMercuryConnectionError("Failed to connect to Mercury socket", 0)
	}

	// Extract raw connection for nhooyr.io/websocket operations
	var conn *websocket.Conn
	if nativeWS, ok := ws.(*nativeWebSocket); ok {
		conn = nativeWS.Conn
		conn.SetReadLimit(1 << 20) // 1MB
	} else {
		// For injected WebSocket, we can't access the raw connection
		// This is acceptable as injected mode users control their implementation
		cancel()
		return NewMercuryConnectionError("Injected WebSocket mode not yet supported for Mercury", 0)
	}

	ms.mu.Lock()
	ms.conn = conn
	ms.mu.Unlock()

	// Send authorization
	ms.logger.Debug("WebSocket opened, sending authorization")
	authMsg, _ := json.Marshal(map[string]interface{}{
		"id":   uuid.New().String(),
		"type": "authorization",
		"data": map[string]string{"token": "Bearer " + ms.token},
	})
	if err := conn.Write(connCtx, websocket.MessageText, authMsg); err != nil {
		cancel()
		return NewMercuryConnectionError("Failed to send authorization", 0)
	}

	// Wait for connection ready signal
	readyCh := make(chan struct{})
	errCh := make(chan error, 1)

	go func() {
		for {
			_, data, err := conn.Read(connCtx)
			if err != nil {
				if !ms.connectionReady {
					errCh <- NewMercuryConnectionError("WebSocket closed during setup", 0)
				} else {
					ms.handleClose(websocket.StatusNormalClosure, "")
				}
				return
			}

			ms.logger.Debug(fmt.Sprintf("WS message received (%d bytes)", len(data)))
			var message map[string]interface{}
			if err := json.Unmarshal(data, &message); err != nil {
				ms.logger.Error(fmt.Sprintf("Failed to parse Mercury message: %v", err))
				continue
			}

			ms.handleMessage(message)

			if !ms.connectionReady && ms.isConnectionReady(message) {
				ms.connectionReady = true
				ms.logger.Debug("Mercury connection ready")
				go ms.startPingLoop(connCtx)
				close(readyCh)
			}
		}
	}()

	select {
	case <-readyCh:
		return nil
	case err := <-errCh:
		cancel()
		return err
	case <-time.After(30 * time.Second):
		cancel()
		return NewMercuryConnectionError("Mercury connection timeout", 0)
	}
}

func (ms *MercurySocket) prepareURL(baseURL string) string {
	u, err := url.Parse(baseURL)
	if err != nil {
		return baseURL
	}
	q := u.Query()
	q.Set("outboundWireFormat", "text")
	q.Set("bufferStates", "true")
	q.Set("aliasHttpStatus", "true")
	q.Set("clientTimestamp", strconv.FormatInt(time.Now().UnixMilli(), 10))
	u.RawQuery = q.Encode()
	return u.String()
}

func (ms *MercurySocket) isConnectionReady(message map[string]interface{}) bool {
	data, _ := message["data"].(map[string]interface{})
	if data == nil {
		return false
	}
	eventType, _ := data["eventType"].(string)
	return eventType == "mercury.buffer_state" || eventType == "mercury.registration_status"
}

func (ms *MercurySocket) startPingLoop(ctx context.Context) {
	ticker := time.NewTicker(ms.pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			ms.mu.RLock()
			conn := ms.conn
			ms.mu.RUnlock()
			if conn == nil {
				return
			}

			pongID := uuid.New().String()
			ms.mu.Lock()
			ms.pendingPongID = pongID
			ms.mu.Unlock()

			pingMsg, _ := json.Marshal(map[string]string{
				"id":   pongID,
				"type": "ping",
			})
			if err := conn.Write(ctx, websocket.MessageText, pingMsg); err != nil {
				return
			}
			ms.logger.Debug(fmt.Sprintf("Sent ping: %s", pongID))

			// Wait for pong with timeout
			go func(expectedID string) {
				select {
				case <-time.After(ms.pongTimeout):
				case <-ctx.Done():
					return
				}
				ms.mu.Lock()
				if ms.pendingPongID != expectedID {
					ms.mu.Unlock()
					return
				}
				ms.pendingPongID = ""
				ms.mu.Unlock()
				ms.logger.Warn(fmt.Sprintf("Pong timeout for ping %s, reconnecting", expectedID))
				ms.triggerReconnect()
			}(pongID)
		}
	}
}

func (ms *MercurySocket) handleMessage(message map[string]interface{}) {
	msgType, _ := message["type"].(string)

	switch {
	case msgType == "pong":
		ms.handlePong(message)
	case ms.hasEventType(message):
		ms.handleActivityEnvelope(message)
	case msgType == "shutdown":
		ms.logger.Info("Received shutdown message from Mercury")
		go ms.triggerReconnect()
	default:
		ms.logger.Debug(fmt.Sprintf("Unhandled Mercury message type: %s", msgType))
	}
}

func (ms *MercurySocket) hasEventType(message map[string]interface{}) bool {
	data, _ := message["data"].(map[string]interface{})
	if data == nil {
		return false
	}
	_, ok := data["eventType"].(string)
	return ok
}

func (ms *MercurySocket) handlePong(message map[string]interface{}) {
	id, _ := message["id"].(string)
	ms.mu.Lock()
	if ms.pendingPongID != "" && id == ms.pendingPongID {
		ms.logger.Debug(fmt.Sprintf("Received pong: %s", id))
		ms.pendingPongID = ""
	}
	ms.mu.Unlock()
}

func (ms *MercurySocket) handleActivityEnvelope(message map[string]interface{}) {
	data, _ := message["data"].(map[string]interface{})
	if data == nil {
		return
	}
	eventType, _ := data["eventType"].(string)
	ms.logger.Debug(fmt.Sprintf("Mercury eventType: %s", eventType))

	// Send ACK
	ms.mu.RLock()
	conn := ms.conn
	ms.mu.RUnlock()
	if conn != nil {
		msgID, _ := message["id"].(string)
		ack, _ := json.Marshal(map[string]string{"messageId": msgID, "type": "ack"})
		conn.Write(context.Background(), websocket.MessageText, ack)
	}

	// Route KMS messages
	if len(eventType) > 11 && eventType[:11] == "encryption." {
		ms.logger.Debug(fmt.Sprintf("Emitting kms:response for eventType: %s", eventType))
		if ms.onKmsResponse != nil {
			ms.onKmsResponse(data)
		}
		return
	}

	// Route conversation activities
	if eventType == "conversation.activity" {
		activityRaw, ok := data["activity"].(map[string]interface{})
		if !ok {
			return
		}

		activity := parseActivity(activityRaw)
		ms.logger.Debug(fmt.Sprintf("Emitting activity: %s", activity.ID))
		if ms.onActivity != nil {
			ms.onActivity(activity)
		}
	}
}

func (ms *MercurySocket) handleClose(code websocket.StatusCode, reason string) {
	ms.logger.Info(fmt.Sprintf("WebSocket closed with code %d: %s", code, reason))
	ms.connectionReady = false

	if code == 4401 {
		ms.logger.Error("Mercury authorization failed")
		ms.shouldReconnect = false
		if ms.onError != nil {
			ms.onError(NewAuthError("Mercury authorization failed"))
		}
		if ms.onDisconnected != nil {
			ms.onDisconnected("auth-failed")
		}
		return
	}

	if code == 4400 || code == 4403 {
		ms.logger.Error(fmt.Sprintf("Mercury permanent failure (code %d)", code))
		ms.shouldReconnect = false
		if ms.onError != nil {
			ms.onError(NewMercuryConnectionError(fmt.Sprintf("Mercury permanent failure (code %d)", code), int(code)))
		}
		if ms.onDisconnected != nil {
			ms.onDisconnected("permanent-failure")
		}
		return
	}

	if ms.shouldReconnect {
		go ms.triggerReconnect()
	} else {
		if ms.onDisconnected != nil {
			ms.onDisconnected("manual")
		}
	}
}

func (ms *MercurySocket) reconnect(ctx context.Context) {
	defer func() {
		ms.mu.Lock()
		ms.reconnecting = false
		ms.mu.Unlock()
	}()

	if !ms.shouldReconnect {
		return
	}

	if ms.reconnectAttempts >= ms.maxReconnectAttempts {
		ms.logger.Error(fmt.Sprintf("Max reconnection attempts (%d) exceeded", ms.maxReconnectAttempts))
		ms.shouldReconnect = false
		if ms.onDisconnected != nil {
			ms.onDisconnected("max-attempts-exceeded")
		}
		return
	}

	ms.reconnectAttempts++
	delay := math.Min(
		math.Pow(2, float64(ms.reconnectAttempts-1)),
		ms.reconnectBackoffMax.Seconds(),
	)

	ms.logger.Info(fmt.Sprintf("Reconnecting (attempt %d/%d) in %.0fs", ms.reconnectAttempts, ms.maxReconnectAttempts, delay))
	if ms.onReconnecting != nil {
		ms.onReconnecting(ms.reconnectAttempts)
	}

	time.Sleep(time.Duration(delay * float64(time.Second)))

	if !ms.shouldReconnect {
		return
	}

	if err := ms.connectInternal(ctx); err != nil {
		ms.logger.Error(fmt.Sprintf("Reconnection failed: %v", err))
		if ms.shouldReconnect {
			ms.reconnect(ctx)
		}
		return
	}

	ms.logger.Info("Successfully reconnected to Mercury")
	ms.reconnectAttempts = 0
	if ms.onConnected != nil {
		ms.onConnected()
	}
}

func (ms *MercurySocket) closeWebSocket() {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	if ms.cancelFn != nil {
		ms.cancelFn()
		ms.cancelFn = nil
	}
	if ms.conn != nil {
		ms.conn.Close(websocket.StatusNormalClosure, "")
		ms.conn = nil
	}
	ms.pendingPongID = ""
}

// triggerReconnect safely closes the socket and starts a reconnection,
// preventing concurrent reconnection attempts.
func (ms *MercurySocket) triggerReconnect() {
	ms.mu.Lock()
	if ms.reconnecting || !ms.shouldReconnect {
		ms.mu.Unlock()
		return
	}
	ms.reconnecting = true
	ms.mu.Unlock()

	ms.closeWebSocket()
	ms.reconnect(context.Background())
}

// Disconnect disconnects from Mercury.
func (ms *MercurySocket) Disconnect() {
	ms.logger.Info("Disconnecting from Mercury")
	ms.shouldReconnect = false
	ms.closeWebSocket()
	ms.connectionReady = false
	if ms.onDisconnected != nil {
		ms.onDisconnected("client")
	}
}

// Connected returns whether the WebSocket is currently open.
func (ms *MercurySocket) Connected() bool {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return ms.conn != nil && ms.connectionReady
}

// CurrentReconnectAttempts returns the current reconnection attempt count.
func (ms *MercurySocket) CurrentReconnectAttempts() int {
	return ms.reconnectAttempts
}

func parseActivity(raw map[string]interface{}) MercuryActivity {
	actor := parseActor(raw["actor"])
	object := parseObject(raw["object"])
	target := parseTarget(raw["target"])

	id, _ := raw["id"].(string)
	verb, _ := raw["verb"].(string)
	published, _ := raw["published"].(string)
	encKeyURL, _ := raw["encryptionKeyUrl"].(string)

	return MercuryActivity{
		ID:               id,
		Verb:             verb,
		Actor:            actor,
		Object:           object,
		Target:           target,
		Published:        published,
		EncryptionKeyURL: encKeyURL,
	}
}

func parseActor(raw interface{}) MercuryActor {
	m, _ := raw.(map[string]interface{})
	if m == nil {
		return MercuryActor{}
	}
	id, _ := m["id"].(string)
	objectType, _ := m["objectType"].(string)
	email, _ := m["emailAddress"].(string)
	return MercuryActor{ID: id, ObjectType: objectType, EmailAddress: email}
}

func parseObject(raw interface{}) MercuryObject {
	m, _ := raw.(map[string]interface{})
	if m == nil {
		return MercuryObject{}
	}
	id, _ := m["id"].(string)
	objectType, _ := m["objectType"].(string)
	displayName, _ := m["displayName"].(string)
	content, _ := m["content"].(string)
	encKeyURL, _ := m["encryptionKeyUrl"].(string)
	return MercuryObject{ID: id, ObjectType: objectType, DisplayName: displayName, Content: content, EncryptionKeyURL: encKeyURL}
}

func parseTarget(raw interface{}) MercuryTarget {
	m, _ := raw.(map[string]interface{})
	if m == nil {
		return MercuryTarget{}
	}
	id, _ := m["id"].(string)
	objectType, _ := m["objectType"].(string)
	encKeyURL, _ := m["encryptionKeyUrl"].(string)
	var tags []string
	if rawTags, ok := m["tags"].([]interface{}); ok {
		for _, t := range rawTags {
			if s, ok := t.(string); ok {
				tags = append(tags, s)
			}
		}
	}
	return MercuryTarget{ID: id, ObjectType: objectType, EncryptionKeyURL: encKeyURL, Tags: tags}
}
