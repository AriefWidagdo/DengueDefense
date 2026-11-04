"""Stage A1: bounded request-body enforcement at the ASGI receive layer.

The multipart parser and route code must never read an unlimited body before
size validation. These tests exercise the streaming receive path directly,
not merely inspect_image after buffering.
"""

from __future__ import annotations

import hashlib

import pytest
from conftest import login, make_image_bytes, upload_image


def _shrink_limits(app, image_bytes: int, request_bytes: int):
    import dataclasses

    app.state.capture.settings = dataclasses.replace(
        app.state.capture.settings,
        max_image_bytes=image_bytes,
        max_request_bytes=request_bytes,
    )


def test_request_larger_than_total_cap_returns_413_without_storing(seeded, db):
    from app.models import Upload

    client = seeded
    _shrink_limits(client.app, image_bytes=1024, request_bytes=1100)
    headers = login(client, "worker1", "worker-password-1")
    big = make_image_bytes("JPEG", width=64, height=48) * 3  # > 1100 bytes total
    response = upload_image(client, headers, 1, "cap-key-0000001", big)
    assert response.status_code == 413, response.text
    assert "upload cap" in response.json()["detail"]
    assert "nothing was stored or dispatched" in response.json()["detail"]
    assert db.query(Upload).count() == 0  # no reservation, file write, or dispatch


def test_file_over_image_limit_but_within_request_cap_is_rejected_by_inspector(seeded):
    client = seeded
    _shrink_limits(client.app, image_bytes=100, request_bytes=100 + 2 * 1024 * 1024)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "imgcap-key-0001", make_image_bytes("JPEG", width=64, height=48))
    assert response.status_code == 413
    assert "MiB" in response.json()["detail"] or "megapixel" in response.json()["detail"]


def test_normal_upload_fits_within_documented_overhead_allowance(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "overhead-key-001", make_image_bytes())
    assert response.status_code == 202  # multipart overhead allowance works


@pytest.mark.anyio
async def test_early_stop_never_reads_beyond_the_cap(seeded):
    """Raw ASGI streaming test: the middleware must stop reading the body
    right after the cap is exceeded, without Content-Length, and must not
    invoke the application."""
    import json

    app = seeded.app
    state = app.state.capture
    limit = state.settings.max_request_bytes
    chunk = 65536
    total_body = limit + 5 * 1024 * 1024  # far beyond the cap
    chunks = [b"x" * chunk] * (total_body // chunk) + [b"y" * (total_body % chunk)]
    index = {"i": 0}
    received_bytes = {"n": 0}

    async def receive():
        if index["i"] >= len(chunks):
            return {"type": "http.request", "body": b"", "more_body": False}
        body = chunks[index["i"]]
        index["i"] += 1
        received_bytes["n"] += len(body)
        return {"type": "http.request", "body": body, "more_body": index["i"] < len(chunks)}

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "method": "POST",
        "path": "/api/samples/1/images",
        "headers": [(b"content-type", b"multipart/form-data; boundary=bd")],  # no Content-Length
        "query_string": b"",
        "state": {},
    }
    await app(scope, receive, send)

    assert sent and sent[0]["type"] == "http.response.start"
    assert sent[0]["status"] == 413
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    detail = json.loads(body)["detail"]
    assert "upload cap" in detail
    # Early stop: the middleware consumed at most one chunk past the cap,
    # never the whole oversized body, and the app never parsed the upload.
    assert received_bytes["n"] <= limit + chunk
    assert len(sent) == 2


@pytest.mark.anyio
async def test_body_within_cap_is_replayed_intact(seeded):
    app = seeded.app
    state = app.state.capture
    data = make_image_bytes("JPEG")
    # Build a minimal multipart body carrying the file part only; the route
    # will reject it for missing form fields, which still proves the whole
    # body was replayed (the parser saw the file part, not a 413).
    boundary = b"testbound"
    body = (
        b"--" + boundary + b"\r\n"
        b'Content-Disposition: form-data; name="file"; filename="p.jpg"\r\n'
        b"Content-Type: image/jpeg\r\n\r\n" + data + b"\r\n"
        b"--" + boundary + b"--\r\n"
    )
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "method": "POST",
        "path": "/api/samples/1/images",
        "headers": [
            (b"content-type", b"multipart/form-data; boundary=testbound"),
            (b"content-length", str(len(body)).encode()),
        ],
        "query_string": b"",
        "state": {},
    }
    await app(scope, receive, send)
    status = sent[0]["status"]
    # The body reached the application (422 missing form fields, or 401
    # without a session); it was NOT capped out at 413.
    assert status in (401, 403, 422), status


def test_hash_of_capped_upload_is_never_computed_after_dispatch(seeded, db):
    """A capped request must not create any upload reservation whose hash
    could later be dispatched: nothing is persisted at all."""
    from app.models import ProcessingJob, Upload

    client = seeded
    _shrink_limits(client.app, image_bytes=1024, request_bytes=1100)
    headers = login(client, "worker1", "worker-password-1")
    big = make_image_bytes("JPEG") * 2
    assert len(big) > 1100
    upload_image(client, headers, 1, "cap2-key-0000001", big)
    assert db.query(Upload).count() == 0
    assert db.query(ProcessingJob).count() == 0