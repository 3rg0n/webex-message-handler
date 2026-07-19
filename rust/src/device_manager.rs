//! WDM device registration, refresh, and unregistration.

use crate::errors::{Result, WebexError};
use crate::types::{DeviceRegistration, FetchFn, FetchRequest};
use crate::url_validation::validate_webex_url;
use serde_json::json;
use std::collections::HashMap;
use tracing::{debug, error, info, warn};

const WDM_API_BASE: &str = "https://wdm-a.wbx2.com/wdm/api/v1/devices";

fn device_body() -> serde_json::Value {
    json!({
        "deviceName": "webex-message-handler",
        "deviceType": "DESKTOP",
        "localizedModel": "rust",
        "model": "rust",
        "name": "webex-message-handler",
        "systemName": "webex-message-handler",
        "systemVersion": "1.0.0"
    })
}

/// Manages WDM device registration lifecycle.
pub struct DeviceManager {
    device_url: Option<String>,
    http_do: FetchFn,
}

impl DeviceManager {
    pub fn new(http_do: FetchFn) -> Self {
        Self {
            device_url: None,
            http_do,
        }
    }

    /// Register a new device with WDM.
    ///
    /// To avoid leaking a new device on every Connect() (which eventually trips the
    /// Webex per-user device cap → HTTP 403), it first lists existing devices and
    /// reuses/refreshes one matching this client's name+deviceType. Only when no
    /// reusable device exists does it POST a new one. If registration fails because
    /// the account already has excessive registrations, it reaps this client's own
    /// devices and retries once.
    pub async fn register(&mut self, token: &str) -> Result<DeviceRegistration> {
        debug!("Registering device with WDM");

        // Reuse-before-register: if a device of ours already exists, refresh it.
        if let Some(existing_url) = self.find_reusable_device(token).await {
            self.device_url = Some(existing_url);
            if let Ok(reg) = self.refresh(token).await {
                info!("Reused existing WDM device registration");
                return Ok(reg);
            }
            // Refresh failed (device stale/deleted server-side) — fall through to
            // create a fresh one.
            self.device_url = None;
        }

        match self.create_device(token).await {
            Ok(reg) => Ok(reg),
            Err(e) => {
                // Check if error is 403 (excessive registrations)
                if let WebexError::DeviceRegistration { status_code: Some(403), .. } = e {
                    warn!("Excessive device registrations detected — reaping this client's devices and retrying");
                    self.reap_own_devices(token).await;
                    return self.create_device(token).await;
                }
                Err(e)
            }
        }
    }

    async fn create_device(&mut self, token: &str) -> Result<DeviceRegistration> {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", token));
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let body = serde_json::to_string(&device_body())
            .map_err(|e| WebexError::device_registration(format!("Failed to serialize body: {e}"), None))?;

        let register_url = format!("{}?includeUpstreamServices=all", WDM_API_BASE);
        let response = (self.http_do)(FetchRequest {
            url: register_url,
            method: "POST".to_string(),
            headers,
            body: Some(body),
        })
        .await
        .map_err(|e| WebexError::device_registration(format!("Failed to register device: {e}"), None))?;

        let status = response.status;

        if status == 401 {
            error!("Device registration failed: Unauthorized");
            return Err(WebexError::auth("Unauthorized to register device"));
        }

        if !response.ok {
            error!("Device registration failed with status {status}");
            return Err(WebexError::device_registration("Failed to register device", Some(status)));
        }

        let mut reg: DeviceRegistration = serde_json::from_slice(&response.body)
            .map_err(|e| WebexError::device_registration(format!("Failed to parse response: {e}"), None))?;

        reg.encryption_service_url = reg.services.get("encryptionServiceUrl").cloned().unwrap_or_default();

        // Validate URLs from the response
        if !reg.web_socket_url.is_empty() {
            validate_webex_url(&reg.web_socket_url, "wss")
                .map_err(|e| WebexError::device_registration(format!("Invalid web_socket_url: {e}"), None))?;
        }

        if !reg.encryption_service_url.is_empty() {
            validate_webex_url(&reg.encryption_service_url, "https")
                .map_err(|e| WebexError::device_registration(format!("Invalid encryption_service_url: {e}"), None))?;
        }

        self.device_url = Some(reg.device_url.clone());

        info!("Device registered successfully");
        Ok(reg)
    }

