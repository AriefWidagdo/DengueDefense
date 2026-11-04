"""Upload validation, idempotency, adapter-failure and throttle tests."""

from __future__ import annotations

import dataclasses

from conftest import login, make_image_bytes, upload_image


def test_valid_jpeg_returns_202_with_saved_upload(seeded):
    from conftest import install_fake_adapter

    client = seeded
    install_fake_adapter(client.app, count=0)  # dispatch stays queued
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "jpeg-key-000001", make_image_bytes("JPEG"))
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "stored"
    assert body["image_id"] is not None
    assert body["processing"]["state"] == "queued"
    assert body["review"]["state"] == "pending_review"
    assert body["status_url"].endswith(f"/api/uploads/{body['upload_id']}")


def test_valid_png_accepted(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "png-key-0000001", make_image_bytes("PNG"))
    assert response.status_code == 202
    assert response.json()["status"] == "stored"


def test_non_image_magic_rejected_415(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "gif-key-0000001", b"GIF89a" + b"\x00" * 64)
    assert response.status_code == 415
    assert "JPEG and PNG" in response.json()["detail"]


def test_fake_jpeg_truncated_400(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    data = make_image_bytes("JPEG")[:-10]  # truncated content
    response = upload_image(client, headers, 1, "trunc-key-000001", data)
    assert response.status_code == 400


def test_byte_limit_enforced_before_dispatch(seeded):
    client = seeded
    settings = dataclasses.replace(client.app.state.capture.settings, max_image_bytes=100)
    client.app.state.capture.settings = settings
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "big-bytes-000001", make_image_bytes("JPEG", width=64, height=48))
    assert response.status_code == 413
    assert "12 MiB" in response.json()["detail"]


def test_pixel_limit_enforced_before_dispatch(seeded):
    client = seeded
    settings = dataclasses.replace(client.app.state.capture.settings, max_image_pixels=100)
    client.app.state.capture.settings = settings
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "big-pixels-00001", make_image_bytes("JPEG", width=64, height=48))
    assert response.status_code == 413
    assert "megapixel" in response.json()["detail"]


def test_idempotent_retry_returns_same_upload(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    first = upload_image(client, headers, 1, "same-key-000001", make_image_bytes())
    assert first.status_code == 202
    retry = upload_image(client, headers, 1, "same-key-000001", make_image_bytes())
    assert retry.status_code == 200
    assert retry.json()["upload_id"] == first.json()["upload_id"]
    assert retry.json()["image_id"] == first.json()["image_id"]


def test_conflicting_payload_on_same_key_409(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    first = upload_image(client, headers, 1, "conflict-key-001", make_image_bytes(width=64, height=48))
    assert first.status_code == 202
    conflict = upload_image(client, headers, 1, "conflict-key-001", make_image_bytes(width=48, height=64))
    assert conflict.status_code == 409


def test_reused_key_on_other_sample_409(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    client.post(
        "/api/traps/VD-001/samples", headers=headers,
        json={"sample_type": "egg_strip", "installed_at": "2026-01-06T08:00:00+00:00", "strip_id": "S-2"},
    )
    first = upload_image(client, headers, 1, "cross-sample-key1", make_image_bytes())
    assert first.status_code == 202
    second = upload_image(client, headers, 2, "cross-sample-key1", make_image_bytes())
    assert second.status_code == 409


def test_prompt_policy_is_not_the_counter_default(seeded):
    client = seeded
    fake = None
    from conftest import install_fake_adapter

    fake = install_fake_adapter(client.app, count=2)
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "prompt-key-00001", make_image_bytes())
    assert response.status_code == 202
    assert len(fake.calls) == 1
    _call_id, _image_bytes, prompt, threshold = fake.calls[0]
    assert prompt == "mosquito"  # adult_card policy, never the counter's "car" default
    assert 0 < threshold < 1


def test_unconfigured_adapter_fails_job_explicitly(seeded):
    client = seeded  # CAPTURE_MODAL_ENABLED=0 -> UnconfiguredAdapter
    headers = login(client, "worker1", "worker-password-1")
    response = upload_image(client, headers, 1, "unconf-key-00001", make_image_bytes())
    assert response.status_code == 202  # durable save succeeded
    status_response = client.get(f"/api/uploads/{response.json()['upload_id']}", headers=headers)
    processing = status_response.json()["processing"]
    assert processing["state"] == "failed"
    assert "not configured" in processing["failure_reason"]


def test_upload_rate_limit(seeded):
    client = seeded
    settings = dataclasses.replace(client.app.state.capture.settings, upload_rate_per_minute=1)
    client.app.state.capture.settings = settings
    headers = login(client, "worker1", "worker-password-1")
    first = upload_image(client, headers, 1, "rate-key-0000001", make_image_bytes())
    assert first.status_code == 202
    second = upload_image(client, headers, 1, "rate-key-0000002", make_image_bytes())
    assert second.status_code == 429


def test_exif_orientation_normalized_for_inference(seeded, db):
    from app.models import ImageRecord, Upload

    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    data = make_image_bytes("JPEG", width=80, height=40, orientation=6)  # rotate 90 degrees
    response = upload_image(client, headers, 1, "exif-key-0000001", data)
    assert response.status_code == 202
    upload = db.query(Upload).filter_by(client_key="exif-key-0000001").one()
    image = db.query(ImageRecord).filter_by(upload_id=upload.upload_id).one()
    assert (image.width, image.height) == (80, 40)  # original dimensions preserved
    inference_bytes = client.app.state.capture.storage.read(image.inference_storage_key)
    from PIL import Image
    import io

    with Image.open(io.BytesIO(inference_bytes)) as normalized:
        assert normalized.size == (40, 80)  # EXIF orientation applied


def test_original_bytes_preserved_and_hashed(seeded, db):
    import hashlib

    from app.models import ImageRecord, Upload

    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    data = make_image_bytes("JPEG")
    response = upload_image(client, headers, 1, "hash-key-0000001", data)
    assert response.status_code == 202
    upload = db.query(Upload).filter_by(client_key="hash-key-0000001").one()
    image = db.query(ImageRecord).filter_by(upload_id=upload.upload_id).one()
    assert upload.expected_sha256 == hashlib.sha256(data).hexdigest() == image.sha256
    assert client.app.state.capture.storage.read(image.storage_key) == data