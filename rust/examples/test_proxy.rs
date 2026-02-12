//! Proxy validation test via mitmproxy.
//!
//! Run with: WEBEX_BOT_TOKEN=... cargo run --example test_proxy
//! Requires mitmproxy running on localhost:8080.
//!
//! Note: Only HTTP traffic (device registration, KMS) routes through the proxy.
//! WebSocket (Mercury) connects directly — tokio-tungstenite does not support
//! HTTP CONNECT proxy. This is a known limitation of the Rust implementation.

use std::env;
use std::time::Duration;
use tokio::time;
use webex_message_handler::{Config, HandlerEvent, WebexMessageHandler};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter("webex_message_handler=debug")
        .init();

    let token = env::var("WEBEX_BOT_TOKEN").expect("WEBEX_BOT_TOKEN environment variable not set");

    let proxy_url = env::var("HTTPS_PROXY").unwrap_or_else(|_| "http://localhost:8080".into());
    println!("\n=== Webex Proxy Test (Rust) ===");
    println!("Using proxy: {proxy_url}");
    println!("Note: HTTP requests go through proxy; WebSocket connects directly\n");

    // Build reqwest client that routes HTTP through mitmproxy
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::https(&proxy_url)?)
        .proxy(reqwest::Proxy::http(&proxy_url)?)
        .danger_accept_invalid_certs(true) // Trust mitmproxy's CA
        .build()?;

    let handler = WebexMessageHandler::new(Config {
        token,
        client: Some(client),
        ..Default::default()
    })?;

    let mut rx = handler
        .take_event_rx()
        .await
        .expect("Event receiver already taken");

    println!("Connecting to Webex through proxy...");
    handler.connect().await?;

    let connected = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                HandlerEvent::Connected => {
                    println!("\nSUCCESS: Connected through proxy!");
                    println!("   - Device registered (via proxy)");
                    println!("   - Mercury WebSocket connected (direct)");
                    println!("   - KMS initialized (via proxy)");
                    return true;
                }
                HandlerEvent::Error(err) => {
                    eprintln!("\nERROR: {err}");
                    return false;
                }
                _ => {}
            }
        }
        false
    });

    match time::timeout(Duration::from_secs(30), connected).await {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) | Ok(Err(_)) => {
            eprintln!("FAILED: Connection error");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("FAILED: Timeout waiting for connection");
            std::process::exit(1);
        }
    }

    time::sleep(Duration::from_secs(3)).await;
    println!("\nProxy validation complete - disconnecting...");
    handler.disconnect().await;
    println!("SUCCESS: Rust proxy test passed\n");

    Ok(())
}
