//! Main orchestrator: device registration, Mercury WebSocket, KMS, decryption.

use crate::device_manager::DeviceManager;
use crate::errors::WebexError;
use crate::kms_client::{KmsClient, KmsResponseHandler};
use crate::mercury_socket::{MercuryEvent, MercurySocket};
use crate::message_decryptor::MessageDecryptor;
use crate::types::{
    Config, ConnectionStatus, DecryptedMessage, DeletedMessage, DeviceRegistration, HandlerStatus,
    MercuryActivity,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

/// Events emitted by WebexMessageHandler.
#[derive(Debug, Clone)]
pub enum HandlerEvent {
    /// A new message was received and decrypted.
    MessageCreated(DecryptedMessage),
    /// A message was deleted.
    MessageDeleted(DeletedMessage),
    /// Successfully connected (or reconnected).
    Connected,
    /// Disconnected with a reason string.
    Disconnected(String),
    /// Reconnecting (attempt number).
    Reconnecting(u32),
    /// An error occurred.
    Error(String),
}

/// Receives and decrypts Webex messages over Mercury WebSocket.
pub struct WebexMessageHandler {
    token: Arc<Mutex<String>>,
    device_manager: Arc<Mutex<DeviceManager>>,
    mercury_socket: Arc<MercurySocket>,
    kms_client: Arc<Mutex<Option<KmsClient>>>,
    /// Separate handle for resolving KMS responses without locking kms_client.
    kms_response_handler: Arc<Mutex<Option<KmsResponseHandler>>>,
    registration: Arc<Mutex<Option<DeviceRegistration>>>,
    connected: Arc<Mutex<bool>>,
    connecting: Arc<Mutex<bool>>,

    #[allow(dead_code)]
    config: Config,
    event_tx: mpsc::UnboundedSender<HandlerEvent>,
    event_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<HandlerEvent>>>>,
}

impl WebexMessageHandler {
    /// Create a new WebexMessageHandler.
    pub fn new(config: Config) -> Result<Self, WebexError> {
        if config.token.is_empty() {
            return Err(WebexError::Internal(
                "WebexMessageHandler requires a non-empty token string".into(),
            ));
        }

        let mercury_socket = MercurySocket::new(
            Duration::from_secs_f64(config.ping_interval),
            Duration::from_secs_f64(config.pong_timeout),
            Duration::from_secs_f64(config.reconnect_backoff_max),
            config.max_reconnect_attempts,
        );

        let (event_tx, event_rx) = mpsc::unbounded_channel();

        Ok(Self {
            token: Arc::new(Mutex::new(config.token.clone())),
            device_manager: Arc::new(Mutex::new(DeviceManager::new())),
            mercury_socket: Arc::new(mercury_socket),
            kms_client: Arc::new(Mutex::new(None)),
            kms_response_handler: Arc::new(Mutex::new(None)),
            registration: Arc::new(Mutex::new(None)),
            connected: Arc::new(Mutex::new(false)),
            connecting: Arc::new(Mutex::new(false)),
            config,
            event_tx,
            event_rx: Arc::new(Mutex::new(Some(event_rx))),
        })
    }

    /// Take the event receiver. Can only be called once.
    pub async fn take_event_rx(&self) -> Option<mpsc::UnboundedReceiver<HandlerEvent>> {
        self.event_rx.lock().await.take()
    }

    /// Connect to Webex (register device, connect Mercury, init KMS).
    pub async fn connect(&self) -> Result<(), WebexError> {
        {
            let connecting = self.connecting.lock().await;
            if *connecting {
                return Err(WebexError::Internal("connect() already in progress".into()));
            }
        }
        {
            let connected = self.connected.lock().await;
            if *connected {
                return Err(WebexError::Internal(
                    "Already connected. Call disconnect() first, or use reconnect().".into(),
                ));
            }
        }

        info!("Connecting to Webex...");
        *self.connecting.lock().await = true;

        let result = self.connect_internal().await;

        *self.connecting.lock().await = false;

        match result {
            Ok(()) => {
                *self.connected.lock().await = true;
                info!("Connected to Webex");
                let _ = self.event_tx.send(HandlerEvent::Connected);
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    async fn connect_internal(&self) -> Result<(), WebexError> {
        let token = self.token.lock().await.clone();

        // Step 1: Register device with WDM
        let reg = {
            let mut dm = self.device_manager.lock().await;
            dm.register(&token).await?
        };
        info!("Device registered");

        // Step 2: Create KMS client
        let kms = KmsClient::new(
            &token,
            &reg.device_url,
            &reg.user_id,
            &reg.encryption_service_url,
        );

        // Get the response handler BEFORE storing the KMS client so the
        // event loop can resolve pending requests without locking kms_client.
        let response_handler = kms.response_handler();
        *self.kms_response_handler.lock().await = Some(response_handler);
        *self.kms_client.lock().await = Some(kms);

        // Step 3: Connect Mercury WebSocket (KMS responses arrive here)
        self.mercury_socket
            .connect(&reg.web_socket_url, &token)
            .await?;
        info!("Mercury connected");

        // Step 4: Start Mercury event loop
        self.start_mercury_event_loop().await;

        // Step 5: Initialize KMS (ECDH handshake — response comes via Mercury)
        {
            let mut kms_guard = self.kms_client.lock().await;
            if let Some(ref mut kms) = *kms_guard {
                kms.initialize().await?;
            }
        }
        info!("KMS initialized");

        // Store registration
        *self.registration.lock().await = Some(reg);

        Ok(())
    }

    /// Start processing Mercury events in a background task.
    async fn start_mercury_event_loop(&self) {
        let mut mercury_rx = match self.mercury_socket.take_event_rx().await {
            Some(rx) => rx,
            None => {
                warn!("Mercury event receiver already taken");
                return;
            }
        };

        let kms_client = self.kms_client.clone();
        let kms_response_handler = self.kms_response_handler.clone();
        let event_tx = self.event_tx.clone();
        let connected = self.connected.clone();
        let registration = self.registration.clone();
        let device_manager = self.device_manager.clone();
        let token = self.token.clone();

        tokio::spawn(async move {
            while let Some(event) = mercury_rx.recv().await {
                match event {
                    MercuryEvent::KmsResponse(data) => {
                        // Use the separate response handler to avoid deadlock
                        // with kms_client lock (held during initialize/get_key).
                        let handler_guard = kms_response_handler.lock().await;
                        if let Some(ref handler) = *handler_guard {
                            handler.handle_kms_message(&data).await;
                        }
                    }
                    MercuryEvent::Activity(activity) => {
                        // Spawn in a separate task so the event loop can continue
                        // processing KMS responses (needed for key retrieval during decryption).
                        let kms_client_clone = kms_client.clone();
                        let event_tx_clone = event_tx.clone();
                        tokio::spawn(async move {
                            let mut kms_guard = kms_client_clone.lock().await;
                            if let Some(ref mut kms) = *kms_guard {
                                Self::handle_activity_static(kms, &activity, &event_tx_clone).await;
                            } else {
                                warn!("Received activity but KMS client not initialized");
                            }
                        });
                    }
                    MercuryEvent::Connected => {
                        info!("Mercury reconnected, refreshing device and KMS");

                        // Refresh device
                        let tok = token.lock().await.clone();
                        {
                            let reg_guard = registration.lock().await;
                            if reg_guard.is_some() {
                                let dm = device_manager.lock().await;
                                match dm.refresh(&tok).await {
                                    Ok(new_reg) => {
                                        drop(reg_guard);
                                        *registration.lock().await = Some(new_reg);
                                    }
                                    Err(e) => {
                                        warn!("Device refresh on reconnect failed: {e}");
                                    }
                                }
                            }
                        }

                        // Re-init KMS
                        {
                            let mut kms_guard = kms_client.lock().await;
                            if let Some(ref mut kms) = *kms_guard {
                                if let Err(e) = kms.initialize().await {
                                    warn!("KMS re-init on reconnect failed: {e}");
                                }
                            }
                        }

                        *connected.lock().await = true;
                        let _ = event_tx.send(HandlerEvent::Connected);
                    }
                    MercuryEvent::Disconnected(reason) => {
                        *connected.lock().await = false;
                        let _ = event_tx.send(HandlerEvent::Disconnected(reason));
                    }
                    MercuryEvent::Reconnecting(attempt) => {
                        let _ = event_tx.send(HandlerEvent::Reconnecting(attempt));
                    }
                    MercuryEvent::Error(msg) => {
                        let _ = event_tx.send(HandlerEvent::Error(msg));
                    }
                }
            }
        });
    }

    /// Handle a single activity (decrypt and route).
    async fn handle_activity_static(
        kms: &mut KmsClient,
        activity: &MercuryActivity,
        event_tx: &mpsc::UnboundedSender<HandlerEvent>,
    ) {
        // message:created — verb=post + objectType=comment
        if activity.verb == "post" && activity.object.object_type == "comment" {
            let mut decryptor = MessageDecryptor::new(kms);
            match decryptor.decrypt_activity(activity).await {
                Ok(decrypted) => {
                    let msg = DecryptedMessage {
                        id: decrypted.object.id.clone(),
                        room_id: decrypted.target.id.clone(),
                        person_id: decrypted.actor.id.clone(),
                        person_email: decrypted
                            .actor
                            .email_address
                            .clone()
                            .unwrap_or_default(),
                        text: decrypted.object.display_name.clone().unwrap_or_default(),
                        html: decrypted.object.content.clone(),
                        created: decrypted.published.clone(),
                        room_type: infer_room_type(&decrypted),
                        raw: decrypted,
                    };
                    let _ = event_tx.send(HandlerEvent::MessageCreated(msg));
                }
                Err(e) => {
                    error!("Error decrypting activity: {e}");
                    let _ = event_tx.send(HandlerEvent::Error(e.to_string()));
                }
            }
            return;
        }

        // message:deleted — verb=delete + objectType=activity
        if activity.verb == "delete" && activity.object.object_type == "activity" {
            let _ = event_tx.send(HandlerEvent::MessageDeleted(DeletedMessage {
                message_id: activity.object.id.clone(),
                room_id: activity.target.id.clone(),
                person_id: activity.actor.id.clone(),
            }));
        }
    }

    /// Disconnect from Webex.
    pub async fn disconnect(&self) {
        info!("Disconnecting from Webex...");
        *self.connected.lock().await = false;

        self.mercury_socket.disconnect().await;

        let token = self.token.lock().await.clone();
        {
            let reg = self.registration.lock().await;
            if reg.is_some() {
                let mut dm = self.device_manager.lock().await;
                if let Err(e) = dm.unregister(&token).await {
                    warn!("Failed to unregister device: {e}");
                } else {
                    info!("Device unregistered");
                }
            }
        }

        *self.registration.lock().await = None;
        *self.kms_client.lock().await = None;
        *self.kms_response_handler.lock().await = None;
    }

    /// Update the access token and re-establish the connection.
    pub async fn reconnect(&self, new_token: &str) -> Result<(), WebexError> {
        if new_token.is_empty() {
            return Err(WebexError::Internal(
                "reconnect() requires a non-empty token string".into(),
            ));
        }

        info!("Reconnecting with new token...");
        self.disconnect().await;

        *self.token.lock().await = new_token.to_string();
        self.connect().await
    }

    /// Whether the handler is fully connected.
    pub async fn connected(&self) -> bool {
        let conn = *self.connected.lock().await;
        conn && self.mercury_socket.connected().await
    }

    /// Returns a structured health check of all connection subsystems.
    pub async fn status(&self) -> HandlerStatus {
        let reconnect_attempt = self.mercury_socket.current_reconnect_attempts().await;
        let ws_open = self.mercury_socket.connected().await;
        let is_connected = *self.connected.lock().await;
        let is_connecting = *self.connecting.lock().await;

        let status = if is_connected && ws_open {
            ConnectionStatus::Connected
        } else if is_connecting {
            ConnectionStatus::Connecting
        } else if reconnect_attempt > 0 {
            ConnectionStatus::Reconnecting
        } else {
            ConnectionStatus::Disconnected
        };

        HandlerStatus {
            status,
            web_socket_open: ws_open,
            kms_initialized: self.kms_client.lock().await.is_some(),
            device_registered: self.registration.lock().await.is_some(),
            reconnect_attempt,
        }
    }
}

fn infer_room_type(activity: &MercuryActivity) -> Option<String> {
    let tags = &activity.target.tags;
    if tags.contains(&"ONE_ON_ONE".to_string()) {
        return Some("direct".to_string());
    }
    if tags.contains(&"TEAM".to_string())
        || tags.contains(&"LOCKED".to_string())
        || tags.contains(&"GROUP".to_string())
    {
        return Some("group".to_string());
    }
    None
}
