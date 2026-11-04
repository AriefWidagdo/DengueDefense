"""Stage B: atomic review/state serialization and status clarity.

Concurrency tests use two separate database sessions against the same local
SQLite file. SQLite serializes writers; a conflicting writer hits the short
busy timeout and the service maps that to an honest 409 (retry). PostgreSQL
relies on the same conditional-UPDATE rowcount plus the partial unique index;
a live PostgreSQL test has NOT been run and is not claimed.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from conftest import (
    install_fake_adapter,
    login,
    make_image_bytes,
    publish_pending,
    upload_image,
)


def _completed_image(client, headers, key: str, count: int = 2) -> str:
    install_fake_adapter(client.app, count=count)
    response = upload_image(client, headers, 1, key, make_image_bytes())
    assert response.status_code == 202, response.text
    image_id = response.json()["image_id"]
    assert publish_pending(client.app) == 1
    return image_id


def _review(client, headers, image_id: str, sample_revision: int, decision: str,
            measurement_revision: int | None = None, **extra):
    payload = {
        "expected_sample_revision": sample_revision,
        "image_id": image_id,
        "decision": decision,
    }
    if measurement_revision is not None:
        payload["expected_measurement_revision"] = measurement_revision
    payload.update(extra)
    return client.post("/api/samples/1/reviews", headers=headers, json=payload)


def _upload_id_of(client, key: str) -> str:
    from app.models import Upload

    with client.app.state.capture.session_factory() as db:
        upload = db.query(Upload).filter_by(client_key=key).one()
        return upload.upload_id


# ---------------------------------------------------------------- Stage B1


def test_update_sample_cas_rejects_concurrent_editor(seeded):
    """Two editors with the same expected revision: the loser's conditional
    UPDATE matches zero rows (or hits the writer lock) and gets 409; the
    winner's change is kept and history preserved."""
    from app import service
    from app.models import Operator, Sample

    client = seeded
    state = client.app.state.capture
    factory: sessionmaker = state.session_factory
    session_a = factory()
    session_b = factory()
    try:
        sample_a = session_a.get(Sample, 1)
        sample_b = session_b.get(Sample, 1)
        operator_a = session_a.query(Operator).filter_by(username="worker1").one()
        operator_b = session_b.query(Operator).filter_by(username="reviewer1").one()

        real_commit_a = session_a.commit

        def flush_only_commit_a():
            session_a.flush()  # hold the write lock; do not commit

        session_a.commit = flush_only_commit_a
        try:
            service.update_sample(
                session_a, sample=sample_a, operator=operator_a, expected_revision=1,
                removed_at=None, removed_at_offset=None,
                condition_notes="editor A wins the lock", exposure_known=None,
            )
            with pytest.raises(HTTPException) as error:
                service.update_sample(
                    session_b, sample=sample_b, operator=operator_b, expected_revision=1,
                    removed_at=None, removed_at_offset=None,
                    condition_notes="editor B must lose", exposure_known=None,
                )
            assert error.value.status_code == 409
        finally:
            session_a.commit = real_commit_a
            session_a.commit()  # editor A's change becomes durable

        with pytest.raises(HTTPException) as stale:
            service.update_sample(
                session_b, sample=sample_b, operator=operator_b, expected_revision=1,
                removed_at=None, removed_at_offset=None,
                condition_notes="stale retry", exposure_known=None,
            )
        assert stale.value.status_code == 409
        sample_ok, _audit = service.update_sample(
            session_b, sample=sample_b, operator=operator_b, expected_revision=2,
            removed_at=None, removed_at_offset=None,
            condition_notes="fresh retry after A", exposure_known=None,
        )
        assert sample_ok.revision == 3
        assert sample_ok.condition_notes == "fresh retry after A"
    finally:
        session_a.close()
        session_b.close()


