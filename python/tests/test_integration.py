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
    """Send a message via REST API and receive it via Mercury.

    Note: Webex doesn't allow bots to message themselves, so you need to provide
    a target email (another bot or your personal email) via WEBEX_TEST_TARGET_EMAIL.
    """
    token = os.getenv("WEBEX_BOT_TOKEN")
    if not token:
        pytest.skip("WEBEX_BOT_TOKEN environment variable not set")

    target_email = os.getenv("WEBEX_TEST_TARGET_EMAIL")
    if not target_email:
        pytest.skip("WEBEX_TEST_TARGET_EMAIL environment variable not set (bots cannot message themselves)")

    print("\n🚀 Starting integration test...\n")

    # Create handler
    handler = WebexMessageHandler(
        WebexMessageHandlerConfig(
            token=token,
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

        # Step 2: Get bot's own email (for display purposes)
        print("2️⃣  Fetching bot identity...")
        async with aiohttp.ClientSession() as session:
            async with session.get(
                "https://webexapis.com/v1/people/me",
                headers={"Authorization": f"Bearer {token}"}
            ) as response:
                assert response.status == 200, f"Failed to get bot identity: {response.status}"
                whoami = await response.json()
                print(f"   Bot: {whoami['displayName']} ({whoami['emails'][0]})")
                print(f"   Target: {target_email}")

            # Step 3: Send message to target email
            print(f"3️⃣  Sending test message: \"{test_message}\"")
            async with session.post(
                "https://webexapis.com/v1/messages",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json"
                },
                json={
                    "toPersonEmail": target_email,
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
