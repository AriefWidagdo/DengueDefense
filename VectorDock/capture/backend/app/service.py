"""Domain services: registry, samples, uploads, dispatch, results, review.

Durability rules implemented here:
- An upload is reserved (committed) before the file is written; the stored
  image and the pending processing job are committed together before a 202.
- Dispatch is a recoverable `.spawn()` path with a retained call ID; an
  atomic, bounded database claim is taken before spawn and shared by the
  upload route and recovery. Attempt budgets are bounded and an exhausted
  budget exposes a needs-attention state. Exactly-once is not claimed.
- Candidate results are immutable; publication is conditional so duplicate
  task completion cannot create duplicate results or measurements.
- Review writes are revision-checked; accepted measurements supersede rather
  than accumulate, and at most one accepted measurement is active per sample.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import and_, exists, or_, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, selectinload

from .adapter import AdapterNotConfigured, ArchiveOptInRequired, CounterAdapter
from .config import SAM3_CODE_COMMIT, Settings
from .images import ImageLimits, InspectedImage, inference_storage_key
from .models import (
    AuditRecord,
    Deployment,
    ImageRecord,
    Measurement,
    Operator,
    ProcessingJob,
    ProcessingResult,
    Sample,
    Trap,
    Upload,
    UsageRate,
    utcnow,
)


def new_id() -> str:
    return str(uuid.uuid4())


class StaleRevision(HTTPException):
    def __init__(self, detail: str) -> None:
        super().__init__(status_code=409, detail=detail)


def parse_worker_time(value: datetime, offset: str | None) -> tuple[datetime, str]:
    """Return (UTC datetime, source offset). Naive values use the given offset."""
    if value.tzinfo is None:
        offset = offset or "+00:00"
        sign = 1 if offset[0] == "+" else -1
        hours, minutes = int(offset[1:3]), int(offset[4:6])
        delta = timedelta(hours=hours, minutes=minutes) * sign
        return (value - delta).replace(tzinfo=timezone.utc), offset
    off = value.utcoffset() or timedelta(0)
    total_minutes = int(off.total_seconds() // 60)
    return value.astimezone(timezone.utc), (
        f"{'+' if total_minutes >= 0 else '-'}{abs(total_minutes) // 60:02d}:{abs(total_minutes) % 60:02d}"
    )


def _offset_string(value: datetime) -> str:
    if value.tzinfo is None:
        return "+00:00"
    offset = value.utcoffset() or timedelta(0)
    total_minutes = int(offset.total_seconds() // 60)
    return f"{'+' if total_minutes >= 0 else '-'}{abs(total_minutes) // 60:02d}:{abs(total_minutes) % 60:02d}"


def parse_worker_time_fixed(value: datetime, offset: str | None) -> tuple[datetime, str]:
    if value.tzinfo is None:
        offset = offset or "+00:00"
        sign = 1 if offset[0] == "+" else -1
        hours, minutes = int(offset[1:3]), int(offset[4:6])
        delta = timedelta(hours=hours, minutes=minutes) * sign
        return (value - delta).replace(tzinfo=timezone.utc), offset
    return value.astimezone(timezone.utc), _offset_string(value)

def active_deployment(db: Session, trap_id: str) -> Deployment | None:
    return (
        db.query(Deployment)
        .filter(Deployment.trap_id == trap_id, Deployment.end_at.is_(None))
        .order_by(Deployment.start_at.desc())
        .first()
    )


def active_samples(db: Session, trap_id: str) -> list[Sample]:
    return (
        db.query(Sample)
        .filter(Sample.trap_id == trap_id, Sample.removed_at.is_(None))
        .order_by(Sample.installed_at.desc())
        .all()
    )


def get_trap_or_404(db: Session, trap_id: str) -> Trap:
    trap = db.get(Trap, trap_id)
    if trap is None:
        raise HTTPException(status_code=404, detail=f"Unknown trap: {trap_id}")
    return trap


def create_sample(
    db: Session,
    *,
    trap: Trap,
    operator: Operator,
    sample_type: str,
    installed_at: datetime,
    installed_at_offset: str,
    cartridge_id: str | None,
    strip_id: str | None,
    exposed_area_cm2: float | None,
    condition_notes: str,
    is_test_fixture: bool,
    now: datetime | None = None,
) -> Sample:
    now = now or utcnow()
    installed_utc, offset = parse_worker_time_fixed(installed_at, installed_at_offset)
    if installed_utc > now + timedelta(minutes=10):
        raise HTTPException(status_code=422, detail="Installation time is in the future")
    deployment = active_deployment(db, trap.trap_id)
    if deployment is None:
        raise HTTPException(status_code=409, detail="Trap has no open deployment; a new sample cannot be accepted")
    if sample_type == "adult_card" and not cartridge_id:
        raise HTTPException(status_code=422, detail="adult_card requires cartridge_id")
    if sample_type == "egg_strip" and not strip_id:
        raise HTTPException(status_code=422, detail="egg_strip requires strip_id")
    sample = Sample(
        trap_id=trap.trap_id,
        deployment_id=deployment.deployment_id,
        sample_type=sample_type,
        cartridge_id=cartridge_id,
        strip_id=strip_id,
        installed_at=installed_utc,
        installed_at_offset=offset,
        exposed_area_cm2=exposed_area_cm2,
        condition_notes=condition_notes,
        exposure_known=True,
        revision=1,
        is_test_fixture=is_test_fixture or trap.is_test_fixture,
        created_by=operator.id,
    )
    db.add(sample)
    db.flush()
    db.add(
        AuditRecord(
            entity_type="sample",
            entity_id=str(sample.sample_id),
            action="created",
            actor_id=operator.id,
            detail={"trap_id": trap.trap_id, "sample_type": sample_type, "installed_at": installed_utc.isoformat()},
        )
    )
    return sample


def _cas_execute(db: Session, statement, conflict_detail: str):
    """Execute a conditional UPDATE; map a concurrent-writer lock conflict
    (SQLite SQLITE_BUSY under the short test timeout) to an honest 409."""
    try:
        return db.execute(statement)
    except OperationalError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail=conflict_detail) from error


def update_sample(
    db: Session,
    *,
    sample: Sample,
    operator: Operator,
    expected_revision: int,
    removed_at: datetime | None,
    removed_at_offset: str | None,
    condition_notes: str | None,
    exposure_known: bool | None,
) -> tuple[Sample, int]:
    """Compare-and-swap the sample revision in one conditional UPDATE.

    The write succeeds only when the stored revision still equals
    expected_revision; a concurrent editor makes this UPDATE match zero rows
    and the caller gets 409 instead of overwriting.
    """
    now = utcnow()
    removed_utc = None
    removed_off = None
    if removed_at is not None:
        removed_utc, removed_off = parse_worker_time_fixed(removed_at, removed_at_offset)
        if removed_utc > now + timedelta(minutes=10):
            raise HTTPException(status_code=422, detail="Removal time is in the future")
        if removed_utc < sample.installed_at:
            raise HTTPException(status_code=422, detail="Removal time is before the installation time")
    values: dict[str, Any] = {"revision": Sample.revision + 1}
    changes: dict[str, Any] = {}
    if removed_at is not None:
        values["removed_at"] = removed_utc
        values["removed_at_offset"] = removed_off
        changes["removed_at"] = removed_utc.isoformat()
    if condition_notes is not None:
        values["condition_notes"] = condition_notes
        changes["condition_notes"] = condition_notes
    if exposure_known is not None:
        values["exposure_known"] = exposure_known
        changes["exposure_known"] = exposure_known
    updated = _cas_execute(
        db,
        update(Sample)
        .where(Sample.sample_id == sample.sample_id, Sample.revision == expected_revision)
        .values(**values),
        "Concurrent sample update in progress; re-read the sample revision and retry",
    )
    if updated.rowcount == 0:
        raise StaleRevision(f"Stale sample revision: expected {expected_revision}")
    audit = AuditRecord(
        entity_type="sample",
        entity_id=str(sample.sample_id),
        action="updated",
        actor_id=operator.id,
        detail=changes,
    )
    db.add(audit)
    try:
        db.commit()
    except OperationalError as error:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Concurrent sample update in progress; re-read the sample revision and retry",
        ) from error
    db.expire(sample)
    return sample, audit.audit_id


def reserve_upload(
    db: Session,
    *,
    sample: Sample,
    uploader: Operator,
    client_key: str,
    data: bytes,
    captured_at: datetime,
    captured_at_offset: str,
    inspected: InspectedImage,
    settings: Settings,
    now: datetime | None = None,
) -> tuple[Upload, bool]:
    """Reserve the idempotency key before the file write. Returns (upload, created)."""
    now = now or utcnow()
    payload_hash = hashlib.sha256(data).hexdigest()
    existing = db.query(Upload).filter(Upload.client_key == client_key).one_or_none()
    if existing is not None:
        if existing.sample_id != sample.sample_id:
            raise HTTPException(status_code=409, detail="Idempotency key already used for a different sample")
        if existing.expected_sha256 != payload_hash:
            raise HTTPException(
                status_code=409,
                detail="Idempotency key reused with different content; use a new key for a retake",
            )
        return existing, False
    captured_utc, offset = parse_worker_time_fixed(captured_at, captured_at_offset)
    if captured_utc > now + timedelta(minutes=5):
        raise HTTPException(status_code=422, detail="Capture time is in the future")
    if captured_utc < now - timedelta(days=90):
        raise HTTPException(status_code=422, detail="Capture time is too far in the past")
    upload_id = new_id()
    upload = Upload(
        upload_id=upload_id,
        sample_id=sample.sample_id,
        client_key=client_key,
        expected_sha256=payload_hash,
        storage_key=(
            f"uploads/{upload_id}/original.png"
            if inspected.media_type == "image/png"
            else f"uploads/{upload_id}/original.jpg"
        ),
        media_type=inspected.media_type,
        byte_size=len(data),
        status="receiving",
        captured_at=captured_utc,
        captured_at_offset=offset,
        uploader_id=uploader.id,
        reserved_at=now,
    )
    db.add(upload)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent writer reserved the same key between our SELECT and
        # this commit. Re-read the winner and apply the same idempotency
        # rules; conflict only when sample or content differ.
        db.rollback()
        db.expire_all()
        winner = db.query(Upload).filter(Upload.client_key == client_key).one_or_none()
        if winner is None:
            raise HTTPException(status_code=409, detail="Concurrent upload with the same idempotency key")
        if winner.sample_id != sample.sample_id:
            raise HTTPException(status_code=409, detail="Idempotency key already used for a different sample")
        if winner.expected_sha256 != payload_hash:
            raise HTTPException(
                status_code=409,
                detail="Idempotency key reused with different content; use a new key for a retake",
            )
        return winner, False
    db.expire_all()
    upload = db.get(Upload, upload.upload_id)
    return upload, True


def complete_upload(
    db: Session,
    *,
    upload: Upload,
    inspected: InspectedImage | None,
    settings: Settings,
    received_at: datetime | None = None,
) -> ProcessingJob:
    """Mark stored, create the image and the pending job in one transaction.

    Idempotent across crash windows: if the image already exists without a
    job, only the missing job is created.
    """
    received = received_at or utcnow()
    sample = db.query(Sample).filter(Sample.sample_id == upload.sample_id).one()
    prompt, threshold = settings.detector_policy.for_sample_type(sample.sample_type)
    if upload.status == "stored":
        image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload.upload_id).one_or_none()
        if image is not None:
            job = db.query(ProcessingJob).filter(ProcessingJob.image_id == image.image_id).one_or_none()
            if job is not None:
                return job
            job = ProcessingJob(
                job_id=new_id(),
                image_id=image.image_id,
                state="queued",
                prompt=prompt,
                threshold=threshold,
                policy_version=settings.detector_policy.policy_version,
                checkpoint_version=f"sam3.pt@{SAM3_CODE_COMMIT}",
            )
            db.add(job)
            db.commit()
            return job
    if inspected is None:
        raise ValueError("A new image requires inspected inference provenance")
    image = ImageRecord(
        image_id=new_id(),
        upload_id=upload.upload_id,
        sample_id=upload.sample_id,
        storage_key=upload.storage_key,
        inference_storage_key=inference_storage_key(upload.upload_id, inspected),
        sha256=upload.expected_sha256,
        inference_sha256=inspected.inference_sha256 if inspected is not None else None,
        transformations=list(inspected.transformations) if inspected is not None else [],
        media_type=upload.media_type,
        width=inspected.width if inspected is not None else 0,
        height=inspected.height if inspected is not None else 0,
        captured_at=upload.captured_at,
        captured_at_offset=upload.captured_at_offset,
        received_at=received,
        uploader_id=upload.uploader_id,
    )
    db.add(image)
    db.flush()
    job = ProcessingJob(
        job_id=new_id(),
        image_id=image.image_id,
        state="queued",
        prompt=prompt,
        threshold=threshold,
        policy_version=settings.detector_policy.policy_version,
        checkpoint_version=f"sam3.pt@{SAM3_CODE_COMMIT}",
    )
    db.add(job)
    upload.status = "stored"
    upload.stored_at = received
    upload.received_at = received
    db.commit()
    return job


def fail_upload(db: Session, upload: Upload, reason: str, actor_id: int | None = None) -> None:
    """Mark a reservation failed and retain the transition in the audit log."""
    status_before = upload.status
    upload.status = "failed"
    upload.failure_reason = reason[:255]
    db.add(
        AuditRecord(
            entity_type="upload",
            entity_id=upload.upload_id,
            action="upload_failed",
            actor_id=actor_id,
            detail={"reason": reason[:255], "status_before": status_before},
        )
    )
    db.commit()


def _ensure_inference_file(
    db: Session, upload: Upload, storage, inspected: InspectedImage,
    *, existing_image: ImageRecord | None = None,
) -> bool:
    """Write or verify the normalized file before marking an upload stored.

    Recovery of an existing image must reproduce its recorded hash exactly.
    Otherwise a changed encoder could silently mislabel different bytes.
    """
    if existing_image is not None:
        if not existing_image.inference_sha256 or existing_image.inference_sha256 != inspected.inference_sha256:
            return False
        inference_key = existing_image.inference_storage_key
    else:
        inference_key = inference_storage_key(upload.upload_id, inspected)
    try:
        if not storage.exists(inference_key):
            storage.save(inference_key, inspected.inference_bytes)
        elif inspected.inference_sha256 is not None:
            saved = storage.read(inference_key)
            if hashlib.sha256(saved).hexdigest() != inspected.inference_sha256:
                storage.save(inference_key, inspected.inference_bytes)
        return True
    except Exception:
        return False


def resume_storage_for_retry(
    db: Session,
    *,
    upload: Upload,
    storage,
    data: bytes,
    inspected: InspectedImage,
    settings: Settings,
    actor_id: int | None = None,
) -> ProcessingJob:
    """Safely resume storage for a same-key/same-sample/same-hash retry.

    Used when a previous attempt failed during the storage phase (or a crash
    left the reservation uncompleted). Re-verifies the payload hash, rewrites
    or verifies both files, then completes the stored transition idempotently;
    no duplicate image or job record can be created. Dispatch is left to the
    caller's bounded claim so an HTTP upload retry never buys a new inference
    for a job that is already queued, spawned, completed or failed.
    """
    if upload.expected_sha256 != inspected.sha256 or hashlib.sha256(data).hexdigest() != upload.expected_sha256:
        raise HTTPException(status_code=409, detail="Retry payload does not match the reserved upload")
    try:
        if not storage.exists(upload.storage_key):
            storage.save(upload.storage_key, data)
        else:
            saved = storage.read(upload.storage_key)
            if hashlib.sha256(saved).hexdigest() != upload.expected_sha256:
                storage.save(upload.storage_key, data)
        if not _ensure_inference_file(db, upload, storage, inspected):
            raise HTTPException(status_code=503, detail="file storage failed for the inference image on retry")
    except HTTPException:
        raise
    except Exception as error:
        fail_upload(db, upload, f"file storage failed on retry: {error}", actor_id=actor_id)
        raise HTTPException(status_code=503, detail=f"file storage failed on retry: {error}") from error
    job = complete_upload(db, upload=upload, inspected=inspected, settings=settings)
    db.add(
        AuditRecord(
            entity_type="upload",
            entity_id=upload.upload_id,
            action="upload_retry_resumed",
            actor_id=actor_id,
            detail={"status_before_resume": "failed or receiving", "job_id": job.job_id},
        )
    )
    db.commit()
    return job


def claim_and_dispatch(
    db: Session,
    storage,
    adapter: CounterAdapter,
    job: ProcessingJob,
    image: ImageRecord,
    settings: Settings,
    now: datetime | None = None,
) -> str:
    """Atomically claim a bounded dispatch lease, then spawn and retain the
    call ID. Shared by the upload route and recovery, so concurrent dispatch
    paths claim the same database row instead of racing.

    Outcomes: 'dispatched', 'not_claimed' (another path holds a live claim or
    the job is beyond claimable states), 'needs_attention' (attempt budget
    exhausted; manual retry required), 'dispatch_failed_retryable',
    'failed_adapter' (explicit adapter/opt-in failure). Exactly-once across
    the spawn/call-ID-save crash window is NOT claimed: a 'spawned' row whose
    call ID was never saved may be reclaimed after its lease expires.
    """
    now = now or utcnow()
    budget = max(1, settings.dispatch_max_attempts)
    lease = timedelta(seconds=settings.dispatch_lease_seconds)
    stale_cutoff = now - lease
    claimed = db.execute(
        update(ProcessingJob)
        .where(
            ProcessingJob.job_id == job.job_id,
            ProcessingJob.state == "queued",
            ProcessingJob.modal_call_id.is_(None),
            ProcessingJob.needs_attention.is_(False),
            ProcessingJob.dispatch_attempts < budget,
            or_(
                ProcessingJob.dispatch_state == "unclaimed",
                and_(
                    ProcessingJob.dispatch_state == "claimed",
                    ProcessingJob.claim_expires_at.isnot(None),
                    ProcessingJob.claim_expires_at < now,
                ),
                and_(
                    ProcessingJob.dispatch_state == "spawned",
                    ProcessingJob.last_dispatch_at.isnot(None),
                    ProcessingJob.last_dispatch_at < stale_cutoff,
                ),
            ),
        )
        .values(
            dispatch_state="claimed",
            dispatch_attempts=ProcessingJob.dispatch_attempts + 1,
            last_dispatch_at=now,
            claim_expires_at=now + lease,
        )
    )
    db.commit()
    if claimed.rowcount == 0:
        db.expire(job)
        if job.modal_call_id is None and job.dispatch_attempts >= budget and job.state == "queued":
            if not job.needs_attention:
                job.needs_attention = True
                job.failure_reason = (
                    f"dispatch attempt budget exhausted after {job.dispatch_attempts} attempts; "
                    "manual attention required"
                )
                db.commit()
            return "needs_attention"
        return "not_claimed"
    # Claim held: read the inference image and spawn.
    try:
        image_bytes = storage.read(image.inference_storage_key)
        call_id = adapter.spawn(image_bytes, job.prompt, job.threshold)
    except (AdapterNotConfigured, ArchiveOptInRequired) as error:
        job.state = "failed"
        job.failure_reason = str(error)[:500]
        job.finished_at = utcnow()
        job.dispatch_state = "unclaimed"
        job.claim_expires_at = None
        db.commit()
        return "failed_adapter"
    except Exception as error:  # dispatch problem: release the claim, bounded retry
        job.failure_reason = f"dispatch failed: {error}"[:500]
        job.dispatch_state = "unclaimed"
        job.claim_expires_at = None
        db.commit()
        db.expire(job)
        if job.dispatch_attempts >= budget:
            job.needs_attention = True
            job.failure_reason = (
                f"dispatch attempt budget exhausted after {job.dispatch_attempts} attempts; "
                f"manual attention required; last error: {error}"
            )[:500]
            db.commit()
            return "needs_attention"
        return "dispatch_failed_retryable"
    job.modal_call_id = call_id
    job.dispatch_state = "spawned"
    job.claim_expires_at = None
    db.commit()
    return "dispatched"


def dispatch_image_bytes(
    db: Session,
    storage,
    adapter: CounterAdapter,
    job: ProcessingJob,
    image: ImageRecord,
    settings: Settings | None = None,
) -> str:
    """Bounded, claim-based dispatch. Returns the claim_and_dispatch outcome."""
    if settings is None:
        raise ValueError("dispatch_image_bytes requires settings for the attempt budget and lease")
    return claim_and_dispatch(db, storage, adapter, job, image, settings)


def publish_result(
    db: Session,
    storage,
    *,
    job_id: str,
    report: dict[str, Any],
    annotated_png: bytes,
    image: ImageRecord,
) -> str:
    """Conditionally publish one result. Returns 'published' or 'duplicate_discarded'.

    Provenance comes from the durable image record: the true normalized
    inference SHA-256 and the recorded transformations, never the original
    file hash. An image without provenance must not be published mislabeled.
    """
    if not image.inference_sha256:
        return fail_job(db, db.get(ProcessingJob, job_id), "Refusing to publish: image lacks inference provenance")
    condition = ProcessingJob.job_id == job_id
    updated = db.execute(
        update(ProcessingJob)
        .where(condition, ProcessingJob.state.in_(["queued", "running"]))
        .values(state="completed", finished_at=utcnow(), failure_reason=None)
    )
    if updated.rowcount == 0:
        db.rollback()
        return "duplicate_discarded"
    job = db.get(ProcessingJob, job_id)
    annotation_key = f"results/{job_id}/annotated.png"
    report_key = f"results/{job_id}/report.json"
    storage.save(annotation_key, annotated_png)
    storage.save(report_key, json.dumps(report, indent=2).encode("utf-8"))
    result = ProcessingResult(
        result_id=new_id(),
        job_id=job_id,
        image_id=job.image_id,
        candidate_count=int(report["count"]),
        candidate_detections=list(report.get("detections", [])),
        candidate_report=dict(report),
        annotation_storage_key=annotation_key,
        inference_sha256=image.inference_sha256,
        transformations=list(image.transformations),
    )
    db.add(result)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return "duplicate_discarded"
    return "published"


def fail_job(db: Session, job: ProcessingJob, reason: str) -> str:
    """Conditionally mark a job failed; a published result is never overwritten."""
    updated = db.execute(
        update(ProcessingJob)
        .where(ProcessingJob.job_id == job.job_id, ProcessingJob.state.in_(["queued", "running"]))
        .values(state="failed", finished_at=utcnow(), failure_reason=reason[:500])
    )
    db.commit()
    return "failed" if updated.rowcount else "duplicate_discarded"


def poll_and_publish(
    db: Session,
    storage,
    adapter: CounterAdapter,
    job: ProcessingJob,
    image: ImageRecord,
    timeout_seconds: float = 0.0,
) -> str:
    try:
        result = adapter.poll(job.modal_call_id, timeout_seconds)
    except (AdapterNotConfigured, ArchiveOptInRequired) as error:
        return fail_job(db, job, str(error))
    if result is None:
        job.state = "running" if job.state == "queued" else job.state
        db.commit()
        return "pending"
    return publish_result(
        db,
        storage,
        job_id=job.job_id,
        report=result.report,
        annotated_png=result.annotated_png,
        image=image,
    )


def review_state_for(db: Session, sample_id: int) -> tuple[str, Measurement | None]:
    active = active_measurement(db, sample_id)
    if active is None:
        return "pending_review", None
    return ("accepted" if active.decision == "accepted" else "rejected"), active


def active_measurement(db: Session, sample_id: int) -> Measurement | None:
    return (
        db.query(Measurement)
        .filter(Measurement.sample_id == sample_id, Measurement.superseded_at.is_(None))
        .order_by(Measurement.revision.desc())
        .first()
    )


def measurement_for_image(db: Session, image_id: str) -> Measurement | None:
    """The latest measurement record for ONE image, if any.

    Distinct from the sample's active measurement: after photo 1 is accepted
    and later superseded by a replacement, this still reports photo 1's own
    (historical) measurement, while `sample_active` reports what is currently
    active for the sample.
    """
    return (
        db.query(Measurement)
        .filter(Measurement.image_id == image_id)
        .order_by(Measurement.revision.desc())
        .first()
    )


def list_samples(
    db: Session,
    trap_id: str,
    state: str = "active",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[Sample], int]:
    """Authorized sample listing with bounded, filtered states.

    - active (default): removed_at IS NULL (unchanged historical behavior)
    - awaiting_image: removed, photographed by nobody yet (reload-safe)
    - awaiting_review: removed, has a completed candidate, no active review
    - all: every sample for the trap, paginated with limit/offset
    Work queues (awaiting_*) are naturally bounded; 'all' is always paginated.
    """
    if state not in {"active", "awaiting_image", "awaiting_review", "all"}:
        raise HTTPException(status_code=422, detail="sample_state must be active, awaiting_image, awaiting_review or all")
    base = db.query(Sample).filter(Sample.trap_id == trap_id)
    image_exists = exists().where(ImageRecord.sample_id == Sample.sample_id)
    active_measurement_exists = exists().where(
        and_(Measurement.sample_id == Sample.sample_id, Measurement.superseded_at.is_(None))
    )
    completed_result_exists = exists().where(
        and_(
            ImageRecord.sample_id == Sample.sample_id,
            ProcessingResult.image_id == ImageRecord.image_id,
        )
    )
    if state == "active":
        base = base.filter(Sample.removed_at.is_(None))
    elif state == "awaiting_image":
        base = base.filter(Sample.removed_at.is_not(None), ~image_exists)
    elif state == "awaiting_review":
        base = base.filter(
            Sample.removed_at.is_not(None),
            completed_result_exists,
            ~active_measurement_exists,
        )
    total = base.count()
    samples = base.order_by(Sample.installed_at.desc()).offset(offset).limit(limit).all()
    return samples, total


def create_review(
    db: Session,
    *,
    sample: Sample,
    reviewer: Operator,
    image_id: str,
    result_id: str | None,
    decision: str,
    corrected_count: int | None,
    usable_exposure: bool,
    quality_flags: list[str],
    taxon_verification: str | None,
    rejection_reason: str | None,
    expected_sample_revision: int,
    expected_measurement_revision: int | None,
) -> Measurement:
    """Create one review with atomic revision serialization.

    Concurrency contract (single transaction):
    - the sample revision is CAS-guarded (row-locked, not overwritten);
    - the active measurement is superseded by a conditional UPDATE that only
      matches a still-active row (CAS); zero rows means a concurrent review
      won and the caller gets 409;
    - the partial unique index allows exactly ONE active review row per
      sample, for accepted AND rejected decisions; a losing concurrent insert
      raises IntegrityError and maps to 409.
    SQLite serializes writers (a conflicting writer gets a lock timeout that
    maps to 409); PostgreSQL relies on row locking plus the same partial
    unique index. A live PostgreSQL test has not been run.
    """
    image = db.get(ImageRecord, image_id)
    if image is None or image.sample_id != sample.sample_id:
        raise HTTPException(status_code=404, detail="Image does not belong to this sample")
    result: ProcessingResult | None = None
    if decision == "accepted":
        if result_id:
            result = db.get(ProcessingResult, result_id)
            if result is None or result.image_id != image_id:
                raise HTTPException(status_code=404, detail="Result does not belong to this image")
        else:
            result = db.query(ProcessingResult).filter(ProcessingResult.image_id == image_id).one_or_none()
        if result is None:
            raise HTTPException(
                status_code=409, detail="No completed candidate result exists for this image; a failed count has no accepted count"
            )
        accepted_count = result.candidate_count if corrected_count is None else corrected_count
        # Server-side zero eligibility derives from sample truth plus the
        # reviewer input; the client checkbox alone is never sufficient.
        derived_usable = bool(usable_exposure) and sample.exposure_known and sample.removed_at is not None
        if accepted_count == 0 and not derived_usable:
            raise HTTPException(
                status_code=422,
                detail=(
                    "A confirmed zero requires a completed exposure: the sample must have a "
                    "recorded removal time and known usable exposure; unknown, incomplete or "
                    "failed exposure never becomes a usable zero"
                ),
            )
        usable_exposure = derived_usable
        count_source = "candidate" if corrected_count is None else "corrected"
    else:
        if not rejection_reason:
            raise HTTPException(status_code=422, detail="A rejected review requires a reason")
        accepted_count = None
        count_source = "candidate"
    now = utcnow()
    # CAS-guard the sample revision inside this transaction (locks the row,
    # changes nothing): a concurrent PATCH or review makes this match 0 rows.
    guarded = _cas_execute(
        db,
        update(Sample)
        .where(Sample.sample_id == sample.sample_id, Sample.revision == expected_sample_revision)
        .values(revision=Sample.revision),
        "Concurrent sample update in progress; re-read the sample revision and retry",
    )
    if guarded.rowcount == 0:
        raise StaleRevision(
            f"Stale sample revision: expected {expected_sample_revision}, current {sample.revision}"
        )
    active = (
        db.query(Measurement)
        .filter(Measurement.sample_id == sample.sample_id, Measurement.superseded_at.is_(None))
        .one_or_none()
    )
    active_revision = active.revision if active else None
    if expected_measurement_revision != active_revision:
        raise StaleRevision(
            f"Stale measurement revision: expected {expected_measurement_revision}, current {active_revision}"
        )
    if active is not None:
        superseded = _cas_execute(
            db,
            update(Measurement)
            .where(
                Measurement.measurement_id == active.measurement_id,
                Measurement.superseded_at.is_(None),
            )
            .values(superseded_at=now),
            "Concurrent review in progress; re-read the active measurement revision and retry",
        )
        if superseded.rowcount == 0:
            raise StaleRevision(
                "Concurrent review superseded the active measurement; "
                "re-read the active measurement revision and retry"
            )
    measurement = Measurement(
        measurement_id=new_id(),
        sample_id=sample.sample_id,
        image_id=image_id,
        result_id=result.result_id if result is not None else None,
        decision=decision,
        accepted_count=accepted_count,
        count_source=count_source,
        reviewer_id=reviewer.id,
        reviewed_at=now,
        available_at=now if decision == "accepted" else None,
        usable_exposure=usable_exposure,
        quality_flags=quality_flags,
        taxon_verification=taxon_verification,
        rejection_reason=rejection_reason if decision == "rejected" else None,
        revision=(active.revision + 1) if active else 1,
        supersedes_measurement_id=active.measurement_id if active else None,
        superseded_at=None,
    )
    db.add(measurement)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Concurrent review for this sample; re-read the active measurement revision and retry",
        ) from error
    except OperationalError as error:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Concurrent review write in progress; re-read the active measurement revision and retry",
        ) from error
    return measurement


def check_rate(db: Session, key: str, limit_per_minute: int, now: datetime | None = None) -> None:
    """Fixed-window per-identity upload throttle backed by the database."""
    now = now or utcnow()
    window_start = now.replace(second=0, microsecond=0)
    # Expire old buckets on use. Unknown login names share a fixed bucket;
    # authenticated upload and known-account keys are bounded by registry IDs.
    db.query(UsageRate).filter(UsageRate.window_start < window_start).delete(synchronize_session=False)
    row = db.get(UsageRate, key)
    if row is None or row.window_start != window_start:
        if row is None:
            db.add(UsageRate(window_key=key, window_start=window_start, count=1))
        else:
            row.window_start = window_start
            row.count = 1
        db.commit()
        return
    if row.count >= limit_per_minute:
        db.commit()
        raise HTTPException(status_code=429, detail="Request rate limit exceeded; retry shortly")
    row.count += 1
    db.commit()


def run_recovery(
    db: Session,
    storage,
    adapter: CounterAdapter,
    settings: Settings,
    now: datetime | None = None,
) -> dict[str, int]:
    """Recovery passes for save/dispatch crashes.

    1. Complete or fail stale `receiving` reservations (crash between file
       save and the stored-commit). The computed inference image is written
       and verified BEFORE the upload is marked stored or any job is created;
       a reservation whose inference image cannot be persisted stays failed.
    2. Create missing processing jobs for stored uploads, with the same
       inference-file guarantee.
    3. Claim queued jobs atomically (bounded attempts, sharing the same claim
       with the upload route), dispatch, then poll and conditionally publish
       finished Modal calls by their retained call ID. Spawn-on-poll never
       happens. Exactly-once is not claimed across the spawn/call-ID-save
       crash window.
    """
    now = now or utcnow()
    summary = {
        "reservations_completed": 0,
        "reservations_failed": 0,
        "jobs_created": 0,
        "jobs_dispatched": 0,
        "jobs_published": 0,
        "jobs_failed": 0,
        "jobs_needs_attention": 0,
    }
    stale_cutoff = now - timedelta(seconds=settings.recovery_reservation_stale_seconds)
    for upload in db.query(Upload).filter(Upload.status == "receiving").all():
        if upload.reserved_at > stale_cutoff:
            continue
        file_ok = False
        try:
            if storage.exists(upload.storage_key):
                saved = storage.read(upload.storage_key)
                file_ok = hashlib.sha256(saved).hexdigest() == upload.expected_sha256
        except Exception:
            file_ok = False
        if file_ok:
            inspected = _reinspect(db, upload, storage, settings)
            if inspected is not None and _ensure_inference_file(db, upload, storage, inspected):
                complete_upload(db, upload=upload, inspected=inspected, settings=settings, received_at=now)
                summary["reservations_completed"] += 1
                continue
        fail_upload(db, upload, "Recovery: reserved upload has no verifiable saved file")
        summary["reservations_failed"] += 1

    stored_uploads = db.query(Upload).filter(Upload.status == "stored").all()
    for upload in stored_uploads:
        image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload.upload_id).one_or_none()
        has_job = (
            image is not None
            and db.query(ProcessingJob).filter(ProcessingJob.image_id == image.image_id).one_or_none() is not None
        )
        if has_job:
            continue
        if image is not None:
            # The image row exists; its inference file must too before a new
            # job is created. Re-inspect and re-save if the crash ate the file.
            if not storage.exists(image.inference_storage_key):
                inspected = _reinspect(db, upload, storage, settings)
                if inspected is None or not _ensure_inference_file(db, upload, storage, inspected, existing_image=image):
                    fail_upload(db, upload, "Recovery: stored upload is missing its verifiable inference image")
                    summary["reservations_failed"] += 1
                    continue
            complete_upload(db, upload=upload, inspected=None, settings=settings, received_at=now)
            summary["jobs_created"] += 1
            continue
        inspected = _reinspect(db, upload, storage, settings)
        if inspected is None or not _ensure_inference_file(db, upload, storage, inspected):
            fail_upload(db, upload, "Recovery: stored upload failed revalidation")
            summary["reservations_failed"] += 1
            continue
        complete_upload(db, upload=upload, inspected=inspected, settings=settings, received_at=now)
        summary["jobs_created"] += 1

    jobs = (
        db.query(ProcessingJob)
        .options(selectinload(ProcessingJob.result))
        .filter(ProcessingJob.state.in_(["queued", "running"]))
        .all()
    )
    for job in jobs:
        image = db.get(ImageRecord, job.image_id)
        if job.modal_call_id is None:
            if job.needs_attention:
                summary["jobs_needs_attention"] += 1
                continue
            outcome = claim_and_dispatch(db, storage, adapter, job, image, settings, now=now)
            if outcome == "dispatched":
                summary["jobs_dispatched"] += 1
            elif outcome in {"needs_attention", "failed_adapter"}:
                summary["jobs_failed"] += 1
            continue
        outcome = poll_and_publish(db, storage, adapter, job, image)
        if outcome == "published":
            summary["jobs_published"] += 1
        elif outcome in {"failed", "provenance_missing"}:
            summary["jobs_failed"] += 1
    return summary


def _reinspect(db: Session, upload: Upload, storage, settings: Settings) -> InspectedImage | None:
    from .images import inspect_image

    try:
        data = storage.read(upload.storage_key)
    except Exception:
        return None
    try:
        return inspect_image(data, ImageLimits(max_bytes=settings.max_image_bytes, max_pixels=settings.max_image_pixels))
    except HTTPException:
        return None