def _review_race(seeded, db, decision_a: str, decision_b: str, count: int = 2):
    """Both reviewers read the same snapshot (no active measurement) and race;
    SQLite serializes the writers and the loser gets an honest 409."""
    from app import service
    from app.models import Measurement, Operator, Sample

    client = seeded
    state = client.app.state.capture
    worker_headers = login(client, "worker1", "worker-password-1")
    image_id = _completed_image(client, worker_headers, f"race-{decision_a}-{decision_b}-key", count=count)
    factory: sessionmaker = state.session_factory
    session_a = factory()
    session_b = factory()
    try:
        sample_a = session_a.get(Sample, 1)
        reviewer_a = session_a.query(Operator).filter_by(username="reviewer1").one()
        reviewer_b = session_b.query(Operator).filter_by(username="reviewer1").one()
        kwargs = dict(
            sample=sample_a, reviewer=reviewer_a, image_id=image_id, result_id=None,
            corrected_count=None, usable_exposure=True, quality_flags=[],
            taxon_verification=None, rejection_reason="glare" if decision_a == "rejected" else None,
            expected_sample_revision=1, expected_measurement_revision=None,
        )
        real_commit_a = session_a.commit

        def flush_only_commit_a():
            session_a.flush()  # hold the write lock, uncommitted

        session_a.commit = flush_only_commit_a
        try:
            service.create_review(session_a, decision=decision_a, **kwargs)
            with pytest.raises(HTTPException) as error:
                service.create_review(
                    session_b,
                    sample=sample_a, reviewer=reviewer_b, image_id=image_id, result_id=None,
                    corrected_count=None, usable_exposure=True, quality_flags=[],
                    taxon_verification=None,
                    rejection_reason="blur" if decision_b == "rejected" else None,
                    expected_sample_revision=1, expected_measurement_revision=None,
                    decision=decision_b,
                )
            assert error.value.status_code == 409
        finally:
            session_a.commit = real_commit_a
            session_a.rollback()  # discard A's uncommitted attempt

        # The sample is untouched by the aborted race: one review can proceed.
        db.expire_all()
        assert db.query(Measurement).filter_by(sample_id=1).count() == 0
        measurement = service.create_review(
            db,
            sample=db.get(Sample, 1),
            reviewer=db.query(Operator).filter_by(username="reviewer1").one(),
            image_id=image_id, result_id=None, decision=decision_b,
            corrected_count=None, usable_exposure=True, quality_flags=[],
            taxon_verification=None,
            rejection_reason="solo after race" if decision_b == "rejected" else None,
            expected_sample_revision=1, expected_measurement_revision=None,
        )
        assert measurement.revision == 1
    finally:
        session_a.close()
        session_b.close()


def test_review_race_accepted_vs_accepted_409(seeded, db):
    _review_race(seeded, db, "accepted", "accepted")


def test_review_race_accepted_vs_rejected_409(seeded, db):
    _review_race(seeded, db, "accepted", "rejected")


def test_review_race_rejected_vs_rejected_409(seeded, db):
    _review_race(seeded, db, "rejected", "rejected")


def test_one_active_review_row_per_sample_any_decision(seeded, db):
    """The partial unique index covers accepted AND rejected decisions."""
    from app import service
    from app.models import Measurement, Operator

    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    image_id = _completed_image(client, worker_headers, "unique-key-000001", count=1)
    reviewer = db.query(Operator).filter_by(username="reviewer1").one()
    base = dict(
        sample_id=1, image_id=image_id, reviewer_id=reviewer.id, usable_exposure=True,
        revision=1, superseded_at=None,
    )
    db.add(Measurement(measurement_id=service.new_id(), decision="rejected", rejection_reason="r1", **base))
    db.add(Measurement(measurement_id=service.new_id(), decision="accepted", accepted_count=1, **base))
    try:
        db.commit()
        raised = False
    except IntegrityError:
        db.rollback()
        raised = True
    assert raised  # rejected-vs-accepted and rejected-vs-rejected are equally blocked


