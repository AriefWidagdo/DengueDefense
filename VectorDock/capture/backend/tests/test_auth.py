"""Authentication, authorization, CSRF and relay-credential tests."""

from __future__ import annotations

from conftest import login, make_image_bytes, upload_image


def test_login_sets_httponly_session_cookie(seeded):
    response = seeded.post("/api/auth/login", json={"username": "worker1", "password": "worker-password-1"})
    assert response.status_code == 200
    cookie_header = response.headers["set-cookie"]
    assert "vd_session=" in cookie_header
    assert "httponly" in cookie_header.lower()
    assert "samesite=lax" in cookie_header.lower()
    assert "secure" not in cookie_header.lower()  # test env runs plain http


def test_login_wrong_password_401(client):
    response = client.post("/api/auth/login", json={"username": "worker1", "password": "wrong"})
    assert response.status_code == 401


def test_me_requires_session(client):
    assert client.get("/api/auth/me").status_code == 401


def test_me_returns_grants(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.get("/api/auth/me", headers=headers)
    assert response.status_code == 200
    assert response.json()["granted_trap_ids"] == ["VD-001"]


def test_write_requires_csrf_token(seeded):
    client = seeded
    login(client, "worker1", "worker-password-1")  # sets cookie, drops token
    response = client.post(
        "/api/traps/VD-001/samples",
        json={"sample_type": "egg_strip", "installed_at": "2026-01-06T08:00:00+00:00", "strip_id": "S-1"},
    )
    assert response.status_code == 403
    assert "CSRF" in response.json()["detail"]


def test_untrusted_origin_rejected(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.post(
        "/api/traps/VD-001/samples",
        headers={**headers, "Origin": "https://evil.example"},
        json={"sample_type": "egg_strip", "installed_at": "2026-01-06T08:00:00+00:00", "strip_id": "S-1"},
    )
    assert response.status_code == 403


def test_forged_identity_header_rejected(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.get("/api/auth/me", headers={**headers, "X-Forwarded-User": "worker1"})
    assert response.status_code == 400
    response = client.get("/api/traps/VD-001", headers={**headers, "X-Vd-Operator": "admin1"})
    assert response.status_code == 400


def test_worker_cannot_review(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.post(
        "/api/samples/1/reviews",
        headers=headers,
        json={"expected_sample_revision": 1, "image_id": "img", "decision": "accepted"},
    )
    assert response.status_code == 403


def test_relay_token_alone_is_not_an_identity(seeded, monkeypatch):
    client = seeded
    token = client.app.state.capture.settings.relay_token
    response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_relay_token_with_wrong_value_401(seeded):
    client = seeded
    response = client.get("/api/auth/me", headers={"Authorization": "Bearer not-the-token"})
    assert response.status_code == 401


def test_no_grant_cannot_read_trap_or_upload(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    upload = upload_image(client, worker_headers, 1, "outsider-check-key", make_image_bytes())
    assert upload.status_code == 202
    upload_id = upload.json()["upload_id"]
    outsider_headers = login(client, "outsider", "outsider-password-1")  # replaces the session cookie
    assert client.get("/api/traps/VD-001", headers=outsider_headers).status_code == 403
    assert client.get(f"/api/uploads/{upload_id}", headers=outsider_headers).status_code == 403
    assert client.get(f"/api/images/{upload.json()['image_id']}/original", headers=outsider_headers).status_code == 403


def test_unknown_trap_not_leaked(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    # Unknown and unauthorized traps both return 403: no existence oracle.
    assert client.get("/api/traps/VD-404", headers=headers).status_code == 403


def test_relay_token_forwards_session(seeded):
    """The Cloudflare Pages proxy uses the relay credential plus the forwarded
    operator session; the credential alone is transport, not identity."""
    client = seeded
    token = client.app.state.capture.settings.relay_token
    headers = login(client, "worker1", "worker-password-1")
    response = client.get("/api/auth/me", headers={**headers, "Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["operator"]["username"] == "worker1"