    async fn find_reusable_device(&self, token: &str) -> Option<String> {
        match self.list_devices(token).await {
            Ok(devices) => {
                for device in devices {
                    if device.name.as_deref() == Some("webex-message-handler")
                        && device.device_type.as_deref() == Some("DESKTOP")
                        && !device.device_url.is_empty()
                    {
                        return Some(device.device_url);
                    }
                }
                None
            }
            Err(e) => {
                debug!("Could not list existing devices (will create new): {e}");
                None
            }
        }
    }

    async fn reap_own_devices(&self, token: &str) {
        match self.list_devices(token).await {
            Ok(devices) => {
                let mut reaped = 0;
                for device in devices {
                    if device.name.as_deref() != Some("webex-message-handler")
                        || device.device_type.as_deref() != Some("DESKTOP")
                        || device.device_url.is_empty()
                    {
                        continue;
                    }
                    match self.delete_device(&device.device_url, token).await {
                        Ok(deleted) => {
                            if deleted {
                                reaped += 1;
                            }
                        }
                        Err(e) => {
                            debug!("Failed to reap device {}: {}", device.device_url, e);
                        }
                    }
                }
                info!("Reaped {} stale WDM device(s)", reaped);
            }
            Err(e) => {
                warn!("Could not list devices to reap: {e}");
            }
        }
    }

    async fn list_devices(&self, token: &str) -> Result<Vec<DeviceRegistration>> {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", token));

        let response = (self.http_do)(FetchRequest {
            url: WDM_API_BASE.to_string(),
            method: "GET".to_string(),
            headers,
            body: None,
        })
        .await
        .map_err(|e| WebexError::device_registration(format!("Failed to list devices: {e}"), None))?;

        let status = response.status;

        if status == 401 {
            return Err(WebexError::auth("Unauthorized to list devices"));
        }

        if !response.ok {
            return Err(WebexError::device_registration(
                format!("Failed to list devices: {status}"),
                Some(status),
            ));
        }

        #[derive(serde::Deserialize)]
        struct DeviceListResponse {
            devices: Vec<serde_json::Value>,
        }

        let list: DeviceListResponse = serde_json::from_slice(&response.body)
            .map_err(|e| WebexError::device_registration(format!("Failed to parse device list: {e}"), None))?;

        let mut result = Vec::new();
        for device_json in list.devices {
            if let Ok(mut reg) = serde_json::from_value::<DeviceRegistration>(device_json) {
                reg.encryption_service_url = reg.services.get("encryptionServiceUrl").cloned().unwrap_or_default();
                result.push(reg);
            }
        }
        Ok(result)
    }

    async fn delete_device(&self, device_url: &str, token: &str) -> Result<bool> {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", token));

        let response = (self.http_do)(FetchRequest {
            url: device_url.to_string(),
            method: "DELETE".to_string(),
            headers,
            body: None,
        })
        .await
        .map_err(|e| WebexError::device_registration(format!("Failed to delete device: {e}"), None))?;

        Ok(response.ok || response.status == 404)
    }

