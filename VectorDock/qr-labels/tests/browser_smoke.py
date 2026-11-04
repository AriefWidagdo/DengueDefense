"""Run against the local label server. Needs Playwright Chromium and OpenCV.

Usage: python VectorDock/qr-labels/tests/browser_smoke.py
Test records stay in an isolated browser context. No physical print job runs.
"""
from pathlib import Path
import json
import tempfile
import cv2
from playwright.sync_api import sync_playwright

artifacts = Path(tempfile.mkdtemp(prefix="vectordock-label-check-"))
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 1100}, device_scale_factor=2)
    page = context.new_page()
    page.set_default_timeout(5000)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto("http://127.0.0.1:8788/", wait_until="networkidle")
    assert page.title() == "VectorDock \u2014 QR labels"
    assert page.locator("#print-current").is_disabled()
    for name, value in {
        "trap_id": "VD-TEST-001",
        "site": "TEST ONLY \u2014 \u6771\u4eac (not a deployment)",
        "location": "TEST ONLY north gate",
        "deployed_on": "2026-11-01",
    }.items():
        page.locator(f"[name={name}]").fill(value)
    assert page.locator("#print-current").is_enabled()
    assert page.locator('[name=mode][value=identity]').is_checked()
    identity_payload = page.locator('#payload').text_content()
    assert identity_payload == 'VD1:TRAP:VD-TEST-001'
    page.locator('#preview .qr-mark').screenshot(path=str(artifacts / 'identity-qr.png'))
    identity_decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(artifacts / 'identity-qr.png')))
    assert identity_decoded == identity_payload
    page.locator('[name=mode][value=details]').check()
    payload = page.locator("#payload").text_content()
    assert "ID: VD-TEST-001" in payload and "http" not in payload
    qr = artifacts / "details-qr.png"
    page.locator("#preview .qr-mark").screenshot(path=str(qr))
    decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(qr)))
    assert decoded == payload, (decoded, payload)
    page.evaluate('window.__printCalls=0; window.__printStacks=[]; window.print=()=>{window.__printCalls++;window.__printStacks.push(new Error().stack);window.dispatchEvent(new Event("beforeprint"));}; void 0')
    page.locator("#print-current").click()
    assert page.evaluate("window.__printCalls") == 1, page.evaluate("({calls:window.__printCalls,stacks:window.__printStacks,invalid:[...document.querySelector('form').elements].filter(e=>e.validity&&!e.validity.valid).map(e=>({name:e.name,value:e.value,message:e.validationMessage})),error:document.querySelector('#form-error').textContent})")
    assert page.locator("#print-area .container-label").count() == 1
    page.locator("#save-label").click()
    assert page.locator("#saved-count").inner_text() == "1"
    page.reload(wait_until="networkidle")
    assert page.locator("#saved-count").inner_text() == "1"
    assert page.locator("[name=trap_id]").input_value() == "VD-TEST-001"
    page.locator("[name=mode][value=maps]").check()
    maps_payload = page.locator("#payload").text_content()
    assert maps_payload.startswith("https://www.google.com/maps/search/")
    assert "TEST+ONLY" in maps_payload
    page.locator("#preview .qr-mark").screenshot(path=str(artifacts / "maps-qr.png"))
    maps_decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(artifacts / "maps-qr.png")))
    assert maps_decoded == maps_payload
    page.locator("[name=mode][value=details]").check()
    page.locator("details.optional-fields summary").click()
    page.locator("[name=latitude]").fill("91")
    page.locator("[name=longitude]").fill("106.8")
    assert page.locator("#print-current").is_disabled()
    page.locator("[name=latitude]").fill("-6.2")
    assert page.locator("#print-current").is_enabled()
    page.locator("[name=site]").fill("<img src=x onerror=alert(1)> TEST ONLY")
    assert page.locator("#preview img").count() == 0
    assert "<img" in page.locator("#preview .label-site").inner_text()
    page.locator("[name=site]").fill("TEST ONLY \u2014 no field deployment")
    page.screenshot(path=str(artifacts / "desktop.png"), full_page=True)
    page.emulate_media(media="print")
    page.evaluate('window.dispatchEvent(new Event("beforeprint"))')
    dimensions = page.locator("#print-area .qr-mark").evaluate("el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})")
    assert abs(dimensions["width"] - 48 * 96 / 25.4) < 1, dimensions
    assert page.locator(".topbar").is_hidden()
    page.pdf(path=str(artifacts / "test-label.pdf"), prefer_css_page_size=True)
    page.emulate_media(media="screen")
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Mobile horizontal overflow"
    page.screenshot(path=str(artifacts / "mobile.png"), full_page=True)
    assert not errors, errors
    print(json.dumps({
        "browser_checks": "PASS",
        "identity_qr_decode": "exact versioned container ID match",
        "details_qr_decode": "exact UTF-8 payload match",
        "maps_qr_decode": "exact URL match",
        "draft_and_saved_list": "persist after reload",
        "validation": "invalid GPS blocks printing",
        "XSS": "metadata renders as text",
        "print_qr_size_css_px": dimensions,
        "mobile_horizontal_overflow": False,
        "page_errors": errors,
        "test_artifacts": str(artifacts),
    }, indent=2))
    browser.close()
