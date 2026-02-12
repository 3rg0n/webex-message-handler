"""
Integration test: Send a message via REST API and receive it via Mercury WebSocket.

This test verifies the entire pipeline:
1. Device registration (WDM)
2. Mercury WebSocket connection
3. KMS initialization (ECDH handshake)
4. Message send (REST API)
5. Message receive (Mercury)
6. Message decryption (KMS)

Run with: WEBEX_BOT_TOKEN=your_token pytest tests/test_integration.py -v
"""

import asyncio
import os
import time

import aiohttp
import pytest

from webex_message_handler import WebexMessageHandler, WebexMessageHandlerConfig

TIMEOUT_SECONDS = 30


@pytest.mark.asyncio
async def test_integration_send_and_receive():
    """Send a message FROM test bot TO receiver bot via REST API and receive via Mercury.

    Uses two bots: receiver bot (WEBEX_BOT_TOKEN) listens for messages,
    sender bot (WEBEX_BOT_TOKEN_TEST) sends test message.
    """
    receiver_token = os.getenv("WEBEX_BOT_TOKEN")
    if not receiver_token:
        pytest.skip("WEBEX_BOT_TOKEN environment variable not set (bot that receives messages)")

    sender_token = os.getenv("WEBEX_BOT_TOKEN_TEST")
    if not sender_token:
        pytest.skip("WEBEX_BOT_TOKEN_TEST environment variable not set (bot that sends test message)")

    print("\n🚀 Starting integration test...\n")

    # Create handler with receiver bot
    handler = WebexMessageHandler(
        WebexMessageHandlerConfig(
            token=receiver_token,
        )
    )

    # Unique test message
    test_message = f"Integration test {int(time.time() * 1000)}"
    received_message = []

    @handler.on("message:created")
    async def on_message(msg):
        print(f"📨 Received message: \"{msg.text}\" from {msg.person_email}")
        if msg.text == test_message:
            received_message.append(msg.text)

    @handler.on("connected")
    def on_connected():
        print("✅ Connected to Mercury")

    @handler.on("error")
    def on_error(err):
        print(f"❌ Handler error: {err}")

    try:
        # Step 1: Connect to Mercury
        print("1️⃣  Connecting to Mercury...")
        await handler.connect()

        # Step 2: Get bot identities
        print("2️⃣  Fetching bot identities...")
        async with aiohttp.ClientSession() as session:
            async with session.get(
                "https://webexapis.com/v1/people/me",
                headers={"Authorization": f"Bearer {receiver_token}"}
            ) as receiver_response, session.get(
                "https://webexapis.com/v1/people/me",
                headers={"Authorization": f"Bearer {sender_token}"}
            ) as sender_response:
                assert receiver_response.status == 200, (
                    f"Failed to get receiver bot identity: {receiver_response.status}"
                )
                assert sender_response.status == 200, f"Failed to get sender bot identity: {sender_response.status}"
                receiver = await receiver_response.json()
                sender = await sender_response.json()
                print(f"   Receiver: {receiver['displayName']} ({receiver['emails'][0]})")
                print(f"   Sender: {sender['displayName']} ({sender['emails'][0]})")

            # Step 3: Send message FROM sender bot TO receiver bot
            print(f"3️⃣  Sending test message: \"{test_message}\"")
            async with session.post(
                "https://webexapis.com/v1/messages",
                headers={
                    "Authorization": f"Bearer {sender_token}",
                    "Content-Type": "application/json"
                },
                json={
                    "toPersonEmail": receiver['emails'][0],
                    "text": test_message
                }
            ) as response:
                assert response.status == 200, f"Failed to send message: {response.status}"
                sent_msg = await response.json()
                print(f"   Message sent (ID: {sent_msg['id']})")

        # Step 4: Wait for message to arrive via Mercury
        print("4️⃣  Waiting for message to arrive via Mercury...")
        start_time = time.time()
        while not received_message and (time.time() - start_time) < TIMEOUT_SECONDS:
            await asyncio.sleep(0.5)

        # Step 5: Verify result
        print("\n📊 Test Results:")
        assert received_message, "Message not received within timeout"
        assert received_message[0] == test_message
        print("✅ PASSED - Message received and decrypted successfully")
        print(f"   Expected: \"{test_message}\"")
        print(f"   Received: \"{received_message[0]}\"")

    finally:
        # Cleanup
        print("\n🧹 Cleaning up...")
        await handler.disconnect()
        print("✅ Disconnected\n")


if __name__ == "__main__":
    asyncio.run(test_integration_send_and_receive())
    print("✅ Integration test completed successfully")