def test_sequential_replacement_keeps_history_and_monotonic_revisions(seeded):
    """Accepted then rejected (and back) through the real route: revisions
    stay monotonic and superseded history is retained with its available_at."""
    from app.models import Measurement

    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _completed_image(client, reviewer_headers, "seq-key-000001", count=3)
    first = _review(client, reviewer_headers, image_id, 1, "accepted")
    assert first.status_code == 201, first.text
    second = _review(client, reviewer_headers, image_id, 1, "rejected", 1,
                     rejection_reason="recount needed")
    assert second.status_code == 201, second.text
    third = _review(client, reviewer_headers, image_id, 1, "accepted", 2)
    assert third.status_code == 201, third.text
    with client.app.state.capture.session_factory() as db:
        rows = db.query(Measurement).filter_by(sample_id=1).all()
    assert [m.revision for m in rows] == [1, 2, 3]
    superseded = [m for m in rows if m.superseded_at is not None]
    assert len(superseded) == 2
    assert all(m.available_at is not None for m in rows if m.decision == "accepted")


def test_stale_concurrent_review_via_route_409(seeded):
    """Sequential stale attempt through the real route: the reviewer that
    still believes revision 1 is active gets 409 with the current revision."""
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _completed_image(client, reviewer_headers, "staleroute-key-01", count=1)
    first = _review(client, reviewer_headers, image_id, 1, "accepted")
    assert first.status_code == 201
    stale = _review(client, reviewer_headers, image_id, 1, "accepted", None, corrected_count=9)
    assert stale.status_code == 409


# ---------------------------------------------------------------- Stage B2


def test_second_photo_status_stays_pending_with_explicit_replacement(seeded):
    """After photo 1 is accepted, completed photo 2 must remain pending human
    review in ITS status, expose its own candidate, and permit an explicit
    replacement using the still-available active revision."""
    client = seeded

    worker = login(client, "worker1", "worker-password-1")
    photo1_id = _completed_image(client, worker, "retake1-key-0001", count=2)
    upload1_id = _upload_id_of(client, "retake1-key-0001")

    reviewer = login(client, "reviewer1", "reviewer-password-1")
    first = _review(client, reviewer, photo1_id, 1, "accepted")
    assert first.status_code == 201, first.text

    worker = login(client, "worker1", "worker-password-1")
    photo2_id = _completed_image(client, worker, "retake2-key-0001", count=5)
    upload2_id = _upload_id_of(client, "retake2-key-0001")
    status2 = client.get(f"/api/uploads/{upload2_id}", headers=worker).json()
    # Photo 2 is pending human review; its candidate is exposed; the sample's
    # active measurement (photo 1) is reported separately with its revision.
    assert status2["review"]["state"] == "pending_review"
    assert status2["review"]["measurement_id"] is None
    assert status2["review"]["measurement_revision"] is None
    assert status2["result"]["candidate_count"] == 5
    assert status2["review"]["sample_active"]["image_id"] == photo1_id
    assert status2["review"]["sample_active"]["revision"] == 1
    assert status2["review"]["sample_active"]["decision"] == "accepted"

    # Explicit replacement uses the ACTIVE revision reported by photo 2's status.
    reviewer = login(client, "reviewer1", "reviewer-password-1")
    replacement = _review(
        client, reviewer, photo2_id, 1, "accepted",
        status2["review"]["sample_active"]["revision"], corrected_count=4,
    )
    assert replacement.status_code == 201, replacement.text
    assert replacement.json()["revision"] == 2
    assert replacement.json()["supersedes_measurement_id"] == first.json()["measurement_id"]

    # Photo 1's own status still reports its (now superseded) measurement.
    worker = login(client, "worker1", "worker-password-1")
    status1 = client.get(f"/api/uploads/{upload1_id}", headers=worker).json()
    assert status1["review"]["state"] == "accepted"
    assert status1["review"]["measurement_id"] == first.json()["measurement_id"]
    assert status1["review"]["sample_active"]["image_id"] == photo2_id
    assert status1["review"]["sample_active"]["revision"] == 2


