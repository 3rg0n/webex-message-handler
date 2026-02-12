"""Proxy validation test via mitmproxy.

Run with: WEBEX_BOT_TOKEN=... python test-proxy.py
Requires mitmproxy running on localhost:8080.
"""

import asyncio
import os
import ssl
import sys

import aiohttp
from aiohttp import TCPConnector

# Add src to path for local development
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from webex_message_handler import WebexMessageHandler, WebexMessageHandlerConfig, console_logger


async def main() -> None:
    token = os.environ.get("WEBEX_BOT_TOKEN")
    if not token:
        print("Error: WEBEX_BOT_TOKEN environment variable not set")
        sys.exit(1)

    proxy_url = os.environ.get("HTTPS_PROXY", "http://localhost:8080")
    # Set HTTPS_PROXY so aiohttp's trust_env picks it up
    os.environ["HTTPS_PROXY"] = proxy_url
    os.environ["HTTP_PROXY"] = proxy_url

    print(f"\n=== Webex Proxy Test (Python) ===")
    print(f"Using proxy: {proxy_url}\n")

    # Create aiohttp connector with disabled SSL verification for mitmproxy
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    connector = TCPConnector(ssl=ssl_ctx)

    config = WebexMessageHandlerConfig(
        token=token,
        connector=connector,
        logger=console_logger,
    )

    handler = WebexMessageHandler(config)

    connected_event = asyncio.Event()

    @handler.on("connected")
    def on_connected() -> None:
        print("\nSUCCESS: Connected through proxy!")
        print("   - Device registered")
        print("   - Mercury WebSocket connected")
        print("   - KMS initialized")
        connected_event.set()

    @handler.on("error")
    def on_error(err: Exception) -> None:
        print(f"\nERROR: {err}")
        sys.exit(1)

    print("Connecting to Webex through proxy...")
    try:
        await handler.connect()
        await asyncio.sleep(3)
        print("\nProxy validation complete - disconnecting...\n")
        await handler.disconnect()
        await connector.close()
        print("SUCCESS: Python proxy test passed")
    except Exception as e:
        print(f"FAILED: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
