"""Shared pytest fixtures. All tests run offline on local disk; no network."""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.adapter import CountResult  # noqa: E402
from app.config import Settings, load_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app import service  # noqa: E402


def make_image_bytes(fmt: str = "JPEG", width: int = 64, height: int = 48, orientation: int | None = None) -> bytes:
    image = Image.new("RGB", (width, height), color=(90, 140, 60))
    if orientation is not None:
        exif = Image.Exif()
        exif[274] = orientation
        buffer = io.BytesIO()
        image.save(buffer, format=fmt, exif=exif)
        return buffer.getvalue()
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


class FakeAdapter:
    """Test double for the Modal counter adapter. Records spawns, returns
    scripted candidate results. Never used for live inference."""

    def __init__(self, count: int = 3) -> None:
        self.count = count
        self.calls: list[tuple[str, bytes, str, float]] = []
        self.pending: dict[str, CountResult] = {}

    def spawn(self, image_bytes: bytes, prompt: str, threshold: float) -> str:
        call_id = f"fc-{len(self.calls) + 1:04d}"
        self.calls.append((call_id, image_bytes, prompt, threshold))
        detections = [
            {"id": i + 1, "score": 0.9, "box_xyxy": [0, 0, 10, 10], "mask_area_pixels": 50}
            for i in range(self.count)
        ]
        report = {
            "run_id": call_id,
            "prompt": prompt,
            "threshold": threshold,
            "count": self.count,
            "detections": detections,
            "input_sha256": "test-input-hash",
        }
        self.pending[call_id] = CountResult(report=report, annotated_png=b"\x89PNG-fake-annotation")
        return call_id

    def poll(self, call_id: str, timeout_seconds: float) -> CountResult | None:
        return self.pending.pop(call_id, None)


def base_env(tmp_path: Path) -> dict[str, str]:
    return {
        "CAPTURE_ENV": "test",
        "DATABASE_URL": f"sqlite:///{tmp_path / 'capture.sqlite3'}",
        "CAPTURE_STORAGE_DIR": str(tmp_path / "storage"),
        "CAPTURE_ALLOWED_ORIGINS": "http://localhost:5173",
        "CAPTURE_MODAL_ENABLED": "0",
        "CAPTURE_PUBLIC_BASE_URL": "http://localhost:5173",
    }


@pytest.fixture()
def settings(tmp_path, monkeypatch) -> Settings:
    for key, value in base_env(tmp_path).items():
        monkeypatch.setenv(key, value)
    return load_settings()


@pytest.fixture()
def app(settings):
    application = create_app(settings)
    return application


@pytest.fixture()
def db(app):
    factory = app.state.capture.session_factory
    session = factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(app):
    return TestClient(app)


def seed_registry(app) -> None:
    """Two operators and one granted trap with an open deployment."""
    from datetime import datetime, timezone

    from app.models import Deployment, Operator, Sample, Trap, TrapGrant
    from app.security import hash_password

    factory = app.state.capture.session_factory
    with factory() as db:
        worker = Operator(
            username="worker1", display_name="Worker One", role="worker",
            password_hash=hash_password("worker-password-1"), is_test_identity=True,
        )
        reviewer = Operator(
            username="reviewer1", display_name="Reviewer One", role="reviewer",
            password_hash=hash_password("reviewer-password-1"), is_test_identity=True,
        )
        outsider = Operator(
            username="outsider", display_name="Outsider", role="worker",
            password_hash=hash_password("outsider-password-1"), is_test_identity=True,
        )
        admin = Operator(
            username="admin1", display_name="Admin One", role="admin",
            password_hash=hash_password("admin-password-12345"), is_test_identity=True,
        )
        db.add_all([worker, reviewer, outsider, admin])
        db.flush()
        trap = Trap(
            trap_id="VD-001", district_code="TEST", site_id="TEST-SITE",
            placement="test fixture - not a real location", is_test_fixture=True,
        )
        db.add(trap)
        db.flush()
        deployment = Deployment(
            trap_id="VD-001", district_code="TEST", site_id="TEST-SITE",
            location_note="test fixture", start_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        db.add(deployment)
        db.flush()
        sample = Sample(
            trap_id="VD-001", deployment_id=deployment.deployment_id, sample_type="adult_card",
            cartridge_id="TEST-CARD-001", installed_at=datetime(2026, 1, 5, 8, 0, tzinfo=timezone.utc),
            installed_at_offset="+00:00", is_test_fixture=True, created_by=worker.id,
        )
        db.add(sample)
        db.add_all([
            TrapGrant(operator_id=worker.id, trap_id="VD-001"),
            TrapGrant(operator_id=reviewer.id, trap_id="VD-001"),
            TrapGrant(operator_id=admin.id, trap_id="VD-001"),
        ])
        db.commit()


@pytest.fixture()
def seeded(client):
    seed_registry(client.app)
    return client


def login(client: TestClient, username: str, password: str) -> dict:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    csrf = response.json()["csrf_token"]
    return {"X-CSRF-Token": csrf}


def upload_image(client: TestClient, headers: dict, sample_id: int, key: str, data: bytes,
                 captured_at: str | None = None) -> object:
    from datetime import datetime, timedelta, timezone

    if captured_at is None:
        captured_at = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    return client.post(
        f"/api/samples/{sample_id}/images",
        headers=headers,
        data={"client_key": key, "captured_at": captured_at, "captured_at_offset": "+00:00"},
        files={"file": ("photo.jpg", data, "image/jpeg")},
    )


def install_fake_adapter(app, count: int = 3) -> FakeAdapter:
    fake = FakeAdapter(count=count)
    app.state.capture.adapter = fake
    return fake


def publish_pending(app) -> int:
    """Poll and publish every pending fake result; return published count."""
    from app.models import ImageRecord, ProcessingJob

    state = app.state.capture
    published = 0
    with state.session_factory() as db:
        jobs = db.query(ProcessingJob).filter(ProcessingJob.state.in_(["queued", "running"])).all()
        for job in jobs:
            image = db.get(ImageRecord, job.image_id)
            outcome = service.poll_and_publish(db, state.storage, state.adapter, job, image)
            if outcome == "published":
                published += 1
    return published