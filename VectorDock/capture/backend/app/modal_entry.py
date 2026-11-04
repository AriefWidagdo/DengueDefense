"""Modal deployment entry points for the VectorDock capture backend.

This file wires the same FastAPI application to a CPU Modal function backed
by the dedicated capture volume,
plus recoverable dispatch/poll helpers that REUSE the already-deployed
`epikd-sam3-counter` ObjectCounter (SAM3/modal_counter.py, unmodified):

- The trained SAM3 weights already exist in Modal storage on the read-only
  `sam3-checkpoint` Volume (mounted at /checkpoints by the existing GPU
  service, which loads /checkpoints/sam3.pt with load_from_HF=False). This
  app performs no new model setup: it does not upload, download, duplicate,
  retrain, or redeploy the checkpoint or the existing GPU service, and it
  never exposes weights or credentials to the browser.
- Incoming phone photos and application results stay on the dedicated capture
  Volume, separate from model-weight storage. This app never writes under
  counter-tests/ on sam3-outputs itself; note that approved live counting
  jobs DO archive a second image/result copy there (the existing counter
  service writes it), which the mandatory CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE
  opt-in acknowledges.

Deployment requirements:
- A dedicated capture Modal Volume named by CAPTURE_VOLUME_NAME. The existing
  `sam3-checkpoint` weight volume stays read-only and mounted only by the
  existing counter app; this app never mounts or writes it, and never writes
  under counter-tests/. The existing GPU service is not redeployed or changed.
- A Modal Secret holding the runtime configuration (DATABASE_URL,
  CAPTURE_SESSION_SECRET, CAPTURE_RELAY_TOKEN, CAPTURE_ALLOWED_ORIGINS,
  CAPTURE_PUBLIC_BASE_URL). Secrets stay server-side. Keep
  CAPTURE_MODAL_ENABLED=0 until live counting is explicitly authorized and
  access and retention responsibilities for both stores are established.
- A PostgreSQL database provisioned and migrated before startup; the app
  refuses to start against an incomplete schema or insecure configuration.
"""

from __future__ import annotations

import os

import modal

APP_NAME = "vectordock-capture"


def _volume_storage(settings):
    """Storage committing through the EXACT mounted capture Volume handle."""
    import sys

    sys.path.insert(0, "/app")
    from app.config import ConfigError
    from app.main import _production_storage

    if settings.volume_name != CAPTURE_VOLUME_NAME:
        raise ConfigError("Configured capture volume differs from the mounted volume name")
    if settings.is_production and settings.volume_mount != "/data":
        raise ConfigError("Configured capture mount differs from the mounted path /data")
    # Modal's in-container metadata can omit a mounted handle's name. Resolve
    # the configured name and compare IDs, then still commit through the exact
    # handle mounted by this app. Never substitute the lookup handle for it.
    resolved = modal.Volume.from_name(settings.volume_name, environment_name=settings.modal_env,
                                      create_if_missing=False).hydrate()
    mounted_id = getattr(capture_volume, "object_id", None)
    resolved_id = getattr(resolved, "object_id", None)
    if not mounted_id or mounted_id != resolved_id:
        raise ConfigError("Configured capture volume ID differs from the mounted volume ID")
    return _production_storage(settings, volume=capture_volume, resolved_volume_id=resolved_id)

cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "fastapi==0.162.0",
        "sqlalchemy==2.1.6",
        "psycopg[binary]==3.2.13",
        "pillow==13.0.0",
        "python-multipart==0.0.33",
        "python-dotenv==1.2.4",
    )
    .add_local_python_source("app")
    # Each Modal build snapshots the local source files into the new image.
    # Forecasts stay off: CAPTURE_FORECAST_RUNTIME is not set here, so the
    # route remains disabled until a separate forecast deployment is approved.
)

