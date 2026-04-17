//! Main orchestrator: device registration, Mercury WebSocket, KMS, decryption.

use crate::device_manager::DeviceManager;
use crate::errors::WebexError;
use crate::kms_client::{KmsClient, KmsResponseHandler};
use crate::mention_parser::parse_mentions;
use crate::mercury_socket::{MercuryEvent, MercurySocket};
use crate::message_decryptor::MessageDecryptor;
use crate::types::{
    AttachmentAction, Config, ConnectionStatus, DecryptedMessage, DeletedMessage,
    DeviceRegistration, FetchRequest, FetchResponse, HandlerStatus, MembershipActivity,
    MetricsEvent, MercuryActivity, NetworkMode, RoomActivity,
};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

// Internal adapter type (alias for public type)
type HttpDoFn = Arc<
    dyn Fn(FetchRequest) -> Pin<Box<dyn Future<Output = Result<FetchResponse, Box<dyn std::error::Error + Send + Sync>>> + Send>>
        + Send
        + Sync,
>;

/// Events emitted by WebexMessageHandler.
#[derive(Debug, Clone)]
pub enum HandlerEvent {
    /// A new message was received and decrypted.
    MessageCreated(DecryptedMessage),
    /// A message was edited.
    MessageUpdated(DecryptedMessage),
    /// A message was deleted.
    MessageDeleted(DeletedMessage),
    /// A membership event occurred (add, leave, assignModerator, unassignModerator).
    MembershipCreated(MembershipActivity),
    /// An adaptive card was submitted.
    AttachmentActionCreated(AttachmentAction),
    /// A room was created.
    RoomCreated(RoomActivity),
    /// A room was updated.
    RoomUpdated(RoomActivity),
    /// Successfully connected (or reconnected).
    Connected,
    /// Disconnected with a reason string.
    Disconnected(String),
    /// Reconnecting (attempt number).
    Reconnecting(u32),
    /// An error occurred.
    Error(String),
}

/// Extract the raw UUID from a Webex person ID.
///
/// The Webex REST API returns base64-encoded IDs like:
///   `"Y2lzY29zcGFyazovL3VzL1BFT1BMRS9mYjUx..."` → `"ciscospark://us/PEOPLE/fb51254f-..."`
///
/// Mercury wire format uses raw UUIDs:
///   `"fb51254f-3b37-4e50-aa04-45744c2effc7"`
///
/// This function normalizes both formats to the raw UUID for comparison.
fn extract_person_uuid(id: &str) -> String {
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
    use base64::Engine;

    // Try standard base64, then no-padding variant
    let decoded_bytes = STANDARD
        .decode(id)
        .or_else(|_| STANDARD_NO_PAD.decode(id));

    if let Ok(bytes) = decoded_bytes {
        if let Ok(decoded) = String::from_utf8(bytes) {
            if decoded.starts_with("ciscospark://") {
                if let Some(uuid) = decoded.rsplit('/').next() {
                    if !uuid.is_empty() {
                        return uuid.to_string();
                    }
                }
            }
        }
    }

    id.to_string()
}

/// Create a native HTTP adapter that wraps reqwest::Client.
fn create_native_http_adapter(client: reqwest::Client) -> HttpDoFn {
    Arc::new(move |req: FetchRequest| {
        let client = client.clone();
        Box::pin(async move {
            let mut request_builder = match req.method.as_str() {
                "GET" => client.get(&req.url),
                "POST" => client.post(&req.url),
                "PUT" => client.put(&req.url),
                "DELETE" => client.delete(&req.url),
                _ => return Err(format!("Unsupported HTTP method: {}", req.method).into()),
            };

            for (key, value) in req.headers {
                request_builder = request_builder.header(key, value);
            }

            if let Some(body) = req.body {
                request_builder = request_builder.body(body);
            }

            let response = request_builder
                .send()
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;

            let status = response.status().as_u16();
            let ok = response.status().is_success();
            let body_bytes = response
                .bytes()
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                .to_vec();

            Ok(FetchResponse {
                status,
                ok,
                body: body_bytes,
            })
        })
    })
}

