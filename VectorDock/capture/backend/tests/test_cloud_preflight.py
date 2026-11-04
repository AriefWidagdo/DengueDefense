"""Offline regressions for the existing Modal counter's production contract."""
import hashlib
import io
import random
import sys
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image

from app import service
from app.adapter import ModalCounterAdapter
from app.images import COUNTER_MAX_IMAGE_BYTES, ImageLimits, inspect_image
from app.models import ImageRecord, Upload
from conftest import install_fake_adapter, login, upload_image


def high_detail_jpeg():
    # Deterministic synthetic pixels. This 3–4 MiB phone-like JPEG expands
    # beyond 12 MiB if normalized as PNG. No photo or network is involved.
    width = height = 2200
    raw = random.Random(17).randbytes(width * height * 3)
    image = Image.frombytes("RGB", (width, height), raw)
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=85)
    return out.getvalue()


def test_high_detail_phone_photo_stays_within_existing_counter_cap(seeded):
    original = high_detail_jpeg()
    assert len(original) < COUNTER_MAX_IMAGE_BYTES
    inspected = inspect_image(original)
    assert inspected.inference_media_type == "image/jpeg"
    assert len(inspected.inference_bytes) <= COUNTER_MAX_IMAGE_BYTES
    conversion = inspected.transformations[-1]
    assert conversion == {"step": "convert_rgb_jpeg", "width": 2200, "height": 2200,
                          "quality": 95, "subsampling": 0, "lossy": True}
    assert hashlib.sha256(inspected.inference_bytes).hexdigest() == inspected.inference_sha256

    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    fake = install_fake_adapter(client.app)
    response = upload_image(client, headers, 1, "cloud-input-test-00001", original)
    assert response.status_code == 202, response.text
    with client.app.state.capture.session_factory() as db:
        image = db.get(ImageRecord, response.json()["image_id"])
        upload = db.get(Upload, response.json()["upload_id"])
        storage = client.app.state.capture.storage
        assert image.inference_storage_key.endswith("/inference.jpg")
        assert storage.read(upload.storage_key) == original
        assert storage.read(image.inference_storage_key) == fake.calls[0][1] == inspected.inference_bytes
        assert image.sha256 == hashlib.sha256(original).hexdigest()
        assert image.inference_sha256 == hashlib.sha256(fake.calls[0][1]).hexdigest()
        assert image.transformations == inspected.transformations
        # Existing-image recovery restores only bytes matching recorded hash.
        (storage.root / image.inference_storage_key).unlink()
        assert service._ensure_inference_file(db, upload, storage, inspected, existing_image=image)
        (storage.root / image.inference_storage_key).unlink()
        image.inference_sha256 = "0" * 64
        assert not service._ensure_inference_file(db, upload, storage, inspected, existing_image=image)
        assert not storage.exists(image.inference_storage_key)


def test_unencodable_normalized_input_is_refused_before_dispatch():
    source = Image.frombytes("RGB", (96, 96), random.Random(3).randbytes(96 * 96 * 3))
    buffer = io.BytesIO()
    source.save(buffer, format="JPEG", quality=85)
    data = buffer.getvalue()
    with pytest.raises(HTTPException) as error:
        inspect_image(data, ImageLimits(max_inference_bytes=100))
    assert error.value.status_code == 413
    assert "smaller photo or crop" in error.value.detail


def test_modal_sdk_timeout_is_pending_not_a_recovery_failure(monkeypatch, settings):
    class SdkTimeout(Exception):
        pass

    assert not issubclass(SdkTimeout, TimeoutError)

    class PendingCall:
        def get(self, timeout):
            assert timeout == 0
            raise SdkTimeout("not ready")

    class Calls:
        @staticmethod
        def from_id(call_id):
            assert call_id == "test-only-call"
            return PendingCall()

    fake_modal = SimpleNamespace(FunctionCall=Calls, exception=SimpleNamespace(TimeoutError=SdkTimeout))
    monkeypatch.setitem(sys.modules, "modal", fake_modal)
    adapter = ModalCounterAdapter(settings)
    assert adapter.poll("test-only-call", 0) is None

    def builtin_timeout(self, timeout):
        raise TimeoutError("test-only builtin timeout")
    monkeypatch.setattr(PendingCall, "get", builtin_timeout)
    assert adapter.poll("test-only-call", 0) is None

    def unrelated_error(self, timeout):
        raise RuntimeError("test-only failure")
    monkeypatch.setattr(PendingCall, "get", unrelated_error)
    with pytest.raises(RuntimeError, match="test-only failure"):
        adapter.poll("test-only-call", 0)
