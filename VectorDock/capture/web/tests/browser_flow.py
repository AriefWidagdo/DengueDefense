"""Browser regression for the one-photo container-QR capture flow.

Runs the REAL page (index.html + js/app.js + vendored jsQR) against the real
`_worker.js` proxy seam (dev-server.mjs) and a real local backend with:
- a fresh temporary SQLite database and local-disk storage (test-only),
- seeded test-fixture identities and trap (is_test_fixture=True),
- the counter disabled (CAPTURE_MODAL_ENABLED unset): counting jobs honestly
  end in a failed state; no live inference, no Modal contact.

Everything binds to loopback only. Port 8788 (the parent's local QR label
tool) is never used. The browser is Playwright's own isolated Chromium
context: no user profile, no persistent storage, no real camera hardware.

Usage:  python tests/browser_flow.py
"""

import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from pathlib import Path
import json
from PIL import Image

from playwright.async_api import async_playwright

WEB = Path(__file__).resolve().parent.parent
BACKEND = WEB.parent / "backend"
PYTHON = Path(os.environ.get("VECTORDOCK_TEST_PYTHON") or (
    BACKEND / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    / ("python.exe" if os.name == "nt" else "python")
))
FIXTURES = WEB / "tests" / "fixtures"

WORKER_PASSWORD = "field-worker-test-pass"
REVIEWER_PASSWORD = "field-reviewer-test-pass"
TRAP = "VD-TEST-001"

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS" if ok else "FAIL") + f" - {name}" + (f" ({detail})" if detail and not ok else ""))


def free_port(start):
    for port in range(start, start + 20):
        if port == 8788:  # the parent's local QR label tool port; never touch it
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free loopback port found")


def wait_health(url, timeout_seconds=40):
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError(f"not healthy: {url}")


async def sign_in(page, username="test-worker", password=WORKER_PASSWORD, stay_dashboard=False):
    await page.goto(f"{ORIGIN}/")
    await page.wait_for_selector("#view-signin:not([hidden])")
    await page.fill("#signinUsername", username)
    await page.fill("#signinPassword", password)
    await page.click("#signinForm button[type=submit]")
    await page.wait_for_selector("#view-dashboard:not([hidden])")
    if not stay_dashboard:
        await page.click("#dashboardCaptureBtn")
        await page.wait_for_selector("#view-trap:not([hidden])")


async def photo_first(page):
    await page.click("#photoFirstBtn")
    await page.wait_for_selector("#view-capture:not([hidden])")


async def wait_trap_card(page, timeout=15000):
    await page.wait_for_selector("#trapCard:not([hidden])", timeout=timeout)
    await page.wait_for_function(
        "() => document.getElementById('trapIdValue').textContent.length > 0", timeout=5000
    )


async def select_sample_1(page):
    await page.wait_for_selector("#view-samples:not([hidden])")
    radio = page.locator('input[name="sample-select"]').first
    await radio.check()
    sample_id = int(await radio.input_value())
    await page.click("#toCaptureBtn")
    await page.wait_for_selector("#view-capture:not([hidden])")
    return sample_id


async def confirm_and_wait_failed(page):
    async with page.expect_response(lambda response: response.request.method == "POST" and "/api/samples/" in response.url and response.url.endswith("/images")) as pending:
        await page.click("#confirmUploadBtn")
    response = await pending.value
    assert response.status in (200, 202), await response.text()
    upload = await response.json()
    assert f"/api/samples/{upload['sample_id']}/images" in response.url
    await page.wait_for_selector("#view-status:not([hidden])")
    await page.wait_for_function(
        "() => document.getElementById('statusBanner').textContent.includes('Counting failed')",
        timeout=20000,
    )
    stored = await page.request.get(f"{ORIGIN}/api/uploads/{upload['upload_id']}")
    assert (await stored.json())["sample_id"] == upload["sample_id"]
    return upload


