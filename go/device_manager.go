package webexmessagehandler

import (
	"context"
	"encoding/json"
	"errors"
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

// Register obtains a usable WDM device registration.
//
// To avoid leaking a new device on every Connect() (which eventually trips the
// Webex per-user device cap → HTTP 403), it first lists existing devices and
// reuses/refreshes one matching this client's name+deviceType. Only when no
// reusable device exists does it POST a new one. If registration fails because
// the account already has excessive registrations, it reaps this client's own
// devices and retries once.
func (dm *DeviceManager) Register(ctx context.Context, token string) (*DeviceRegistration, error) {
	dm.logger.Debug("Registering device with WDM")

	// Reuse-before-register: if a device of ours already exists, refresh it.
	if existing := dm.findReusableDevice(ctx, token); existing != "" {
		dm.deviceURL = existing
		if reg, err := dm.Refresh(ctx, token); err == nil {
			dm.logger.Info("Reused existing WDM device registration")
			return reg, nil
		}
		// Refresh failed (device stale/deleted server-side) — fall through to
		// create a fresh one.
		dm.deviceURL = ""
	}

	reg, err := dm.createDevice(ctx, token)
	if err != nil {
		if isExcessiveRegistrationsError(err) {
			dm.logger.Warn("Excessive device registrations detected — reaping this client's devices and retrying")
			dm.reapOwnDevices(ctx, token)
			return dm.createDevice(ctx, token)
		}
		return nil, err
	}
	return reg, nil
}

// createDevice performs the raw POST /devices registration.
func (dm *DeviceManager) createDevice(ctx context.Context, token string) (*DeviceRegistration, error) {
	bodyBytes, err := json.Marshal(deviceBody)
	if err != nil {
		return nil, NewDeviceRegistrationError("Failed to marshal device body", 0)
	}

	// includeUpstreamServices=all requests the full service catalog on the
	// registration response (matches the reference Webex SDKs).
	registerURL := wdmAPIBase + "?includeUpstreamServices=all"
	resp, err := dm.httpDo(ctx, FetchRequest{
		URL:    registerURL,
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
	reg, err := dm.parseDeviceResponse(&data)
	if err != nil {
		return nil, err
	}
	dm.logger.Info("Device registered successfully")
	return reg, nil
}

// findReusableDevice lists existing WDM devices and returns the URL of one
// matching this client's name+deviceType, or "" if none/on any error (in which
// case the caller falls back to creating a new device — best-effort, never fatal).
func (dm *DeviceManager) findReusableDevice(ctx context.Context, token string) string {
	devices, err := dm.listDevices(ctx, token)
	if err != nil {
		dm.logger.Debug(fmt.Sprintf("Could not list existing devices (will create new): %v", err))
		return ""
	}
	for _, d := range devices {
		if d.Name == deviceBody["name"] && d.DeviceType == deviceBody["deviceType"] && d.URL != "" {
			return d.URL
		}
	}
	return ""
}

// reapOwnDevices best-effort deletes all WDM devices matching this client's
// name+deviceType, to recover from the per-user device cap. Never fatal.
func (dm *DeviceManager) reapOwnDevices(ctx context.Context, token string) {
	devices, err := dm.listDevices(ctx, token)
	if err != nil {
		dm.logger.Warn(fmt.Sprintf("Could not list devices to reap: %v", err))
		return
	}
	reaped := 0
	for _, d := range devices {
		if d.Name != deviceBody["name"] || d.DeviceType != deviceBody["deviceType"] || d.URL == "" {
			continue
		}
		resp, err := dm.httpDo(ctx, FetchRequest{
			URL:     d.URL,
			Method:  http.MethodDelete,
			Headers: map[string]string{"Authorization": "Bearer " + token},
		})
		if err != nil {
			dm.logger.Debug(fmt.Sprintf("Failed to reap device %s: %v", d.URL, err))
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.OK || resp.Status == 404 {
			reaped++
		}
	}
	dm.logger.Info(fmt.Sprintf("Reaped %d stale WDM device(s)", reaped))
}

// listDevices fetches the account's current WDM device registrations.
func (dm *DeviceManager) listDevices(ctx context.Context, token string) ([]wdmDeviceResponse, error) {
	resp, err := dm.httpDo(ctx, FetchRequest{
		URL:     wdmAPIBase,
		Method:  http.MethodGet,
		Headers: map[string]string{"Authorization": "Bearer " + token},
	})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.Status == 401 {
		return nil, NewAuthError("Unauthorized to list devices")
	}
	if !resp.OK {
		return nil, NewDeviceRegistrationError(fmt.Sprintf("Failed to list devices: %d", resp.Status), resp.Status)
	}

	var list wdmDeviceListResponse
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, NewDeviceRegistrationError("Failed to parse device list", 0)
	}
	return list.Devices, nil
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

	reg, err := dm.parseDeviceResponse(&data)
	if err != nil {
		return nil, err
	}
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
	_, _ = io.Copy(io.Discard, resp.Body)

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
	Name         string            `json:"name"`
	DeviceType   string            `json:"deviceType"`
	Services     map[string]string `json:"services"`
}

// wdmDeviceListResponse is the shape of GET /wdm/api/v1/devices.
type wdmDeviceListResponse struct {
	Devices []wdmDeviceResponse `json:"devices"`
}

// isExcessiveRegistrationsError reports whether err is the WDM per-user device
// cap rejection (HTTP 403 on device creation).
func isExcessiveRegistrationsError(err error) bool {
	var de *DeviceRegistrationError
	if errors.As(err, &de) {
		return de.StatusCode == http.StatusForbidden
	}
	return false
}

func (dm *DeviceManager) parseDeviceResponse(data *wdmDeviceResponse) (*DeviceRegistration, error) {
	services := data.Services
	if services == nil {
		services = make(map[string]string)
	}

	// Validate URLs from external API response
	if err := validateWebexURL(data.WebSocketURL, "wss"); err != nil {
		dm.logger.Error(fmt.Sprintf("Invalid webSocketUrl from WDM: %v", err))
		return nil, NewDeviceRegistrationError(fmt.Sprintf("untrusted webSocketUrl: %v", err), 0)
	}

	encryptionServiceURL := services["encryptionServiceUrl"]
	if encryptionServiceURL != "" {
		if err := validateWebexURL(encryptionServiceURL, "https"); err != nil {
			dm.logger.Error(fmt.Sprintf("Invalid encryptionServiceUrl from WDM: %v", err))
			return nil, NewDeviceRegistrationError(fmt.Sprintf("untrusted encryptionServiceUrl: %v", err), 0)
		}
	}

	return &DeviceRegistration{
		WebSocketURL:         data.WebSocketURL,
		DeviceURL:            data.URL,
		UserID:               data.UserID,
		Services:             services,
		EncryptionServiceURL: encryptionServiceURL,
	}, nil
}
