//! WDM device registration, refresh, and unregistration.

use crate::errors::{Result, WebexError};
use crate::types::DeviceRegistration;
use serde_json::json;
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
    client: reqwest::Client,
}

impl DeviceManager {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            device_url: None,
            client,
        }
    }

    /// Register a new device with WDM.
    pub async fn register(&mut self, token: &str) -> Result<DeviceRegistration> {
        debug!("Registering device with WDM");

        let response = self
            .client
            .post(WDM_API_BASE)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&device_body())
            .send()
            .await
            .map_err(|e| WebexError::device_registration(format!("Failed to register device: {e}"), None))?;

        let status = response.status().as_u16();

        if status == 401 {
            error!("Device registration failed: Unauthorized");
            return Err(WebexError::auth("Unauthorized to register device"));
        }

        if !response.status().is_success() {
            error!("Device registration failed with status {status}");
            return Err(WebexError::device_registration("Failed to register device", Some(status)));
        }

        let mut reg: DeviceRegistration = response
            .json()
            .await
            .map_err(|e| WebexError::device_registration(format!("Failed to parse response: {e}"), None))?;

        reg.encryption_service_url = reg.services.get("encryptionServiceUrl").cloned().unwrap_or_default();
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

        let response = self
            .client
            .put(device_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .json(&device_body())
            .send()
            .await
            .map_err(|e| WebexError::device_registration(format!("Failed to refresh device: {e}"), None))?;

        let status = response.status().as_u16();

        if status == 401 {
            error!("Device refresh failed: Unauthorized");
            return Err(WebexError::auth("Unauthorized to refresh device"));
        }

        if !response.status().is_success() {
            error!("Device refresh failed with status {status}");
            return Err(WebexError::device_registration("Failed to refresh device", Some(status)));
        }

        let mut reg: DeviceRegistration = response
            .json()
            .await
            .map_err(|e| WebexError::device_registration(format!("Failed to parse response: {e}"), None))?;

        reg.encryption_service_url = reg.services.get("encryptionServiceUrl").cloned().unwrap_or_default();

        info!("Device refreshed successfully");
        Ok(reg)
    }

    /// Unregister the device from WDM.
    pub async fn unregister(&mut self, token: &str) -> Result<()> {
        let device_url = self.device_url.as_deref().ok_or_else(|| {
            WebexError::device_registration("Device not registered. Call register() first.", None)
        })?;

        debug!("Unregistering device");

        let response = self
            .client
            .delete(device_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| WebexError::device_registration(format!("Failed to unregister device: {e}"), None))?;

        let status = response.status().as_u16();

        if status == 401 {
            error!("Device unregistration failed: Unauthorized");
            return Err(WebexError::auth("Unauthorized to unregister device"));
        }

        if !response.status().is_success() && status != 404 {
            error!("Device unregistration failed with status {status}");
            return Err(WebexError::device_registration("Failed to unregister device", Some(status)));
        }

        self.device_url = None;
        info!("Device unregistered successfully");
        Ok(())
    }
}
