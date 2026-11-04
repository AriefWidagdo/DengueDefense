"""Recoverable upload/job pipeline and duplicate-publication tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from conftest import install_fake_adapter, login, make_image_bytes, upload_image


def _get_job(db, image_id):
    from app.models import ProcessingJob

    return db.query(ProcessingJob).filter_by(image_id=image_id).one()


def _reserve_only(app, db, data: bytes, key: str, sample_id: int = 1):
    """Simulate the crash window: reservation committed, stored state not."""
    from app import service
    from app.images import ImageLimits, inspect_image
    from app.models import Operator, Sample

    settings = app.state.capture.settings
    inspected = inspect_image(data, ImageLimits(max_bytes=settings.max_image_bytes, max_pixels=settings.max_image_pixels))
    sample = db.get(Sample, sample_id)
    uploader = db.query(Operator).filter_by(username="worker1").one()
    captured_at = datetime.now(timezone.utc) - timedelta(hours=2)
    upload, created = service.reserve_upload(
        db,
        sample=sample,
        uploader=uploader,
        client_key=key,
        data=data,
        captured_at=captured_at,
        captured_at_offset="+00:00",
        inspected=inspected,
        settings=settings,
    )
    assert created
    return upload, inspected


def _age_reservation(app, db, upload) -> None:
    settings = app.state.capture.settings
    upload.reserved_at = datetime.now(timezone.utc) - timedelta(
        seconds=settings.recovery_reservation_stale_seconds + 1
    )
    db.commit()


def test_crash_after_save_before_stored_commit_recovers(seeded, db):
    from app import service
    from app.models import ImageRecord, Upload

    client = seeded
    fake = install_fake_adapter(client.app, count=2)
    data = make_image_bytes()
    upload, inspected = _reserve_only(client.app, db, data, "crash-key-000001")
    state = client.app.state.capture
    # A real crash here leaves both files saved: original plus inference view.
    state.storage.save(upload.storage_key, data)
    state.storage.save(f"uploads/{upload.upload_id}/inference.png", inspected.inference_bytes)
    _age_reservation(client.app, db, upload)

    summary = service.run_recovery(db, state.storage, state.adapter, state.settings)
    assert summary["reservations_completed"] == 1
    db.expire_all()
    recovered = db.get(Upload, upload.upload_id)
    assert recovered.status == "stored"
    image = db.query(ImageRecord).filter_by(upload_id=upload.upload_id).one()
    job = _get_job(db, image.image_id)
    assert job.state == "queued"
    assert job.modal_call_id is not None  # dispatched during recovery
    assert len(fake.calls) == 1
    assert fake.calls[0][2] == "mosquito"  # policy prompt preserved across recovery


def test_reserved_without_verifiable_file_fails(seeded, db):
    from app import service
    from app.models import Upload

    client = seeded
    data = make_image_bytes()
    upload, _ = _reserve_only(client.app, db, data, "nofile-key-00001")  # no file written
    _age_reservation(client.app, db, upload)
    summary = service.run_recovery(
        db, client.app.state.capture.storage, client.app.state.capture.adapter, client.app.state.capture.settings
    )
    assert summary["reservations_failed"] == 1
    db.expire_all()
    assert db.get(Upload, upload.upload_id).status == "failed"


def test_stored_upload_without_job_gets_job_rebuilt(seeded, db):
    from app import service
    from app.models import ProcessingJob, Upload

    client = seeded
    install_fake_adapter(client.app, count=1)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "nojob-key-000001", make_image_bytes())
    assert response.status_code == 202
    image_id = response.json()["image_id"]
    # Simulate a crash between the image insert and the job insert.
    db.query(ProcessingJob).filter_by(image_id=image_id).delete()
    db.commit()
    summary = service.run_recovery(
        db, client.app.state.capture.storage, client.app.state.capture.adapter, client.app.state.capture.settings
    )
    assert summary["jobs_created"] == 1
    db.expire_all()
    rebuilt = db.query(ProcessingJob).filter_by(image_id=image_id).one()
    assert rebuilt.state == "queued"


def test_dispatch_lease_allows_redispatch(seeded, db):
    from app import service
    from app.models import ImageRecord, ProcessingJob

    client = seeded
    fake = install_fake_adapter(client.app, count=1)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "lease-key-000001", make_image_bytes())
    image_id = response.json()["image_id"]
    assert len(fake.calls) == 1
    # Simulate a crash between .spawn() and saving the call ID.
    job = _get_job(db, image_id)
    job.modal_call_id = None
    job.last_dispatch_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db.commit()
    service.run_recovery(
        db, client.app.state.capture.storage, client.app.state.capture.adapter, client.app.state.capture.settings
    )
    assert len(fake.calls) == 2  # redundant dispatch allowed; not exactly-once


def test_duplicate_result_publication_discarded(seeded, db):
    from app import service
    from app.models import ImageRecord, ProcessingJob, ProcessingResult

    client = seeded
    install_fake_adapter(client.app, count=4)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "dup-key-0000001", make_image_bytes())
    image_id = response.json()["image_id"]
    image = db.get(ImageRecord, image_id)
    job = _get_job(db, image_id)
    first = service.poll_and_publish(db, client.app.state.capture.storage, client.app.state.capture.adapter, job, image)
    assert first == "published"
    second = service.publish_result(
        db,
        client.app.state.capture.storage,
        job_id=job.job_id,
        report={"count": 4, "detections": [], "prompt": job.prompt, "threshold": job.threshold},
        annotated_png=b"\x89PNG-duplicate",
        image=image,
    )
    assert second == "duplicate_discarded"
    assert db.query(ProcessingResult).filter_by(job_id=job.job_id).count() == 1


def test_poll_pending_keeps_job_running(seeded, db):
    from app import service
    from app.models import ImageRecord

    client = seeded
    install_fake_adapter(client.app, count=0)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "pending-key-00001", make_image_bytes())
    image = db.get(ImageRecord, response.json()["image_id"])
    job = _get_job(db, image.image_id)
    # Empty the fake queue so the call stays pending.
    client.app.state.capture.adapter.pending.clear()
    outcome = service.poll_and_publish(db, client.app.state.capture.storage, client.app.state.capture.adapter, job, image)
    assert outcome == "pending"
    db.expire_all()
    assert _get_job(db, image.image_id).state == "running"


def test_failed_processing_has_no_result(seeded):
    from app.models import ProcessingJob, ProcessingResult

    client = seeded  # unconfigured adapter -> explicit failure
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "fail-key-000001", make_image_bytes())
    image_id = response.json()["image_id"]
    db = None
    with client.app.state.capture.session_factory() as db:
        job = _get_job(db, image_id)
        assert job.state == "failed"
        assert db.query(ProcessingResult).filter_by(job_id=job.job_id).count() == 0

# ---------------------------------------------------------------- Stage A3


def test_recovery_with_only_original_saved_writes_inference_before_job(seeded, db):
    """The exact crash window: reservation committed, ONLY the original file
    saved. Recovery must re-inspect, write and commit the computed inference
    image BEFORE creating/storing/dispatching the job."""
    import hashlib

    from app import service
    from app.models import ImageRecord, ProcessingJob, Upload

    client = seeded
    fake = install_fake_adapter(client.app, count=2)
    data = make_image_bytes("JPEG", width=80, height=40, orientation=6)
    upload, inspected = _reserve_only(client.app, db, data, "origonly-key-001")
    state = client.app.state.capture
    state.storage.save(upload.storage_key, data)  # ONLY the original; no inference.png
    _age_reservation(client.app, db, upload)

    summary = service.run_recovery(db, state.storage, state.adapter, state.settings)
    assert summary["reservations_completed"] == 1
    db.expire_all()
    recovered = db.get(Upload, upload.upload_id)
    assert recovered.status == "stored"
    inference_key = f"uploads/{upload.upload_id}/inference.png"
    inference_bytes = state.storage.read(inference_key)
    assert hashlib.sha256(inference_bytes).hexdigest() == inspected.inference_sha256
    image = db.query(ImageRecord).filter_by(upload_id=upload.upload_id).one()
    # Durable provenance from the inspector, not the original-file hash.
    assert image.inference_sha256 == inspected.inference_sha256
    assert image.inference_sha256 != image.sha256
    assert any(step.get("from_orientation") == 6 for step in image.transformations)
    job = _get_job(db, image.image_id)
    assert job.state == "queued"
    assert job.modal_call_id is not None  # dispatched only after the file existed
    assert len(fake.calls) == 1


def test_recovery_fails_reservation_when_inference_cannot_be_saved(seeded, db):
    """If the inference image cannot be persisted, the upload must never be
    marked stored and no job may be created."""
    from app import service
    from app.models import ImageRecord, ProcessingJob, Upload

    client = seeded
    install_fake_adapter(client.app, count=1)
    data = make_image_bytes()
    upload, _inspected = _reserve_only(client.app, db, data, "inffail-key-001")
    state = client.app.state.capture
    state.storage.save(upload.storage_key, data)
    _age_reservation(client.app, db, upload)

    class InferenceSaveFails:
        def __init__(self, inner):
            self.inner = inner

        def exists(self, key):
            return self.inner.exists(key)

        def read(self, key):
            return self.inner.read(key)

        def save(self, key, payload):
            if key.endswith("inference.png"):
                raise OSError("volume write failed")
            return self.inner.save(key, payload)

    failing = InferenceSaveFails(state.storage)
    summary = service.run_recovery(db, failing, state.adapter, state.settings)
    assert summary["reservations_failed"] == 1
    db.expire_all()
    failed = db.get(Upload, upload.upload_id)
    assert failed.status == "failed"
    assert db.query(ImageRecord).filter_by(upload_id=upload.upload_id).count() == 0
    assert db.query(ProcessingJob).count() == 0


def test_recovery_rebuilds_job_only_after_inference_file_exists(seeded, db):
    from app import service
    from app.models import ProcessingJob

    client = seeded
    install_fake_adapter(client.app, count=1)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "inffile-key-001", make_image_bytes())
    image_id = response.json()["image_id"]
    # Simulate a crash that lost the inference file after the image row.
    state = client.app.state.capture
    import hashlib

    from app.models import ImageRecord
    image = db.get(ImageRecord, image_id)
    stored_inference = state.storage.read(image.inference_storage_key)
    db.query(ProcessingJob).filter_by(image_id=image_id).delete()
    db.commit()
    # Delete the inference file directly to simulate the missing file.
    (state.storage.root / image.inference_storage_key).unlink()
    summary = service.run_recovery(db, state.storage, state.adapter, state.settings)
    assert summary["jobs_created"] == 1
    db.expire_all()
    rebuilt = _get_job(db, image_id)
    assert rebuilt.state == "queued"
    image = db.get(ImageRecord, image_id)
    assert hashlib.sha256(state.storage.read(image.inference_storage_key)).hexdigest() == image.inference_sha256
    assert stored_inference == state.storage.read(image.inference_storage_key)


# ---------------------------------------------------------------- Stage A6


def test_concurrent_dispatch_claims_share_one_spawn(seeded, db):
    """Two dispatch paths (e.g. upload route and recovery) must share the
    atomic database claim: exactly one spawn wins, the other is not claimed."""
    from app import service
    from app.models import ImageRecord, ProcessingJob

    client = seeded
    state = client.app.state.capture
    fake = install_fake_adapter(client.app, count=1)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "claim-key-000001", make_image_bytes())
    image_id = response.json()["image_id"]
    assert len(fake.calls) == 1
    # Simulate the spawn/call-ID-save crash window: reset to claimable.
    job = _get_job(db, image_id)
    job.modal_call_id = None
    job.dispatch_state = "unclaimed"
    job.dispatch_attempts = 0
    db.commit()

    settings = state.settings
    factory = state.session_factory
    with factory() as session_a, factory() as session_b:
        job_a = session_a.get(ProcessingJob, job.job_id)
        job_b = session_b.get(ProcessingJob, job.job_id)
        image_a = session_a.get(ImageRecord, image_id)
        image_b = session_b.get(ImageRecord, image_id)
        outcome_a = service.claim_and_dispatch(session_a, state.storage, fake, job_a, image_a, settings)
        outcome_b = service.claim_and_dispatch(session_b, state.storage, fake, job_b, image_b, settings)
    assert outcome_a == "dispatched"
    assert outcome_b == "not_claimed"
    # One reclaimed crash-window spawn only; the loser never spawned.
    assert len(fake.calls) == 2
    with factory() as session_c:
        final = session_c.get(ProcessingJob, job.job_id)
        assert final.modal_call_id == fake.calls[-1][0]
        assert final.dispatch_state == "spawned"


def test_dispatch_attempt_budget_exhaustion_exposes_needs_attention(seeded, db):
    import dataclasses

    from app import service
    from app.models import ImageRecord

    client = seeded
    state = client.app.state.capture
    calls = {"n": 0}

    class AlwaysFailsAdapter:
        def spawn(self, image_bytes, prompt, threshold):
            calls["n"] += 1
            raise RuntimeError("simulated dispatch outage")

        def poll(self, call_id, timeout_seconds):
            return None

    state.settings = dataclasses.replace(state.settings, dispatch_max_attempts=2)
    state.adapter = AlwaysFailsAdapter()
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "budget-key-0001", make_image_bytes())
    image = db.get(ImageRecord, response.json()["image_id"])
    job = _get_job(db, image.image_id)
    assert job.dispatch_attempts == 1  # the route dispatch consumed attempt 1
    assert job.needs_attention is False

    outcome2 = service.dispatch_image_bytes(db, state.storage, state.adapter, job, image, state.settings)
    assert outcome2 == "needs_attention"
    assert calls["n"] == 2
    db.expire_all()
    job = _get_job(db, image.image_id)
    assert job.dispatch_attempts == 2
    assert job.needs_attention is True
    assert job.state == "queued"  # truthful: not failed, waiting for attention
    assert "budget exhausted" in job.failure_reason

    # Further dispatch refuses to resubmit: no more attempts, still truthful.
    outcome3 = service.dispatch_image_bytes(db, state.storage, state.adapter, job, image, state.settings)
    assert outcome3 == "needs_attention"
    assert calls["n"] == 2

    body = client.get(f"/api/uploads/{response.json()['upload_id']}", headers=headers).json()
    assert body["processing"]["needs_attention"] is True


def test_live_dispatch_claim_blocks_recovery_reshoot(seeded, db):
    """A live claim (unexpired lease) must stop recovery from spawning."""
    from app import service

    client = seeded
    fake = install_fake_adapter(client.app, count=1)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "leasehold-key-01", make_image_bytes())
    image_id = response.json()["image_id"]
    assert len(fake.calls) == 1
    job = _get_job(db, image_id)
    job.modal_call_id = None
    job.dispatch_state = "claimed"
    job.claim_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
    job.dispatch_attempts = 1
    db.commit()
    service.run_recovery(
        db, client.app.state.capture.storage, client.app.state.capture.adapter, client.app.state.capture.settings
    )
    assert len(fake.calls) == 1  # live claim held; no duplicate spawn
