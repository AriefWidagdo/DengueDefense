"""Durable metadata tables for the VectorDock capture backend.

All timestamps are stored in UTC. Source timezone offsets for worker-supplied
exposure and capture times are retained next to the UTC value.
Upload, processing and review states are kept in separate fields/tables.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    TypeDecorator,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

JSONVariant = sqlite.JSON().with_variant(postgresql.JSONB(), "postgresql")


def utcnow() -> datetime:
    from datetime import timezone

    return datetime.now(timezone.utc)


class UTCDateTime(TypeDecorator):
    """Store UTC datetimes; return tz-aware values on read (SQLite keeps none)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            value = value.astimezone(timezone.utc)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSONVariant, list[str]: JSONVariant}


class Operator(Base):
    __tablename__ = "operators"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="worker")  # worker|reviewer|admin
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_test_identity: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    grants: Mapped[list["TrapGrant"]] = relationship(back_populates="operator", cascade="all, delete-orphan")


class TrapGrant(Base):
    """A named operator's access to one trap. QR identification is not authorization."""

    __tablename__ = "trap_grants"
    __table_args__ = (UniqueConstraint("operator_id", "trap_id", name="uq_operator_trap"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    operator_id: Mapped[int] = mapped_column(ForeignKey("operators.id"), nullable=False)
    trap_id: Mapped[str] = mapped_column(String(64), ForeignKey("traps.trap_id"), nullable=False)
    granted_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    operator: Mapped[Operator] = relationship(back_populates="grants")


class SessionRecord(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    operator_id: Mapped[int] = mapped_column(ForeignKey("operators.id"), nullable=False)
    csrf_token: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class Trap(Base):
    __tablename__ = "traps"

    trap_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    district_code: Mapped[str] = mapped_column(String(32), nullable=False)
    site_id: Mapped[str] = mapped_column(String(64), nullable=False)
    placement: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    trap_design_version: Mapped[str] = mapped_column(String(64), nullable=False, default="v1")
    lure_version: Mapped[str | None] = mapped_column(String(64))
    surface_protocol: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    is_test_fixture: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    deployments: Mapped[list["Deployment"]] = relationship(back_populates="trap", order_by="Deployment.start_at")


class Deployment(Base):
    __tablename__ = "deployments"

    deployment_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trap_id: Mapped[str] = mapped_column(String(64), ForeignKey("traps.trap_id"), nullable=False)
    district_code: Mapped[str] = mapped_column(String(32), nullable=False)
    site_id: Mapped[str] = mapped_column(String(64), nullable=False)
    location_note: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    start_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    end_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    trap: Mapped[Trap] = relationship(back_populates="deployments")
    samples: Mapped[list["Sample"]] = relationship(back_populates="deployment")


class Sample(Base):
    __tablename__ = "samples"

    sample_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trap_id: Mapped[str] = mapped_column(String(64), ForeignKey("traps.trap_id"), nullable=False)
    deployment_id: Mapped[int] = mapped_column(ForeignKey("deployments.deployment_id"), nullable=False)
    sample_type: Mapped[str] = mapped_column(String(16), nullable=False)  # adult_card|egg_strip
    cartridge_id: Mapped[str | None] = mapped_column(String(64))
    strip_id: Mapped[str | None] = mapped_column(String(64))
    installed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    installed_at_offset: Mapped[str] = mapped_column(String(8), nullable=False, default="+00:00")
    removed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    removed_at_offset: Mapped[str | None] = mapped_column(String(8))
    exposed_area_cm2: Mapped[float | None] = mapped_column(Float)
    condition_notes: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    exposure_known: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_test_fixture: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[int] = mapped_column(ForeignKey("operators.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    deployment: Mapped[Deployment] = relationship(back_populates="samples")


class Upload(Base):
    """Reservation record for one upload attempt. One writer owns one client key."""

    __tablename__ = "uploads"

    upload_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.sample_id"), nullable=False)
    client_key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    expected_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str] = mapped_column(String(32), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="receiving")  # receiving|stored|failed
    failure_reason: Mapped[str | None] = mapped_column(String(255))
    captured_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    captured_at_offset: Mapped[str] = mapped_column(String(8), nullable=False, default="+00:00")
    received_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    uploader_id: Mapped[int] = mapped_column(ForeignKey("operators.id"), nullable=False)
    reserved_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    stored_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    image: Mapped["ImageRecord | None"] = relationship(back_populates="upload", uselist=False)


class ImageRecord(Base):
    __tablename__ = "images"

    image_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    upload_id: Mapped[str] = mapped_column(ForeignKey("uploads.upload_id"), unique=True, nullable=False)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.sample_id"), nullable=False)
    storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    inference_storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    media_type: Mapped[str] = mapped_column(String(32), nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    # Provenance of the inference input. Nullable for additive migration of
    # pre-existing databases; new rows always carry the true normalized-hash
    # and transformation records (never the original-file hash).
    inference_sha256: Mapped[str | None] = mapped_column(String(64))
    transformations: Mapped[list[dict[str, Any]]] = mapped_column(JSONVariant, nullable=False, default=list)
    captured_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    captured_at_offset: Mapped[str] = mapped_column(String(8), nullable=False, default="+00:00")
    received_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    uploader_id: Mapped[int] = mapped_column(ForeignKey("operators.id"), nullable=False)

    upload: Mapped[Upload] = relationship(back_populates="image")


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"

    job_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    image_id: Mapped[str] = mapped_column(ForeignKey("images.image_id"), unique=True, nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")  # queued|running|completed|failed
    prompt: Mapped[str] = mapped_column(String(120), nullable=False)
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    policy_version: Mapped[str] = mapped_column(String(64), nullable=False)
    checkpoint_version: Mapped[str] = mapped_column(String(120), nullable=False)
    modal_call_id: Mapped[str | None] = mapped_column(String(128))
    dispatch_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_dispatch_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    # Atomic dispatch claim (additive columns for existing databases).
    # unclaimed -> claimed (lease held) -> spawned (call ID retained).
    # A 'claimed' row whose lease expired, or a 'spawned' row that never
    # recorded its call ID (the unavoidable crash window), may be reclaimed
    # after the lease; redundant GPU work is possible and never exactly-once.
    dispatch_state: Mapped[str] = mapped_column(String(16), nullable=False, default="unclaimed")
    claim_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    needs_attention: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    failure_reason: Mapped[str | None] = mapped_column(String(500))

    result: Mapped["ProcessingResult | None"] = relationship(back_populates="job", uselist=False)


class ProcessingResult(Base):
    """Immutable candidate output from one completed counting job."""

    __tablename__ = "processing_results"

    result_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("processing_jobs.job_id"), unique=True, nullable=False)
    image_id: Mapped[str] = mapped_column(ForeignKey("images.image_id"), nullable=False)
    candidate_count: Mapped[int] = mapped_column(Integer, nullable=False)
    candidate_detections: Mapped[list[dict[str, Any]]] = mapped_column(JSONVariant, nullable=False, default=list)
    candidate_report: Mapped[dict[str, Any]] = mapped_column(JSONVariant, nullable=False, default=dict)
    annotation_storage_key: Mapped[str] = mapped_column(String(255), nullable=False)
    inference_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    transformations: Mapped[list[dict[str, Any]]] = mapped_column(JSONVariant, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)

    job: Mapped[ProcessingJob] = relationship(back_populates="result")


class Measurement(Base):
    """One accepted or rejected review decision for one sample.

    Measurements form a revision chain; at most one is active, whatever its
    decision. The partial unique index enforces one active review row per
    sample for accepted AND rejected decisions, so concurrent reviews cannot
    both become active; the loser commits second and gets a 409.
    """

    __tablename__ = "measurements"
    __table_args__ = (
        Index(
            "uq_active_measurement",
            "sample_id",
            unique=True,
            sqlite_where=text("superseded_at IS NULL"),
            postgresql_where=text("superseded_at IS NULL"),
        ),
    )

    measurement_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sample_id: Mapped[int] = mapped_column(ForeignKey("samples.sample_id"), nullable=False)
    image_id: Mapped[str] = mapped_column(ForeignKey("images.image_id"), nullable=False)
    result_id: Mapped[str | None] = mapped_column(ForeignKey("processing_results.result_id"))
    decision: Mapped[str] = mapped_column(String(16), nullable=False)  # accepted|rejected
    accepted_count: Mapped[int | None] = mapped_column(Integer)
    count_source: Mapped[str] = mapped_column(String(16), nullable=False, default="candidate")  # candidate|corrected
    reviewer_id: Mapped[int] = mapped_column(ForeignKey("operators.id"), nullable=False)
    reviewed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    available_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    usable_exposure: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    quality_flags: Mapped[list[str]] = mapped_column(JSONVariant, nullable=False, default=list)
    taxon_verification: Mapped[str | None] = mapped_column(String(64))
    rejection_reason: Mapped[str | None] = mapped_column(String(255))
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    supersedes_measurement_id: Mapped[str | None] = mapped_column(String(36))
    superseded_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    image: Mapped[ImageRecord] = relationship()


class AuditRecord(Base):
    __tablename__ = "audit_records"

    audit_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("operators.id"))
    at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=utcnow)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONVariant, nullable=False, default=dict)


class UsageRate(Base):
    """Per-process fixed-window upload throttle counters (not durable state)."""

    __tablename__ = "rate_windows"

    window_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)