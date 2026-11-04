"""Typed API contracts (Pydantic v2) for the VectorDock capture backend."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SAMPLE_TYPES = ("adult_card", "egg_strip")
UPLOAD_STATES = ("receiving", "stored", "failed")
PROCESSING_STATES = ("queued", "running", "completed", "failed")
REVIEW_STATES = ("pending_review", "accepted", "rejected")


class ErrorOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    detail: str


class OperatorOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str
    display_name: str
    role: Literal["worker", "reviewer", "admin"]


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class LoginOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operator: OperatorOut
    csrf_token: str


class MeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operator: OperatorOut
    granted_trap_ids: list[str]


class DeploymentOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    deployment_id: int
    trap_id: str
    site_id: str
    district_code: str
    location_note: str
    start_at: datetime
    end_at: datetime | None


class SampleOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sample_id: int
    trap_id: str
    deployment_id: int
    sample_type: Literal["adult_card", "egg_strip"]
    cartridge_id: str | None
    strip_id: str | None
    installed_at: datetime
    installed_at_offset: str
    removed_at: datetime | None
    removed_at_offset: str | None
    exposed_area_cm2: float | None
    condition_notes: str
    exposure_known: bool
    revision: int
    is_test_fixture: bool


class TrapOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trap_id: str
    district_code: str
    site_id: str
    placement: str
    trap_design_version: str
    lure_version: str | None
    surface_protocol: str
    is_test_fixture: bool
    active_deployment: DeploymentOut | None
    samples: list[SampleOut]
    # Additive listing metadata: which filtered slice `samples` contains and
    # how many samples match the filter in total (bounded work queues; 'all'
    # is paginated with limit/offset).
    sample_state: str = "active"
    sample_total: int = 0


class SampleCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sample_type: Literal["adult_card", "egg_strip"]
    installed_at: datetime
    installed_at_offset: str = "+00:00"
    cartridge_id: str | None = Field(default=None, max_length=64)
    strip_id: str | None = Field(default=None, max_length=64)
    exposed_area_cm2: float | None = Field(default=None, gt=0)
    condition_notes: str = Field(default="", max_length=255)

    @field_validator("installed_at_offset")
    @classmethod
    def _offset_format(cls, value: str) -> str:
        if not (value.startswith(("+", "-")) and len(value) == 6 and value[3] == ":"):
            raise ValueError("installed_at_offset must look like +07:00")
        return value


class SampleUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)
    removed_at: datetime | None = None
    removed_at_offset: str | None = None
    condition_notes: str | None = Field(default=None, max_length=255)
    exposure_known: bool | None = None


class SampleUpdateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sample: SampleOut
    audit_id: int


class ProcessingStatusOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: Literal["queued", "running", "completed", "failed"]
    failure_reason: str | None
    modal_call_id: str | None
    needs_attention: bool = False


class SampleActiveReviewOut(BaseModel):
    """The SAMPLE's active measurement (any image, any decision).

    Its revision is the optimistic-concurrency token for the next explicit
    replacement or correcting review (expected_measurement_revision).
    """

    model_config = ConfigDict(extra="forbid")
    measurement_id: str
    image_id: str
    decision: Literal["accepted", "rejected"]
    revision: int


class ReviewStatusOut(BaseModel):
    """Review view returned by upload status.

    Field semantics (documented contract):
    - `state`, `measurement_id` and `measurement_revision` describe THIS
      upload's image only: they are pending_review/None while the image awaits
      human review, even when another photo of the same sample is already the
      accepted active measurement.
    - `sample_active` describes the SAMPLE's active measurement (any image,
      any decision); its `revision` is the expected_measurement_revision a
      reviewer supplies to supersede it explicitly.
    """

    model_config = ConfigDict(extra="forbid")
    state: Literal["pending_review", "accepted", "rejected"]
    measurement_id: str | None = None
    measurement_revision: int | None = None
    accepted_count: int | None = None
    sample_active: SampleActiveReviewOut | None = None


class ResultPreviewOut(BaseModel):
    """Read-only preview of a completed candidate result.

    Exposing a candidate never creates a measurement, never sets available_at
    and never accepts a sample. Retrieval of the annotation stays authorized
    by the trap access grant.
    """

    model_config = ConfigDict(extra="forbid")
    result_id: str
    candidate_count: int
    annotation_url: str


class UploadOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    upload_id: str
    sample_id: int
    image_id: str | None
    status: Literal["receiving", "stored", "failed"]
    failure_reason: str | None
    received_at: datetime | None
    captured_at: datetime
    processing: ProcessingStatusOut | None
    review: ReviewStatusOut
    result: ResultPreviewOut | None = None
    status_url: str
    original_url: str | None = None


class UploadQueueItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sample: SampleOut
    upload: UploadOut


class UploadQueueOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[UploadQueueItemOut]
    total: int
    limit: int
    offset: int


class RetakeRequestOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sample_id: int
    audit_id: int


class ReviewCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_sample_revision: int = Field(ge=1)
    expected_measurement_revision: int | None = Field(default=None, ge=1)
    image_id: str
    result_id: str | None = None
    decision: Literal["accepted", "rejected"]
    corrected_count: int | None = Field(default=None, ge=0)
    usable_exposure: bool = True
    quality_flags: list[str] = Field(default_factory=list)
    taxon_verification: str | None = Field(default=None, max_length=64)
    rejection_reason: str | None = Field(default=None, max_length=255)


class MeasurementOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    measurement_id: str
    sample_id: int
    image_id: str
    result_id: str | None
    decision: Literal["accepted", "rejected"]
    accepted_count: int | None
    count_source: Literal["candidate", "corrected"]
    candidate_count: int | None
    reviewer: str
    reviewed_at: datetime
    available_at: datetime | None
    usable_exposure: bool
    quality_flags: list[str]
    taxon_verification: str | None
    rejection_reason: str | None
    revision: int
    supersedes_measurement_id: str | None
    superseded_at: datetime | None


class RecoveryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reservations_completed: int
    reservations_failed: int
    jobs_created: int
    jobs_dispatched: int
    jobs_published: int
    jobs_failed: int
    jobs_needs_attention: int = 0


class HealthOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str
    env: str
    database: str
    storage: str
