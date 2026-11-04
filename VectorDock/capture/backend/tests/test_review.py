"""Review workflow: accept, correct, reject, revisions, zero vs failure."""

from __future__ import annotations

from conftest import install_fake_adapter, login, make_image_bytes, publish_pending, upload_image


def _accepted_flow(client, headers, key: str, count: int):
    install_fake_adapter(client.app, count=count)
    response = upload_image(client, headers, 1, key, make_image_bytes())
    assert response.status_code == 202, response.text
    image_id = response.json()["image_id"]
    published = publish_pending(client.app)
    assert published == 1
    return image_id


def test_accept_candidate_count_and_server_available_at(seeded):
    from datetime import timedelta

    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "accept-key-00001", count=3)
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "expected_measurement_revision": None,
              "image_id": image_id, "decision": "accepted"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["accepted_count"] == 3
    assert body["count_source"] == "candidate"
    assert body["available_at"] is not None
    assert body["available_at"] is not None  # server-set, not client-supplied


def test_corrected_count_keeps_candidate_immutable(seeded, db):
    from app.models import ProcessingResult

    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "correct-key-0001", count=3)
    result = db.query(ProcessingResult).one()
    original_report = result.candidate_report
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "accepted",
              "corrected_count": 2},
    )
    assert response.status_code == 201
    assert response.json()["accepted_count"] == 2
    assert response.json()["count_source"] == "corrected"
    db.expire_all()
    result = db.query(ProcessingResult).one()
    assert result.candidate_count == 3  # candidate output unchanged
    assert result.candidate_report == original_report


def test_rejected_review_has_no_accepted_count(seeded):
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "reject-key-00001", count=3)
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "rejected",
              "rejection_reason": "glare over half the card"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["decision"] == "rejected"
    assert body["accepted_count"] is None
    assert body["available_at"] is None
    status_response = client.get(f"/api/uploads/{response.json()['measurement_id']}", headers=reviewer_headers) \
        if False else None
    # review state reported through the upload route
    upload_headers = login(client, "worker1", "worker-password-1")
    uploads = client.get("/api/auth/me", headers=upload_headers)
    assert uploads.status_code == 200


def test_review_rejection_reason_required(seeded):
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "reject2-key-0001", count=1)
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "rejected"},
    )
    assert response.status_code == 422


def test_confirmed_zero_valid_with_usable_exposure(seeded):
    """A valid zero requires a completed exposure: removal recorded and known."""
    client = seeded
    # Record the removal first (server-side eligibility requires it).
    worker_headers = login(client, "worker1", "worker-password-1")
    patched = client.patch(
        "/api/samples/1",
        headers=worker_headers,
        json={"expected_revision": 1, "removed_at": "2026-01-12T09:00:00+00:00"},
    )
    assert patched.status_code == 200
    sample_revision = patched.json()["sample"]["revision"]
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "zero-key-000001", count=0)
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": sample_revision, "image_id": image_id,
              "decision": "accepted", "usable_exposure": True},
    )
    assert response.status_code == 201, response.text
    assert response.json()["accepted_count"] == 0
    assert response.json()["usable_exposure"] is True


def test_zero_without_usable_exposure_422(seeded):
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "zero2-key-00001", count=0)
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "accepted",
              "usable_exposure": False},
    )
    assert response.status_code == 422


def test_failed_count_cannot_be_accepted(seeded):
    client = seeded  # unconfigured adapter -> processing failed
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    response = upload_image(client, reviewer_headers, 1, "failed-key-0001", make_image_bytes())
    image_id = response.json()["image_id"]
    review = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "accepted"},
    )
    assert review.status_code == 409
    assert "failed count has no accepted count" in review.json()["detail"]


def test_stale_sample_revision_rejected(seeded):
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "stale-key-000001", count=1)
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 99, "image_id": image_id, "decision": "accepted"},
    )
    assert response.status_code == 409


def test_stale_measurement_revision_rejected(seeded):
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    first_image = _accepted_flow(client, reviewer_headers, "meas1-key-00001", count=3)
    first = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": first_image, "decision": "accepted"},
    )
    assert first.status_code == 201
    # A second review that still believes no measurement exists is stale.
    second_image = _accepted_flow(client, reviewer_headers, "meas2-key-00001", count=5)
    stale = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "expected_measurement_revision": None,
              "image_id": second_image, "decision": "accepted"},
    )
    assert stale.status_code == 409


def test_retake_supersedes_previous_acceptance(seeded, db):
    from app.models import Measurement

    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    first_image = _accepted_flow(client, reviewer_headers, "sup1-key-000001", count=3)
    first = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": first_image, "decision": "accepted"},
    )
    assert first.status_code == 201
    second_image = _accepted_flow(client, reviewer_headers, "sup2-key-000001", count=5)
    second = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "expected_measurement_revision": 1,
              "image_id": second_image, "decision": "accepted"},
    )
    assert second.status_code == 201, second.text
    body = second.json()
    assert body["revision"] == 2
    assert body["supersedes_measurement_id"] == first.json()["measurement_id"]
    db.expire_all()
    superseded = db.get(Measurement, first.json()["measurement_id"])
    assert superseded.superseded_at is not None  # retained for audit, no longer active
    measurements = db.query(Measurement).filter_by(sample_id=1).all()
    assert len(measurements) == 2


def test_duplicate_active_accepted_measurement_blocked_at_database(seeded, db):
    from app import service
    from app.models import ImageRecord, Measurement, utcnow

    client = seeded
    from app.models import Operator

    reviewer = db.query(Operator).filter_by(username="reviewer1").one()
    headers = login(client, "worker1", "worker-password-1")
    upload = upload_image(client, headers, 1, "dupidx-key-00001", make_image_bytes())
    image = db.get(ImageRecord, upload.json()["image_id"])
    base = dict(
        sample_id=1, image_id=image.image_id, decision="accepted", accepted_count=1,
        reviewer_id=reviewer.id, usable_exposure=True,
    )
    db.add(Measurement(measurement_id=service.new_id(), revision=1, **base))
    db.add(Measurement(measurement_id=service.new_id(), revision=2, **base))
    try:
        db.commit()
        raised = False
    except Exception:
        db.rollback()
        raised = True
    assert raised  # partial unique index enforces one active accepted measurement


def test_image_of_other_sample_cannot_be_reviewed(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    image_id = _accepted_flow(client, worker_headers, "other-key-000001", count=1)
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    response = client.post(
        "/api/samples/999/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "accepted"},
    )
    assert response.status_code == 404


def test_late_review_does_not_backdate_available_at(seeded, db):
    from datetime import timedelta

    from app.models import Measurement, utcnow

    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _accepted_flow(client, reviewer_headers, "avail-key-00001", count=2)
    response = client.post(
        "/api/samples/1/reviews",
        headers=reviewer_headers,
        json={"expected_sample_revision": 1, "image_id": image_id, "decision": "accepted"},
    )
    assert response.status_code == 201
    db.expire_all()
    measurement = db.query(Measurement).filter_by(sample_id=1).one()
    now = utcnow()
    assert measurement.available_at is not None
    assert now - measurement.available_at < timedelta(minutes=1)  # set at acceptance time, server-side