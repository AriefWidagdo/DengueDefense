"""Registry, sample lifecycle, exposure-time and retake tests."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from conftest import login, make_image_bytes, upload_image


def test_trap_lookup_returns_deployment_and_active_samples(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.get("/api/traps/VD-001", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["trap_id"] == "VD-001"
    assert body["district_code"] == "TEST"
    assert body["active_deployment"]["deployment_id"] == 1
    assert body["active_deployment"]["end_at"] is None
    assert len(body["samples"]) == 1
    assert body["samples"][0]["sample_type"] == "adult_card"
    assert body["samples"][0]["is_test_fixture"] is True


def test_create_sample_egg_strip(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.post(
        "/api/traps/VD-001/samples",
        headers=headers,
        json={
            "sample_type": "egg_strip",
            "installed_at": "2026-01-20T07:30:00+07:00",
            "installed_at_offset": "+07:00",
            "strip_id": "TEST-STRIP-001",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["installed_at"].startswith("2026-01-20T00:30:00")  # normalized to UTC
    assert body["installed_at_offset"] == "+07:00"
    assert body["revision"] == 1


def test_create_sample_requires_matching_surface_id(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.post(
        "/api/traps/VD-001/samples",
        headers=headers,
        json={"sample_type": "adult_card", "installed_at": "2026-01-20T07:30:00+00:00"},
    )
    assert response.status_code == 422


def test_create_sample_rejected_on_closed_deployment(seeded, db):
    from app.models import Deployment

    deployment = db.get(Deployment, 1)
    deployment.end_at = datetime(2026, 1, 15, tzinfo=timezone.utc)
    db.commit()
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.post(
        "/api/traps/VD-001/samples",
        headers=headers,
        json={"sample_type": "egg_strip", "installed_at": "2026-01-20T08:00:00+00:00", "strip_id": "S-9"},
    )
    assert response.status_code == 409


def test_patch_sample_records_removal_and_audit(seeded, db):
    from app.models import AuditRecord

    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.patch(
        "/api/samples/1",
        headers=headers,
        json={"expected_revision": 1, "removed_at": "2026-01-12T09:00:00+07:00", "removed_at_offset": "+07:00",
              "condition_notes": "intact, no rain damage"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sample"]["revision"] == 2
    assert body["sample"]["removed_at"].startswith("2026-01-12T02:00:00")
    assert body["sample"]["removed_at_offset"] == "+07:00"
    audit = db.query(AuditRecord).filter_by(entity_type="sample", entity_id="1").all()
    assert any(record.action == "updated" for record in audit)


def test_patch_sample_stale_revision_409(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    first = client.patch(
        "/api/samples/1", headers=headers,
        json={"expected_revision": 1, "condition_notes": "first update"},
    )
    assert first.status_code == 200
    stale = client.patch(
        "/api/samples/1", headers=headers,
        json={"expected_revision": 1, "condition_notes": "overwrites later edit"},
    )
    assert stale.status_code == 409
    assert "Stale" in stale.json()["detail"]


def test_patch_removal_before_installation_422(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.patch(
        "/api/samples/1", headers=headers,
        json={"expected_revision": 1, "removed_at": "2026-01-01T00:00:00+00:00"},
    )
    assert response.status_code == 422


def test_future_installation_422(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    future = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    response = client.post(
        "/api/traps/VD-001/samples",
        headers=headers,
        json={"sample_type": "egg_strip", "installed_at": future, "strip_id": "S-F"},
    )
    assert response.status_code == 422


def test_retake_shares_the_sample(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    first = upload_image(client, headers, 1, "retake-key-0001", make_image_bytes())
    assert first.status_code == 202
    second = upload_image(client, headers, 1, "retake-key-0002", make_image_bytes())
    assert second.status_code == 202
    assert first.json()["sample_id"] == second.json()["sample_id"] == 1
    assert first.json()["image_id"] != second.json()["image_id"]
    trap = client.get("/api/traps/VD-001", headers=headers).json()
    assert len(trap["samples"]) == 1  # still one active sample exposure


def test_exposure_known_flag_preserved(seeded):
    client = seeded
    headers = login(client, "worker1", "worker-password-1")
    response = client.patch(
        "/api/samples/1", headers=headers,
        json={"expected_revision": 1, "exposure_known": False, "condition_notes": "installation time unknown"},
    )
    assert response.status_code == 200
    assert response.json()["sample"]["exposure_known"] is False