/// Receives and decrypts Webex messages over Mercury WebSocket.
pub struct WebexMessageHandler {
    token: Arc<Mutex<String>>,
    http_do: HttpDoFn,
    device_manager: Arc<Mutex<DeviceManager>>,
    mercury_socket: Arc<MercurySocket>,
    kms_client: Arc<Mutex<Option<KmsClient>>>,
    /// Separate handle for resolving KMS responses without locking kms_client.
    kms_response_handler: Arc<Mutex<Option<KmsResponseHandler>>>,
    registration: Arc<Mutex<Option<DeviceRegistration>>>,
    connected: Arc<Mutex<bool>>,
    connecting: Arc<Mutex<bool>>,
    ignore_self_messages: bool,
    bot_person_id: Arc<Mutex<Option<String>>>,
    /// Track recent activity IDs to prevent replay attacks (activity_id -> Instant)
    recent_activity_ids: Arc<Mutex<HashMap<String, Instant>>>,

    #[allow(dead_code)]
    config: Config,
    metrics_callback: Option<Arc<dyn Fn(MetricsEvent) + Send + Sync>>,
    event_tx: mpsc::Sender<HandlerEvent>,
    event_rx: Arc<Mutex<Option<mpsc::Receiver<HandlerEvent>>>>,
}

impl WebexMessageHandler {
    /// Create a new WebexMessageHandler.
    pub fn new(config: Config) -> Result<Self, WebexError> {
        if config.token.is_empty() {
            return Err(WebexError::Internal(
                "WebexMessageHandler requires a non-empty token string".into(),
            ));
        }

        // Validate networking mode configuration
        match config.mode {
            NetworkMode::Injected => {
                if config.fetch.is_none() || config.web_socket_factory.is_none() {
                    return Err(WebexError::Internal(
                        "Injected mode requires both fetch and web_socket_factory".into(),
                    ));
                }
                if config.client.is_some() {
                    return Err(WebexError::Internal(
                        "Cannot use native proxy parameters (client) in injected mode".into(),
                    ));
                }
            }
            NetworkMode::Native => {
                if config.fetch.is_some() || config.web_socket_factory.is_some() {
                    return Err(WebexError::Internal(
                        "Cannot provide fetch/web_socket_factory in native mode — set mode to Injected".into(),
                    ));
                }
            }
        }

        // Create adapters based on mode
        let (http_do, ws_factory) = match config.mode {
            NetworkMode::Native => {
                let client = config.client.clone().unwrap_or_default();
                let http_adapter = create_native_http_adapter(client.clone());
                (http_adapter, None)
            }
            NetworkMode::Injected => {
                let http_adapter = config.fetch.clone().expect("Injected mode requires fetch adapter");
                let ws_factory = config.web_socket_factory.clone();
                (http_adapter, ws_factory)
            }
        };

        let mercury_socket = MercurySocket::new(
            ws_factory,
            Duration::from_secs_f64(config.ping_interval),
            Duration::from_secs_f64(config.pong_timeout),
            Duration::from_secs_f64(config.reconnect_backoff_max),
            config.max_reconnect_attempts,
        );

        let (event_tx, event_rx) = mpsc::channel(config.event_channel_capacity);

        let ignore_self_messages = config.ignore_self_messages;

        Ok(Self {
            token: Arc::new(Mutex::new(config.token.clone())),
            http_do: http_do.clone(),
            device_manager: Arc::new(Mutex::new(DeviceManager::new(http_do.clone()))),
            mercury_socket: Arc::new(mercury_socket),
            kms_client: Arc::new(Mutex::new(None)),
            kms_response_handler: Arc::new(Mutex::new(None)),
            registration: Arc::new(Mutex::new(None)),
            connected: Arc::new(Mutex::new(false)),
            connecting: Arc::new(Mutex::new(false)),
            ignore_self_messages,
            bot_person_id: Arc::new(Mutex::new(None)),
            recent_activity_ids: Arc::new(Mutex::new(HashMap::new())),
            metrics_callback: config.metrics_callback.clone(),
            config,
            event_tx,
            event_rx: Arc::new(Mutex::new(Some(event_rx))),
        })
    }

