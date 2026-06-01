//! Integration tests for webex-message-handler.
//!
//! These tests validate the public API surface and type construction.
//! Full integration tests require a live Webex bot token.

use webex_message_handler::{
    Config, ConnectionStatus, DeletedMessage, HandlerStatus, MembershipActivity,
    MercuryActivity, NetworkMode, WebexError, WebexMessageHandler,
};
use std::sync::Arc;

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
async fn test_device_registration_none_before_connect() {
    let handler = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        ..Default::default()
    })
    .unwrap();

    assert!(handler.device_registration().await.is_none());
    assert!(handler.service_url("conversationServiceUrl").await.is_none());
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
    // url is absent in this payload → None
    assert_eq!(activity.url, None);
}

#[test]
fn test_mercury_activity_deserializes_url() {
    let json = serde_json::json!({
        "id": "activity-123",
        "url": "https://conv-a.wbx2.com/conversation/api/v1/activities/activity-123",
        "verb": "post",
        "object": { "id": "o", "objectType": "comment" },
        "target": { "id": "t", "objectType": "conversation" },
        "published": "2024-01-01T00:00:00.000Z"
    });

    let activity: MercuryActivity = serde_json::from_value(json).unwrap();
    assert_eq!(
        activity.url,
        Some("https://conv-a.wbx2.com/conversation/api/v1/activities/activity-123".to_string())
    );
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

// Networking mode validation tests

#[test]
fn test_accepts_native_mode_with_client() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        mode: NetworkMode::Native,
        client: Some(reqwest::Client::new()),
        ..Default::default()
    });
    assert!(result.is_ok());
}

#[test]
fn test_accepts_default_native_mode() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        ..Default::default()
    });
    assert!(result.is_ok());
}

#[test]
fn test_rejects_injected_mode_missing_fetch() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        mode: NetworkMode::Injected,
        web_socket_factory: Some(Arc::new(|_url| {
            Box::pin(async { Err("not implemented".into()) })
        })),
        ..Default::default()
    });
    assert!(result.is_err());
    if let Err(e) = result {
        assert!(e.to_string().contains("Injected mode requires both"));
    }
}

#[test]
fn test_rejects_injected_mode_missing_ws_factory() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        mode: NetworkMode::Injected,
        fetch: Some(Arc::new(|_req| {
            Box::pin(async { Err("not implemented".into()) })
        })),
        ..Default::default()
    });
    assert!(result.is_err());
    if let Err(e) = result {
        assert!(e.to_string().contains("Injected mode requires both"));
    }
}

#[test]
fn test_rejects_injected_mode_with_client() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        mode: NetworkMode::Injected,
        client: Some(reqwest::Client::new()),
        fetch: Some(Arc::new(|_req| {
            Box::pin(async { Err("not implemented".into()) })
        })),
        web_socket_factory: Some(Arc::new(|_url| {
            Box::pin(async { Err("not implemented".into()) })
        })),
        ..Default::default()
    });
    assert!(result.is_err());
    if let Err(e) = result {
        assert!(e.to_string().contains("Cannot use native proxy parameters"));
    }
}

#[test]
fn test_rejects_native_mode_with_fetch() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        mode: NetworkMode::Native,
        fetch: Some(Arc::new(|_req| {
            Box::pin(async { Err("not implemented".into()) })
        })),
        ..Default::default()
    });
    assert!(result.is_err());
    if let Err(e) = result {
        assert!(e.to_string().contains("Cannot provide fetch/web_socket_factory in native mode"));
    }
}

#[test]
fn test_rejects_native_mode_with_ws_factory() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        mode: NetworkMode::Native,
        web_socket_factory: Some(Arc::new(|_url| {
            Box::pin(async { Err("not implemented".into()) })
        })),
        ..Default::default()
    });
    assert!(result.is_err());
    if let Err(e) = result {
        assert!(e.to_string().contains("Cannot provide fetch/web_socket_factory in native mode"));
    }
}

#[test]
fn test_rejects_default_mode_with_fetch() {
    let result = WebexMessageHandler::new(Config {
        token: "test-token".to_string(),
        fetch: Some(Arc::new(|_req| {
            Box::pin(async { Err("not implemented".into()) })
        })),
        ..Default::default()
    });
    assert!(result.is_err());
    if let Err(e) = result {
        assert!(e.to_string().contains("Cannot provide fetch/web_socket_factory in native mode"));
    }
}

#[test]
fn test_membership_activity_construction() {
    let activity = MembershipActivity {
        id: "membership-1".to_string(),
        actor_id: "admin-1".to_string(),
        person_id: "member-1".to_string(),
        room_id: "room-1".to_string(),
        action: "add".to_string(),
        created: "2024-01-01T00:00:00Z".to_string(),
        room_type: Some("group".to_string()),
        raw: MercuryActivity {
            id: "membership-1".to_string(),
            url: None,
            verb: "add".to_string(),
            actor: webex_message_handler::MercuryActor {
                id: "admin-1".to_string(),
                object_type: "person".to_string(),
                email_address: None,
            },
            object: webex_message_handler::MercuryObject {
                id: "member-1".to_string(),
                object_type: "person".to_string(),
                display_name: None,
                content: None,
                encryption_key_url: None,
                inputs: None,
                files: None,
            },
            target: webex_message_handler::MercuryTarget {
                id: "room-1".to_string(),
                object_type: "conversation".to_string(),
                encryption_key_url: None,
                tags: vec!["GROUP".to_string()],
            },
            published: "2024-01-01T00:00:00Z".to_string(),
            encryption_key_url: None,
            parent: None,
        },
    };
    assert_eq!(activity.id, "membership-1");
    assert_eq!(activity.actor_id, "admin-1");
    assert_eq!(activity.person_id, "member-1");
    assert_eq!(activity.room_id, "room-1");
    assert_eq!(activity.action, "add");
    assert_eq!(activity.room_type, Some("group".to_string()));
}

#[test]
fn test_membership_activity_all_verbs() {
    for verb in &["add", "leave", "assignModerator", "unassignModerator"] {
        let activity = MembershipActivity {
            id: "test".to_string(),
            actor_id: "actor".to_string(),
            person_id: "person".to_string(),
            room_id: "room".to_string(),
            action: verb.to_string(),
            created: "2024-01-01T00:00:00Z".to_string(),
            room_type: None,
            raw: MercuryActivity {
                id: "test".to_string(),
                url: None,
                verb: verb.to_string(),
                actor: Default::default(),
                object: Default::default(),
                target: Default::default(),
                published: String::new(),
                encryption_key_url: None,
                parent: None,
            },
        };
        assert_eq!(activity.action, *verb);
    }
}
