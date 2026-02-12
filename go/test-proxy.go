//go:build ignore

// Proxy validation test via mitmproxy.
// Run with: WEBEX_BOT_TOKEN=... go run test-proxy.go
// Requires mitmproxy running on localhost:8080.
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"time"

	webex "github.com/3rg0n/webex-message-handler/go"
)

func main() {
	token := os.Getenv("WEBEX_BOT_TOKEN")
	if token == "" {
		fmt.Println("Error: WEBEX_BOT_TOKEN environment variable not set")
		os.Exit(1)
	}

	proxyURL := os.Getenv("HTTPS_PROXY")
	if proxyURL == "" {
		proxyURL = "http://localhost:8080"
	}
	fmt.Printf("\n=== Webex Proxy Test (Go) ===\n")
	fmt.Printf("Using proxy: %s\n\n", proxyURL)

	proxy, err := url.Parse(proxyURL)
	if err != nil {
		fmt.Printf("Error parsing proxy URL: %v\n", err)
		os.Exit(1)
	}

	// Create HTTP client that routes through mitmproxy
	httpClient := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(proxy),
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true, // Trust mitmproxy's CA
			},
		},
	}

	handler, err := webex.New(webex.Config{
		Token:      token,
		HTTPClient: httpClient,
		Logger:     webex.NewSlogLogger(slog.Default()),
	})
	if err != nil {
		fmt.Printf("Error creating handler: %v\n", err)
		os.Exit(1)
	}

	connected := make(chan struct{})
	handler.OnConnected(func() {
		fmt.Println("\nSUCCESS: Connected through proxy!")
		fmt.Println("   - Device registered")
		fmt.Println("   - Mercury WebSocket connected")
		fmt.Println("   - KMS initialized")
		close(connected)
	})

	handler.OnError(func(err error) {
		fmt.Printf("\nERROR: %v\n", err)
	})

	fmt.Println("Connecting to Webex through proxy...")
	ctx := context.Background()
	if err := handler.Connect(ctx); err != nil {
		fmt.Printf("FAILED: %v\n", err)
		os.Exit(1)
	}

	select {
	case <-connected:
	case <-time.After(30 * time.Second):
		fmt.Println("FAILED: Timeout waiting for connection")
		os.Exit(1)
	}

	time.Sleep(3 * time.Second)
	fmt.Println("\nProxy validation complete - disconnecting...")
	handler.Disconnect(ctx)
	fmt.Println("SUCCESS: Go proxy test passed\n")
}
