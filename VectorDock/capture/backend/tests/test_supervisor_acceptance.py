"""Regressions from the independent repair review. Local fixtures only."""
import importlib
import sys
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from conftest import install_fake_adapter, login, make_image_bytes, publish_pending, upload_image
from app.config import ConfigError
from app.main import _verify_production_schema
from app.models import AuditRecord, Base, ImageRecord, ProcessingJob, UsageRate, utcnow
from app import service


def test_modal_api_uses_the_same_configured_mounted_handle(tmp_path, monkeypatch):
    """Execute the actual api() entry point with an offline Modal SDK fake."""
    class Builder:
        @classmethod
        def debian_slim(cls, **kwargs): return cls()
        def pip_install(self, *args, **kwargs): return self
        def add_local_python_source(self, *args, **kwargs): return self
    class App:
        def __init__(self, *args, **kwargs): pass
        def function(self, **kwargs): return lambda function: function
    class Volume:
        name = "test-custom-capture"
        object_id = "vo-test-capture"
        commits = 0
        reloads = 0
        def hydrate(self): return self
        def commit(self): self.commits += 1
        def reload(self): self.reloads += 1
    volume = Volume()
    requested = []
    def from_name(name, **kwargs):
        requested.append((name, kwargs))
        return volume
    periods = []
    def period(**kwargs):
        periods.append(kwargs)
        return object()
    sdk = SimpleNamespace(Image=Builder, App=App, Volume=SimpleNamespace(from_name=from_name),
                          Secret=SimpleNamespace(from_name=lambda name: object()),
                          asgi_app=lambda: (lambda function: function), Period=period)
    for key, value in {
        "CAPTURE_ENV": "test", "DATABASE_URL": f"sqlite:///{tmp_path / 'api.sqlite3'}",
        "CAPTURE_STORAGE_BACKEND": "modal_volume", "CAPTURE_VOLUME_MOUNT": str(tmp_path),
        "CAPTURE_VOLUME_NAME": volume.name, "CAPTURE_MODAL_ENABLED": "0",
    }.items(): monkeypatch.setenv(key, value)
    monkeypatch.setitem(sys.modules, "modal", sdk)
    monkeypatch.delitem(sys.modules, "app.modal_entry", raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    entry = importlib.import_module("app.modal_entry")
    try:
        application = entry.api()
        assert requested == [
            (volume.name, {"create_if_missing": False}),
            (volume.name, {"environment_name": "main", "create_if_missing": False}),
        ]
        assert periods == [{"minutes": 30}]
        assert application.state.capture.storage.volume is volume
        application.state.capture.storage.save("uploads/test/original.png", b"test")
        assert volume.commits == 1
        assert volume.reloads == 1
        assert TestClient(application).get("/api/health").status_code == 200
        volume.name = ""  # observed in the real Modal container
        assert entry._volume_storage(application.state.capture.settings).volume is volume
        other = SimpleNamespace(object_id="vo-other")
        other.hydrate = lambda: other
        monkeypatch.setattr(sdk.Volume, "from_name", lambda *args, **kwargs: other)
        with pytest.raises(ConfigError, match="volume ID differs"):
            entry._volume_storage(application.state.capture.settings)
    finally:
        sys.modules.pop("app.modal_entry", None)


def test_schema_gate_rejects_missing_or_wrong_active_review_index(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'schema.sqlite3'}")
    Base.metadata.create_all(engine)
    _verify_production_schema(engine)
    with engine.begin() as connection: connection.execute(text("DROP INDEX uq_active_measurement"))
    with pytest.raises(ConfigError, match="uq_active_measurement"): _verify_production_schema(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE UNIQUE INDEX uq_active_measurement ON measurements(sample_id) WHERE superseded_at IS NULL AND decision='accepted'"))
    with pytest.raises(ConfigError, match="uq_active_measurement"): _verify_production_schema(engine)
    engine.dispose()


def test_login_names_do_not_create_unbounded_rate_rows(seeded):
    for i in range(15):
        response = seeded.post("/api/auth/login", json={"username": f"unknown-{i}", "password": "bad"})
        assert response.status_code in (401, 429)
    with seeded.app.state.capture.session_factory() as db:
        assert [row.window_key for row in db.query(UsageRate).all()] == ["login:unknown"]
        db.add(UsageRate(window_key="old-unknown-name", window_start=utcnow()-timedelta(days=1), count=1))
        db.commit()
        service.check_rate(db, "test-current", 10)
        assert db.get(UsageRate, "old-unknown-name") is None


def test_saved_upload_queue_includes_closed_samples_retakes_and_reviewed_images(seeded):
    client = seeded
    worker = login(client, "worker1", "worker-password-1")
    install_fake_adapter(client.app, count=3)
    first = upload_image(client, worker, 1, "supervisor-queue-key-1", make_image_bytes()).json()
    assert publish_pending(client.app) == 1
    reviewer = login(client, "reviewer1", "reviewer-password-1")
    reviewed = client.post("/api/samples/1/reviews", headers=reviewer, json={
        "expected_sample_revision": 1, "expected_measurement_revision": None,
        "image_id": first["image_id"], "decision": "accepted", "corrected_count": 7,
    })
    assert reviewed.status_code == 201, reviewed.text
    worker = login(client, "worker1", "worker-password-1")
    closed = client.patch("/api/samples/1", headers=worker, json={
        "expected_revision": 1, "removed_at": utcnow().isoformat(), "removed_at_offset": "+00:00",
    })
    assert closed.status_code == 200
    second = upload_image(client, worker, 1, "supervisor-queue-key-2", make_image_bytes()).json()
    assert publish_pending(client.app) == 1
    assert client.get("/api/traps/VD-001").json()["samples"] == []
    response = client.get("/api/traps/VD-001/uploads?limit=1")
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["total"] == 2 and page["limit"] == 1
    assert page["items"][0]["upload"]["upload_id"] == second["upload_id"]
    assert page["items"][0]["sample"]["removed_at"]
    assert page["items"][0]["sample"]["revision"] == 2
    assert page["items"][0]["upload"]["review"]["state"] == "pending_review"
    assert page["items"][0]["upload"]["review"]["sample_active"]["image_id"] == first["image_id"]
    older = client.get("/api/traps/VD-001/uploads?limit=1&offset=1").json()["items"][0]
    assert older["upload"]["review"]["accepted_count"] == 7
    assert client.get("/api/samples/1").json()["revision"] == 2
    assert client.get("/api/traps/VD-001/uploads?limit=51").status_code == 422
    assert client.get("/api/traps/VD-001/uploads?offset=-1").status_code == 422
    login(client, "outsider", "outsider-password-1")
    assert client.get("/api/traps/VD-001/uploads").status_code == 403
    assert client.get("/api/samples/1").status_code == 403


def test_attention_retake_is_authorized_audited_and_never_restarts_old_job(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    upload = upload_image(client, headers, 1, "attention-retake-key-1", make_image_bytes()).json()
    path = f"/api/uploads/{upload['upload_id']}/retake"
    assert client.post(path, headers=headers).status_code == 409
    with client.app.state.capture.session_factory() as db:
        image = db.query(ImageRecord).filter_by(upload_id=upload["upload_id"]).one()
        job = db.query(ProcessingJob).filter_by(image_id=image.image_id).one()
        job.state = "queued"
        job.needs_attention = True
        job.dispatch_attempts = 5
        db.commit()
    fake = install_fake_adapter(client.app, count=3)
    response = client.post(path, headers=headers)
    assert response.status_code == 201, response.text
    assert response.json()["sample_id"] == 1
    assert fake.calls == []
    with client.app.state.capture.session_factory() as db:
        audit = db.get(AuditRecord, response.json()["audit_id"])
        assert audit.action == "retake_requested" and audit.entity_id == upload["upload_id"]
        assert audit.detail["new_photo_required"] is True
        assert audit.detail["automatic_retry"] is False
        assert audit.actor_id is not None
        job = db.query(ProcessingJob).one()
        assert job.needs_attention is True and job.dispatch_attempts == 5
        assert job.state == "queued" and job.modal_call_id is None
    outsider = login(client, "outsider", "outsider-password-1")
    assert client.post(path, headers=outsider).status_code == 403
