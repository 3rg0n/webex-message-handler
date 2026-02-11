# webex-message-handler-go

Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages — no Webex SDK required.

Go port of the [TypeScript webex-message-handler](https://github.com/ecopelan/webex-message-handler).

## Install

```bash
go get github.com/ecopelan/webex-message-handler-go
```

Requires Go 1.21+.

## Quick Start

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	webex "github.com/ecopelan/webex-message-handler-go"
)

func main() {
	handler, err := webex.New(webex.Config{
		Token:  os.Getenv("WEBEX_BOT_TOKEN"),
		Logger: webex.NewSlogLogger(slog.Default()),
	})
	if err != nil {
		panic(err)
	}

	handler.OnMessageCreated(func(msg webex.DecryptedMessage) {
		fmt.Printf("[%s] %s\n", msg.PersonEmail, msg.Text)
	})

	handler.OnError(func(err error) {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
	})

	if err := handler.Connect(context.Background()); err != nil {
		panic(err)
	}

	select {} // block forever
}
```

## API

### `New(cfg Config) (*WebexMessageHandler, error)`

Creates a new handler. Config fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `Token` | `string` | required | Webex bot access token |
| `Logger` | `Logger` | noop | Logger implementation |
| `PingInterval` | `float64` | `15` | Ping interval (seconds) |
| `PongTimeout` | `float64` | `14` | Pong timeout (seconds) |
| `ReconnectBackoffMax` | `float64` | `32` | Max reconnect backoff (seconds) |
| `MaxReconnectAttempts` | `int` | `10` | Max reconnect attempts |

### Methods

- `Connect(ctx) error` — Connect to Webex
- `Disconnect(ctx) error` — Graceful disconnect
- `Reconnect(ctx, newToken) error` — Update token and reconnect
- `Connected() bool` — Connection status
- `Status() HandlerStatus` — Health check

### Event Callbacks

```go
handler.OnMessageCreated(func(msg DecryptedMessage) { ... })
handler.OnMessageDeleted(func(data DeletedMessage) { ... })
handler.OnConnected(func() { ... })
handler.OnDisconnected(func(reason string) { ... })
handler.OnReconnecting(func(attempt int) { ... })
handler.OnError(func(err error) { ... })
```

### Error Types

- `AuthError` — Token invalid/expired
- `DeviceRegistrationError` — WDM operations failed (has `.StatusCode`)
- `MercuryConnectionError` — WebSocket failed (has `.CloseCode`)
- `KmsError` — KMS operations failed
- `DecryptionError` — Message decryption failed

All implement `error` and extend `WebexError`. Use `errors.As()` for type checking.

## Architecture

```
WebexMessageHandler (orchestrator)
├── DeviceManager    — WDM registration
├── MercurySocket    — WebSocket + ping/pong + reconnect (goroutines)
├── KmsClient        — ECDH handshake + key retrieval
└── MessageDecryptor — JWE decryption
```

## License

MIT