# ---------------------------------------------------------------- Stage B3


def test_zero_requires_removal_time(seeded):
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _completed_image(client, reviewer_headers, "zero-norem-key-1", count=0)
    response = _review(client, reviewer_headers, image_id, 1, "accepted", usable_exposure=True)
    assert response.status_code == 422
    assert "removal time" in response.json()["detail"]


def test_zero_requires_known_exposure(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    patched = client.patch(
        "/api/samples/1", headers=worker_headers,
        json={"expected_revision": 1, "exposure_known": False,
              "removed_at": "2026-01-12T09:00:00+00:00"},
    )
    assert patched.status_code == 200
    sample_revision = patched.json()["sample"]["revision"]
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _completed_image(client, reviewer_headers, "zero-unknown-key-1", count=0)
    response = _review(client, reviewer_headers, image_id, sample_revision, "accepted", usable_exposure=True)
    assert response.status_code == 422
    assert "exposure" in response.json()["detail"]


def test_zero_accepted_after_completed_exposure(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    patched = client.patch(
        "/api/samples/1", headers=worker_headers,
        json={"expected_revision": 1, "exposure_known": True,
              "removed_at": "2026-01-12T09:00:00+00:00"},
    )
    assert patched.status_code == 200
    sample_revision = patched.json()["sample"]["revision"]
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _completed_image(client, reviewer_headers, "zero-ok-key-00001", count=0)
    response = _review(client, reviewer_headers, image_id, sample_revision, "accepted", usable_exposure=True)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["accepted_count"] == 0
    assert body["usable_exposure"] is True  # derived from sample truth + reviewer input
    assert body["available_at"] is not None


def test_nonzero_accept_records_derived_usability(seeded):
    """A nonzero accept on an unknown-exposure sample is allowed but recorded
    as NOT usable exposure (excluded from exposure-normalized features)."""
    client = seeded
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _completed_image(client, reviewer_headers, "nonzero-key-0001", count=3)
    response = _review(client, reviewer_headers, image_id, 1, "accepted", usable_exposure=True)
    assert response.status_code == 201, response.text
    assert response.json()["accepted_count"] == 3
    assert response.json()["usable_exposure"] is False  # no removal time recorded


def test_zero_with_client_checkbox_only_never_passes(seeded):
    """The client checkbox alone (default True) must not enable a zero when
    the sample truth contradicts it."""
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    client.patch(
        "/api/samples/1", headers=worker_headers,
        json={"expected_revision": 1, "exposure_known": False},
    )
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")
    image_id = _completed_image(client, reviewer_headers, "zero-check-key-01", count=0)
    response = _review(client, reviewer_headers, image_id, 2, "accepted", usable_exposure=True)
    assert response.status_code == 422


# ---------------------------------------------------------------- Stage B4


def test_removed_sample_awaiting_photo_stays_retrievable(seeded):
    """A removed, not-yet-photographed sample must be retrievable after
    reload/trap navigation without any in-memory browser state."""
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    patched = client.patch(
        "/api/samples/1", headers=worker_headers,
        json={"expected_revision": 1, "removed_at": "2026-01-12T09:00:00+00:00"},
    )
    assert patched.status_code == 200

    default_view = client.get("/api/traps/VD-001", headers=worker_headers).json()
    assert default_view["samples"] == []  # active slice unchanged
    assert default_view["sample_state"] == "active"

    awaiting = client.get(
        "/api/traps/VD-001?sample_state=awaiting_image", headers=worker_headers
    ).json()
    assert awaiting["sample_state"] == "awaiting_image"
    assert [s["sample_id"] for s in awaiting["samples"]] == [1]
    assert awaiting["sample_total"] == 1
    assert awaiting["samples"][0]["removed_at"] is not None


def test_removed_sample_awaiting_review_listed(seeded):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    patched = client.patch(
        "/api/samples/1", headers=worker_headers,
        json={"expected_revision": 1, "removed_at": "2026-01-12T09:00:00+00:00"},
    )
    assert patched.status_code == 200
    image_id = _completed_image(client, worker_headers, "awaitrev-key-001", count=2)
    reviewer_headers = login(client, "reviewer1", "reviewer-password-1")

    awaiting = client.get(
        "/api/traps/VD-001?sample_state=awaiting_review", headers=worker_headers
    ).json()
    assert [s["sample_id"] for s in awaiting["samples"]] == [1]
    # After an accepted review the sample leaves the awaiting_review queue.
    accepted = _review(client, reviewer_headers, image_id, 2, "accepted")
    assert accepted.status_code == 201
    awaiting_after = client.get(
        "/api/traps/VD-001?sample_state=awaiting_review", headers=worker_headers
    ).json()
    assert awaiting_after["samples"] == []
    assert awaiting_after["sample_total"] == 0


def _image_id_of(client, key: str) -> str:
    from app.models import ImageRecord, Upload

    with client.app.state.capture.session_factory() as db:
        upload = db.query(Upload).filter_by(client_key=key).one()
        image = db.query(ImageRecord).filter_by(upload_id=upload.upload_id).one()
        return image.image_id


def test_all_samples_paginated_and_bounded(seeded, db):
    client = seeded
    worker_headers = login(client, "worker1", "worker-password-1")
    for i in range(3):
        created = client.post(
            "/api/traps/VD-001/samples", headers=worker_headers,
            json={"sample_type": "egg_strip", "installed_at": "2026-01-20T08:00:00+00:00",
                  "strip_id": f"S-{i}"},
        )
        assert created.status_code == 201
    page = client.get(
        "/api/traps/VD-001?sample_state=all&limit=2&offset=0", headers=worker_headers
    ).json()
    assert page["sample_total"] == 4  # seeded sample + 3 created
    assert len(page["samples"]) == 2
    page2 = client.get(
        "/api/traps/VD-001?sample_state=all&limit=2&offset=2", headers=worker_headers
    ).json()
    assert len(page2["samples"]) == 2
    assert {s["sample_id"] for s in page["samples"]}.isdisjoint(
        {s["sample_id"] for s in page2["samples"]}
    )
    bad = client.get("/api/traps/VD-001?sample_state=nonsense", headers=worker_headers)
    assert bad.status_code == 422


# ---------------------------------------------------------------- Stage B5


def test_login_throttle_bounded(seeded):
    import dataclasses

    client = seeded
    client.app.state.capture.settings = dataclasses.replace(
        client.app.state.capture.settings, login_rate_per_minute=2
    )
    for _ in range(2):
        attempt = client.post("/api/auth/login", json={"username": "worker1", "password": "wrong"})
        assert attempt.status_code == 401
    third = client.post("/api/auth/login", json={"username": "worker1", "password": "worker-password-1"})
    assert third.status_code == 429
    # A different username is throttled independently.
    other = client.post("/api/auth/login", json={"username": "outsider", "password": "wrong"})
    assert other.status_code == 401


def test_production_schema_gate_refuses_old_or_partial_schemas(tmp_path, monkeypatch):
    """The startup gate checks ALL metadata tables and columns; an old or
    partial schema is refused with actionable guidance and no data is erased."""
    from sqlalchemy import create_engine, text

    from app.config import ConfigError
    from app.main import _verify_production_schema
    from app.models import Base

    engine = create_engine(f"sqlite:///{tmp_path / 'old-schema.sqlite3'}")
    Base.metadata.create_all(engine)
    _verify_production_schema(engine)  # complete schema passes

    # Simulate an old schema: drop the Stage-A additive column and one table.
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE processing_jobs DROP COLUMN needs_attention"))
        connection.execute(text("DROP TABLE rate_windows"))

    with pytest.raises(ConfigError) as error:
        _verify_production_schema(engine)
    message = str(error.value)
    assert "processing_jobs.needs_attention" in message
    assert "rate_windows" in message
    assert "never recreate or erase" in message
    engine.dispose()