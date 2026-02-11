# webex-message-handler-go API Reference

Lightweight Go package for receiving and decrypting Webex messages over Mercury WebSocket. No full Webex SDK required.

## Installation

```bash
go get github.com/ecopelan/webex-message-handler-go
```

## Quick Start

```go
handler, _ := webexmessagehandler.New(webexmessagehandler.Config{
    Token:  os.Getenv("WEBEX_BOT_TOKEN"),
    Logger: webexmessagehandler.NewSlogLogger(slog.Default()),
})

handler.OnMessageCreated(func(msg webexmessagehandler.DecryptedMessage) {
    fmt.Printf("[%s] %s\n", msg.PersonEmail, msg.Text)
})

handler.Connect(ctx)
```

---

## Config

```go
type Config struct {
    Token                string  // Required: Webex access token
    Logger               Logger  // Optional: logger (silent by default)
    PingInterval         float64 // Optional: ping interval in seconds (default: 15)
    PongTimeout          float64 // Optional: pong timeout in seconds (default: 14)
    ReconnectBackoffMax  float64 // Optional: max reconnect backoff in seconds (default: 32)
    MaxReconnectAttempts int     // Optional: max reconnect attempts (default: 10)
}
```

## WebexMessageHandler

### Constructor

```go
handler, err := webexmessagehandler.New(cfg Config)
```

### Methods

#### `Connect(ctx context.Context) error`

Establishes the connection: device registration, Mercury WebSocket, KMS ECDH handshake.

#### `Disconnect(ctx context.Context) error`

Tears down the connection: closes WebSocket, unregisters device, clears KMS context.

#### `Reconnect(ctx context.Context, newToken string) error`

Updates the token and re-establishes the connection from scratch.

#### `Connected() bool`

Returns whether the handler is fully connected.

#### `Status() HandlerStatus`

Returns structured health check.

```go
type HandlerStatus struct {
    Status           ConnectionStatus // "connected", "connecting", "reconnecting", "disconnected"
    WebSocketOpen    bool
    KmsInitialized   bool
    DeviceRegistered bool
    ReconnectAttempt int
}
```

### Event Callbacks

```go
handler.OnMessageCreated(func(msg DecryptedMessage) { ... })
handler.OnMessageDeleted(func(data DeletedMessage) { ... })
handler.OnConnected(func() { ... })
handler.OnDisconnected(func(reason string) { ... })
handler.OnReconnecting(func(attempt int) { ... })
handler.OnError(func(err error) { ... })
```

---

## Types

### DecryptedMessage

```go
type DecryptedMessage struct {
    ID          string           // Unique message ID
    RoomID      string           // Conversation/space ID
    PersonID    string           // Sender's user ID
    PersonEmail string           // Sender's email
    Text        string           // Decrypted plain text
    HTML        string           // Decrypted HTML content
    Created     string           // ISO 8601 timestamp
    RoomType    string           // "direct", "group", or ""
    Raw         *MercuryActivity // Full decrypted activity
}
```

### DeletedMessage

```go
type DeletedMessage struct {
    MessageID string
    RoomID    string
    PersonID  string
}
```

---

## Error Types

All errors embed `WebexError` and implement the `error` interface. Use `errors.As()` for type matching.

| Type | Code | When |
|------|------|------|
| `AuthError` | `AUTH_ERROR` | Token invalid or expired |
| `DeviceRegistrationError` | `DEVICE_REGISTRATION_ERROR` | WDM operations failed |
| `MercuryConnectionError` | `MERCURY_CONNECTION_ERROR` | WebSocket failed |
| `KmsError` | `KMS_ERROR` | KMS operations failed |
| `DecryptionError` | `DECRYPTION_ERROR` | Message decryption failed |

```go
var authErr *webexmessagehandler.AuthError
if errors.As(err, &authErr) {
    // Handle auth failure
}
```

---

## Logger

The `Logger` interface requires four methods:

```go
type Logger interface {
    Debug(msg string, args ...any)
    Info(msg string, args ...any)
    Warn(msg string, args ...any)
    Error(msg string, args ...any)
}
```

Built-in implementations:

| Function | Behavior |
|----------|----------|
| `NoopLogger()` | Silent (default) |
| `NewSlogLogger(l)` | Wraps `*slog.Logger` |

---

## Disconnection Reasons

| Reason | Meaning |
|--------|---------|
| `"client"` | You called `Disconnect()` |
| `"auth-failed"` | Token invalid (code 4401) |
| `"permanent-failure"` | Server rejected (4400/4403) |
| `"max-attempts-exceeded"` | Auto-reconnect gave up |
| `"manual"` | WebSocket closed, no reconnect |