    /// Take the event receiver. Can only be called once.
    /// Returns a bounded receiver with capacity configured in Config::event_channel_capacity.
    pub async fn take_event_rx(&self) -> Option<mpsc::Receiver<HandlerEvent>> {
        self.event_rx.lock().await.take()
    }

    /// Report a timing metric if callback is set.
    fn report_metric(&self, name: &str, start: Instant, success: bool, metadata: Option<HashMap<String, String>>) {
        if let Some(ref callback) = self.metrics_callback {
            callback(MetricsEvent {
                name: name.to_string(),
                duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                success,
                metadata,
            });
        }
    }

    /// Connect to Webex (register device, connect Mercury, init KMS).
    pub async fn connect(&self) -> Result<(), WebexError> {
        {
            let connecting = self.connecting.lock().await;
            let connected = self.connected.lock().await;
            if *connecting {
                return Err(WebexError::Internal("connect() already in progress".into()));
            }
            if *connected {
                return Err(WebexError::Internal(
                    "Already connected. Call disconnect() first, or use reconnect().".into(),
                ));
            }
        }

        info!("Connecting to Webex...");
        *self.connecting.lock().await = true;

        let connect_start = Instant::now();
        let result = self.connect_internal().await;

        *self.connecting.lock().await = false;

        match result {
            Ok(()) => {
                *self.connected.lock().await = true;
                info!("Connected to Webex");
                self.report_metric("connect", connect_start, true, None);
                if let Err(e) = self.event_tx.try_send(HandlerEvent::Connected) {
                    match e {
                        mpsc::error::TrySendError::Full(_) => {
                            warn!("Event channel at capacity, dropping Connected event (backpressure)");
                        }
                        mpsc::error::TrySendError::Closed(_) => {
                            warn!("Event receiver dropped, cannot send Connected event");
                        }
                    }
                }
                Ok(())
            }
            Err(e) => {
                self.report_metric("connect", connect_start, false, None);
                Err(e)
            }
        }
    }

    async fn fetch_bot_person_id(&self) -> Result<(), WebexError> {
        info!("Fetching bot person info for self-message filtering");
        let token = self.token.lock().await.clone();
        let req = FetchRequest {
            url: "https://webexapis.com/v1/people/me".into(),
            method: "GET".into(),
            headers: {
                let mut h = std::collections::HashMap::new();
                h.insert("Authorization".into(), format!("Bearer {}", token));
                h.insert("Content-Type".into(), "application/json".into());
                h
            },
            body: None,
        };

        let resp = (self.http_do)(req).await.map_err(|e| {
            WebexError::Internal(format!(
                "Failed to fetch bot identity for self-message filtering: {e}. \
                 Set ignore_self_messages to false to skip this check (not recommended — may cause message loops)."
            ))
        })?;

        if !resp.ok {
            return Err(WebexError::Internal(format!(
                "Failed to fetch bot identity for self-message filtering: HTTP {}. \
                 Set ignore_self_messages to false to skip this check (not recommended — may cause message loops).",
                resp.status
            )));
        }

        let data: serde_json::Value = serde_json::from_slice(&resp.body).map_err(|e| {
            WebexError::Internal(format!("Failed to parse bot identity response: {e}"))
        })?;

        let id = data
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| WebexError::Internal("Bot identity response missing 'id' field".into()))?;

