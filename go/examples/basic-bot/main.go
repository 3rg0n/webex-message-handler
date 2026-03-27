package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	webex "github.com/3rg0n/webex-message-handler/go"
)

func main() {
	token := os.Getenv("WEBEX_BOT_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "Set WEBEX_BOT_TOKEN environment variable")
		os.Exit(1)
	}

	handler, err := webex.New(webex.Config{
		Token:  token,
		Logger: webex.NewSlogLogger(slog.Default()),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create handler: %v\n", err)
		os.Exit(1)
	}

	handler.OnMessageCreated(func(msg webex.DecryptedMessage) {
		fmt.Printf("[%s] %s\n", msg.PersonEmail, msg.Text)
		if msg.HTML != "" {
			fmt.Printf("  HTML: %s\n", msg.HTML)
		}
	})

	handler.OnMessageDeleted(func(data webex.DeletedMessage) {
		fmt.Printf("Message %s deleted by %s\n", data.MessageID, data.PersonID)
	})

	handler.OnConnected(func() {
		fmt.Println("Connected to Webex")
	})

	handler.OnDisconnected(func(reason string) {
		fmt.Printf("Disconnected: %s\n", reason)
	})

	handler.OnReconnecting(func(attempt int) {
		fmt.Printf("Reconnecting (attempt %d)...\n", attempt)
	})

	handler.OnError(func(err error) {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigCh
		fmt.Println("Shutting down...")
		_ = handler.Disconnect(ctx)
		cancel()
	}()

	if err := handler.Connect(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to connect: %v\n", err)
		os.Exit(1)
	}

	<-ctx.Done()
}
