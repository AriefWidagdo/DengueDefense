"""Environment-driven configuration for the VectorDock capture backend.

Rules enforced here:
- Production uses a configurable PostgreSQL DATABASE_URL. SQLite is allowed
  only for local tests/development on local disk, never on a Modal Volume.
- Production refuses incomplete or insecure configuration (no default
  password, secret, host, or credential).
- The capture volume is a dedicated volume. The existing `sam3-checkpoint`
  volume stays read-only. Approved live counter calls also archive a copy in
  `sam3-outputs/counter-tests/`; the explicit archive opt-in is required.
- The counter's default `car` prompt is never accepted for trap work.
"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import PurePosixPath

MAX_IMAGE_BYTES_DEFAULT = 12 * 1024 * 1024
MAX_IMAGE_PIXELS_DEFAULT = 16_000_000
# Documented multipart/form overhead allowance above the 12 MiB decoded-file
# limit (form fields, part boundaries, encoding). The total request-byte cap
# enforced by the ASGI receive wrapper is max_image_bytes + this overhead.
MULTIPART_OVERHEAD_BYTES_DEFAULT = 2 * 1024 * 1024

# Existing SAM3 resources. The trained weights already live in Modal storage on
# the `sam3-checkpoint` Volume; the deployed GPU service `epikd-sam3-counter`
# (SAM3/modal_counter.py) mounts it read-only at /checkpoints and loads
# /checkpoints/sam3.pt with load_from_HF=False. This backend reuses that
# deployed counter as-is. It never uploads, downloads, retrains, duplicates, or
# redeployes the checkpoint, and never exposes weights or credentials to a
# browser. Incoming phone photos and application results live on the separate
# dedicated capture volume, never on the weight volume.
SAM3_APP_NAME = "epikd-sam3-counter"
SAM3_CHECKPOINT_VOLUME = "sam3-checkpoint"
SAM3_CHECKPOINT_MOUNT = "/checkpoints"
SAM3_CHECKPOINT_FILE = "/checkpoints/sam3.pt"
SAM3_OUTPUTS_VOLUME = "sam3-outputs"
SAM3_LEGACY_OUTPUT_PREFIX = "counter-tests/"
SAM3_CODE_COMMIT = "f1647e8d0c1d280991f4d1b7d974c2704537fe66"

FORBIDDEN_PROMPTS = {"car"}
FORBIDDEN_CAPTURE_VOLUMES = {SAM3_CHECKPOINT_VOLUME, SAM3_OUTPUTS_VOLUME}
WEAK_SECRET_VALUES = {"", "changeme", "secret", "password", "change-me"}
FORBIDDEN_IDENTITY_HEADERS = (
    "x-vd-operator",
    "x-vd-user",
    "x-forwarded-user",
    "x-remote-user",
    "x-authenticated-user",
    "x-user-id",
    "x-operator-id",
)


class ConfigError(ValueError):
    """Raised for incomplete or insecure configuration."""


@dataclass(frozen=True)
class DetectorPolicy:
    policy_version: str
    prompts: dict[str, str]  # sample_type -> prompt
    thresholds: dict[str, float]  # sample_type -> threshold

    def for_sample_type(self, sample_type: str) -> tuple[str, float]:
        if sample_type not in self.prompts:
            raise ConfigError(f"No detector policy for sample type: {sample_type}")
        return self.prompts[sample_type], self.thresholds[sample_type]


@dataclass(frozen=True)
class Settings:
    env: str  # "test", "development", or "production"
    database_url: str
    storage_backend: str  # "local" or "modal_volume"
    storage_dir: str  # local backend root (local disk only)
    volume_mount: str  # in-container mount path for the capture volume
    volume_name: str  # dedicated capture Modal Volume name
    session_secret: str
    relay_token: str
    allowed_origins: tuple[str, ...]
    cookie_secure: bool
    session_ttl_hours: int
    public_base_url: str  # https:// capture base URL used for QR labels
    detector_policy: DetectorPolicy
    modal_app_name: str
    modal_env: str
    modal_counter_class: str
    modal_enabled: bool
    allow_legacy_counter_archive: bool
    max_image_bytes: int
    max_image_pixels: int
    max_request_bytes: int
    upload_rate_per_minute: int
    login_rate_per_minute: int
    recovery_reservation_stale_seconds: int
    dispatch_lease_seconds: int
    dispatch_max_attempts: int
    secrets_ephemeral: bool = False
    problems: tuple[str, ...] = field(default=())

    @property
    def is_production(self) -> bool:
        return self.env == "production"


def _flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, "").split(",") if item.strip()]


def load_settings(env: str | None = None) -> Settings:
    """Build settings from environment variables and validate them."""
    resolved_env = (env or os.environ.get("CAPTURE_ENV", "development")).strip().lower()
    if resolved_env not in {"test", "development", "production"}:
        raise ConfigError(f"CAPTURE_ENV must be test, development or production: {resolved_env}")

    problems: list[str] = []
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url and resolved_env != "production":
        database_url = "sqlite:///" + os.path.join(os.getcwd(), "data", "capture.sqlite3").replace("\\", "/")
    storage_backend = os.environ.get("CAPTURE_STORAGE_BACKEND", "").strip().lower() or (
        "modal_volume" if resolved_env == "production" else "local"
    )
    storage_dir = os.environ.get("CAPTURE_STORAGE_DIR", "").strip() or str(
        os.path.join(os.getcwd(), "data", "storage")
    )
    volume_mount = os.environ.get("CAPTURE_VOLUME_MOUNT", "").strip() or "/data"
    volume_name = os.environ.get("CAPTURE_VOLUME_NAME", "").strip()
    session_secret = os.environ.get("CAPTURE_SESSION_SECRET", "")
    relay_token = os.environ.get("CAPTURE_RELAY_TOKEN", "")
    allowed_origins = tuple(_csv("CAPTURE_ALLOWED_ORIGINS"))
    cookie_secure = _flag("CAPTURE_COOKIE_SECURE", "1" if resolved_env == "production" else "0")
    public_base_url = os.environ.get("CAPTURE_PUBLIC_BASE_URL", "").strip().rstrip("/")
    allow_legacy_counter_archive = _flag("CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE")

    prompt_adult = os.environ.get("CAPTURE_PROMPT_ADULT_CARD", "mosquito").strip()
    prompt_egg = os.environ.get("CAPTURE_PROMPT_EGG_STRIP", "egg").strip()
    try:
        threshold_adult = float(os.environ.get("CAPTURE_THRESHOLD_ADULT_CARD", "0.5"))
        threshold_egg = float(os.environ.get("CAPTURE_THRESHOLD_EGG_STRIP", "0.5"))
    except ValueError as error:
        raise ConfigError(f"Detector thresholds must be numbers: {error}") from error
    for name, value in (("CAPTURE_THRESHOLD_ADULT_CARD", threshold_adult), ("CAPTURE_THRESHOLD_EGG_STRIP", threshold_egg)):
        if not 0.0 < value < 1.0:
            raise ConfigError(f"{name} must be strictly between 0 and 1")
    policy = DetectorPolicy(
        policy_version=os.environ.get("CAPTURE_DETECTOR_POLICY_VERSION", "candidate-policy-v1"),
        prompts={"adult_card": prompt_adult, "egg_strip": prompt_egg},
        thresholds={"adult_card": threshold_adult, "egg_strip": threshold_egg},
    )
    for sample_type, prompt in policy.prompts.items():
        if not 1 <= len(prompt) <= 120:
            raise ConfigError(f"Prompt for {sample_type} must contain 1-120 characters")
        if prompt.strip().lower() in FORBIDDEN_PROMPTS:
            raise ConfigError(
                "The counter's default 'car' prompt is not a trap policy. "
                "Set CAPTURE_PROMPT_ADULT_CARD and CAPTURE_PROMPT_EGG_STRIP."
            )

    secrets_ephemeral = False
    if resolved_env == "production":
        if not database_url:
            problems.append("DATABASE_URL is required in production")
        elif not database_url.startswith(("postgresql://", "postgresql+")):
            problems.append("DATABASE_URL must be PostgreSQL in production")
        if database_url.startswith("sqlite"):
            problems.append("SQLite is not a production database")
        if storage_backend != "modal_volume":
            problems.append("CAPTURE_STORAGE_BACKEND must be modal_volume in production")
        if not volume_name:
            problems.append("CAPTURE_VOLUME_NAME is required in production")
        elif volume_name in FORBIDDEN_CAPTURE_VOLUMES:
            problems.append(f"CAPTURE_VOLUME_NAME must be a dedicated capture volume, not {volume_name}")
        if not public_base_url:
            problems.append("CAPTURE_PUBLIC_BASE_URL is required in production")
        elif not public_base_url.startswith("https://"):
            problems.append("CAPTURE_PUBLIC_BASE_URL must be https")
        if not session_secret or session_secret.strip().lower() in WEAK_SECRET_VALUES or len(session_secret) < 32:
            problems.append("CAPTURE_SESSION_SECRET must be at least 32 characters and not a default value")
        if not relay_token or relay_token.strip().lower() in WEAK_SECRET_VALUES or len(relay_token) < 32:
            problems.append("CAPTURE_RELAY_TOKEN must be at least 32 characters and not a default value")
        if not allowed_origins:
            problems.append("CAPTURE_ALLOWED_ORIGINS is required in production (the relay origin must be listed)")
        if storage_dir and (storage_dir.startswith("/vol/") or storage_dir.startswith("/mnt/")):
            problems.append("CAPTURE_STORAGE_DIR must be local disk in production; files live on the capture volume")
        if _flag("CAPTURE_MODAL_ENABLED") and not allow_legacy_counter_archive:
            problems.append(
                "CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE must be explicitly set to 1 in production before "
                "any live submission: the existing ObjectCounter.count always stores input.png, "
                "annotated.png and result.json under sam3-outputs/counter-tests/, so every counted "
                "image and result is also archived there in addition to the dedicated capture "
                "volume. Access, retention and deletion rules for BOTH stores need operator "
                "confirmation before field use"
            )
    else:
        if database_url.startswith("sqlite"):
            path = database_url.split("///", 1)[-1] if "///" in database_url else ""
            if path.startswith("/vol/") or path.startswith("/mnt/"):
                problems.append("SQLite may not live on a Modal Volume mount")
        if not session_secret:
            session_secret = secrets.token_urlsafe(32)
            secrets_ephemeral = True
        if not relay_token:
            relay_token = secrets.token_urlsafe(32)
            secrets_ephemeral = True
    if storage_backend not in {"local", "modal_volume"}:
        raise ConfigError("CAPTURE_STORAGE_BACKEND must be 'local' or 'modal_volume'")
    if volume_name in FORBIDDEN_CAPTURE_VOLUMES:
        raise ConfigError(
            f"CAPTURE_VOLUME_NAME must be a dedicated capture volume, not {volume_name}; "
            "the read-only sam3-checkpoint weight volume and sam3-outputs are off-limits"
        )
    if volume_name and volume_name not in {"vectordock-capture", ""} and volume_name.startswith("sam3"):
        raise ConfigError(
            "CAPTURE_VOLUME_NAME must not shadow SAM3 storage; phone photos and "
            "results stay separate from model-weight storage"
        )

    settings = Settings(
        env=resolved_env,
        database_url=database_url,
        storage_backend=storage_backend,
        storage_dir=storage_dir,
        volume_mount=volume_mount,
        volume_name=volume_name,
        session_secret=session_secret,
        relay_token=relay_token,
        allowed_origins=allowed_origins,
        cookie_secure=cookie_secure,
        session_ttl_hours=int(os.environ.get("CAPTURE_SESSION_TTL_HOURS", "12")),
        public_base_url=public_base_url,
        detector_policy=policy,
        modal_app_name=os.environ.get("CAPTURE_MODAL_APP_NAME", SAM3_APP_NAME),
        modal_env=os.environ.get("CAPTURE_MODAL_ENV", "main"),
        modal_counter_class=os.environ.get("CAPTURE_MODAL_COUNTER_CLASS", "ObjectCounter"),
        modal_enabled=_flag("CAPTURE_MODAL_ENABLED"),
        allow_legacy_counter_archive=allow_legacy_counter_archive,
        max_image_bytes=int(os.environ.get("CAPTURE_MAX_IMAGE_BYTES", str(MAX_IMAGE_BYTES_DEFAULT))),
        max_image_pixels=int(os.environ.get("CAPTURE_MAX_IMAGE_PIXELS", str(MAX_IMAGE_PIXELS_DEFAULT))),
        max_request_bytes=(
            int(os.environ.get("CAPTURE_MAX_IMAGE_BYTES", str(MAX_IMAGE_BYTES_DEFAULT)))
            + int(os.environ.get("CAPTURE_MULTIPART_OVERHEAD_BYTES", str(MULTIPART_OVERHEAD_BYTES_DEFAULT)))
        ),
        upload_rate_per_minute=int(os.environ.get("CAPTURE_UPLOAD_RATE_PER_MINUTE", "30")),
        login_rate_per_minute=int(os.environ.get("CAPTURE_LOGIN_RATE_PER_MINUTE", "5")),
        recovery_reservation_stale_seconds=int(os.environ.get("CAPTURE_RESERVATION_STALE_SECONDS", "300")),
        dispatch_lease_seconds=int(os.environ.get("CAPTURE_DISPATCH_LEASE_SECONDS", "600")),
        dispatch_max_attempts=int(os.environ.get("CAPTURE_DISPATCH_MAX_ATTEMPTS", "5")),
        secrets_ephemeral=secrets_ephemeral,
        problems=tuple(problems),
    )
    return settings


def volume_key_guard(key: str) -> str:
    """Normalize a storage key and refuse legacy SAM3 result paths."""
    normalized = PurePosixPath(key).as_posix().lstrip("/")
    if ".." in normalized.split("/"):
        raise ValueError(f"Unsafe storage key: {key}")
    if normalized.startswith(SAM3_LEGACY_OUTPUT_PREFIX):
        raise ValueError(
            "Refusing to write under counter-tests/: existing SAM3 counter results are untouched"
        )
    return normalized