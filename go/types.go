package webexmessagehandler

import "net/http"

// Config holds configuration for WebexMessageHandler.
type Config struct {
	// Token is the Webex bot or user access token (required).
	Token string

	// Logger is an optional logger implementation (silent by default).
	Logger Logger

	// HTTPClient is an optional HTTP client for proxy support or custom connection handling.
	// If nil, http.DefaultClient is used.
	HTTPClient *http.Client

	// PingInterval is the Mercury ping interval in seconds (default: 15).
	PingInterval float64

	// PongTimeout is the pong response timeout in seconds (default: 14).
	PongTimeout float64

	// ReconnectBackoffMax is the max reconnect backoff in seconds (default: 32).
	ReconnectBackoffMax float64

	// MaxReconnectAttempts is the max consecutive reconnection attempts (default: 10).
	MaxReconnectAttempts int
}

// DeviceRegistration holds the result of WDM device registration.
type DeviceRegistration struct {
	// WebSocketURL is the Mercury WebSocket URL.
	WebSocketURL string `json:"webSocketUrl"`

	// DeviceURL is the device URL (used as clientId for KMS).
	DeviceURL string `json:"url"`

	// UserID is the bot's user ID.
	UserID string `json:"userId"`

	// Services is the service catalog from WDM.
	Services map[string]string `json:"services"`

	// EncryptionServiceURL is extracted from Services.
	EncryptionServiceURL string `json:"-"`
}

// MercuryActor represents the actor in a Mercury activity.
type MercuryActor struct {
	ID           string `json:"id"`
	ObjectType   string `json:"objectType"`
	EmailAddress string `json:"emailAddress,omitempty"`
}

// MercuryObject represents the object in a Mercury activity.
type MercuryObject struct {
	ID               string `json:"id"`
	ObjectType       string `json:"objectType"`
	DisplayName      string `json:"displayName,omitempty"`
	Content          string `json:"content,omitempty"`
	EncryptionKeyURL string `json:"encryptionKeyUrl,omitempty"`
}

// MercuryTarget represents the target in a Mercury activity.
type MercuryTarget struct {
	ID               string   `json:"id"`
	ObjectType       string   `json:"objectType"`
	EncryptionKeyURL string   `json:"encryptionKeyUrl,omitempty"`
	Tags             []string `json:"tags,omitempty"`
}

// MercuryActivity represents a conversation activity from Mercury.
type MercuryActivity struct {
	ID               string        `json:"id"`
	Verb             string        `json:"verb"`
	Actor            MercuryActor  `json:"actor"`
	Object           MercuryObject `json:"object"`
	Target           MercuryTarget `json:"target"`
	Published        string        `json:"published"`
	EncryptionKeyURL string        `json:"encryptionKeyUrl,omitempty"`
}

// MercuryEnvelope is the wire format envelope from Mercury WebSocket.
type MercuryEnvelope struct {
	ID             string                 `json:"id"`
	Data           map[string]interface{} `json:"data"`
	Timestamp      int64                  `json:"timestamp"`
	TrackingID     string                 `json:"trackingId"`
	SequenceNumber *int64                 `json:"sequenceNumber,omitempty"`
}

// DecryptedMessage is a decrypted Webex message.
type DecryptedMessage struct {
	// ID is the unique message ID.
	ID string

	// RoomID is the conversation/space ID.
	RoomID string

	// PersonID is the sender's user ID.
	PersonID string

	// PersonEmail is the sender's email address.
	PersonEmail string

	// Text is the decrypted plain text.
	Text string

	// HTML is the decrypted HTML content (rich text messages).
	HTML string

	// Created is the ISO 8601 timestamp.
	Created string

	// RoomType is "direct", "group", or empty.
	RoomType string

	// Raw is the full decrypted activity for advanced use.
	Raw *MercuryActivity
}

// DeletedMessage represents a deleted Webex message notification.
type DeletedMessage struct {
	MessageID string
	RoomID    string
	PersonID  string
}

// ConnectionStatus represents the overall connection state.
type ConnectionStatus string

const (
	StatusConnected    ConnectionStatus = "connected"
	StatusConnecting   ConnectionStatus = "connecting"
	StatusReconnecting ConnectionStatus = "reconnecting"
	StatusDisconnected ConnectionStatus = "disconnected"
)

// HandlerStatus is a structured health check of all connection subsystems.
type HandlerStatus struct {
	// Status is the overall connection state.
	Status ConnectionStatus

	// WebSocketOpen indicates whether the Mercury WebSocket is currently open.
	WebSocketOpen bool

	// KmsInitialized indicates whether the KMS encryption context has been established.
	KmsInitialized bool

	// DeviceRegistered indicates whether the device is registered with WDM.
	DeviceRegistered bool

	// ReconnectAttempt is the current auto-reconnect attempt number (0 if not reconnecting).
	ReconnectAttempt int
}
