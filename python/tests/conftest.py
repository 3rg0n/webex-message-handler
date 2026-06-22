"""Pytest configuration and fixtures."""

import json as _json

import aiohttp

from webex_message_handler.types import FetchRequest, FetchResponse


class MockHttpResponse:
    """A canned FetchResponse for the injected http_do adapter."""

    def __init__(self, status: int = 200, payload=None, *, exc: Exception | None = None):
        self.status = status
        self.ok = 200 <= status < 300
        self._payload = payload
        self._exc = exc

    async def json(self):
        return self._payload

    async def text(self):
        return _json.dumps(self._payload) if self._payload is not None else ""


class MockHttpDo:
    """Mocks HTTP at the injected ``http_do`` seam instead of patching aiohttp.

    Register canned responses keyed by ``(METHOD, url)``; the adapter pops them
    in registration order so repeated calls to the same endpoint can return
    different responses. A registered ``Exception`` is raised to simulate a
    network failure (mirroring the handler's try/except path).
    """

    def __init__(self):
        self._routes: dict[tuple[str, str], list] = {}
        self.calls: list[FetchRequest] = []

    def add(self, method: str, url: str, *, status: int = 200, payload=None, exc: Exception | None = None):
        self._routes.setdefault((method.upper(), url), []).append(
            MockHttpResponse(status=status, payload=payload, exc=exc)
        )
        return self

    async def __call__(self, request: FetchRequest) -> FetchResponse:
        self.calls.append(request)
        key = (request.method.upper(), request.url)
        queue = self._routes.get(key)
        if not queue:
            raise AssertionError(f"unexpected request: {request.method} {request.url}")
        response = queue.pop(0) if len(queue) > 1 else queue[0]
        if response._exc is not None:
            raise response._exc
        return response  # type: ignore[return-value]


async def create_test_http_do(connector: aiohttp.BaseConnector | None = None):
    """Create a test HTTP adapter for use in tests."""
    async def http_do(request: FetchRequest) -> FetchResponse:
        async with (
            aiohttp.ClientSession(connector=connector) as session,
            session.request(
                request.method,
                request.url,
                headers=request.headers,
                data=request.body,
            ) as response,
        ):
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