    /// Refresh an existing device registration.
    pub async fn refresh(&self, token: &str) -> Result<DeviceRegistration> {
        let device_url = self.device_url.as_deref().ok_or_else(|| {
            WebexError::device_registration("Device not registered. Call register() first.", None)
        })?;

        debug!("Refreshing device registration");

        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", token));
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let body = serde_json::to_string(&device_body())
            .map_err(|e| WebexError::device_registration(format!("Failed to serialize body: {e}"), None))?;

        let response = (self.http_do)(FetchRequest {
            url: device_url.to_string(),
            method: "PUT".to_string(),
            headers,
            body: Some(body),
        })
        .await
        .map_err(|e| WebexError::device_registration(format!("Failed to refresh device: {e}"), None))?;

        let status = response.status;

        if status == 401 {
            error!("Device refresh failed: Unauthorized");
            return Err(WebexError::auth("Unauthorized to refresh device"));
        }

        if !response.ok {
            error!("Device refresh failed with status {status}");
            return Err(WebexError::device_registration("Failed to refresh device", Some(status)));
        }

        let mut reg: DeviceRegistration = serde_json::from_slice(&response.body)
            .map_err(|e| WebexError::device_registration(format!("Failed to parse response: {e}"), None))?;

        reg.encryption_service_url = reg.services.get("encryptionServiceUrl").cloned().unwrap_or_default();

        // Validate URLs from the response
        if !reg.web_socket_url.is_empty() {
            validate_webex_url(&reg.web_socket_url, "wss")
                .map_err(|e| WebexError::device_registration(format!("Invalid web_socket_url: {e}"), None))?;
        }

        if !reg.encryption_service_url.is_empty() {
            validate_webex_url(&reg.encryption_service_url, "https")
                .map_err(|e| WebexError::device_registration(format!("Invalid encryption_service_url: {e}"), None))?;
        }

        info!("Device refreshed successfully");
        Ok(reg)
    }

