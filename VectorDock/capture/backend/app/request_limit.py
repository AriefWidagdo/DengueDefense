"""Request-body size limiting at the ASGI receive layer.

The multipart/form parser and route code must never read an unlimited body
before size validation. This middleware pre-reads the request body from
`receive` up to a bounded cap, counting ACTUAL bytes: it does not trust
Content-Length and works with chunked or absent-length encodings.

- If the actual byte count exceeds the cap, the middleware stops reading,
  returns a truthful 413 response, and never invokes the application: no
  upload record, no file write, and no dispatch happen.
- Otherwise the buffered body (bounded by the cap) is replayed to the
  application unchanged.

The cap equals the decoded-image limit plus a documented multipart overhead
allowance (`CAPTURE_MULTIPART_OVERHEAD_BYTES`, default 2 MiB for form fields,
boundaries and encoding), so a valid 12 MiB image still passes.
"""

from __future__ import annotations

import json
from typing import Callable

BODY_METHODS = {"POST", "PUT", "PATCH"}


class RequestSizeLimitMiddleware:
    """Pure ASGI middleware: bounds the request body at the receive layer."""

    def __init__(self, app, limit_bytes: Callable[[], int]) -> None:
        self.app = app
        self._limit_bytes = limit_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope.get("method") not in BODY_METHODS:
            await self.app(scope, receive, send)
            return
        limit = int(self._limit_bytes())
        buffered: list[dict] = []
        total = 0
        disconnected = False
        while True:
            message = await receive()
            mtype = message.get("type")
            if mtype == "http.disconnect":
                disconnected = True
                break
            if mtype != "http.request":
                # Non-body lifecycle messages are replayed untouched.
                buffered.append(message)
                continue
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > limit:
                # Stop reading immediately; the client keeps sending but the
                # server answers 413 and never parses or stores the body.
                await self._send_413(send, limit, total)
                return
            buffered.append(message)
            if not message.get("more_body"):
                break
        if disconnected:
            return

        replay = iter(buffered)

        async def replay_receive() -> dict:
            try:
                return next(replay)
            except StopIteration:
                return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)

    async def _send_413(self, send, limit: int, total: int) -> None:
        payload = json.dumps(
            {
                "detail": (
                    f"Request body exceeds the {limit} byte upload cap "
                    f"(received at least {total} bytes); nothing was stored or dispatched"
                )
            }
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode("ascii")),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})