def set_test_job(upload_id, mode, count=3):
    """Explicit offline fixture controller; never part of the app or a live job.

    Uses only this test's temporary SQLite DB with Modal disabled. It makes
    completed/attention records so browser review/navigation can be tested.
    """
    program = r'''
import sys
from app.config import load_settings
from app.db import create_db_engine, create_session_factory
from app.models import Upload, Sample, ImageRecord, ProcessingJob, utcnow
from app.storage import build_storage
from app import service
settings=load_settings()
assert settings.env == "development" and not settings.modal_enabled
assert "vd-capture-browser-" in settings.database_url
factory=create_session_factory(create_db_engine(settings))
with factory() as db:
    upload=db.get(Upload,sys.argv[1])
    sample=db.get(Sample,upload.sample_id)
    if sample.removed_at is None:
        sample.removed_at=utcnow(); sample.removed_at_offset="+00:00"; sample.revision+=1
    image=db.query(ImageRecord).filter_by(upload_id=upload.upload_id).one()
    job=db.query(ProcessingJob).filter_by(image_id=image.image_id).one()
    job.state="queued"; job.failure_reason=None; job.finished_at=None
    job.needs_attention=sys.argv[2] == "attention"
    db.commit()
    if sys.argv[2] == "complete":
        storage=build_storage(settings)
        result=service.publish_result(db,storage,job_id=job.job_id,
            report={"count":int(sys.argv[3]),"detections":[],"test_only_synthetic_result":True},
            annotated_png=storage.read(image.inference_storage_key),image=image)
        assert result == "published", result
'''
    response = subprocess.run([str(PYTHON), "-c", program, upload_id, mode, str(count)], cwd=BACKEND, env=TEST_ENV, capture_output=True, text=True)
    assert response.returncode == 0, response.stdout + response.stderr


