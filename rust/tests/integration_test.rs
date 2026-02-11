//! Integration tests for webex-message-handler.
//!
//! These tests validate the public API surface and type construction.
//! Full integration tests require a live Webex bot token.

use webex_message_handler::{
    Config, ConnectionStatus, DeletedMessage, HandlerStatus,
    MercuryActivity, WebexError, WebexMessageHandler,
};

#[test]
fn test_config_defaults() {
    let config = Config::default();
    assert_eq!(config.ping_interval, 15.0);
    assert_eq!(config.pong_timeout, 14.0);
    assert_eq!(config.reconnect_backoff_max, 32.0);
    assert_eq!(config.max_reconnect_attempts, 10);
    assert!(config.token.is_empty());
}

#[test]
fn test_handler_requires_token() {
    let result = WebexMessageHandler::new(Config::default());
    assert!(result.is_err());
}

#[test]
fn test_handler_creation_with_token() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        ..Default::default()
    });
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_handler_not_connected_initially() {
    let handler = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        ..Default::default()
    })
    .unwrap();

    assert!(!handler.connected().await);
}

#[tokio::test]
async fn test_handler_status_disconnected() {
    let handler = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        ..Default::default()
    })
    .unwrap();

    let status = handler.status().await;
    assert_eq!(status.status, ConnectionStatus::Disconnected);
    assert!(!status.web_socket_open);
    assert!(!status.kms_initialized);
    assert!(!status.device_registered);
    assert_eq!(status.reconnect_attempt, 0);
}

#[tokio::test]
async fn test_event_receiver_can_be_taken_once() {
    let handler = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        ..Default::default()
    })
    .unwrap();

    let rx1 = handler.take_event_rx().await;
    assert!(rx1.is_some());

    let rx2 = handler.take_event_rx().await;
    assert!(rx2.is_none());
}

#[test]
fn test_error_codes() {
    let auth_err = WebexError::auth("test");
    assert_eq!(auth_err.code(), "AUTH_ERROR");

    let device_err = WebexError::device_registration("test", Some(500));
    assert_eq!(device_err.code(), "DEVICE_REGISTRATION_ERROR");

    let mercury_err = WebexError::mercury_connection("test", None);
    assert_eq!(mercury_err.code(), "MERCURY_CONNECTION_ERROR");

    let kms_err = WebexError::kms("test");
    assert_eq!(kms_err.code(), "KMS_ERROR");

    let decrypt_err = WebexError::decryption("test");
    assert_eq!(decrypt_err.code(), "DECRYPTION_ERROR");
}

#[test]
fn test_connection_status_display() {
    assert_eq!(ConnectionStatus::Connected.to_string(), "connected");
    assert_eq!(ConnectionStatus::Connecting.to_string(), "connecting");
    assert_eq!(ConnectionStatus::Reconnecting.to_string(), "reconnecting");
    assert_eq!(ConnectionStatus::Disconnected.to_string(), "disconnected");
}

#[test]
fn test_mercury_activity_deserialization() {
    let json = serde_json::json!({
        "id": "activity-123",
        "verb": "post",
        "actor": {
            "id": "actor-id",
            "objectType": "person",
            "emailAddress": "test@example.com"
        },
        "object": {
            "id": "object-id",
            "objectType": "comment",
            "displayName": "Hello",
            "content": "<p>Hello</p>"
        },
        "target": {
            "id": "target-id",
            "objectType": "conversation",
            "tags": ["ONE_ON_ONE"]
        },
        "published": "2024-01-01T00:00:00.000Z"
    });

    let activity: MercuryActivity = serde_json::from_value(json).unwrap();
    assert_eq!(activity.id, "activity-123");
    assert_eq!(activity.verb, "post");
    assert_eq!(activity.actor.id, "actor-id");
    assert_eq!(activity.actor.email_address, Some("test@example.com".to_string()));
    assert_eq!(activity.object.object_type, "comment");
    assert_eq!(activity.object.display_name, Some("Hello".to_string()));
    assert_eq!(activity.object.content, Some("<p>Hello</p>".to_string()));
    assert_eq!(activity.target.tags, vec!["ONE_ON_ONE"]);
}

#[test]
fn test_deleted_message_construction() {
    let msg = DeletedMessage {
        message_id: "msg-1".to_string(),
        room_id: "room-1".to_string(),
        person_id: "person-1".to_string(),
    };
    assert_eq!(msg.message_id, "msg-1");
    assert_eq!(msg.room_id, "room-1");
    assert_eq!(msg.person_id, "person-1");
}

#[test]
fn test_handler_status_construction() {
    let status = HandlerStatus {
        status: ConnectionStatus::Connected,
        web_socket_open: true,
        kms_initialized: true,
        device_registered: true,
        reconnect_attempt: 0,
    };
    assert_eq!(status.status, ConnectionStatus::Connected);
    assert!(status.web_socket_open);
}
