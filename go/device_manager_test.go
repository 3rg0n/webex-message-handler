package webexmessagehandler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// emptyDeviceList writes a WDM device-list response with no devices, so
// Register() finds nothing to reuse and falls through to POST-create.
func emptyDeviceList(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(wdmDeviceListResponse{Devices: []wdmDeviceResponse{}})
}

func TestDeviceManagerRegisterSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			emptyDeviceList(w)
			return
		}
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			t.Errorf("expected Bearer test-token, got %q", auth)
		}

		resp := wdmDeviceResponse{
			WebSocketURL: "wss://mercury-connection-a2.wbx2.com/ws",
			URL:          "https://wdm-a.wbx2.com/devices/123",
			UserID:       "user-123",
			Services: map[string]string{
				"encryptionServiceUrl": "https://encryption-a.wbx2.com/encryption/api/v1",
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
	reg, err := dm.Register(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if reg.WebSocketURL != "wss://mercury-connection-a2.wbx2.com/ws" {
		t.Errorf("expected wss://mercury-connection-a2.wbx2.com/ws, got %q", reg.WebSocketURL)
	}
	if reg.DeviceURL != "https://wdm-a.wbx2.com/devices/123" {
		t.Errorf("expected https://wdm-a.wbx2.com/devices/123, got %q", reg.DeviceURL)
	}
	if reg.UserID != "user-123" {
		t.Errorf("expected user-123, got %q", reg.UserID)
	}
	if reg.EncryptionServiceURL != "https://encryption-a.wbx2.com/encryption/api/v1" {
		t.Errorf("expected https://encryption-a.wbx2.com/encryption/api/v1, got %q", reg.EncryptionServiceURL)
	}
}

func TestDeviceManagerRegister401(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			// List also 401s; Register should surface the POST 401.
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(401)
	}))
	defer server.Close()

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
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
		if r.Method == http.MethodGet {
			emptyDeviceList(w)
			return
		}
		w.WriteHeader(500)
	}))
	defer server.Close()

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
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
	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
	_, err := dm.Refresh(context.Background(), "test-token")
	if err == nil {
		t.Fatal("expected error when not registered")
	}
}

func TestDeviceManagerUnregisterNotRegistered(t *testing.T) {
	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
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
		if r.Method == http.MethodGet {
			emptyDeviceList(w)
			return
		}
		// Register endpoint (POST)
		resp := wdmDeviceResponse{
			WebSocketURL: "wss://mercury-connection-a2.wbx2.com/ws",
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

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
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
		if r.Method == http.MethodGet {
			emptyDeviceList(w)
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

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
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
		if r.Method == http.MethodGet {
			emptyDeviceList(w)
			return
		}
		resp := wdmDeviceResponse{
			WebSocketURL: "wss://mercury-connection-a2.wbx2.com/ws",
			URL:          "https://wdm-a.wbx2.com/devices/123",
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

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
	reg, err := dm.Register(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reg.EncryptionServiceURL != "" {
		t.Errorf("expected empty EncryptionServiceURL, got %q", reg.EncryptionServiceURL)
	}
}

// TestDeviceManagerReusesExistingDevice verifies that when a device matching
// our name+deviceType already exists, Register refreshes it (PUT) instead of
// creating a new one (POST) — the core fix for the device-leak issue (#26).
func TestDeviceManagerReusesExistingDevice(t *testing.T) {
	var serverURL string
	var mu sync.Mutex
	postCount, putCount := 0, 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(wdmDeviceListResponse{Devices: []wdmDeviceResponse{{
				WebSocketURL: "wss://mercury-connection-a2.wbx2.com/ws",
				URL:          serverURL + "/devices/existing",
				UserID:       "user-123",
				Name:         deviceBody["name"],
				DeviceType:   deviceBody["deviceType"],
				Services:     map[string]string{},
			}}})
		case http.MethodPut:
			mu.Lock()
			putCount++
			mu.Unlock()
			resp := wdmDeviceResponse{
				WebSocketURL: "wss://mercury-connection-a2.wbx2.com/ws",
				URL:          serverURL + "/devices/existing",
				UserID:       "user-123",
				Services:     map[string]string{},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
		case http.MethodPost:
			mu.Lock()
			postCount++
			mu.Unlock()
			w.WriteHeader(500) // should never be reached
		}
	}))
	defer server.Close()
	serverURL = server.URL

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
	reg, err := dm.Register(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if reg.DeviceURL != serverURL+"/devices/existing" {
		t.Errorf("expected reused device URL, got %q", reg.DeviceURL)
	}

	mu.Lock()
	defer mu.Unlock()
	if putCount != 1 {
		t.Errorf("expected exactly 1 PUT (refresh), got %d", putCount)
	}
	if postCount != 0 {
		t.Errorf("expected 0 POST (no new device), got %d", postCount)
	}
}

// TestDeviceManagerReapsOnExcessiveRegistrations verifies that a 403 on create
// triggers reaping of this client's own devices followed by a single retry.
func TestDeviceManagerReapsOnExcessiveRegistrations(t *testing.T) {
	var serverURL string
	var mu sync.Mutex
	postCount, deleteCount := 0, 0

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// First list (reuse check): empty so we go to POST.
			// Second list (reap): return our own devices to delete.
			mu.Lock()
			pc := postCount
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			if pc == 0 {
				json.NewEncoder(w).Encode(wdmDeviceListResponse{Devices: []wdmDeviceResponse{}})
			} else {
				json.NewEncoder(w).Encode(wdmDeviceListResponse{Devices: []wdmDeviceResponse{{
					URL:        serverURL + "/devices/old",
					Name:       deviceBody["name"],
					DeviceType: deviceBody["deviceType"],
				}}})
			}
		case http.MethodDelete:
			mu.Lock()
			deleteCount++
			mu.Unlock()
			w.WriteHeader(204)
		case http.MethodPost:
			mu.Lock()
			postCount++
			first := postCount == 1
			mu.Unlock()
			if first {
				w.WriteHeader(403) // excessive registrations
				return
			}
			resp := wdmDeviceResponse{
				WebSocketURL: "wss://mercury-connection-a2.wbx2.com/ws",
				URL:          serverURL + "/devices/new",
				UserID:       "user-123",
				Services:     map[string]string{},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
		}
	}))
	defer server.Close()
	serverURL = server.URL

	origBase := wdmAPIBase
	defer func() { setWdmAPIBase(origBase) }()
	setWdmAPIBase(server.URL)

	dm := NewDeviceManager(NoopLogger(), createTestHTTPAdapter(nil))
	reg, err := dm.Register(context.Background(), "test-token")
	if err != nil {
		t.Fatalf("unexpected error after reap+retry: %v", err)
	}
	if reg.DeviceURL != serverURL+"/devices/new" {
		t.Errorf("expected new device URL after retry, got %q", reg.DeviceURL)
	}

	mu.Lock()
	defer mu.Unlock()
	if deleteCount != 1 {
		t.Errorf("expected 1 reap DELETE, got %d", deleteCount)
	}
	if postCount != 2 {
		t.Errorf("expected 2 POSTs (initial 403 + retry), got %d", postCount)
	}
}