async def main():
    uploads_seen = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        context = await browser.new_context()
        page = await context.new_page()
        page.on("request", lambda request: uploads_seen.append(request.url)
                if "/api/samples/" in request.url and request.url.endswith("/images") else None)

        # 1. Login opens the operator dashboard before the capture workflow.
        await sign_in(page, stay_dashboard=True)
        await page.wait_for_selector(".dashboard-trap", timeout=15000)
        record("login opens dashboard with assigned test trap",
               TRAP in await page.text_content("#dashboardTrapList"))

        # Stub only this request: it tests the dashboard form, not inference.
        forecast_requests = []
        async def forecast_stub(route):
            forecast_requests.append(route.request.post_data or "")
            await route.fulfill(status=200, json={
                "model": "tree", "district": "31.73", "issue_date": "2028-02-29",
                "predictions": [{"target_month": "2028-03-01", "expected_cases": 12.5,
                                 "uncertainty": {"quantiles": {"q0.025": 3, "q0.975": 22}}}],
                "limitations": ["Synthetic browser test only."],
            })
        await page.route("**/api/forecasts", forecast_stub)
        await page.wait_for_function("document.getElementById('forecastDistricts').options.length === 514")
        await page.fill("#forecastRegion", "31.73")
        record("trained district selection fills the matching province",
               await page.input_value("#forecastProvince") == "DKI Jakarta")
        await page.fill("#forecastMonth", "2028-02")
        await page.set_input_files("#forecastPanel", {"name": "test.csv", "mimeType": "text/csv", "buffer": b"test,data\n1,2\n"})
        await page.click("#forecastRunBtn")
        await page.wait_for_selector("#forecastResult:not([hidden])")
        record("dashboard submits a forecast and shows the returned result",
               "12.5" in await page.text_content("#forecastResultList")
               and "2028-02-29" in forecast_requests[0])
        await page.check("#forecastSourceManual")
        await page.fill("#forecastProvince", "DKI Jakarta")
        await page.select_option("#forecastIsland", "0")
        await page.click("#forecastGenerateBtn")
        assert await page.locator(".monthly-entry").count() == 24
        await page.evaluate("""() => {
          const months = [...document.querySelectorAll('.monthly-entry')];
          months.slice(0, 12).forEach((month, index) => {
            month.querySelector('[data-field=cases]').value = String(index);
          });
          months[0].querySelector('[data-field=tmin]').value = '24.5';
        }""")
        await page.click("#forecastRunBtn")
        await page.wait_for_function("document.getElementById('forecastResult').hidden === false")
        record("manual entry sends 24 months and Celsius values",
               len(forecast_requests) == 2 and '2026-03-01' in forecast_requests[1]
               and '24.5' in forecast_requests[1] and 'DKI Jakarta' in forecast_requests[1])
        await page.unroute("**/api/forecasts", forecast_stub)
        await page.click("#dashboardCaptureBtn")
        await page.wait_for_selector("#view-trap:not([hidden])")
        record("leaving the dashboard clears the transient forecast", await page.is_hidden("#forecastResult"))
        # Photo-first with the token fixture resolves the authorized bucket.
        await photo_first(page)
        assert await page.is_visible("#view-capture"), "capture view must open without a selected bucket"
        await page.set_input_files("#photoInput", str(FIXTURES / "photo-qr-token.png"))
        await wait_trap_card(page)
        trap_id = await page.text_content("#trapIdValue")
        site = await page.text_content("#trapSite")
        record("photo-first upload-photo resolves authorized bucket", trap_id == TRAP and site == "TEST-SITE",
               f"trap={trap_id} site={site}")
        registry = await page.request.get(f"{ORIGIN}/api/traps/{TRAP}")
        expected_location = (await registry.json())["active_deployment"]["location_note"]
        assert await page.text_content("#trapLocation") == expected_location
        record("confirmation shows the registered location note", bool(expected_location))
        await page.click("#trapConfirmBtn")
        selected_id = await select_sample_1(page)
        assert await page.is_visible("#previewFigure"), "retained photo preview must still be shown"
        outcome = await page.text_content("#qrOutcome")
        record("retained photo shows matching-container outcome",
               outcome and "matches" in outcome, f"outcome={outcome!r}")
        first_upload = await confirm_and_wait_failed(page)
        record("confirmation stores the upload against the selected sample", first_upload["sample_id"] == selected_id)

        # 2. Camera input must identify a bucket BEFORE any trap confirmation.
        await page.click("#statusBackBtn")
        await page.wait_for_selector("#view-samples:not([hidden])")
        await page.click("#samplesBackBtn")
        await page.wait_for_selector("#view-trap:not([hidden])")
        await photo_first(page)
        assert "not selected yet" in await page.text_content("#captureSampleId")
        await page.set_input_files("#cameraInput", str(FIXTURES / "photo-qr-token.png"))
        await wait_trap_card(page)
        record("take-picture input performs photo-first registry lookup", await page.text_content("#trapIdValue") == TRAP and await page.text_content("#trapLocation") == expected_location)
        await page.click("#trapConfirmBtn")
        await select_sample_1(page)
        await page.wait_for_function("() => document.getElementById('qrOutcome').textContent.includes('matches')")

        # 3. A wrong (unauthorized) container ID never auto-assigns or uploads.
        uploads_seen.clear()
        await page.click("#captureBackBtn")
        await page.wait_for_selector("#view-samples:not([hidden])")
        await page.click("#samplesBackBtn")
        await page.wait_for_selector("#view-trap:not([hidden])")
        await photo_first(page)
        await page.set_input_files("#photoInput", str(FIXTURES / "photo-qr-wrong-trap.png"))
        await page.wait_for_selector("#trapError:not([hidden])", timeout=15000)
        error_text = await page.text_content("#trapError")
        record("wrong/unauthorized bucket id is refused, no silent upload",
               "access grant" in error_text and not uploads_seen and await page.is_hidden("#view-status"),
               f"error={error_text!r} uploads={uploads_seen}")

        # 4. Multiple conflicting IDs force an explicit choice.
        await photo_first(page)
        await page.set_input_files("#photoInput", str(FIXTURES / "photo-qr-conflict.png"))
        await page.wait_for_selector("#view-photo-id:not([hidden])", timeout=15000)
        buttons = await page.locator("#photoIdConflictButtons button").all_text_contents()
        record("conflicting ids require an explicit resolution",
               any(TRAP in text for text in buttons) and any("VD-OTHER-9" in text for text in buttons),
               f"buttons={buttons}")

        # 5. No readable QR: explicit retake or manual fallback; manual path
        #    keeps the retained photo and never reuses an old bucket silently.
        await page.click("#photoIdConflictRetakeBtn")
        await page.wait_for_selector("#view-capture:not([hidden])")
        await page.click("#captureBackBtn")
        await page.wait_for_selector("#view-trap:not([hidden])")
        await photo_first(page)
        await page.set_input_files("#photoInput", str(FIXTURES / "photo-no-qr.png"))
        await page.wait_for_selector("#photoIdProblem:not([hidden])", timeout=15000)
        await page.click("#photoIdManualBtn")
        await page.wait_for_selector("#view-trap:not([hidden])")
        await page.fill("#trapIdInput", TRAP)
        await page.click("#trapLookupForm button[type=submit]")
        await wait_trap_card(page)
        await page.click("#trapConfirmBtn")
        await select_sample_1(page)
        assert await page.is_visible("#previewFigure"), "retained photo must survive manual resolution"
        record("explicit manual fallback retains the photo for the confirmed bucket", True)
        manual_upload = await confirm_and_wait_failed(page)

        # 6. A late decode/lookup cannot overwrite a newer photo decision.
        async def delay_trap_route(route):
            await asyncio.sleep(1.5)
            await route.continue_()

        await page.route("**/api/traps/VD-TEST-001", delay_trap_route)
        try:
            await page.click("#statusBackBtn")
            await page.wait_for_selector("#view-samples:not([hidden])")
            await page.click("#samplesBackBtn")
            await page.wait_for_selector("#view-trap:not([hidden])")
            await photo_first(page)
            await page.set_input_files("#photoInput", str(FIXTURES / "photo-qr-token.png"))
            await page.wait_for_timeout(300)  # lookup now in flight (delayed)
            await page.set_input_files("#photoInput", str(FIXTURES / "photo-no-qr.png"))
            await page.wait_for_selector("#view-photo-id:not([hidden])", timeout=15000)
            await page.wait_for_timeout(2500)  # the delayed lookup lands here
            still_problem = await page.is_visible("#photoIdProblem")
            trap_card_hidden = await page.is_hidden("#trapCard")
            record("late lookup cannot overwrite a newer image decision",
                   still_problem and trap_card_hidden,
                   f"problem={still_problem} trapCardHidden={trap_card_hidden}")
        finally:
            await page.unroute("**/api/traps/VD-TEST-001")

        # 7. EXIF-rotated fixture through the real createImageBitmap/canvas path.
        await page.click("#photoIdProblemRetakeBtn")
        await page.wait_for_selector("#view-capture:not([hidden])")
        await page.click("#captureBackBtn")
        await page.wait_for_selector("#view-trap:not([hidden])")
        await photo_first(page)
        await page.set_input_files("#photoInput", str(FIXTURES / "photo-qr-token-exif6.jpg"))
        await wait_trap_card(page)
        trap_id = await page.text_content("#trapIdValue")
        record("EXIF-rotated fixture decodes through the browser image path", trap_id == TRAP, f"trap={trap_id}")

        # 8. Duplicate trap query parameter in the page URL is refused.
        await page.goto(f"{ORIGIN}/?trap={TRAP}&trap={TRAP}")
        await page.wait_for_selector("#view-trap:not([hidden])")
        await page.wait_for_selector("#trapError:not([hidden])", timeout=10000)
        url_error = await page.text_content("#trapError")
        record("duplicate trap URL parameter (identical values) is refused",
               "duplicated or conflicting" in url_error and await page.is_hidden("#trapCard"),
               f"error={url_error!r}")
        # Isolate the invalid-URL check from later navigation/restore checks.
        await page.evaluate("history.replaceState({}, '', '/')")

        # 9. Confirm a real sample BEFORE taking a conflicting photo.
        # The unauthorized photo-first case is already covered in check 3.
        await page.fill("#trapIdInput", TRAP)
        await page.click("#trapLookupForm button[type=submit]")
        await wait_trap_card(page)
        await page.click("#trapConfirmBtn")
        await select_sample_1(page)
        await page.set_input_files("#photoInput", str(FIXTURES / "photo-qr-wrong-trap.png"))
        await page.wait_for_selector("#view-photo-id:not([hidden])", timeout=15000)
        keep_text = await page.locator("#photoIdConflictButtons button").first.text_content()
        record("disagreement with the confirmed bucket blocks silent assignment",
               "Keep" in keep_text and TRAP in keep_text, f"button={keep_text!r}")
        await page.click("#photoIdConflictRetakeBtn")
        record("retake is offered after disagreement", await page.is_visible("#view-capture"))

        # 10. Cancel the actual bitmap await, not only a network lookup.
        for action in ("retake", "cancel", "invalid", "navigate"):
            if not await page.is_visible("#view-trap"):
                await page.click("#captureBackBtn")
                await page.wait_for_selector("#view-samples:not([hidden]), #view-trap:not([hidden])")
                if await page.is_visible("#view-samples"):
                    await page.click("#samplesBackBtn")
            await photo_first(page)
            await page.evaluate("""() => {
                window.__bitmapOriginal = window.createImageBitmap;
                window.__bitmapStarted = false; window.__bitmapFinished = false;
                const gate = new Promise(resolve => { window.__releaseBitmap = resolve; });
                window.createImageBitmap = async (...args) => {
                    window.__bitmapStarted = true; await gate;
                    const bitmap = await window.__bitmapOriginal(...args);
                    window.__bitmapFinished = true; return bitmap;
                };
            }""")
            await page.set_input_files("#photoInput", str(FIXTURES / "photo-qr-token.png"))
            await page.wait_for_function("window.__bitmapStarted")
            if action == "retake":
                await page.click("#retakeBtn")
            elif action == "cancel":
                await page.dispatch_event("#photoInput", "cancel")
            elif action == "invalid":
                await page.set_input_files("#photoInput", {"name":"bad.txt","mimeType":"text/plain","buffer":b"bad"})
            else:
                await page.click("#captureBackBtn")
                await wait_trap_card(page)
            await page.evaluate("window.__releaseBitmap()")
            await page.wait_for_function("window.__bitmapFinished")
            if action == "navigate":
                ok = await page.is_visible("#view-trap") and await page.text_content("#trapIdValue") == TRAP
            else:
                ok = await page.is_visible("#view-capture") and await page.is_hidden("#previewFigure") and await page.is_hidden("#captureActions")
            record(f"in-flight decode is invalidated by {action}", ok)
            await page.evaluate("window.createImageBitmap = window.__bitmapOriginal; void 0")

        # 11. A small compressed, oversized image must never allocate a bitmap.
        await photo_first(page)
        oversized = WORKDIR / "test-only-20mp.png"
        Image.new("L", (5000, 4000), 0).save(oversized, format="PNG")
        assert oversized.stat().st_size < 12 * 1024 * 1024
        await page.evaluate("""() => {
            window.__bitmapCalls=0; window.__bitmapOriginal=window.createImageBitmap;
            window.createImageBitmap=(...args)=>{window.__bitmapCalls++;return window.__bitmapOriginal(...args);};
        }""")
        await page.set_input_files("#photoInput", str(oversized))
        await page.wait_for_selector("#photoError:not([hidden])")
        record("20 MP compressed photo is rejected before bitmap decode", "16 megapixels" in await page.text_content("#photoError") and await page.evaluate("window.__bitmapCalls") == 0 and await page.is_hidden("#previewFigure"))
        await page.evaluate("window.createImageBitmap = window.__bitmapOriginal; void 0")

        # 12. Reopen a CLOSED sample's queued image after a real page reload.
        set_test_job(first_upload["upload_id"], "queued")
        await page.reload()
        await page.wait_for_selector("#view-dashboard:not([hidden])")
        await page.click("#dashboardCaptureBtn")
        await wait_trap_card(page)
        await page.click("#trapConfirmBtn")
        first_button = f'[data-upload-id="{first_upload["upload_id"]}"]'
        await page.wait_for_selector(first_button)
        await page.click(first_button)
        await page.wait_for_function("document.getElementById('statusBanner').dataset.state === 'saved-queued'")
        record("reload reopens a saved queued upload for a closed sample", await page.text_content("#statusSampleId") == f"#{selected_id}")
        async with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith(f"/uploads/{first_upload['upload_id']}/poll"), timeout=12000) as poll:
            pass  # the active status page sends the checked poll on its timer
        poll_response = await poll.value
        record("active status page checks the existing upload through the authorized poll route", poll_response.status == 200 and (await poll_response.json())["upload_id"] == first_upload["upload_id"])
        set_test_job(first_upload["upload_id"], "attention")
        await page.wait_for_function("document.getElementById('statusBanner').dataset.state === 'needs-attention'", timeout=10000)
        record("exhausted dispatch becomes visible supervisor attention", "supervisor" in (await page.text_content("#statusDetail")).lower())
        assert await page.is_hidden("#retryUploadBtn"), "attention must not offer an old-photo retry"
        await page.wait_for_selector("#retakeFromStatusBtn:not([hidden])")
        page.once("dialog", lambda dialog: asyncio.create_task(dialog.accept()))
        async with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/retake")) as intent:
            await page.click("#retakeFromStatusBtn")
        audit_response = await intent.value
        assert audit_response.status == 201
        audit = await audit_response.json()
        await page.wait_for_selector("#view-capture:not([hidden])")
        assert await page.is_hidden("#previewFigure"), "retake must discard the old File/key"
        await page.set_input_files("#cameraInput", str(FIXTURES / "photo-qr-token.png"))
        await page.wait_for_function("document.getElementById('qrOutcome').textContent.includes('matches')")
        new_upload = await confirm_and_wait_failed(page)
        old_status = await (await page.request.get(f"{ORIGIN}/api/uploads/{first_upload['upload_id']}")).json()
        record("attention offers an audited new-photo retake without restarting the stopped job", audit["sample_id"] == selected_id and audit["audit_id"] > 0 and new_upload["sample_id"] == selected_id and new_upload["upload_id"] != first_upload["upload_id"] and old_status["processing"]["needs_attention"] is True)

        # 13. Complete only this isolated fixture; reopen and revise as reviewer.
        set_test_job(first_upload["upload_id"], "complete", 3)
        await page.click("#signOutBtn")
        await sign_in(page, "test-reviewer", REVIEWER_PASSWORD)
        await page.fill("#trapIdInput", TRAP)
        await page.click("#trapLookupForm button[type=submit]")
        await wait_trap_card(page)
        await page.click("#trapConfirmBtn")
        await page.wait_for_selector(first_button)
        await page.click(first_button)
        await page.wait_for_selector("#reviewBlock:not([hidden])")
        await page.fill("#correctedCountInput", "7")
        await page.click("#reviewForm button[type=submit]")
        await page.wait_for_function("document.getElementById('statusBanner').dataset.state === 'accepted'")
        assert await page.text_content("#reviewedCount") == "7"
        await page.reload()
        await page.wait_for_selector("#view-dashboard:not([hidden])")
        await page.click("#dashboardCaptureBtn")
        await wait_trap_card(page)
        await page.click("#trapConfirmBtn")
        await page.wait_for_selector(first_button)
        await page.click(first_button)
        await page.wait_for_selector("#reviewEditBtn:not([hidden])")
        await page.click("#reviewEditBtn")
        await page.wait_for_selector("#reviewBlock:not([hidden])")
        assert await page.input_value("#correctedCountInput") == "7"
        await page.fill("#correctedCountInput", "9")
        async with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/reviews")) as pending:
            await page.click("#reviewForm button[type=submit]")
        revision = await (await pending.value).json()
        await page.wait_for_function("document.getElementById('reviewedCount').textContent === '9'")
        record("accepted image can be reopened and explicitly corrected after reload", revision.get("revision") == 2 and revision.get("accepted_count") == 9 and await page.text_content("#candidateCount") == "3")

        # A second photo stays reviewable even when a different photo is active.
        set_test_job(manual_upload["upload_id"], "complete", 5)
        await page.click("#statusBackBtn")
        second_button = f'[data-upload-id="{manual_upload["upload_id"]}"]'
        await page.wait_for_selector(second_button)
        await page.click(second_button)
        await page.wait_for_selector("#reviewBlock:not([hidden])")
        record("retake candidate reopens with an explicit active-review replacement", await page.text_content("#candidateCount") == "5" and "revision 2" in await page.text_content("#reviewContext"))

        # A rejected active review is not an accepted count on the next photo.
        await page.click("#statusBackBtn")
        await page.wait_for_selector(first_button)
        await page.click(first_button)
        await page.wait_for_selector("#reviewEditBtn:not([hidden])")
        await page.click("#reviewEditBtn")
        await page.wait_for_selector("#reviewBlock:not([hidden])")
        await page.check("#decisionReject")
        await page.fill("#rejectionReasonInput", "TEST ONLY prior image rejection")
        async with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/reviews")) as rejection:
            await page.click("#reviewForm button[type=submit]")
        rejected = await (await rejection.value).json()
        assert rejected["decision"] == "rejected" and rejected["revision"] == 3
        assert rejected["accepted_count"] is None and rejected["available_at"] is None
        await page.wait_for_function("document.getElementById('statusBanner').dataset.state === 'rejected'")
        await page.click("#statusBackBtn")
        await page.wait_for_selector(second_button)
        await page.click(second_button)
        await page.wait_for_selector("#reviewBlock:not([hidden])")
        context_text = await page.text_content("#reviewContext")
        record("pending retake describes a rejected prior review truthfully", "a rejected review" in context_text and "accepted measurement" not in context_text and "revision 3" in context_text)
        async with page.expect_response(lambda response: response.request.method == "POST" and response.url.endswith("/reviews")) as replacement:
            await page.click("#reviewForm button[type=submit]")
        replaced = await (await replacement.value).json()
        record("a new candidate explicitly supersedes the rejected prior review", replaced.get("decision") == "accepted" and replaced.get("accepted_count") == 5 and replaced.get("revision") == 4 and replaced.get("available_at") is not None)
        await browser.close()


