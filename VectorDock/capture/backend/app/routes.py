"""Application routes for the VectorDock capture backend.

All state-changing routes require an authenticated session; cookie writes
additionally require the session CSRF token and a trusted Origin. Images and
results are private: retrieval is authorized by trap access grants. A job or
upload ID is not an access token.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import Response as BytesResponse
from sqlalchemy.orm import Session

from .deps import AppState, get_db, get_state, require_admin, require_user
from .images import ImageLimits, inference_storage_key, inspect_image
from .models import (
    AuditRecord,
    ImageRecord,
    Measurement,
    Operator,
    ProcessingJob,
    ProcessingResult,
    Sample,
    SessionRecord,
    Upload,
    utcnow,
)
from .schemas import (
    DeploymentOut,
    HealthOut,
    LoginIn,
    LoginOut,
    MeasurementOut,
    MeOut,
    OperatorOut,
    RecoveryOut,
    RetakeRequestOut,
    ReviewCreateIn,
    SampleCreateIn,
    SampleOut,
    SampleUpdateIn,
    SampleUpdateOut,
    TrapOut,
    UploadOut,
    UploadQueueOut,
)
from .security import (
    SESSION_COOKIE,
    SESSION_TTL,
    AuthContext,
    check_identity_headers,
    check_origin,
    grant_trap_ids,
    hash_token,
    new_csrf_token,
    new_session_token,
    require_trap_access,
    verify_password,
)
from . import service

router = APIRouter(prefix="/api")


def _sample_out(sample: Sample) -> SampleOut:
    return SampleOut(
        sample_id=sample.sample_id,
        trap_id=sample.trap_id,
        deployment_id=sample.deployment_id,
        sample_type=sample.sample_type,
        cartridge_id=sample.cartridge_id,
        strip_id=sample.strip_id,
        installed_at=sample.installed_at,
        installed_at_offset=sample.installed_at_offset,
        removed_at=sample.removed_at,
        removed_at_offset=sample.removed_at_offset,
        exposed_area_cm2=sample.exposed_area_cm2,
        condition_notes=sample.condition_notes,
        exposure_known=sample.exposure_known,
        revision=sample.revision,
        is_test_fixture=sample.is_test_fixture,
    )


def _measurement_out(db: Session, measurement: Measurement) -> MeasurementOut:
    result = db.get(ProcessingResult, measurement.result_id) if measurement.result_id else None
    reviewer = db.get(Operator, measurement.reviewer_id)
    return MeasurementOut(
        measurement_id=measurement.measurement_id,
        sample_id=measurement.sample_id,
        image_id=measurement.image_id,
        result_id=measurement.result_id,
        decision=measurement.decision,  # type: ignore[arg-type]
        accepted_count=measurement.accepted_count,
        count_source=measurement.count_source,  # type: ignore[arg-type]
        candidate_count=result.candidate_count if result else None,
        reviewer=reviewer.username if reviewer else "unknown",
        reviewed_at=measurement.reviewed_at,
        available_at=measurement.available_at,
        usable_exposure=measurement.usable_exposure,
        quality_flags=measurement.quality_flags,
        taxon_verification=measurement.taxon_verification,
        rejection_reason=measurement.rejection_reason,
        revision=measurement.revision,
        supersedes_measurement_id=measurement.supersedes_measurement_id,
        superseded_at=measurement.superseded_at,
    )


def _get_sample_or_404(db: Session, sample_id: int) -> Sample:
    sample = db.get(Sample, sample_id)
    if sample is None:
        raise HTTPException(status_code=404, detail=f"Unknown sample: {sample_id}")
    return sample


def _upload_out(db: Session, request: Request, upload: Upload, image: ImageRecord | None) -> UploadOut:
    processing = None
    result_preview = None
    if image is not None:
        job = db.query(ProcessingJob).filter(ProcessingJob.image_id == image.image_id).one_or_none()
        if job is not None:
            processing = {
                "state": job.state,
                "failure_reason": job.failure_reason,
                "modal_call_id": job.modal_call_id,
                "needs_attention": bool(job.needs_attention),
            }
            if job.state == "completed":
                result = (
                    db.query(ProcessingResult)
                    .filter(ProcessingResult.image_id == image.image_id)
                    .one_or_none()
                )
                if result is not None:
                    base = str(request.base_url).rstrip("/")
                    result_preview = {
                        "result_id": result.result_id,
                        "candidate_count": result.candidate_count,
                        "annotation_url": f"{base}/api/results/{result.result_id}/annotation",
                    }
    review_state, active = service.review_state_for(db, upload.sample_id)
    base = str(request.base_url).rstrip("/")
    # Per-image review state: THIS upload's image, not the sample's active
    # measurement. Photo 1 accepted + photo 2 completed => photo 2 stays
    # pending_review here while sample_active still reports the accepted
    # measurement and its revision for an explicit replacement review.
    image_measurement = service.measurement_for_image(db, image.image_id) if image is not None else None
    if image_measurement is not None:
        review_state = "accepted" if image_measurement.decision == "accepted" else "rejected"
        measurement_id = image_measurement.measurement_id
        measurement_revision = image_measurement.revision
    else:
        review_state = "pending_review"
        measurement_id = None
        measurement_revision = None
    return UploadOut(
        upload_id=upload.upload_id,
        sample_id=upload.sample_id,
        image_id=image.image_id if image else None,
        status=upload.status,  # type: ignore[arg-type]
        failure_reason=upload.failure_reason,
        received_at=upload.received_at,
        captured_at=upload.captured_at,
        processing=processing,  # type: ignore[arg-type]
        review={
            "state": review_state,
            "measurement_id": measurement_id,
            "measurement_revision": measurement_revision,
            "accepted_count": image_measurement.accepted_count if image_measurement else None,
            "sample_active": {
                "measurement_id": active.measurement_id,
                "image_id": active.image_id,
                "decision": active.decision,
                "revision": active.revision,
            }
            if active
            else None,
        },  # type: ignore[arg-type]
        result=result_preview,
        status_url=f"{base}/api/uploads/{upload.upload_id}",
        original_url=f"{base}/api/images/{image.image_id}/original" if image else None,
    )


# --------------------------------------------------------------------------- auth


@router.post("/auth/login", response_model=LoginOut)
def login(
    payload: LoginIn,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
    state: AppState = Depends(get_state),
) -> LoginOut:
    check_identity_headers(request)
    check_origin(request, state.settings)
    operator = db.query(Operator).filter(Operator.username == payload.username).one_or_none()
    # Unknown names share one bucket; attacker-controlled names do not create
    # unbounded rows. Registered accounts keep independent limits.
    rate_key = f"login:operator:{operator.id}" if operator else "login:unknown"
    service.check_rate(db, rate_key, state.settings.login_rate_per_minute)
    if operator is None or not operator.is_active or not verify_password(payload.password, operator.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    token = new_session_token()
    csrf = new_csrf_token()
    now = utcnow()
    record = SessionRecord(
        token_hash=hash_token(token),
        operator_id=operator.id,
        csrf_token=csrf,
        created_at=now,
        expires_at=now + SESSION_TTL,
    )
    db.add(record)
    db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=state.settings.cookie_secure,
        samesite="lax",
        max_age=int(SESSION_TTL.total_seconds()),
        path="/",
    )
    return LoginOut(
        operator=OperatorOut(username=operator.username, display_name=operator.display_name, role=operator.role),  # type: ignore[arg-type]
        csrf_token=csrf,
    )


@router.post("/auth/logout", status_code=204)
def logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> None:
    if auth.session is not None:
        record = db.query(SessionRecord).filter(SessionRecord.id == auth.session.id).one()
        record.revoked_at = utcnow()
        db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/auth/me", response_model=MeOut)
def me(db: Session = Depends(get_db), auth: AuthContext = Depends(require_user)) -> MeOut:
    return MeOut(
        operator=OperatorOut(username=auth.operator.username, display_name=auth.operator.display_name, role=auth.operator.role),  # type: ignore[arg-type]
        granted_trap_ids=sorted(grant_trap_ids(db, auth.operator.id)),
    )


@router.get("/health", response_model=HealthOut)
def health(state: AppState = Depends(get_state)) -> HealthOut:
    return HealthOut(
        status="ok",
        env=state.settings.env,
        database=state.settings.database_url.split("://", 1)[0] if state.settings.database_url else "unset",
        storage=state.settings.storage_backend,
    )


# --------------------------------------------------------------------------- registry


@router.get("/traps/{trap_id}", response_model=TrapOut)
def get_trap(
    trap_id: str,
    sample_state: str = Query("active"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> TrapOut:
    """Authorized trap lookup with a bounded sample slice.

    sample_state filters: active (default, removed_at IS NULL),
    awaiting_image (removed, no photo yet), awaiting_review (removed, has a
    completed candidate, no active review), all (paginated). Defaults keep
    the historical response shape.
    """
    require_trap_access(db, auth, trap_id)
    trap = service.get_trap_or_404(db, trap_id)
    deployment = service.active_deployment(db, trap_id)
    samples, total = service.list_samples(db, trap_id, sample_state, limit, offset)
    return TrapOut(
        trap_id=trap.trap_id,
        district_code=trap.district_code,
        site_id=trap.site_id,
        placement=trap.placement,
        trap_design_version=trap.trap_design_version,
        lure_version=trap.lure_version,
        surface_protocol=trap.surface_protocol,
        is_test_fixture=trap.is_test_fixture,
        active_deployment=DeploymentOut(
            deployment_id=deployment.deployment_id,
            trap_id=deployment.trap_id,
            site_id=deployment.site_id,
            district_code=deployment.district_code,
            location_note=deployment.location_note,
            start_at=deployment.start_at,
            end_at=deployment.end_at,
        )
        if deployment
        else None,
        samples=[_sample_out(sample) for sample in samples],
        sample_state=sample_state,
        sample_total=total,
    )


@router.get("/traps/{trap_id}/uploads", response_model=UploadQueueOut)
def list_trap_uploads(
    trap_id: str,
    request: Request,
    limit: int = Query(25, ge=1, le=50),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> UploadQueueOut:
    """Reload-safe, paginated image history, including unreviewed retakes."""
    require_trap_access(db, auth, trap_id)
    service.get_trap_or_404(db, trap_id)
    query = db.query(Upload).join(Sample, Upload.sample_id == Sample.sample_id).filter(Sample.trap_id == trap_id)
    total = query.count()
    uploads = query.order_by(Upload.reserved_at.desc(), Upload.upload_id.desc()).offset(offset).limit(limit).all()
    items = []
    for upload in uploads:
        sample = db.get(Sample, upload.sample_id)
        image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload.upload_id).one_or_none()
        items.append({"sample": _sample_out(sample), "upload": _upload_out(db, request, upload, image)})
    return UploadQueueOut(items=items, total=total, limit=limit, offset=offset)


@router.get("/samples/{sample_id}", response_model=SampleOut)
def get_sample(
    sample_id: int,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> SampleOut:
    sample = _get_sample_or_404(db, sample_id)
    require_trap_access(db, auth, sample.trap_id)
    return _sample_out(sample)


@router.post("/traps/{trap_id}/samples", response_model=SampleOut, status_code=201)
def create_sample_route(
    trap_id: str,
    payload: SampleCreateIn,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> SampleOut:
    require_trap_access(db, auth, trap_id)
    trap = service.get_trap_or_404(db, trap_id)
    sample = service.create_sample(
        db,
        trap=trap,
        operator=auth.operator,
        sample_type=payload.sample_type,
        installed_at=payload.installed_at,
        installed_at_offset=payload.installed_at_offset,
        cartridge_id=payload.cartridge_id,
        strip_id=payload.strip_id,
        exposed_area_cm2=payload.exposed_area_cm2,
        condition_notes=payload.condition_notes,
        is_test_fixture=trap.is_test_fixture,
    )
    db.commit()
    return _sample_out(sample)


@router.patch("/samples/{sample_id}", response_model=SampleUpdateOut)
def patch_sample(
    sample_id: int,
    payload: SampleUpdateIn,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> SampleUpdateOut:
    sample = _get_sample_or_404(db, sample_id)
    require_trap_access(db, auth, sample.trap_id)
    sample, audit_id = service.update_sample(
        db,
        sample=sample,
        operator=auth.operator,
        expected_revision=payload.expected_revision,
        removed_at=payload.removed_at,
        removed_at_offset=payload.removed_at_offset,
        condition_notes=payload.condition_notes,
        exposure_known=payload.exposure_known,
    )
    db.commit()
    return SampleUpdateOut(sample=_sample_out(sample), audit_id=audit_id)


# --------------------------------------------------------------------------- upload and jobs


@router.post("/samples/{sample_id}/images", response_model=UploadOut, status_code=202)
def submit_image(
    sample_id: int,
    request: Request,
    response: Response,
    client_key: str = Form(min_length=8, max_length=128),
    captured_at: str = Form(),
    captured_at_offset: str = Form(default="+00:00"),
    file: UploadFile = File(),
    db: Session = Depends(get_db),
    state: AppState = Depends(get_state),
    auth: AuthContext = Depends(require_user),
) -> UploadOut:
    sample = _get_sample_or_404(db, sample_id)
    require_trap_access(db, auth, sample.trap_id)
    if state.settings.is_production and not state.settings.modal_enabled:
        raise HTTPException(
            status_code=503,
            detail="Photo upload is disabled until live counting is authorized. No photo was saved.",
        )
    service.check_rate(db, f"upload:{auth.operator.id}", state.settings.upload_rate_per_minute)
    try:
        capture_time = datetime.fromisoformat(captured_at)
    except ValueError as error:
        raise HTTPException(status_code=422, detail="captured_at must be an ISO 8601 timestamp") from error
    data = file.file.read()
    inspected = inspect_image(
        data,
        ImageLimits(max_bytes=state.settings.max_image_bytes, max_pixels=state.settings.max_image_pixels),
    )
    upload, created = service.reserve_upload(
        db,
        sample=sample,
        uploader=auth.operator,
        client_key=client_key,
        data=data,
        captured_at=capture_time,
        captured_at_offset=captured_at_offset,
        inspected=inspected,
        settings=state.settings,
    )
    if created:
        try:
            state.storage.save(upload.storage_key, data)
            state.storage.save(inference_storage_key(upload.upload_id, inspected), inspected.inference_bytes)
        except Exception as error:  # file write failed: explicit failure, no saved confirmation
            service.fail_upload(db, upload, f"file storage failed: {error}", actor_id=auth.operator.id)
            raise HTTPException(status_code=503, detail=f"file storage failed: {error}") from error
        job = service.complete_upload(db, upload=upload, inspected=inspected, settings=state.settings)
        image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload.upload_id).one()
        service.dispatch_image_bytes(db, state.storage, state.adapter, job, image, state.settings)
    elif upload.status == "failed" or (
        upload.status == "receiving"
        and (utcnow() - upload.reserved_at)
        > timedelta(seconds=state.settings.recovery_reservation_stale_seconds)
    ):
        # Same key, same sample, same content after a failed storage attempt
        # (or a crashed, stale reservation): safely resume storage instead of
        # returning the dead record. A fresh 'receiving' reservation still
        # belongs to its in-flight writer and is not stolen. A job that is
        # already queued/spawned/completed/failed is NOT dispatched again by
        # an HTTP retry; the bounded claim decides dispatch.
        resumed_job = service.resume_storage_for_retry(
            db,
            upload=upload,
            storage=state.storage,
            data=data,
            inspected=inspected,
            settings=state.settings,
            actor_id=auth.operator.id,
        )
        image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload.upload_id).one_or_none()
        if image is not None and resumed_job is not None:
            service.dispatch_image_bytes(db, state.storage, state.adapter, resumed_job, image, state.settings)
    image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload.upload_id).one_or_none()
    db.commit()
    out = _upload_out(db, request, upload, image)
    response.status_code = 202 if created else 200
    return out


@router.get("/uploads/{upload_id}", response_model=UploadOut)
def get_upload(
    upload_id: str,
    request: Request,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> UploadOut:
    upload = db.get(Upload, upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail=f"Unknown upload: {upload_id}")
    sample = _get_sample_or_404(db, upload.sample_id)
    require_trap_access(db, auth, sample.trap_id)
    image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload.upload_id).one_or_none()
    return _upload_out(db, request, upload, image)


@router.post("/uploads/{upload_id}/poll", response_model=UploadOut)
def poll_upload(
    upload_id: str,
    request: Request,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
    state: AppState = Depends(get_state),
) -> UploadOut:
    """Check an existing call, without submitting another inference job.

    The phone uses this only while a user is looking at a pending upload.
    Unattended recovery remains scheduled separately. A candidate result is
    not an accepted measurement and creates no measurement revision.
    """
    upload = db.get(Upload, upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="Unknown upload")
    sample = _get_sample_or_404(db, upload.sample_id)
    require_trap_access(db, auth, sample.trap_id)
    service.check_rate(db, f"poll:{auth.operator.id}", 120)
    image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload_id).one_or_none()
    job = db.query(ProcessingJob).filter(ProcessingJob.image_id == image.image_id).one_or_none() if image else None
    if job is not None and job.state in {"queued", "running"} and job.modal_call_id and not job.needs_attention:
        try:
            service.poll_and_publish(db, state.storage, state.adapter, job, image, timeout_seconds=0)
        except Exception:
            db.rollback()
            raise HTTPException(status_code=503, detail="Result check failed; the saved upload remains unchanged. Retry shortly.") from None
        db.expire_all()
        upload = db.get(Upload, upload_id)
        image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload_id).one_or_none()
    return _upload_out(db, request, upload, image)


# --------------------------------------------------------------------------- private files


@router.post("/uploads/{upload_id}/retake", response_model=RetakeRequestOut, status_code=201)
def request_attention_retake(
    upload_id: str,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
    state: AppState = Depends(get_state),
) -> RetakeRequestOut:
    """Audit a human choice to take a NEW photo. Never restart the old job."""
    upload = db.get(Upload, upload_id)
    if upload is None:
        raise HTTPException(status_code=404, detail="Unknown upload")
    sample = _get_sample_or_404(db, upload.sample_id)
    require_trap_access(db, auth, sample.trap_id)
    image = db.query(ImageRecord).filter(ImageRecord.upload_id == upload_id).one_or_none()
    job = db.query(ProcessingJob).filter(ProcessingJob.image_id == image.image_id).one_or_none() if image else None
    if job is None or not job.needs_attention or job.state != "queued":
        raise HTTPException(status_code=409, detail="This job is not awaiting supervisor attention. Refresh its status before choosing another action.")
    service.check_rate(db, f"retake:{auth.operator.id}", state.settings.upload_rate_per_minute)
    audit = AuditRecord(entity_type="upload", entity_id=upload_id, action="retake_requested",
                        actor_id=auth.operator.id, detail={"sample_id": sample.sample_id,
                        "job_id": job.job_id, "automatic_retry": False, "new_photo_required": True})
    db.add(audit)
    db.commit()
    return RetakeRequestOut(sample_id=sample.sample_id, audit_id=audit.audit_id)


@router.get("/images/{image_id}/original")
def get_original(
    image_id: str,
    db: Session = Depends(get_db),
    state: AppState = Depends(get_state),
    auth: AuthContext = Depends(require_user),
) -> BytesResponse:
    image = db.get(ImageRecord, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail=f"Unknown image: {image_id}")
    sample = _get_sample_or_404(db, image.sample_id)
    require_trap_access(db, auth, sample.trap_id)
    return BytesResponse(
        content=state.storage.read(image.storage_key),
        media_type=image.media_type,
        headers={"Cache-Control": "no-store"},
    )


@router.get("/results/{result_id}/annotation")
def get_annotation(
    result_id: str,
    db: Session = Depends(get_db),
    state: AppState = Depends(get_state),
    auth: AuthContext = Depends(require_user),
) -> BytesResponse:
    result = db.get(ProcessingResult, result_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown result: {result_id}")
    image = db.get(ImageRecord, result.image_id)
    sample = _get_sample_or_404(db, image.sample_id)
    require_trap_access(db, auth, sample.trap_id)
    return BytesResponse(
        content=state.storage.read(result.annotation_storage_key),
        media_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


# --------------------------------------------------------------------------- review


@router.post("/samples/{sample_id}/reviews", response_model=MeasurementOut, status_code=201)
def create_review_route(
    sample_id: int,
    payload: ReviewCreateIn,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_user),
) -> MeasurementOut:
    if not auth.is_reviewer:
        raise HTTPException(status_code=403, detail="Reviewer role required")
    sample = _get_sample_or_404(db, sample_id)
    require_trap_access(db, auth, sample.trap_id)
    measurement = service.create_review(
        db,
        sample=sample,
        reviewer=auth.operator,
        image_id=payload.image_id,
        result_id=payload.result_id,
        decision=payload.decision,
        corrected_count=payload.corrected_count,
        usable_exposure=payload.usable_exposure,
        quality_flags=payload.quality_flags,
        taxon_verification=payload.taxon_verification,
        rejection_reason=payload.rejection_reason,
        expected_sample_revision=payload.expected_sample_revision,
        expected_measurement_revision=payload.expected_measurement_revision,
    )
    return _measurement_out(db, measurement)


# --------------------------------------------------------------------------- admin


@router.post("/admin/recovery", response_model=RecoveryOut)
def run_recovery_route(
    db: Session = Depends(get_db),
    state: AppState = Depends(get_state),
    _admin: AuthContext = Depends(require_admin),
) -> RecoveryOut:
    summary = service.run_recovery(db, state.storage, state.adapter, state.settings)
    return RecoveryOut(**summary)