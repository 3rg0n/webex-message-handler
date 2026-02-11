package webexmessagehandler

import (
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
	logger    Logger
	httpDo    fetchDoFn
	deviceURL string
}

// NewDeviceManager creates a new DeviceManager.
func NewDeviceManager(logger Logger, httpDo fetchDoFn) *DeviceManager {
	if logger == nil {
		logger = NoopLogger()
	}
	return &DeviceManager{
		logger: logger,
		httpDo: httpDo,
	}
}

// Register registers a new device with WDM.
func (dm *DeviceManager) Register(ctx context.Context, token string) (*DeviceRegistration, error) {
	dm.logger.Debug("Registering device with WDM")

	bodyBytes, err := json.Marshal(deviceBody)
	if err != nil {
		return nil, NewDeviceRegistrationError("Failed to marshal device body", 0)
	}

	resp, err := dm.httpDo(ctx, FetchRequest{
		URL:    wdmAPIBase,
		Method: http.MethodPost,
		Headers: map[string]string{
			"Authorization": "Bearer " + token,
			"Content-Type":  "application/json",
		},
		Body: string(bodyBytes),
	})
	if err != nil {
		dm.logger.Error(fmt.Sprintf("Device registration error: %v", err))
		return nil, NewDeviceRegistrationError("Failed to register device", 0)
	}
	defer resp.Body.Close()

	if resp.Status == 401 {
		dm.logger.Error("Device registration failed: Unauthorized")
		return nil, NewAuthError("Unauthorized to register device")
	}

	if !resp.OK {
		dm.logger.Error(fmt.Sprintf("Device registration failed with status %d", resp.Status))
		return nil, NewDeviceRegistrationError("Failed to register device", resp.Status)
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

	resp, err := dm.httpDo(ctx, FetchRequest{
		URL:    dm.deviceURL,
		Method: http.MethodPut,
		Headers: map[string]string{
			"Authorization": "Bearer " + token,
			"Content-Type":  "application/json",
		},
		Body: string(bodyBytes),
	})
	if err != nil {
		dm.logger.Error(fmt.Sprintf("Device refresh error: %v", err))
		return nil, NewDeviceRegistrationError("Failed to refresh device", 0)
	}
	defer resp.Body.Close()

	if resp.Status == 401 {
		dm.logger.Error("Device refresh failed: Unauthorized")
		return nil, NewAuthError("Unauthorized to refresh device")
	}

	if !resp.OK {
		dm.logger.Error(fmt.Sprintf("Device refresh failed with status %d", resp.Status))
		return nil, NewDeviceRegistrationError("Failed to refresh device", resp.Status)
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

	resp, err := dm.httpDo(ctx, FetchRequest{
		URL:    dm.deviceURL,
		Method: http.MethodDelete,
		Headers: map[string]string{
			"Authorization": "Bearer " + token,
			"Content-Type":  "application/json",
		},
	})
	if err != nil {
		dm.logger.Error(fmt.Sprintf("Device unregistration error: %v", err))
		return NewDeviceRegistrationError("Failed to unregister device", 0)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)

	if resp.Status == 401 {
		dm.logger.Error("Device unregistration failed: Unauthorized")
		return NewAuthError("Unauthorized to unregister device")
	}

	if !resp.OK {
		dm.logger.Error(fmt.Sprintf("Device unregistration failed with status %d", resp.Status))
		return NewDeviceRegistrationError("Failed to unregister device", resp.Status)
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
