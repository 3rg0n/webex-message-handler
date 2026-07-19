package webexmessagehandler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestNativeWSAdapterSendsAuthHeader verifies the native WebSocket dial presents
// the access token on the upgrade request's Authorization header. Mercury binds
// live conversation.activity delivery to this identity, so its absence is the
// root cause of a socket that authorizes but receives no activities (issue #27).
func TestNativeWSAdapterSendsAuthHeader(t *testing.T) {
	gotAuth := make(chan string, 1)

	// A plain HTTP server is enough: we only need to observe the upgrade
	// request headers. We intentionally do NOT complete the WS handshake.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth <- r.Header.Get("Authorization")
		http.Error(w, "not switching protocols", http.StatusBadRequest)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	factory := createNativeWSAdapter(http.DefaultClient, func() string { return "test-token" })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Dial is expected to fail the handshake (server returns 400); we only care
	// that the Authorization header was sent on the upgrade request.
	_, _ = factory(ctx, wsURL)

	select {
	case auth := <-gotAuth:
		if auth != "Bearer test-token" {
			t.Errorf("expected upgrade request Authorization %q, got %q", "Bearer test-token", auth)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("dial did not reach the server")
	}
}

// TestNativeWSAdapterNoTokenNoHeader verifies that with no token available the
// adapter omits the Authorization header rather than sending "Bearer ".
func TestNativeWSAdapterNoTokenNoHeader(t *testing.T) {
	gotAuth := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth <- r.Header.Get("Authorization")
		http.Error(w, "not switching protocols", http.StatusBadRequest)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	factory := createNativeWSAdapter(http.DefaultClient, func() string { return "" })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = factory(ctx, wsURL)

	select {
	case auth := <-gotAuth:
		if auth != "" {
			t.Errorf("expected no Authorization header, got %q", auth)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("dial did not reach the server")
	}
}
