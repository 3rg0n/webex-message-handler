"""Pytest configuration and fixtures."""

import aiohttp

from webex_message_handler.types import FetchRequest, FetchResponse


async def create_test_http_do(connector: aiohttp.BaseConnector | None = None):
    """Create a test HTTP adapter for use in tests."""
    async def http_do(request: FetchRequest) -> FetchResponse:
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.request(
                request.method,
                request.url,
                headers=request.headers,
                data=request.body,
            ) as response:
                # Eagerly read the response body before the context closes
                body_bytes = await response.read()
                status = response.status
                ok = 200 <= status < 300

                class TestFetchResponse:
                    def __init__(self):
                        self.status = status
                        self.ok = ok
                        self._body = body_bytes

                    async def json(self):
                        import json
                        return json.loads(self._body.decode('utf-8'))

                    async def text(self):
                        return self._body.decode('utf-8')

                return TestFetchResponse()  # type: ignore[return-value]

    return http_do
