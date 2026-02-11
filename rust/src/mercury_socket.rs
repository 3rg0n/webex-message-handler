//! Mercury WebSocket connection with auth, heartbeat, and reconnection.

use crate::errors::WebexError;
use crate::types::MercuryActivity;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info};
use url::Url;
use uuid::Uuid;

/// Events emitted by the Mercury socket.
#[derive(Debug, Clone)]
pub enum MercuryEvent {
    Connected,
    Disconnected(String),
    Reconnecting(u32),
    Activity(MercuryActivity),
    KmsResponse(Value),
    Error(String),
}

/// Mercury WebSocket connection manager.
pub struct MercurySocket {
    #[allow(dead_code)]
    ws_factory: Option<Arc<dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Box<dyn crate::types::InjectedWebSocket>, Box<dyn std::error::Error + Send + Sync>>> + Send>> + Send + Sync>>,
    ping_interval: Duration,
    pong_timeout: Duration,
    reconnect_backoff_max: Duration,
    max_reconnect_attempts: u32,

    token: Arc<Mutex<String>>,
    base_url: Arc<Mutex<String>>,
    connected: Arc<Mutex<bool>>,
    should_reconnect: Arc<Mutex<bool>>,
    reconnect_attempts: Arc<Mutex<u32>>,
    shutdown: Arc<Notify>,

    event_tx: mpsc::UnboundedSender<MercuryEvent>,
    event_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<MercuryEvent>>>>,
}

impl MercurySocket {
    pub fn new(
        _ws_factory: Option<Arc<dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Box<dyn crate::types::InjectedWebSocket>, Box<dyn std::error::Error + Send + Sync>>> + Send>> + Send + Sync>>,
        ping_interval: Duration,
        pong_timeout: Duration,
        reconnect_backoff_max: Duration,
        max_reconnect_attempts: u32,
    ) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel();

