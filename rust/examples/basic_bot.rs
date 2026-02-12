//! Basic bot example using webex-message-handler.
//!
//! Set WEBEX_BOT_TOKEN environment variable and run:
//!   cargo run --example basic_bot

use std::env;
use tokio::signal;
use tracing_subscriber;
use webex_message_handler::{Config, HandlerEvent, WebexMessageHandler};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing (logging)
    tracing_subscriber::fmt()
        .with_env_filter("webex_message_handler=debug,basic_bot=debug")
        .init();

    let token = env::var("WEBEX_BOT_TOKEN").expect("WEBEX_BOT_TOKEN environment variable not set");

    let handler = WebexMessageHandler::new(Config {
        token,
        ..Default::default()
    })?;

    // Take the event receiver before connecting
    let mut rx = handler
        .take_event_rx()
        .await
        .expect("Event receiver already taken");

    // Connect to Webex
    handler.connect().await?;
    println!("Bot is running. Press Ctrl+C to stop.");

    // Spawn event processing loop
    let _event_handle = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                HandlerEvent::MessageCreated(msg) => {
                    let room_type = msg.room_type.as_deref().unwrap_or("unknown");
                    println!(
                        "[{} in {} ({})] {}",
                        msg.person_email, msg.room_id, room_type, msg.text
                    );
                }
                HandlerEvent::MessageDeleted(del) => {
                    println!(
                        "Message {} deleted by {} in {}",
                        del.message_id, del.person_id, del.room_id
                    );
                }
                HandlerEvent::MembershipCreated(membership) => {
                    println!(
                        "Membership {}: {} affected {} in {}",
                        membership.action, membership.actor_id, membership.person_id, membership.room_id
                    );
                }
                HandlerEvent::Connected => {
                    println!("Connected to Webex");
                }
                HandlerEvent::Disconnected(reason) => {
                    println!("Disconnected: {reason}");
                }
                HandlerEvent::Reconnecting(attempt) => {
                    println!("Reconnecting (attempt {attempt})...");
                }
                HandlerEvent::Error(err) => {
                    eprintln!("Error: {err}");
                }
            }
        }
    });

    // Wait for Ctrl+C
    signal::ctrl_c().await?;
    println!("\nShutting down...");

    handler.disconnect().await;
    println!("Disconnected. Goodbye!");

    Ok(())
}