def run():
    workdir = Path(tempfile.mkdtemp(prefix="vd-capture-browser-"))
    backend_port = free_port(8790)
    web_port = free_port(max(backend_port + 1, 8791))
    global ORIGIN, TEST_ENV, WORKDIR
    ORIGIN = f"http://127.0.0.1:{web_port}"
    backend_origin = f"http://127.0.0.1:{backend_port}"
    db_path = (workdir / "capture.sqlite3").as_posix()
    env = {
        **os.environ,
        "CAPTURE_ENV": "development",
        "CAPTURE_STORAGE_BACKEND": "local",
        "DATABASE_URL": f"sqlite:///{db_path}",
        "CAPTURE_STORAGE_DIR": str(workdir / "storage"),
        "CAPTURE_ALLOWED_ORIGINS": ORIGIN,
        "CAPTURE_RELAY_TOKEN": "browser-flow-relay-token-0123456789abcdef",
        "CAPTURE_PUBLIC_BASE_URL": ORIGIN,
        "CAPTURE_MODAL_ENABLED": "0",
    }
    TEST_ENV = env
    WORKDIR = workdir
    (workdir / "storage").mkdir()
    seed = subprocess.run(
        [str(PYTHON), "-m", "app.cli", "seed-fixtures",
         "--db", f"sqlite:///{db_path}",
         "--worker-password", WORKER_PASSWORD,
         "--reviewer-password", REVIEWER_PASSWORD],
        cwd=BACKEND, env=env, capture_output=True, text=True,
    )
    if seed.returncode != 0:
        print(seed.stdout, seed.stderr)
        raise RuntimeError("fixture seeding failed")
    backend = subprocess.Popen(
        [str(PYTHON), "-m", "uvicorn", "app.main:create_app", "--factory",
         "--host", "127.0.0.1", "--port", str(backend_port)],
        cwd=BACKEND, env=env,
        stdout=open(workdir / "backend.log", "w"), stderr=subprocess.STDOUT,
    )
    web_env = {**env, "CAPTURE_BACKEND_ORIGIN": backend_origin}
    web = subprocess.Popen(
        ["node", "dev-server.mjs", str(web_port)],
        cwd=WEB, env=web_env,
        stdout=open(workdir / "devserver.log", "w"), stderr=subprocess.STDOUT,
    )
    try:
        wait_health(f"{backend_origin}/api/health")
        wait_health(f"{ORIGIN}/api/health")
        asyncio.run(main())
    except Exception as error:
        record("unexpected failure", False, f"{error}\n{traceback.format_exc()}")
    finally:
        for process in (backend, web):
            process.terminate()
        try:
            backend.wait(timeout=10)
            web.wait(timeout=10)
        except Exception:
            backend.kill(); web.kill()
    failed = [name for name, ok, _ in results if not ok]
    passed = len(results) - len(failed)
    print(f"\nbrowser_flow: {passed} checks passed, {len(failed)} failed")
    if failed:
        artifacts = Path(tempfile.gettempdir()) / "vd-capture-browser-artifacts"
        artifacts.mkdir(exist_ok=True)
        print(f"server logs: {workdir}")
        print(f"artifact dir: {artifacts}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(run())