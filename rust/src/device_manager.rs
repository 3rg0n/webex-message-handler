//! WDM device registration, refresh, and unregistration.

use crate::errors::{Result, WebexError};
use crate::types::{DeviceRegistration, FetchFn, FetchRequest};
use crate::url_validation::validate_webex_url;
use serde_json::json;
use std::collections::HashMap;
use tracing::{debug, error, info};

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
    pub async fn register(&mut self, token: &str) -> Result<DeviceRegistration> {
        debug!("Registering device with WDM");

        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), format!("Bearer {}", token));
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let body = serde_json::to_string(&device_body())
            .map_err(|e| WebexError::device_registration(format!("Failed to serialize body: {e}"), None))?;

        let response = (self.http_do)(FetchRequest {
            url: WDM_API_BASE.to_string(),
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
