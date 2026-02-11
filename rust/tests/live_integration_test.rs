/*
 * Live integration test: Send a message via REST API and receive it via Mercury WebSocket.
 *
 * This test verifies the entire pipeline:
 * 1. Device registration (WDM)
 * 2. Mercury WebSocket connection
 * 3. KMS initialization (ECDH handshake)
 * 4. Message send (REST API)
 * 5. Message receive (Mercury)
 * 6. Message decryption (KMS)
 *
 * Run with: WEBEX_BOT_TOKEN=your_token cargo test --test live_integration_test -- --nocapture --ignored
 */

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::timeout;
use webex_message_handler::{Config, HandlerEvent, WebexMessageHandler};

const TIMEOUT_SECONDS: u64 = 30;

#[derive(Debug, Deserialize)]
struct WebexPerson {
    id: String,
    emails: Vec<String>,
    #[serde(rename = "displayName")]
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct WebexMessage {
    id: String,
}

#[derive(Debug, Serialize)]
struct SendMessageRequest {
    #[serde(rename = "toPersonEmail")]
    to_person_email: String,
    text: String,
}

#[tokio::test]
#[ignore] // Only run with --ignored flag
async fn test_live_integration_send_and_receive() {
    let token = match std::env::var("WEBEX_BOT_TOKEN") {
        Ok(t) => t,
        Err(_) => {
            println!("⏭️  Skipping integration test: WEBEX_BOT_TOKEN not set");
            return;
        }
    };

    println!("\n🚀 Starting integration test...\n");

    // Create handler
    let handler = WebexMessageHandler::new(Config {
        token: token.clone(),
        ..Default::default()
    })
    .expect("Failed to create handler");

    // Unique test message
    let test_message = format!(
        "Integration test {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );

    let mut event_rx = handler
        .take_event_rx()
        .await
        .expect("Failed to get event receiver");

    // Step 1: Connect to Mercury
    println!("1️⃣  Connecting to Mercury...");
    handler.connect().await.expect("Failed to connect");

    // Step 2: Get bot's own email
    println!("2️⃣  Fetching bot identity...");
    let client = reqwest::Client::new();
    let whoami: WebexPerson = client
        .get("https://webexapis.com/v1/people/me")
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .expect("Failed to fetch bot identity")
        .json()
        .await
        .expect("Failed to parse bot identity");

    println!("   Bot: {} ({})", whoami.display_name, whoami.emails[0]);

    // Step 3: Send message to self
    println!("3️⃣  Sending test message: \"{}\"", test_message);
    let sent_msg: WebexMessage = client
        .post("https://webexapis.com/v1/messages")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&SendMessageRequest {
            to_person_email: whoami.emails[0].clone(),
            text: test_message.clone(),
        })
        .send()
        .await
        .expect("Failed to send message")
        .json()
        .await
        .expect("Failed to parse sent message");

    println!("   Message sent (ID: {})", sent_msg.id);

    // Step 4: Wait for message to arrive via Mercury
    println!("4️⃣  Waiting for message to arrive via Mercury...");

    let result = timeout(Duration::from_secs(TIMEOUT_SECONDS), async {
        while let Some(event) = event_rx.recv().await {
            match event {
                HandlerEvent::MessageCreated(msg) => {
                    println!("📨 Received message: \"{}\" from {}", msg.text, msg.person_email);
                    if msg.text == test_message {
                        return Some(msg.text);
                    }
                }
                HandlerEvent::Connected => {
                    println!("✅ Connected to Mercury");
                }
                HandlerEvent::Error(err) => {
                    println!("❌ Handler error: {}", err);
                }
                _ => {}
            }
        }
        None
    })
    .await;

    // Step 5: Verify result
    println!("\n📊 Test Results:");
    match result {
        Ok(Some(received_text)) => {
            println!("✅ PASSED - Message received and decrypted successfully");
            println!("   Expected: \"{}\"", test_message);
            println!("   Received: \"{}\"", received_text);
            assert_eq!(received_text, test_message);
        }
        Ok(None) => {
            println!("❌ FAILED - Event stream ended without receiving message");
            panic!("Integration test failed: event stream ended");
        }
        Err(_) => {
            println!("❌ FAILED - Message not received within timeout");
            panic!("Integration test failed: timeout");
        }
    }

    // Cleanup
    println!("\n🧹 Cleaning up...");
    handler.disconnect().await;
    println!("✅ Disconnected");
}
