"""Disabled production counting refuses photo storage, not a failed fake count."""
from dataclasses import replace

from app.models import ImageRecord, ProcessingJob, Upload
from conftest import install_fake_adapter, login, make_image_bytes, upload_image


def test_production_without_authorized_counting_rejects_image_before_storage(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    fake = install_fake_adapter(client.app)
    state = client.app.state.capture
    state.settings = replace(state.settings, env="production", modal_enabled=False)
    response = upload_image(client, headers, 1, "disabled-test-00001", make_image_bytes())
    assert response.status_code == 503
    assert "No photo was saved" in response.json()["detail"]
    with state.session_factory() as db:
        assert db.query(Upload).count() == 0
        assert db.query(ImageRecord).count() == 0
        assert db.query(ProcessingJob).count() == 0
    assert not fake.calls
    assert not any(path.is_file() for path in state.storage.root.rglob("*"))
