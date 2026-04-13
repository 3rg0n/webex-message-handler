# webex-message-handler-go

Lightweight Webex Mercury WebSocket + KMS decryption for receiving bot messages — no Webex SDK required.

Go port of the [TypeScript webex-message-handler](https://github.com/ecopelan/webex-message-handler).

## Install

```bash
go get github.com/3rg0n/webex-message-handler/go
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

	webex "github.com/3rg0n/webex-message-handler/go"
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

## Important: Implementing Loop Detection

This library only handles the **receive side** of messaging — it decrypts incoming messages from the Mercury WebSocket. It has no visibility into messages your bot **sends** via the REST API. This means it cannot detect message loops on its own.

If your bot replies to incoming messages, you **must** implement loop detection in your wrapper code. Without it, a bug or misconfiguration could cause your bot to endlessly reply to its own messages. Webex enforces a server-side rate limit (approximately 11 consecutive messages before throttling), but that still results in spam before the cutoff.

**Recommended approach:** Track your bot's outgoing message rate. If it exceeds a threshold (e.g., 5 messages in 3 seconds to the same room), pause sending and log a warning.

The `IgnoreSelfMessages` option (default: `true`) provides a first line of defense by filtering out messages sent by this bot's own identity. If the library cannot verify the bot's identity during `Connect()` (e.g., `/people/me` API failure), connection will fail rather than silently running without protection. Set `IgnoreSelfMessages` to `false` to opt out, but only if you have your own loop prevention in place.

## Proxy Support (Enterprise)

For corporate environments behind a proxy, pass a configured HTTP client:

```go
package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"

	webex "github.com/3rg0n/webex-message-handler/go"
)

func main() {
	// Configure proxy
	var httpClient *http.Client
	if proxyURL := os.Getenv("HTTPS_PROXY"); proxyURL != "" {
		proxy, _ := url.Parse(proxyURL)
		httpClient = &http.Client{
			Transport: &http.Transport{
				Proxy: http.ProxyURL(proxy),
			},
		}
	}

	handler, err := webex.New(webex.Config{
		Token:      os.Getenv("WEBEX_BOT_TOKEN"),
		HTTPClient: httpClient, // Pass configured client
	})
	if err != nil {
		panic(err)
	}

	// ... set up callbacks and connect
}
```

## Threading & Message IDs

Mercury uses raw activity UUIDs while the Webex REST API uses base64-encoded IDs. Use the conversion utilities to bridge them:

```go
// Convert Mercury UUID to REST API ID for GET requests
restID := webexmessagehandler.ToRestID(msg.ID, "MESSAGE")

// Thread replies: msg.ParentID contains the parent activity UUID
if msg.ParentID != "" {
    // Use msg.ParentID as parentId in POST /v1/messages
}

// Reverse: REST API ID back to UUID
uuid, err := webexmessagehandler.FromRestID(restID)
```

Resource types: `"MESSAGE"`, `"PEOPLE"`, `"ROOM"`.

## API

### `New(cfg Config) (*WebexMessageHandler, error)`

Creates a new handler. Config fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `Token` | `string` | required | Webex bot access token |
| `Logger` | `Logger` | noop | Logger implementation |
| `IgnoreSelfMessages` | `*bool` | `true` | Filter out messages sent by this bot |
| `HTTPClient` | `*http.Client` | `http.DefaultClient` | HTTP client for proxy support |
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