CAPTURE_VOLUME_NAME = os.environ.get("CAPTURE_VOLUME_NAME", "vectordock-capture").strip()
capture_volume = modal.Volume.from_name(CAPTURE_VOLUME_NAME, create_if_missing=False)

app = modal.App(APP_NAME)


@app.function(
    image=cpu_image,
    volumes={"/data": capture_volume},
    secrets=[modal.Secret.from_name("vectordock-capture-secrets")],
    scaledown_window=120,
    timeout=300,
)
@modal.asgi_app()
def api():
    """CPU ASGI entry point.

    The upload route saves the image to /data (the capture volume) and commits
    the durable pending-job record in the database BEFORE the 202 response is
    produced. No GPU work happens in this function.
    """
    import sys

    sys.path.insert(0, "/app")
    from app.config import load_settings
    from app.main import create_app

    settings = load_settings()
    return create_app(settings, storage=_volume_storage(settings))


@app.function(
    image=cpu_image,
    volumes={"/data": capture_volume},
    secrets=[modal.Secret.from_name("vectordock-capture-secrets")],
    timeout=600,
)
def dispatch_and_poll(batch_size: int = 20) -> dict:
    """Recoverable dispatcher: re-dispatch leased-out jobs, poll Modal calls.

    Uses the existing authenticated `ObjectCounter.count` method: jobs were
    submitted with `.spawn()` and results are retrieved by retained call ID
    with `modal.FunctionCall.from_id`. Result publication is conditional, so
    duplicate polling of the same call cannot create duplicate results.
    """
    import sys

    sys.path.insert(0, "/app")
    from app.adapter import build_adapter
    from app.config import load_settings
    from app.db import create_db_engine, create_session_factory
    from app.main import _production_storage  # storage bound to /data
    from app.models import ImageRecord, ProcessingJob
    from app import service

    settings = load_settings()
    engine = create_db_engine(settings)
    factory = create_session_factory(engine)
    storage = _volume_storage(settings)
    adapter = build_adapter(settings)
    summary = {"dispatched": 0, "published": 0, "failed": 0, "pending": 0, "needs_attention": 0}
    with factory() as db:
        jobs = (
            db.query(ProcessingJob)
            .filter(ProcessingJob.state.in_(["queued", "running"]))
            .limit(batch_size)
            .all()
        )
        for job in jobs:
            image = db.get(ImageRecord, job.image_id)
            if job.modal_call_id is None:
                if job.needs_attention:
                    summary["needs_attention"] += 1
                    continue
                outcome = service.claim_and_dispatch(db, storage, adapter, job, image, settings)
                if outcome == "dispatched":
                    summary["dispatched"] += 1
                elif outcome in {"needs_attention", "failed_adapter"}:
                    summary["failed"] += 1
                continue
            outcome = service.poll_and_publish(db, storage, adapter, job, image, timeout_seconds=30)
            if outcome == "published":
                summary["published"] += 1
            elif outcome == "pending":
                summary["pending"] += 1
            elif outcome in {"failed", "provenance_missing"}:
                summary["failed"] += 1
    capture_volume.commit()
    return summary


@app.function(
    image=cpu_image,
    volumes={"/data": capture_volume},
    secrets=[modal.Secret.from_name("vectordock-capture-secrets")],
    # Let a Free Neon database scale to zero between unattended passes.
    # Active phones poll their own existing calls through the authorized API.
    schedule=modal.Period(minutes=30),
    timeout=600,
)
def recovery_scheduled():
    """Scheduled recovery pass for reservations and undispatched jobs."""
    import sys

    sys.path.insert(0, "/app")
    from app import service
    from app.adapter import build_adapter
    from app.config import load_settings
    from app.db import create_db_engine, create_session_factory
    from app.main import _production_storage

    settings = load_settings()
    factory = create_session_factory(create_db_engine(settings))
    with factory() as db:
        summary = service.run_recovery(db, _volume_storage(settings), build_adapter(settings), settings)
    capture_volume.commit()
    print(f"capture recovery: {summary}")