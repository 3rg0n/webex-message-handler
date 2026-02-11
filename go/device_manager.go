package webexmessagehandler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

var wdmAPIBase = "https://wdm-a.wbx2.com/wdm/api/v1/devices"

// setWdmAPIBase overrides the WDM API base URL (used in tests).
func setWdmAPIBase(url string) { wdmAPIBase = url }

var deviceBody = map[string]string{
	"deviceName":     "webex-message-handler",
	"deviceType":     "DESKTOP",
	"localizedModel": "go",
	"model":          "go",
	"name":           "webex-message-handler",
	"systemName":     "webex-message-handler",
	"systemVersion":  "1.0.0",
}

// DeviceManager manages WDM device registration lifecycle.
type DeviceManager struct {
	logger     Logger
	httpClient *http.Client
	deviceURL  string
}

// NewDeviceManager creates a new DeviceManager.
func NewDeviceManager(logger Logger, httpClient *http.Client) *DeviceManager {
	if logger == nil {
		logger = NoopLogger()
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &DeviceManager{
		logger:     logger,
		httpClient: httpClient,
	}
}

// Register registers a new device with WDM.
func (dm *DeviceManager) Register(ctx context.Context, token string) (*DeviceRegistration, error) {
	dm.logger.Debug("Registering device with WDM")

	bodyBytes, err := json.Marshal(deviceBody)
	if err != nil {
		return nil, NewDeviceRegistrationError("Failed to marshal device body", 0)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, wdmAPIBase, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, NewDeviceRegistrationError("Failed to create request", 0)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := dm.httpClient.Do(req)
	if err != nil {
		dm.logger.Error(fmt.Sprintf("Device registration error: %v", err))
		return nil, NewDeviceRegistrationError("Failed to register device", 0)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		dm.logger.Error("Device registration failed: Unauthorized")
		return nil, NewAuthError("Unauthorized to register device")
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		dm.logger.Error(fmt.Sprintf("Device registration failed with status %d", resp.StatusCode))
		return nil, NewDeviceRegistrationError("Failed to register device", resp.StatusCode)
	}

	var data wdmDeviceResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, NewDeviceRegistrationError("Failed to parse device response", 0)
	}

	dm.deviceURL = data.URL
	reg := dm.parseDeviceResponse(&data)
	dm.logger.Info("Device registered successfully")
	return reg, nil
}

// Refresh refreshes an existing device registration.
func (dm *DeviceManager) Refresh(ctx context.Context, token string) (*DeviceRegistration, error) {
	if dm.deviceURL == "" {
		return nil, NewDeviceRegistrationError("Device not registered. Call Register() first.", 0)
	}

	dm.logger.Debug("Refreshing device registration")

	bodyBytes, err := json.Marshal(deviceBody)
	if err != nil {
		return nil, NewDeviceRegistrationError("Failed to marshal device body", 0)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, dm.deviceURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, NewDeviceRegistrationError("Failed to create request", 0)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := dm.httpClient.Do(req)
	if err != nil {
		dm.logger.Error(fmt.Sprintf("Device refresh error: %v", err))
		return nil, NewDeviceRegistrationError("Failed to refresh device", 0)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 {
		dm.logger.Error("Device refresh failed: Unauthorized")
		return nil, NewAuthError("Unauthorized to refresh device")
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		dm.logger.Error(fmt.Sprintf("Device refresh failed with status %d", resp.StatusCode))
		return nil, NewDeviceRegistrationError("Failed to refresh device", resp.StatusCode)
	}

	var data wdmDeviceResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, NewDeviceRegistrationError("Failed to parse device response", 0)
	}

	reg := dm.parseDeviceResponse(&data)
	dm.logger.Info("Device refreshed successfully")
	return reg, nil
}

// Unregister unregisters the device from WDM.
func (dm *DeviceManager) Unregister(ctx context.Context, token string) error {
	if dm.deviceURL == "" {
		return NewDeviceRegistrationError("Device not registered. Call Register() first.", 0)
	}

	dm.logger.Debug("Unregistering device")

	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, dm.deviceURL, nil)
	if err != nil {
		return NewDeviceRegistrationError("Failed to create request", 0)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := dm.httpClient.Do(req)
	if err != nil {
		dm.logger.Error(fmt.Sprintf("Device unregistration error: %v", err))
		return NewDeviceRegistrationError("Failed to unregister device", 0)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if resp.StatusCode == 401 {
		dm.logger.Error("Device unregistration failed: Unauthorized")
		return NewAuthError("Unauthorized to unregister device")
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		dm.logger.Error(fmt.Sprintf("Device unregistration failed with status %d", resp.StatusCode))
		return NewDeviceRegistrationError("Failed to unregister device", resp.StatusCode)
	}

	dm.deviceURL = ""
	dm.logger.Info("Device unregistered successfully")
	return nil
}

type wdmDeviceResponse struct {
	WebSocketURL string            `json:"webSocketUrl"`
	URL          string            `json:"url"`
	UserID       string            `json:"userId"`
	Services     map[string]string `json:"services"`
}

func (dm *DeviceManager) parseDeviceResponse(data *wdmDeviceResponse) *DeviceRegistration {
	services := data.Services
	if services == nil {
		services = make(map[string]string)
	}

	return &DeviceRegistration{
		WebSocketURL:         data.WebSocketURL,
		DeviceURL:            data.URL,
		UserID:               data.UserID,
		Services:             services,
		EncryptionServiceURL: services["encryptionServiceUrl"],
	}
}
