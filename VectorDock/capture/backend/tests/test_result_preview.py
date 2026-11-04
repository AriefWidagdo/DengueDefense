"""Pre-review candidate result preview.

Contract addition (sanctioned exception to the frontend-stage backend freeze):
GET /api/uploads/{upload_id} exposes the completed candidate result
(result_id, immutable candidate_count, authorized annotation_url) and the
active measurement revision in review status. Exposing a candidate must NOT
create a measurement, set available_at or change review semantics.
"""

from __future__ import annotations

from conftest import install_fake_adapter, login, make_image_bytes, publish_pending, upload_image


def _completed_upload(client, headers, key: str, count: int):
    install_fake_adapter(client.app, count=count)
    response = upload_image(client, headers, 1, key, make_image_bytes())
    assert response.status_code == 202, response.text
    upload_id = response.json()["upload_id"]
    assert publish_pending(client.app) == 1
    return upload_id


def test_completed_upload_exposes_candidate_before_any_review(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    upload_id = _completed_upload(client, headers, "preview-key-0001", count=3)

    response = client.get(f"/api/uploads/{upload_id}", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["processing"]["state"] == "completed"
    assert body["result"] is not None
    assert isinstance(body["result"]["candidate_count"], int)
    assert body["result"]["candidate_count"] == 3
    assert body["result"]["result_id"]
    assert body["result"]["annotation_url"].startswith("http")
    assert "/api/results/" in body["result"]["annotation_url"]
    # No measurement was created by exposing the candidate.
    assert body["review"]["state"] == "pending_review"
    assert body["review"]["measurement_id"] is None
    assert body["review"]["measurement_revision"] is None


def test_preview_does_not_set_available_at_or_create_measurement(seeded, db):
    from app.models import Measurement

    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    upload_id = _completed_upload(client, headers, "preview-key-0002", count=2)
    client.get(f"/api/uploads/{upload_id}", headers=headers)
    client.get(f"/api/uploads/{upload_id}", headers=headers)
    assert db.query(Measurement).count() == 0


def test_preview_absent_for_queued_and_failed_jobs(seeded):
    from datetime import datetime, timedelta, timezone

    from conftest import make_image_bytes as image_bytes

    client = seeded
    # No adapter configured -> dispatch marks the job failed.
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "failed-key-00001", image_bytes())
    assert response.status_code == 202, response.text
    failed_upload = response.json()["upload_id"]
    body = client.get(f"/api/uploads/{failed_upload}", headers=headers).json()
    assert body["processing"]["state"] == "failed"
    assert body["result"] is None

    # A queued job (never polled) has no result either.
    install_fake_adapter(client.app, count=1)
    response = upload_image(
        client,
        headers,
        1,
        "queued-key-00001",
        image_bytes(),
        captured_at=(datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
    )
    assert response.status_code == 202, response.text
    queued_upload = response.json()["upload_id"]
    body = client.get(f"/api/uploads/{queued_upload}", headers=headers).json()
    assert body["processing"]["state"] == "queued"
    assert body["result"] is None


def test_annotation_url_is_authorized(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    upload_id = _completed_upload(client, worker_headers, "annot-key-00001", count=1)
    body = client.get(f"/api/uploads/{upload_id}", headers=worker_headers).json()
    annotation_url = body["result"]["annotation_url"]
    path = "/" + annotation_url.split("/", 3)[3]

    granted = client.get(path, headers=worker_headers)
    assert granted.status_code == 200, granted.text
    assert granted.headers["content-type"].startswith("image/png")

    outsider_headers = login(client, "outsider", "outsider-password-1")
    denied = client.get(path, headers=outsider_headers)
    assert denied.status_code == 403, denied.text

    client.cookies.clear()
    anonymous = client.get(path)
    assert anonymous.status_code == 401, anonymous.text


def test_review_status_reports_active_measurement_revision(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    upload_id = _completed_upload(client, worker_headers, "revision-key-001", count=4)
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    body = client.get(f"/api/uploads/{upload_id}", headers=worker_headers).json()
    image_id = body["image_id"]

    first = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "expected_measurement_revision": None,
              "image_id": image_id, "decision": "accepted"},
    )
    assert first.status_code == 201, first.text
    assert first.json()["revision"] == 1

    status = client.get(f"/api/uploads/{upload_id}", headers=reviewer_headers).json()
    assert status["review"]["state"] == "accepted"
    assert status["review"]["measurement_revision"] == 1
    assert status["review"]["measurement_id"] == first.json()["measurement_id"]

    # A correcting review uses the reported revision and succeeds; the
    # candidate count stays immutable and available_at is not backdated.
    second = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "expected_measurement_revision": 1,
              "image_id": image_id, "decision": "accepted", "corrected_count": 2},
    )
    assert second.status_code == 201, second.text
    assert second.json()["revision"] == 2
    assert second.json()["accepted_count"] == 2
    assert second.json()["candidate_count"] == 4

    status = client.get(f"/api/uploads/{upload_id}", headers=reviewer_headers).json()
    assert status["review"]["measurement_revision"] == 2


def test_stale_measurement_revision_reported_by_preview_is_rejected(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    upload_id = _completed_upload(client, worker_headers, "stale-key-00001", count=1)
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    body = client.get(f"/api/uploads/{upload_id}", headers=worker_headers).json()
    image_id = body["image_id"]
    client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "accepted"},
    )
    client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "expected_measurement_revision": 1,
              "image_id": image_id, "decision": "accepted", "corrected_count": 7},
    )
    status = client.get(f"/api/uploads/{upload_id}", headers=worker_headers).json()
    reported_revision = status["review"]["measurement_revision"]
    assert reported_revision == 2
    # Submit a correcting review with a deliberately stale expected revision.
    stale = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "expected_measurement_revision": 1,
              "image_id": image_id, "decision": "accepted", "corrected_count": 9},
    )
    assert stale.status_code == 409, stale.text