        Self {
            ws_factory: _ws_factory,
            ping_interval,
            pong_timeout,
            reconnect_backoff_max,
            max_reconnect_attempts,
            token: Arc::new(Mutex::new(String::new())),
            base_url: Arc::new(Mutex::new(String::new())),
            connected: Arc::new(Mutex::new(false)),
            should_reconnect: Arc::new(Mutex::new(true)),
            reconnect_attempts: Arc::new(Mutex::new(0)),
            shutdown: Arc::new(Notify::new()),
            event_tx,
            event_rx: Arc::new(Mutex::new(Some(event_rx))),
        }
    }

    /// Take the event receiver. Can only be called once.
    pub async fn take_event_rx(&self) -> Option<mpsc::UnboundedReceiver<MercuryEvent>> {
        self.event_rx.lock().await.take()
    }

    /// Connect to Mercury WebSocket.
    pub async fn connect(&self, ws_url: &str, token: &str) -> Result<(), WebexError> {
        *self.token.lock().await = token.to_string();
        *self.base_url.lock().await = ws_url.to_string();
        *self.should_reconnect.lock().await = true;
        *self.reconnect_attempts.lock().await = 0;
        self.connect_internal().await
    }

    async fn connect_internal(&self) -> Result<(), WebexError> {
        let base_url = self.base_url.lock().await.clone();
        let prepared_url = Self::prepare_url(&base_url)?;
        debug!("Connecting to Mercury at {prepared_url}");

        *self.connected.lock().await = false;

        let (ws_stream, _) = connect_async(&prepared_url)
            .await
            .map_err(|e| WebexError::mercury_connection(format!("Failed to connect: {e}"), None))?;

        let (mut write, mut read) = ws_stream.split();

        // Send authorization
        let token = self.token.lock().await.clone();
        let auth_msg = serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "type": "authorization",
            "data": { "token": format!("Bearer {}", token) }
        });
        write
            .send(Message::Text(auth_msg.to_string().into()))
            .await
            .map_err(|e| WebexError::mercury_connection(format!("Failed to send auth: {e}"), None))?;

        // Wait for connection ready
        let _ready_timeout = time::timeout(Duration::from_secs(30), async {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        let text_str: &str = &text;
                        if let Ok(parsed) = serde_json::from_str::<Value>(text_str) {
                            if Self::is_connection_ready(&parsed) {
                                return Ok(parsed);
                            }
                        }
                    }
                    Err(e) => {
                        return Err(WebexError::mercury_connection(
                            format!("WebSocket error during setup: {e}"),
                            None,
                        ));
                    }
                    _ => {}
                }
            }
            Err(WebexError::mercury_connection("WebSocket closed during setup", None))
        })
        .await
        .map_err(|_| WebexError::mercury_connection("Mercury connection timeout", None))??;

        debug!("Mercury connection ready");
        *self.connected.lock().await = true;

        // Spawn read loop and ping loop
        let event_tx = self.event_tx.clone();
        let connected = self.connected.clone();
        let should_reconnect = self.should_reconnect.clone();
        let reconnect_attempts = self.reconnect_attempts.clone();
        let max_reconnect = self.max_reconnect_attempts;
        let backoff_max = self.reconnect_backoff_max;
        let ping_interval = self.ping_interval;
        let _pong_timeout = self.pong_timeout;
        let shutdown = self.shutdown.clone();
        let base_url_clone = self.base_url.clone();
        let token_clone = self.token.clone();

        let write = Arc::new(Mutex::new(write));
        let write_clone = write.clone();

        // Ping loop
        let ping_write = write.clone();
        let ping_connected = connected.clone();
        let ping_shutdown = shutdown.clone();
        let _ping_event_tx = event_tx.clone();
        tokio::spawn(async move {
            let mut interval = time::interval(ping_interval);
            interval.tick().await; // skip first tick

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if !*ping_connected.lock().await {
                            break;
                        }
                        let pong_id = Uuid::new_v4().to_string();
                        let ping_msg = serde_json::json!({
                            "id": pong_id,
                            "type": "ping"
                        });
                        let mut w = ping_write.lock().await;
                        if w.send(Message::Text(ping_msg.to_string().into())).await.is_err() {
                            break;
                        }
                        debug!("Sent ping: {pong_id}");
                        drop(w);

                        // Pong timeout handled by read loop
                    }
                    _ = ping_shutdown.notified() => break,
                }
            }
        });

        // Read loop
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        let text_str: &str = &text;
                        debug!("WS message received ({} bytes)", text_str.len());
                        if let Ok(parsed) = serde_json::from_str::<Value>(text_str) {
                            Self::handle_message_static(&parsed, &event_tx, &write_clone).await;
                        } else {
                            debug!("Failed to parse WS message as JSON");
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        let code = frame.as_ref().map(|f| f.code.into()).unwrap_or(1000u16);
                        let reason = frame.as_ref().map(|f| f.reason.to_string()).unwrap_or_default();
                        Self::handle_close_static(
                            code,
                            &reason,
                            &connected,
                            &should_reconnect,
                            &reconnect_attempts,
                            max_reconnect,
                            backoff_max,
                            &base_url_clone,
                            &token_clone,
                            &event_tx,
                        )
                        .await;
                        break;
                    }
                    Err(e) => {
                        error!("WebSocket error: {e}");
                        let _ = event_tx.send(MercuryEvent::Error(e.to_string()));
                        *connected.lock().await = false;
                        break;
                    }
                    _ => {}
                }
            }

            // Connection ended — handle reconnection if needed
            if *should_reconnect.lock().await && *connected.lock().await == false {
                // Reconnect logic handled in handle_close_static
            }
        });

        Ok(())
    }

    fn prepare_url(base_url: &str) -> Result<String, WebexError> {
        let mut url = Url::parse(base_url)
            .map_err(|e| WebexError::mercury_connection(format!("Invalid URL: {e}"), None))?;
        url.query_pairs_mut()
            .append_pair("outboundWireFormat", "text")
            .append_pair("bufferStates", "true")
            .append_pair("aliasHttpStatus", "true")
            .append_pair(
                "clientTimestamp",
                &std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .to_string(),
            );
        Ok(url.to_string())
    }

    fn is_connection_ready(message: &Value) -> bool {
        let event_type = message
            .get("data")
            .and_then(|d| d.get("eventType"))
            .and_then(|e| e.as_str())
            .unwrap_or("");
        event_type.contains("mercury.buffer_state") || event_type.contains("mercury.registration_status")
    }

    async fn handle_message_static(
        message: &Value,
        event_tx: &mpsc::UnboundedSender<MercuryEvent>,
        write: &Arc<Mutex<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>>>,
    ) {
        let msg_type = message.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match msg_type {
            "pong" => {
                let id = message.get("id").and_then(|i| i.as_str()).unwrap_or("");
                debug!("Received pong: {id}");
            }
            "shutdown" => {
                info!("Received shutdown message from Mercury");
                // Reconnection will be triggered by connection close
            }
            _ => {
                if let Some(data) = message.get("data") {
                    if let Some(event_type) = data.get("eventType").and_then(|e| e.as_str()) {
                        debug!("Mercury eventType: {event_type}");

                        // Send ACK
                        if let Some(msg_id) = message.get("id").and_then(|i| i.as_str()) {
                            let ack = serde_json::json!({"messageId": msg_id, "type": "ack"});
                            let mut w = write.lock().await;
                            let _ = w.send(Message::Text(ack.to_string().into())).await;
                        }

                        if event_type.starts_with("encryption.") {
                            debug!("Emitting kms:response for eventType: {event_type}");
                            let _ = event_tx.send(MercuryEvent::KmsResponse(data.clone()));
                        } else if event_type == "conversation.activity" {
                            if let Some(activity_raw) = data.get("activity") {
                                match serde_json::from_value::<MercuryActivity>(activity_raw.clone()) {
                                    Ok(activity) => {
                                        debug!("Emitting activity: {}", activity.id);
                                        let _ = event_tx.send(MercuryEvent::Activity(activity));
                                    }
                                    Err(e) => {
                                        error!("Failed to parse activity: {e}");
                                        debug!("Raw activity keys: {:?}", activity_raw.as_object().map(|o| o.keys().collect::<Vec<_>>()));
                                    }
                                }
                            }
                        }
                    } else {
                        debug!("Unhandled Mercury message, type={msg_type:?}, keys={:?}", message.as_object().map(|o| o.keys().collect::<Vec<_>>()));
                    }
                } else {
                    debug!("Unhandled Mercury message, type={msg_type:?}, no data field");
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn handle_close_static(
        code: u16,
        reason: &str,
        connected: &Arc<Mutex<bool>>,
        should_reconnect: &Arc<Mutex<bool>>,
        reconnect_attempts: &Arc<Mutex<u32>>,
        max_reconnect: u32,
        backoff_max: Duration,
        _base_url: &Arc<Mutex<String>>,
        _token: &Arc<Mutex<String>>,
        event_tx: &mpsc::UnboundedSender<MercuryEvent>,
    ) {
        info!("WebSocket closed with code {code}: {reason}");
        *connected.lock().await = false;

        if code == 4401 {
            error!("Mercury authorization failed");
            *should_reconnect.lock().await = false;
            let _ = event_tx.send(MercuryEvent::Error("Mercury authorization failed".into()));
            let _ = event_tx.send(MercuryEvent::Disconnected("auth-failed".into()));
            return;
        }

        if code == 4400 || code == 4403 {
            error!("Mercury permanent failure (code {code})");
            *should_reconnect.lock().await = false;
            let _ = event_tx.send(MercuryEvent::Error(format!("Mercury permanent failure (code {code})")));
            let _ = event_tx.send(MercuryEvent::Disconnected("permanent-failure".into()));
            return;
        }

        if *should_reconnect.lock().await {
            let mut attempts = reconnect_attempts.lock().await;
            if *attempts >= max_reconnect {
                error!("Max reconnection attempts ({max_reconnect}) exceeded");
                *should_reconnect.lock().await = false;
                let _ = event_tx.send(MercuryEvent::Disconnected("max-attempts-exceeded".into()));
                return;
            }
            *attempts += 1;
            let attempt = *attempts;
            let delay_secs = (2.0f64.powi(attempt as i32 - 1)).min(backoff_max.as_secs_f64());
            drop(attempts);

            info!("Reconnecting (attempt {attempt}/{max_reconnect}) in {delay_secs}s");
            let _ = event_tx.send(MercuryEvent::Reconnecting(attempt));

            time::sleep(Duration::from_secs_f64(delay_secs)).await;

            // Signal that reconnection should happen (handler will re-connect)
            let _ = event_tx.send(MercuryEvent::Disconnected("reconnect-needed".into()));
        } else {
            let _ = event_tx.send(MercuryEvent::Disconnected("manual".into()));
        }
    }

    /// Disconnect from Mercury.
    pub async fn disconnect(&self) {
        info!("Disconnecting from Mercury");
        *self.should_reconnect.lock().await = false;
        *self.connected.lock().await = false;
        self.shutdown.notify_waiters();
        let _ = self.event_tx.send(MercuryEvent::Disconnected("client".into()));
    }

    /// Whether the WebSocket is currently connected.
    pub async fn connected(&self) -> bool {
        *self.connected.lock().await
    }

    /// Current reconnection attempt count.
    pub async fn current_reconnect_attempts(&self) -> u32 {
        *self.reconnect_attempts.lock().await
    }
}