    /// Unregister the device from WDM.
    pub async fn unregister(&mut self, token: &str) -> Result<()> {
        let device_url = self.device_url.as_deref().ok_or_else(|| {
            WebexError::device_registration("Device not registered. Call register() first.", None)
        })?;

        debug!("Unregistering device");

        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", token));
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let response = (self.http_do)(FetchRequest {
            url: device_url.to_string(),
            method: "DELETE".to_string(),
            headers,
            body: None,
        })
        .await
        .map_err(|e| WebexError::device_registration(format!("Failed to unregister device: {e}"), None))?;

        let status = response.status;

        if status == 401 {
            error!("Device unregistration failed: Unauthorized");
            return Err(WebexError::auth("Unauthorized to unregister device"));
        }

        if !response.ok && status != 404 {
            error!("Device unregistration failed with status {status}");
            return Err(WebexError::device_registration("Failed to unregister device", Some(status)));
        }

        self.device_url = None;
        info!("Device unregistered successfully");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FetchResponse;
    use std::sync::{Arc, Mutex};

    const DEVICE_URL: &str = "https://wdm-a.wbx2.com/wdm/api/v1/devices/dev-123";
    const WS_URL: &str = "wss://mercury-connection-a.wbx2.com/ws";

    #[derive(Clone)]
    struct Call {
        method: String,
        url: String,
    }

    /// An in-process FetchFn that records calls and returns queued responses
    /// keyed by HTTP method. Lets us assert the exact method/URL sequence the
    /// device manager issues (list → refresh, or create → reap → retry).
    fn mock_fetch(
        responses: Vec<(&'static str, u16, serde_json::Value)>,
    ) -> (FetchFn, Arc<Mutex<Vec<Call>>>) {
        let calls: Arc<Mutex<Vec<Call>>> = Arc::new(Mutex::new(Vec::new()));
        // Per-method FIFO queue of (status, body) responses.
        let mut queues: HashMap<String, Vec<(u16, serde_json::Value)>> = HashMap::new();
        for (method, status, body) in responses {
            queues.entry(method.to_string()).or_default().push((status, body));
        }
        let queues = Arc::new(Mutex::new(queues));
        let calls_c = calls.clone();

        let f: FetchFn = Arc::new(move |req: FetchRequest| {
            let calls_c = calls_c.clone();
            let queues = queues.clone();
            Box::pin(async move {
                calls_c.lock().unwrap().push(Call {
                    method: req.method.clone(),
                    url: req.url.clone(),
                });
                let mut q = queues.lock().unwrap();
                let entry = q.get_mut(&req.method).and_then(|v| {
                    if v.len() > 1 {
                        Some(v.remove(0))
                    } else {
                        v.first().cloned()
                    }
                });
                let (status, body) = entry.unwrap_or((500, json!({})));
                Ok(FetchResponse {
                    status,
                    ok: (200..300).contains(&status),
                    body: serde_json::to_vec(&body).unwrap(),
                })
            })
        });
        (f, calls)
    }

    fn device_json() -> serde_json::Value {
        json!({
            "webSocketUrl": WS_URL,
            "url": DEVICE_URL,
            "userId": "user-123",
            "services": {"encryptionServiceUrl": "https://encryption-a.wbx2.com/e/v1"}
        })
    }

    #[tokio::test]
    async fn reuses_existing_device_via_refresh_not_create() {
        // GET (list) returns a device matching our name+deviceType; register
        // must PUT-refresh it and never POST.
        let listed = json!({
            "devices": [{
                "webSocketUrl": WS_URL,
                "url": DEVICE_URL,
                "userId": "user-123",
                "name": "webex-message-handler",
                "deviceType": "DESKTOP",
                "services": {"encryptionServiceUrl": "https://encryption-a.wbx2.com/e/v1"}
            }]
        });
        let (fetch, calls) = mock_fetch(vec![
            ("GET", 200, listed),
            ("PUT", 200, device_json()),
        ]);
        let mut dm = DeviceManager::new(fetch);
        let reg = dm.register("tok").await.unwrap();
        assert_eq!(reg.device_url, DEVICE_URL);

        let calls = calls.lock().unwrap();
        let methods: Vec<&str> = calls.iter().map(|c| c.method.as_str()).collect();
        assert_eq!(methods, vec!["GET", "PUT"], "should list then refresh, never POST");
        // The refresh targets the existing device URL, not the base collection.
        assert_eq!(calls[1].url, DEVICE_URL);
    }

    #[tokio::test]
    async fn reaps_and_retries_on_excessive_registrations_403() {
        // No reusable device (empty list), first POST → 403, reap lists our
        // device and DELETEs it, then a second POST succeeds.
        let empty = json!({"devices": []});
        let ours = json!({
            "devices": [{
                "url": DEVICE_URL, "name": "webex-message-handler", "deviceType": "DESKTOP",
                "webSocketUrl": WS_URL, "userId": "u", "services": {}
            }]
        });
        let (fetch, calls) = mock_fetch(vec![
            ("GET", 200, empty),          // find_reusable_device → none
            ("POST", 403, json!({})),     // create → excessive registrations
            ("GET", 200, ours),           // reap → list our devices
            ("DELETE", 204, json!({})),   // reap → delete
            ("POST", 200, device_json()), // retry create → success
        ]);
        let mut dm = DeviceManager::new(fetch);
        let reg = dm.register("tok").await.unwrap();
        assert_eq!(reg.device_url, DEVICE_URL);

        let calls = calls.lock().unwrap();
        let methods: Vec<&str> = calls.iter().map(|c| c.method.as_str()).collect();
        assert_eq!(methods, vec!["GET", "POST", "GET", "DELETE", "POST"]);
        // Create requests the full upstream-service catalog.
        assert!(calls[1].url.contains("includeUpstreamServices=all"));
        // Reap deletes our specific device URL.
        assert_eq!(calls[3].url, DEVICE_URL);
    }

    #[tokio::test]
    async fn falls_back_to_create_when_list_fails() {
        // A failing list (500) must not be fatal: register proceeds to POST.
        let (fetch, calls) = mock_fetch(vec![
            ("GET", 500, json!({})),
            ("POST", 200, device_json()),
        ]);
        let mut dm = DeviceManager::new(fetch);
        let reg = dm.register("tok").await.unwrap();
        assert_eq!(reg.device_url, DEVICE_URL);

        let calls = calls.lock().unwrap();
        let methods: Vec<&str> = calls.iter().map(|c| c.method.as_str()).collect();
        assert_eq!(methods, vec!["GET", "POST"]);
    }
}

