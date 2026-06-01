package webexmessagehandler

import (
	"context"
	"io"
	"net/http"
)

// NetworkMode defines the networking mode for the handler.
type NetworkMode string

const (
	// NetworkModeNative uses built-in HTTP and WebSocket libraries.
	NetworkModeNative NetworkMode = "native"
	// NetworkModeInjected uses provided fetch and WebSocket factory functions.
	NetworkModeInjected NetworkMode = "injected"
)

// FetchRequest represents an HTTP request for injected fetch function.
type FetchRequest struct {
	URL     string
	Method  string
	Headers map[string]string
	Body    string
}

// FetchResponse represents an HTTP response from injected fetch function.
type FetchResponse struct {
	Status int
	OK     bool
	Body   io.ReadCloser
}

// FetchFunc is a custom fetch function for injected mode.
type FetchFunc func(ctx context.Context, req FetchRequest) (*FetchResponse, error)

// WebSocket represents a WebSocket connection interface.
type WebSocket interface {
	Send(data string) error
	Receive() (string, error)
	Close() error
	Done() <-chan struct{}
}

// WebSocketFactory creates WebSocket connections for injected mode.
type WebSocketFactory func(ctx context.Context, url string) (WebSocket, error)

// Config holds configuration for WebexMessageHandler.
type Config struct {
	// Token is the Webex bot or user access token (required).
	Token string

	// Mode is the networking mode: "native" or "injected" (default: "native").
	Mode NetworkMode

	// Logger is an optional logger implementation (silent by default).
	Logger Logger

	// HTTPClient is an optional HTTP client for proxy support (native mode only).
	// If nil, http.DefaultClient is used.
	HTTPClient *http.Client

	// Fetch is a custom fetch function for all HTTP requests (injected mode).
	Fetch FetchFunc

	// WebSocketFactory is a custom WebSocket factory (injected mode).
	WebSocketFactory WebSocketFactory

	// PingInterval is the Mercury ping interval in seconds (default: 15).
	PingInterval float64

	// PongTimeout is the pong response timeout in seconds (default: 14).
	PongTimeout float64

	// ReconnectBackoffMax is the max reconnect backoff in seconds (default: 32).
	ReconnectBackoffMax float64

	// MaxReconnectAttempts is the max consecutive reconnection attempts (default: 10).
	MaxReconnectAttempts int

	// IgnoreSelfMessages filters out messages sent by this bot to prevent loops (default: true).
	// Set to false explicitly via IgnoreSelfMessagesPtr if you need to receive bot's own messages.
	IgnoreSelfMessages *bool

	// MetricsCallback is an optional callback for receiving timing metrics (no overhead if not set).
	MetricsCallback MetricsCallback
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
	ID               string                 `json:"id"`
	ObjectType       string                 `json:"objectType"`
	DisplayName      string                 `json:"displayName,omitempty"`
	Content          string                 `json:"content,omitempty"`
	EncryptionKeyURL string                 `json:"encryptionKeyUrl,omitempty"`
	Inputs           map[string]interface{} `json:"inputs,omitempty"`
	Files            []string               `json:"files,omitempty"`
}

// MercuryTarget represents the target in a Mercury activity.
type MercuryTarget struct {
	ID               string   `json:"id"`
	ObjectType       string   `json:"objectType"`
	EncryptionKeyURL string   `json:"encryptionKeyUrl,omitempty"`
	Tags             []string `json:"tags,omitempty"`
}

// MercuryParent represents a parent activity reference for threaded replies.
type MercuryParent struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// MercuryActivity represents a conversation activity from Mercury.
type MercuryActivity struct {
	ID               string         `json:"id"`
	URL              string         `json:"url,omitempty"`
	Verb             string         `json:"verb"`
	Actor            MercuryActor   `json:"actor"`
	Object           MercuryObject  `json:"object"`
	Target           MercuryTarget  `json:"target"`
	Published        string         `json:"published"`
	EncryptionKeyURL string         `json:"encryptionKeyUrl,omitempty"`
	Parent           *MercuryParent `json:"parent,omitempty"`
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
	// ID is the Mercury activity UUID. Works as parentId for threaded replies.
	ID string

	// URL is the full Conversation-service activity URL, when present on the
	// raw Mercury activity (e.g. for an outbound "acknowledge" read-receipt).
	// Empty if Mercury did not include it.
	URL string

	// ParentID is the parent activity UUID for threaded replies. Empty if not a thread reply.
	ParentID string

	// MentionedPeople contains person UUIDs mentioned via @mention in the message.
	MentionedPeople []string

	// MentionedGroups contains group mention types (e.g. "all") in the message.
	MentionedGroups []string

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

	// Files contains file URLs attached to the message.
	Files []string

	// Raw is the full decrypted activity for advanced use.
	Raw *MercuryActivity
}

// DeletedMessage represents a deleted Webex message notification.
type DeletedMessage struct {
	MessageID string
	RoomID    string
	PersonID  string
}

// MembershipActivity represents a membership event from Mercury.
type MembershipActivity struct {
	// ID is the activity ID.
	ID string

	// ActorID is the ID of the person who performed the action.
	ActorID string

	// PersonID is the ID of the member affected.
	PersonID string

	// RoomID is the conversation/space ID.
	RoomID string

	// Action is the membership action: "add", "leave", "assignModerator", or "unassignModerator".
	Action string

	// Created is the ISO 8601 timestamp.
	Created string

	// RoomType is "direct", "group", or empty.
	RoomType string

	// Raw is the full raw activity for advanced use.
	Raw *MercuryActivity
}

// AttachmentAction represents an adaptive card submission from Mercury.
type AttachmentAction struct {
	// ID is the activity ID.
	ID string

	// MessageID is the ID of the message the card was attached to.
	MessageID string

	// PersonID is the ID of the person who submitted the card.
	PersonID string

	// PersonEmail is the email of the person who submitted the card.
	PersonEmail string

	// RoomID is the conversation/space ID.
	RoomID string

	// Inputs contains the card form input values.
	Inputs map[string]interface{}

	// Created is the ISO 8601 timestamp.
	Created string

	// Raw is the full raw activity for advanced use.
	Raw *MercuryActivity
}

// RoomActivity represents a room event from Mercury.
type RoomActivity struct {
	// ID is the activity ID.
	ID string

	// RoomID is the conversation/space ID.
	RoomID string

	// ActorID is the ID of the person who performed the action.
	ActorID string

	// Action is the room action: "created" or "updated".
	Action string

	// Created is the ISO 8601 timestamp.
	Created string

	// Raw is the full raw activity for advanced use.
	Raw *MercuryActivity
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

// MetricsEvent is a timing metric event.
type MetricsEvent struct {
	// Name is the metric name: "connect", "kms_fetch", or "decrypt".
	Name string

	// DurationMs is the duration in milliseconds.
	DurationMs float64

	// Success indicates whether the operation succeeded.
	Success bool

	// Metadata is optional context (e.g., key URI for kms_fetch).
	Metadata map[string]string
}

// MetricsCallback is a callback function for receiving metrics events.
type MetricsCallback func(event MetricsEvent)
