"""Stage A4/A5: storage-retry resumption, race handling, and inference provenance."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from conftest import install_fake_adapter, login, make_image_bytes, upload_image


class _FailingOnceStorage:
    """Storage wrapper whose save() fails while `failing` is True."""

    def __init__(self, inner):
        self.inner = inner
        self.failing = True

    def exists(self, key):
        return self.inner.exists(key)

    def read(self, key):
        return self.inner.read(key)

    def save(self, key, data):
        if self.failing:
            raise OSError("simulated storage outage")
        return self.inner.save(key, data)


# ---------------------------------------------------------------- Stage A4


def test_storage_failure_then_same_key_retry_resumes_without_duplicates(seeded, db):
    from app.models import AuditRecord, ImageRecord, ProcessingJob, Upload

    client = seeded
    state = client.app.state.capture
    fake = install_fake_adapter(client.app, count=3)
    headers = login(client, "worker1", "worker-password-1")
    data = make_image_bytes()
    state.storage = _FailingOnceStorage(state.storage)
    first = upload_image(client, headers, 1, "resume-key-00001", data)
    assert first.status_code == 503, first.text
    db.expire_all()
    upload = db.query(Upload).filter_by(client_key="resume-key-00001").one()
    assert upload.status == "failed"
    audit_actions = [row.action for row in db.query(AuditRecord).filter_by(entity_type="upload").all()]
    assert "upload_failed" in audit_actions

    # Client retries the same photo with the same key: storage resumes.
    state.storage.failing = False
    retry = upload_image(client, headers, 1, "resume-key-00001", data)
    assert retry.status_code == 200, retry.text
    body = retry.json()
    assert body["status"] == "stored"
    assert body["upload_id"] == upload.upload_id
    assert body["image_id"] is not None

    # No duplicate image/job records; exactly one inference dispatch.
    assert db.query(ImageRecord).filter_by(upload_id=upload.upload_id).count() == 1
    assert db.query(ProcessingJob).count() == 1
    assert len(fake.calls) == 1
    resumed = [row.action for row in db.query(AuditRecord).filter_by(entity_type="upload").all()]
    assert "upload_retry_resumed" in resumed
    state.storage = state.storage.inner  # restore the real storage


def test_stale_receiving_reservation_resumes_via_http_retry(seeded, db):
    from app import service
    from app.images import ImageLimits, inspect_image
    from app.models import ImageRecord, Operator, ProcessingJob, Sample

    client = seeded
    state = client.app.state.capture
    fake = install_fake_adapter(client.app, count=1)
    settings = state.settings
    data = make_image_bytes()
    inspected = inspect_image(
        data, ImageLimits(max_bytes=settings.max_image_bytes, max_pixels=settings.max_image_pixels)
    )
    sample = db.get(Sample, 1)
    uploader = db.query(Operator).filter_by(username="worker1").one()
    upload, created = service.reserve_upload(
        db,
        sample=sample,
        uploader=uploader,
        client_key="stale-key-000001",
        data=data,
        captured_at=datetime.now(timezone.utc) - timedelta(hours=2),
        captured_at_offset="+00:00",
        inspected=inspected,
        settings=settings,
    )
    assert created
    # Crash: no files were saved. Age the reservation past the stale window.
    upload.reserved_at = datetime.now(timezone.utc) - timedelta(
        seconds=settings.recovery_reservation_stale_seconds + 1
    )
    db.commit()

    headers = login(client, "worker1", "worker-password-1")
    retry = upload_image(client, headers, 1, "stale-key-000001", data)
    assert retry.status_code == 200, retry.text
    assert retry.json()["status"] == "stored"
    assert retry.json()["upload_id"] == upload.upload_id
    db.expire_all()
    assert db.query(ImageRecord).filter_by(upload_id=upload.upload_id).count() == 1
    assert db.query(ProcessingJob).count() == 1
    assert len(fake.calls) == 1


def test_retry_after_completed_job_does_not_buy_another_inference(seeded, db):
    from conftest import publish_pending

    client = seeded
    fake = install_fake_adapter(client.app, count=1)
    headers = login(client, "worker1", "worker-password-1")
    data = make_image_bytes()
    first = upload_image(client, headers, 1, "done-key-000001", data)
    assert first.status_code == 202
    assert publish_pending(client.app) == 1
    assert len(fake.calls) == 1

    retry = upload_image(client, headers, 1, "done-key-000001", data)
    assert retry.status_code == 200
    assert retry.json()["upload_id"] == first.json()["upload_id"]
    assert len(fake.calls) == 1  # HTTP retry never triggers another inference


def test_fresh_receiving_reservation_is_not_stolen_by_retry(seeded, db):
    """A brand-new reservation still belongs to its in-flight writer."""
    from app import service
    from app.images import ImageLimits, inspect_image
    from app.models import Operator, Sample, Upload

    client = seeded
    state = client.app.state.capture
    settings = state.settings
    data = make_image_bytes()
    inspected = inspect_image(
        data, ImageLimits(max_bytes=settings.max_image_bytes, max_pixels=settings.max_image_pixels)
    )
    sample = db.get(Sample, 1)
    uploader = db.query(Operator).filter_by(username="worker1").one()
    upload, created = service.reserve_upload(
        db,
        sample=sample,
        uploader=uploader,
        client_key="fresh-key-00001",
        data=data,
        captured_at=datetime.now(timezone.utc) - timedelta(hours=1),
        captured_at_offset="+00:00",
        inspected=inspected,
        settings=settings,
    )
    assert created
    headers = login(client, "worker1", "worker-password-1")
    retry = upload_image(client, headers, 1, "fresh-key-00001", data)
    assert retry.status_code == 200
    assert retry.json()["status"] == "receiving"  # untouched, still the writer's
    db.expire_all()
    assert db.get(Upload, upload.upload_id).status == "receiving"


def test_concurrent_same_key_race_returns_the_winning_record(seeded, db):
    """Simulate the SELECT/INSERT race: the loser's re-read after the unique
    violation must return the winner instead of a bare 409."""
    from app import service
    from app.images import ImageLimits, inspect_image
    from app.models import Operator, Sample, Upload

    client = seeded
    state = client.app.state.capture
    settings = state.settings
    data = make_image_bytes()
    inspected = inspect_image(
        data, ImageLimits(max_bytes=settings.max_image_bytes, max_pixels=settings.max_image_pixels)
    )
    sample = db.get(Sample, 1)
    uploader = db.query(Operator).filter_by(username="worker1").one()
    winner, created = service.reserve_upload(
        db,
        sample=sample,
        uploader=uploader,
        client_key="race-key-000001",
        data=data,
        captured_at=datetime.now(timezone.utc) - timedelta(hours=1),
        captured_at_offset="+00:00",
        inspected=inspected,
        settings=settings,
    )
    assert created

    # A second session whose SELECT misses the committed winner (the race
    # window), then hits the unique constraint on commit and re-reads.
    factory = state.session_factory
    with factory() as session_b:
        real_query = session_b.query
        calls = {"n": 0}

        class _NoneOnce:
            def filter(self, *a, **k):
                return self

            def one_or_none(self):
                return None

        def fake_query(entity, *a, **k):
            result = real_query(entity, *a, **k)
            if entity is Upload and calls["n"] == 0:
                calls["n"] += 1
                return _NoneOnce()
            return result

        session_b.query = fake_query
        try:
            loser_upload, loser_created = service.reserve_upload(
                session_b,
                sample=sample,
                uploader=uploader,
                client_key="race-key-000001",
                data=data,
                captured_at=datetime.now(timezone.utc) - timedelta(hours=1),
                captured_at_offset="+00:00",
                inspected=inspected,
                settings=settings,
            )
        finally:
            session_b.query = real_query
        assert loser_created is False
        assert loser_upload.upload_id == winner.upload_id


def test_different_content_on_same_key_still_conflicts(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    first = upload_image(client, headers, 1, "conflict2-key-01", make_image_bytes(width=64, height=48))
    assert first.status_code == 202
    conflict = upload_image(client, headers, 1, "conflict2-key-01", make_image_bytes(width=48, height=64))
    assert conflict.status_code == 409


# ---------------------------------------------------------------- Stage A5


def test_inference_provenance_persisted_and_used_in_result(seeded, db):
    from app.models import ImageRecord, ProcessingResult

    client = seeded
    install_fake_adapter(client.app, count=2)
    headers = login(client, "worker1", "worker-password-1")
    data = make_image_bytes("JPEG", width=80, height=40, orientation=6)
    response = upload_image(client, headers, 1, "prov-key-000001", data)
    assert response.status_code == 202
    image_id = response.json()["image_id"]
    db.expire_all()
    image = db.get(ImageRecord, image_id)

    stored_inference = client.app.state.capture.storage.read(image.inference_storage_key)
    assert image.inference_sha256 == hashlib.sha256(stored_inference).hexdigest()
    assert image.inference_sha256 != image.sha256  # NOT the original-file hash
    assert image.sha256 == hashlib.sha256(data).hexdigest()
    steps = [step.get("step") for step in image.transformations]
    assert "exif_transpose" in steps and "convert_rgb_png" in steps
    assert any(step.get("from_orientation") == 6 for step in image.transformations)

    from conftest import publish_pending

    assert publish_pending(client.app) == 1
    result = db.query(ProcessingResult).one()
    assert result.inference_sha256 == image.inference_sha256
    assert result.transformations == image.transformations