"""Configuration-refusal, seed-command, QR-label and contract-export tests."""

from __future__ import annotations

import json

import pytest
from conftest import BACKEND_DIR

from app.config import ConfigError, load_settings, volume_key_guard


def test_incomplete_production_configuration_refused(monkeypatch):
    monkeypatch.setenv("CAPTURE_ENV", "production")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("CAPTURE_SESSION_SECRET", raising=False)
    with pytest.raises(ConfigError) as error:
        settings = load_settings()
        if settings.problems:
            raise ConfigError("; ".join(settings.problems))
    assert "DATABASE_URL" in str(error.value)


def test_production_sqlite_refused(monkeypatch):
    monkeypatch.setenv("CAPTURE_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///data.db")
    monkeypatch.setenv("CAPTURE_SESSION_SECRET", "x" * 40)
    monkeypatch.setenv("CAPTURE_RELAY_TOKEN", "y" * 40)
    monkeypatch.setenv("CAPTURE_ALLOWED_ORIGINS", "https://capture.example")
    monkeypatch.setenv("CAPTURE_PUBLIC_BASE_URL", "https://capture.example")
    monkeypatch.setenv("CAPTURE_VOLUME_NAME", "vectordock-capture")
    with pytest.raises(ConfigError) as error:
        settings = load_settings()
        if settings.problems:
            raise ConfigError("; ".join(settings.problems))
    message = str(error.value)
    assert "SQLite is not a production database" in message or "must be PostgreSQL" in message


def test_car_prompt_refused(monkeypatch):
    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.setenv("CAPTURE_PROMPT_ADULT_CARD", "car")
    with pytest.raises(ConfigError) as error:
        load_settings()
    assert "car" in str(error.value)


def test_default_capture_volume_refused(monkeypatch):
    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.setenv("CAPTURE_STORAGE_BACKEND", "modal_volume")
    monkeypatch.setenv("CAPTURE_VOLUME_NAME", "sam3-checkpoint")
    with pytest.raises(ConfigError):
        load_settings()


def test_legacy_counter_output_prefix_refused():
    with pytest.raises(ValueError):
        volume_key_guard("counter-tests/20260101T000000Z_test/result.json")
    assert volume_key_guard("uploads/abc/original.jpg") == "uploads/abc/original.jpg"
    with pytest.raises(ValueError):
        volume_key_guard("../escape.jpg")


def test_cli_seed_creates_test_only_fixtures(tmp_path, monkeypatch):
    from app.cli import main
    from app.db import create_db_engine, create_session_factory
    from app.models import Operator, Sample, Trap

    db_file = tmp_path / "seed.sqlite3"
    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file}")
    exit_code = main([
        "seed-fixtures", "--worker-password", "test-only-worker-pw", "--reviewer-password", "test-only-reviewer-pw",
    ])
    assert exit_code == 0
    engine = create_db_engine(load_settings())
    factory = create_session_factory(engine)
    with factory() as db:
        trap = db.get(Trap, "VD-TEST-001")
        assert trap is not None and trap.is_test_fixture is True
        assert trap.district_code == "TEST" and trap.site_id == "TEST-SITE"
        assert db.query(Sample).filter_by(is_test_fixture=True).count() >= 1
        assert db.query(Operator).filter_by(username="test-worker", is_test_identity=True).count() == 1
        assert db.query(Operator).filter_by(username="test-reviewer", is_test_identity=True).count() == 1


def test_cli_seed_refuses_production(monkeypatch):
    from app.cli import main

    monkeypatch.setenv("CAPTURE_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@db.example/vd")
    monkeypatch.setenv("CAPTURE_SESSION_SECRET", "x" * 40)
    monkeypatch.setenv("CAPTURE_RELAY_TOKEN", "y" * 40)
    monkeypatch.setenv("CAPTURE_ALLOWED_ORIGINS", "https://capture.example")
    monkeypatch.setenv("CAPTURE_PUBLIC_BASE_URL", "https://capture.example")
    monkeypatch.setenv("CAPTURE_VOLUME_NAME", "vectordock-capture")
    assert main(["seed-fixtures"]) == 2


def test_cli_qr_requires_configurable_base_url(monkeypatch, tmp_path):
    from app.cli import main

    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.delenv("CAPTURE_PUBLIC_BASE_URL", raising=False)
    assert main(["qr", "--trap-id", "VD-001"]) == 2


def test_cli_qr_writes_label_from_base_url(monkeypatch, tmp_path):
    from app.cli import main

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("CAPTURE_ENV", "test")
    out = tmp_path / "labels" / "VD-001.png"
    exit_code = main([
        "qr", "--trap-id", "VD-001",
        "--base-url", "http://localhost:5173", "--out", str(out),
    ])
    assert exit_code == 0
    assert out.is_file() and out.stat().st_size > 0


def test_cli_qr_refuses_plain_http_outside_localhost(monkeypatch, tmp_path):
    from app.cli import main

    monkeypatch.setenv("CAPTURE_ENV", "test")
    assert main(["qr", "--trap-id", "VD-001", "--base-url", "http://traps.example.com"]) == 2