        let uuid = extract_person_uuid(id);
        info!("Bot person ID cached for self-message filtering: {}", uuid);
        *self.bot_person_id.lock().await = Some(uuid);
        Ok(())
    }

    async fn connect_internal(&self) -> Result<(), WebexError> {
        let token = self.token.lock().await.clone();

        // Step 1: Register device with WDM
        let reg = {
            let mut dm = self.device_manager.lock().await;
            dm.register(&token).await?
        };
        info!("Device registered");

        // Step 1.5: Fetch bot person info if self-message filtering is enabled
        if self.ignore_self_messages {
            self.fetch_bot_person_id().await?;
        }

        // Step 2: Create KMS client
        let kms = KmsClient::new(
            self.http_do.clone(),
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
        let bot_person_id = self.bot_person_id.clone();
        let recent_activity_ids = self.recent_activity_ids.clone();
        let metrics_callback = self.metrics_callback.clone();

        tokio::spawn(async move {
            let mut sweep_interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    Some(event) = mercury_rx.recv() => {
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
                        let bot_person_id = bot_person_id.clone();
                        let metrics_callback = metrics_callback.clone();
                        tokio::spawn(async move {
                            let mut kms_guard = kms_client_clone.lock().await;
                            if let Some(ref mut kms) = *kms_guard {
                                let bot_id = bot_person_id.lock().await.clone();
                                Self::handle_activity_static(kms, &activity, &event_tx_clone, bot_id.as_deref(), metrics_callback).await;
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
                        if event_tx.send(HandlerEvent::Connected).await.is_err() {
                            warn!("Event receiver dropped, cannot send Connected event");
                        }
                    }
                    MercuryEvent::Disconnected(reason) => {
                        *connected.lock().await = false;
                        if event_tx.send(HandlerEvent::Disconnected(reason)).await.is_err() {
                            warn!("Event receiver dropped, cannot send Disconnected event");
                        }
                    }
                    MercuryEvent::Reconnecting(attempt) => {
                        if event_tx.send(HandlerEvent::Reconnecting(attempt)).await.is_err() {
                            warn!("Event receiver dropped, cannot send Reconnecting event");
                        }
                    }
                    MercuryEvent::Error(msg) => {
                        if event_tx.send(HandlerEvent::Error(msg)).await.is_err() {
                            warn!("Event receiver dropped, cannot send Error event");
                        }
                    }
                }
                    }
                    _ = sweep_interval.tick() => {
                        let mut ids = recent_activity_ids.lock().await;
                        let cutoff = Instant::now() - Duration::from_secs(300);
                        ids.retain(|_, &mut t| t > cutoff);
                    }
                }
            }
        });
    }

    /// Handle a single activity (decrypt and route).
    async fn handle_activity_static(
        kms: &mut KmsClient,
        activity: &MercuryActivity,
        event_tx: &mpsc::Sender<HandlerEvent>,
        bot_person_id: Option<&str>,
        metrics_callback: Option<Arc<dyn Fn(MetricsEvent) + Send + Sync>>,
    ) {
        // message:created or message:updated — verb=post/update + objectType=comment
        if (activity.verb == "post" || activity.verb == "update") && activity.object.object_type == "comment" {
            let mut decryptor = MessageDecryptor::new(kms);
            let decrypt_start = Instant::now();
            match decryptor.decrypt_activity(activity).await {
                Ok(decrypted) => {
                    if let Some(ref callback) = metrics_callback {
                        callback(MetricsEvent {
                            name: "decrypt".to_string(),
                            duration_ms: decrypt_start.elapsed().as_secs_f64() * 1000.0,
                            success: true,
                            metadata: None,
                        });
                    }
                    let mentions = parse_mentions(decrypted.object.content.as_deref());
                    let msg = DecryptedMessage {
                        id: decrypted.id.clone(),
                        parent_id: decrypted.parent.as_ref().map(|p| p.id.clone()),
                        mentioned_people: mentions.mentioned_people,
                        mentioned_groups: mentions.mentioned_groups,
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
                        files: decrypted.object.files.clone().unwrap_or_default(),
                        raw: decrypted,
                    };

                    // Filter self-messages if enabled
                    if let Some(bot_id) = bot_person_id {
                        if extract_person_uuid(&msg.person_id) == bot_id {
                            info!("Ignoring self-message from bot ({})", bot_id);
                            return;
                        }
                    }

                    let event = if activity.verb == "update" {
                        HandlerEvent::MessageUpdated(msg)
                    } else {
                        HandlerEvent::MessageCreated(msg)
                    };
                    if event_tx.send(event).await.is_err() {
                        warn!("Event receiver dropped, cannot send message event");
                    }
                }
                Err(e) => {
                    if let Some(ref callback) = metrics_callback {
                        callback(MetricsEvent {
                            name: "decrypt".to_string(),
                            duration_ms: decrypt_start.elapsed().as_secs_f64() * 1000.0,
                            success: false,
                            metadata: None,
                        });
                    }
                    error!("Error decrypting activity: {e}");
                    if event_tx.send(HandlerEvent::Error(e.to_string())).await.is_err() {
                        warn!("Event receiver dropped, cannot send Error event");
                    }
                }
            }
            return;
        }

        // message:deleted — verb=delete + objectType=activity
        if activity.verb == "delete" && activity.object.object_type == "activity" {
            if event_tx.send(HandlerEvent::MessageDeleted(DeletedMessage {
                message_id: activity.object.id.clone(),
                room_id: activity.target.id.clone(),
                person_id: activity.actor.id.clone(),
            })).await.is_err() {
                warn!("Event receiver dropped, cannot send MessageDeleted event");
            }
            return;
        }

        // membership:created — membership verbs + objectType=person
        let membership_verbs = ["add", "leave", "assignModerator", "unassignModerator"];
        if membership_verbs.contains(&activity.verb.as_str())
            && activity.object.object_type == "person"
        {
            let event = HandlerEvent::MembershipCreated(MembershipActivity {
                id: activity.id.clone(),
                actor_id: activity.actor.id.clone(),
                person_id: activity.object.id.clone(),
                room_id: activity.target.id.clone(),
                action: activity.verb.clone(),
                created: activity.published.clone(),
                room_type: infer_room_type(activity),
                raw: activity.clone(),
            });
            if event_tx.send(event).await.is_err() {
                warn!("Event receiver dropped, cannot send MembershipCreated event");
            }
            return;
        }

        // attachmentAction:created — verb=cardAction + objectType=submit
        if activity.verb == "cardAction" && activity.object.object_type == "submit" {
            let event = HandlerEvent::AttachmentActionCreated(AttachmentAction {
                id: activity.id.clone(),
                message_id: activity.parent.as_ref().map(|p| p.id.clone()).unwrap_or_default(),
                person_id: activity.actor.id.clone(),
                person_email: activity.actor.email_address.clone().unwrap_or_default(),
                room_id: activity.target.id.clone(),
                inputs: activity.object.inputs.clone().unwrap_or(serde_json::Value::Object(Default::default())),
                created: activity.published.clone(),
                raw: activity.clone(),
            });
            if event_tx.send(event).await.is_err() {
                warn!("Event receiver dropped, cannot send AttachmentActionCreated event");
            }
            return;
        }

        // room:created or room:updated — verb=create/update + object.objectType=conversation
        if (activity.verb == "create" || activity.verb == "update")
            && activity.object.object_type == "conversation"
        {
            let action = if activity.verb == "create" { "created" } else { "updated" };
            let ra = RoomActivity {
                id: activity.id.clone(),
                room_id: activity.target.id.clone(),
                actor_id: activity.actor.id.clone(),
                action: action.to_string(),
                created: activity.published.clone(),
                raw: activity.clone(),
            };
            let event = if activity.verb == "create" {
                HandlerEvent::RoomCreated(ra)
            } else {
                HandlerEvent::RoomUpdated(ra)
            };
            if event_tx.send(event).await.is_err() {
                warn!("Event receiver dropped, cannot send room event");
            }
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
        *self.bot_person_id.lock().await = None;
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
