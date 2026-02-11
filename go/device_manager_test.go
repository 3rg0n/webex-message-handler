package webexmessagehandler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeviceManagerRegisterSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			t.Errorf("expected Bearer test-token, got %q", auth)
		}

		resp := wdmDeviceResponse{
			WebSocketURL: "wss://mercury.example.com/ws",
			URL:          "https://wdm.example.com/devices/123",
			UserID:       "user-123",
			Services: map[string]string{
				"encryptionServiceUrl": "https://encryption.example.com",
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	// Temporarily override the WDM base URL
	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), nil)
	reg, err := dm.Register(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if reg.WebSocketURL != "wss://mercury.example.com/ws" {
		t.Errorf("expected wss://mercury.example.com/ws, got %q", reg.WebSocketURL)
	}
	if reg.DeviceURL != "https://wdm.example.com/devices/123" {
		t.Errorf("expected https://wdm.example.com/devices/123, got %q", reg.DeviceURL)
	}
	if reg.UserID != "user-123" {
		t.Errorf("expected user-123, got %q", reg.UserID)
	}
	if reg.EncryptionServiceURL != "https://encryption.example.com" {
		t.Errorf("expected https://encryption.example.com, got %q", reg.EncryptionServiceURL)
	}
}

func TestDeviceManagerRegister401(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer server.Close()

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), nil)
	_, err := dm.Register(context.Background(), "bad-token")
	if err == nil {
		t.Fatal("expected error for 401")
	}
	authErr, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("expected *AuthError, got %T", err)
	}
	if authErr.Code != "AUTH_ERROR" {
		t.Errorf("expected AUTH_ERROR, got %q", authErr.Code)
	}
}

func TestDeviceManagerRegister500(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer server.Close()

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), nil)
	_, err := dm.Register(context.Background(), "test-token")
	if err == nil {
		t.Fatal("expected error for 500")
	}
	devErr, ok := err.(*DeviceRegistrationError)
	if !ok {
		t.Fatalf("expected *DeviceRegistrationError, got %T", err)
	}
	if devErr.StatusCode != 500 {
		t.Errorf("expected 500, got %d", devErr.StatusCode)
	}
}

func TestDeviceManagerRefreshNotRegistered(t *testing.T) {
	dm := NewDeviceManager(NoopLogger(), nil)
	_, err := dm.Refresh(context.Background(), "test-token")
	if err == nil {
		t.Fatal("expected error when not registered")
	}
}

func TestDeviceManagerUnregisterNotRegistered(t *testing.T) {
	dm := NewDeviceManager(NoopLogger(), nil)
	err := dm.Unregister(context.Background(), "test-token")
	if err == nil {
		t.Fatal("expected error when not registered")
	}
}

func TestDeviceManagerUnregisterSuccess(t *testing.T) {
	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/devices/123" && r.Method == http.MethodDelete {
			w.WriteHeader(200)
			return
		}
		// Register endpoint
		resp := wdmDeviceResponse{
			WebSocketURL: "wss://mercury.example.com/ws",
			URL:          serverURL + "/devices/123",
			UserID:       "user-123",
			Services:     map[string]string{},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()
	serverURL = server.URL

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), nil)
	_, err := dm.Register(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected register error: %v", err)
	}

	err = dm.Unregister(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected unregister error: %v", err)
	}
}

func TestDeviceManagerUnregister401(t *testing.T) {
	var serverURL string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(401)
			return
		}
		resp := wdmDeviceResponse{
			URL:      serverURL + "/devices/123",
			Services: map[string]string{},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()
	serverURL = server.URL

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), nil)
	dm.Register(context.Background(), "test-token")

	err := dm.Unregister(context.Background(), "test-token")
	if err == nil {
		t.Fatal("expected error for 401")
	}
	_, ok := err.(*AuthError)
	if !ok {
		t.Fatalf("expected *AuthError, got %T", err)
	}
}

func TestDeviceManagerEmptyServices(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := wdmDeviceResponse{
			WebSocketURL: "wss://mercury.example.com/ws",
			URL:          "https://wdm.example.com/devices/123",
			UserID:       "user-123",
			// No services
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), nil)
	reg, err := dm.Register(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reg.EncryptionServiceURL != "" {
		t.Errorf("expected empty EncryptionServiceURL, got %q", reg.EncryptionServiceURL)
	}
}