def test_exported_openapi_contract_matches_app(tmp_path, monkeypatch):
    for key, value in {
        "CAPTURE_ENV": "test",
        "DATABASE_URL": f"sqlite:///{tmp_path / 'openapi.sqlite3'}",
        "CAPTURE_STORAGE_DIR": str(tmp_path / "storage"),
        "CAPTURE_ALLOWED_ORIGINS": "http://localhost:5173",
        "CAPTURE_MODAL_ENABLED": "0",
        "CAPTURE_PUBLIC_BASE_URL": "http://localhost:5173",
    }.items():
        monkeypatch.setenv(key, value)
    from app.cli import main

    out = tmp_path / "openapi.json"
    assert main(["export-openapi", "--out", str(out)]) == 0
    spec = json.loads(out.read_text(encoding="utf-8"))
    paths = spec["paths"]
    for expected in [
        "/api/traps/{trap_id}",
        "/api/traps/{trap_id}/samples",
        "/api/samples/{sample_id}",
        "/api/samples/{sample_id}/images",
        "/api/samples/{sample_id}/reviews",
        "/api/uploads/{upload_id}",
        "/api/images/{image_id}/original",
        "/api/results/{result_id}/annotation",
        "/api/auth/login",
    ]:
        assert expected in paths, f"missing contract route: {expected}"
    committed = json.loads((BACKEND_DIR / "openapi.json").read_text(encoding="utf-8"))
    assert committed["paths"].keys() == paths.keys() or set(committed["paths"]) == set(paths)

def test_reuse_contract_matches_existing_sam3_service():
    """The adapter reuses the deployed counter and its existing weights as-is.

    SAM3/modal_counter.py (read-only reference) names Volume `sam3-checkpoint`,
    mounts it read-only at /checkpoints, and loads /checkpoints/sam.pt with
    load_from_HF=False; the deployed app is epikd-sam3-counter/ObjectCounter.
    The backend constants must keep matching it; no new model setup exists.
    """
    from app import adapter, config

    assert config.SAM3_APP_NAME == "epikd-sam3-counter"
    assert config.SAM3_CHECKPOINT_VOLUME == "sam3-checkpoint"
    assert config.SAM3_CHECKPOINT_MOUNT == "/checkpoints"
    assert config.SAM3_CHECKPOINT_FILE == "/checkpoints/sam3.pt"
    assert config.SAM3_LEGACY_OUTPUT_PREFIX == "counter-tests/"

    source = (BACKEND_DIR.parent.parent.parent / "SAM3" / "modal_counter.py").read_text(encoding="utf-8")
    assert 'APP_NAME = "epikd-sam3-counter"' in source
    assert 'modal.Volume.from_name("sam3-checkpoint", create_if_missing=False)' in source
    assert 'read_only=True' in source
    assert '"/checkpoints/sam3.pt"' in source
    assert "load_from_HF=False" in source

    assert adapter.ModalCounterAdapter is not None
    settings = load_settings()
    assert settings.modal_app_name == config.SAM3_APP_NAME  # reuse, never a new app
    unconfigured = adapter.build_adapter(settings)
    import pytest

    with pytest.raises(adapter.AdapterNotConfigured):
        unconfigured.spawn(b"not-an-image", "mosquito", 0.5)


def test_production_live_submission_requires_legacy_archive_opt_in(monkeypatch):
    """Fail closed: production with CAPTURE_MODAL_ENABLED=1 but no explicit
    archive opt-in is an incomplete configuration and must refuse to start."""
    monkeypatch.setenv("CAPTURE_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@db.example/vd")
    monkeypatch.setenv("CAPTURE_SESSION_SECRET", "x" * 40)
    monkeypatch.setenv("CAPTURE_RELAY_TOKEN", "y" * 40)
    monkeypatch.setenv("CAPTURE_ALLOWED_ORIGINS", "https://capture.example")
    monkeypatch.setenv("CAPTURE_PUBLIC_BASE_URL", "https://capture.example")
    monkeypatch.setenv("CAPTURE_VOLUME_NAME", "vectordock-capture")
    monkeypatch.setenv("CAPTURE_MODAL_ENABLED", "1")
    monkeypatch.delenv("CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE", raising=False)
    settings = load_settings()
    assert any("CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE" in problem for problem in settings.problems)
    assert settings.problems  # create_app refuses to start on any problem


def test_modal_adapter_fails_closed_without_archive_opt_in(monkeypatch):
    """The adapter itself refuses live submission before any Modal contact."""
    from app.adapter import ArchiveOptInRequired, ModalCounterAdapter

    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.setenv("CAPTURE_MODAL_ENABLED", "1")
    monkeypatch.delenv("CAPTURE_ALLOW_LEGACY_COUNTER_ARCHIVE", raising=False)
    adapter = ModalCounterAdapter(load_settings())
    with pytest.raises(ArchiveOptInRequired) as error:
        adapter.spawn(b"image-bytes", "mosquito", 0.5)
    assert "counter-tests" in str(error.value)
    assert "No submission was made" in str(error.value)


def test_dispatch_marks_job_failed_when_archive_opt_in_missing(seeded, db):
    from app import service
    from app.models import ImageRecord, ProcessingJob

    class OptInGateAdapter:
        def spawn(self, image_bytes, prompt, threshold):
            from app.adapter import ArchiveOptInRequired

            raise ArchiveOptInRequired("Live submission blocked: archive opt-in absent")

        def poll(self, call_id, timeout_seconds):
            return None

    client = seeded
    from conftest import install_fake_adapter, login, make_image_bytes, upload_image

    install_fake_adapter(client.app, count=1)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "optin-key-0000001", make_image_bytes())
    assert response.status_code == 202
    image = db.get(ImageRecord, response.json()["image_id"])
    job = db.query(ProcessingJob).filter_by(image_id=image.image_id).one()
    # Replace the already-dispatched job with an undispatched one and gate it.
    job.modal_call_id = None
    job.state = "queued"
    job.dispatch_state = "unclaimed"
    job.last_dispatch_at = None
    db.commit()
    outcome = service.dispatch_image_bytes(
        db, client.app.state.capture.storage, OptInGateAdapter(), job, image, client.app.state.capture.settings
    )
    assert outcome == "failed_adapter"
    db.expire_all()
    job = db.get(ProcessingJob, job.job_id)
    assert job.state == "failed"
    assert "archive opt-in absent" in job.failure_reason
