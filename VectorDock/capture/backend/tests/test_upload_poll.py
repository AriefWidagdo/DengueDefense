"""Active phone checks of retained test calls; no Modal contact or inference."""
from app.models import ImageRecord, Measurement, ProcessingJob, ProcessingResult
from conftest import install_fake_adapter, login, make_image_bytes, upload_image


def create_fake_upload(client):
    headers = login(client, "worker1", "worker-password-1")
    fake = install_fake_adapter(client.app, count=4)
    response = upload_image(client, headers, 1, "poll-test-00000001", make_image_bytes())
    assert response.status_code == 202
    return headers, fake, response.json()


def test_poll_existing_call_publishes_candidate_not_measurement(seeded):
    client = seeded
    headers, fake, upload = create_fake_upload(client)
    path = f"/api/uploads/{upload['upload_id']}/poll"
    # A status read has no processing side effects.
    assert client.get(f"/api/uploads/{upload['upload_id']}").json()["result"] is None
    # A non-relayed cookie write needs CSRF and a permitted Origin.
    assert client.post(path).status_code == 403
    assert client.post(path, headers={**headers, "Origin": "https://untrusted.invalid"}).status_code == 403
    response = client.post(path, headers=headers)
    assert response.status_code == 200, response.text
    output = response.json()
    assert output["processing"]["state"] == "completed"
    assert output["result"]["candidate_count"] == 4
    assert output["review"]["state"] == "pending_review"
    assert len(fake.calls) == 1  # poll never spawns a second GPU job
    with client.app.state.capture.session_factory() as db:
        assert db.query(ProcessingResult).count() == 1
        assert db.query(Measurement).count() == 0  # no acceptance or available_at
    assert client.post(path, headers=headers).json()["result"]["candidate_count"] == 4
    assert len(fake.calls) == 1


def test_poll_requires_a_trap_grant(seeded):
    client = seeded
    _, fake, upload = create_fake_upload(client)
    path = f"/api/uploads/{upload['upload_id']}/poll"
    outsider = login(client, "outsider", "outsider-password-1")
    assert client.post(path, headers=outsider).status_code == 403
    assert len(fake.calls) == 1
    assert len(fake.pending) == 1
    with client.app.state.capture.session_factory() as db:
        assert db.query(ProcessingResult).count() == 0


def test_pending_call_stays_running_without_dispatch(seeded):
    client = seeded
    headers, fake, upload = create_fake_upload(client)
    fake.pending.clear()
    response = client.post(f"/api/uploads/{upload['upload_id']}/poll", headers=headers)
    assert response.status_code == 200
    assert response.json()["processing"]["state"] == "running"
    assert response.json()["result"] is None
    assert len(fake.calls) == 1


def test_no_call_or_attention_never_triggers_poll_or_spawn(seeded):
    client = seeded
    headers, fake, upload = create_fake_upload(client)
    with client.app.state.capture.session_factory() as db:
        image = db.get(ImageRecord, upload["image_id"])
        job = db.query(ProcessingJob).filter_by(image_id=image.image_id).one()
        job.modal_call_id = None
        db.commit()
    path = f"/api/uploads/{upload['upload_id']}/poll"
    assert client.post(path, headers=headers).status_code == 200
    assert len(fake.pending) == 1 and len(fake.calls) == 1
    with client.app.state.capture.session_factory() as db:
        job = db.query(ProcessingJob).one()
        job.modal_call_id = fake.calls[0][0]
        job.needs_attention = True
        db.commit()
    response = client.post(path, headers=headers)
    assert response.status_code == 200 and response.json()["processing"]["needs_attention"] is True
    assert len(fake.pending) == 1 and len(fake.calls) == 1


def test_poll_failure_is_sanitized_and_keeps_job_pending(seeded):
    client = seeded
    headers, fake, upload = create_fake_upload(client)
    def fail(*args):
        raise RuntimeError("test-only sensitive adapter failure")
    fake.poll = fail
    response = client.post(f"/api/uploads/{upload['upload_id']}/poll", headers=headers)
    assert response.status_code == 503
    assert "sensitive" not in response.text
    with client.app.state.capture.session_factory() as db:
        assert db.query(ProcessingJob).one().state in {"queued", "running"}
        assert db.query(ProcessingResult).count() == 0
        assert db.query(Measurement).count() == 0
    assert len(fake.calls) == 1
