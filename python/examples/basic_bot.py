"""Basic Webex bot example using webex-message-handler."""

import asyncio
import logging
import os
import signal

from webex_message_handler import WebexMessageHandler, WebexMessageHandlerConfig, console_logger

logger = logging.getLogger("basic_bot")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


async def main() -> None:
    token = os.environ.get("WEBEX_BOT_TOKEN")
    if not token:
        print("Set WEBEX_BOT_TOKEN environment variable")
        return

    handler = WebexMessageHandler(
        WebexMessageHandlerConfig(token=token, logger=console_logger)
    )

    @handler.on("message:created")
    async def on_message(msg):
        print(f"[{msg.person_email}] {msg.text}", flush=True)
        if msg.html:
            print(f"  HTML: {msg.html}", flush=True)

    @handler.on("message:deleted")
    def on_deleted(data):
        print(f"Message {data.message_id} deleted by {data.person_id}")

    @handler.on("connected")
    def on_connected():
        print("Connected to Webex", flush=True)

    @handler.on("disconnected")
    def on_disconnected(reason):
        print(f"Disconnected: {reason}", flush=True)

    @handler.on("reconnecting")
    def on_reconnecting(attempt):
        print(f"Reconnecting (attempt {attempt})...", flush=True)

    @handler.on("error")
    def on_error(err):
        print(f"Error: {err}", flush=True)

    # Graceful shutdown
    loop = asyncio.get_event_loop()
    stop_event = asyncio.Event()

    def _shutdown():
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            signal.signal(sig, lambda s, f: _shutdown())

    try:
        await handler.connect()
        await stop_event.wait()
    except KeyboardInterrupt:
        pass
    finally:
        print("Shutting down...")
        await handler.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
