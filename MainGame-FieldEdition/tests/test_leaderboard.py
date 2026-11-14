"""Local browser checks for the game and leaderboard. No cloud writes.

Run from MainGame with: python -m unittest discover -s tests -v
Requires Playwright's Chromium and Node.js 22.5 or newer.

If Playwright (or its Chromium browser) is unavailable, the E2E tests are
skipped with an explicit reason; the static-site, worker API and source
mapping checks still run.
"""

import json
import re
import socket
import subprocess
import time
import unittest
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
    PLAYWRIGHT_IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - environment dependent
    sync_playwright = None
    PLAYWRIGHT_AVAILABLE = False
    PLAYWRIGHT_IMPORT_ERROR = exc

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

EMOJI_RE = re.compile(r'[\U0001F300-\U0001FAFF\u2600-\u27BF]')
DISCLAIMER_STRINGS = (
    "not calibrated parameters",
    "Attribution check:",
    "not guarantees",
)
GAMEPLAY_REGION_IDS = (
    "hud",
    "panel",
    "reportScreen",
    "dispatchScreen",
    "perkScreen",
    "endScreen",
)
LEADERBOARD_OFFLINE_TEXT = "Leaderboard offline"


def site_js_files():
    return sorted((SITE / "js").rglob("*.js"))


def site_css_files():
    return sorted((SITE / "css").glob("*.css"))


def all_site_text_files():
    files = [SITE / "index.html"] + site_css_files() + site_js_files()
    return [f for f in files if f.is_file()]


class AssetCollector(HTMLParser):
    """Collect local src/href references from HTML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.refs = []

    def handle_starttag(self, tag, attrs):
        attr = dict(attrs)
        if tag == "link" and attr.get("href"):
            self.refs.append((tag, attr["href"]))
        elif tag == "script" and attr.get("src"):
            self.refs.append((tag, attr["src"]))
        elif tag == "img" and attr.get("src"):
            self.refs.append((tag, attr["src"]))


def is_local_ref(ref):
    ref = ref.strip()
    if not ref or ref.startswith(("data:", "http://", "https://", "//", "#", "mailto:")):
        return False
    return True


def normalize_site_path(ref, base_dir_rel=""):
    """Map a local URL reference to a path relative to SITE (posix style)."""
    ref = ref.strip().split("#", 1)[0].split("?", 1)[0]
    if ref.startswith("/"):
        candidate = Path(ref.lstrip("/"))
    else:
        candidate = Path(base_dir_rel) / ref if base_dir_rel else Path(ref)
    parts = []
    for part in candidate.parts:
        if part in (".", ""):
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return Path(*parts) if parts else Path("index.html")


def collect_assets():
    """Every local asset the site can load, as paths relative to SITE."""
    assets = set()
    index_html = (SITE / "index.html").read_text(encoding="utf-8")
    parser = AssetCollector()
    parser.feed(index_html)
    for _tag, ref in parser.refs:
        if is_local_ref(ref):
            assets.add(normalize_site_path(ref))
    import_re = re.compile(
        r"""(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]"""
        r"""|import\s*\(\s*['"]([^'"]+)['"]\s*\)"""
        r"""|import\s*['"]([^'"]+)['"]"""
    )
    for js_file in site_js_files():
        source = js_file.read_text(encoding="utf-8", errors="replace")
        base_dir_rel = js_file.relative_to(SITE).parent.as_posix()
        for match in import_re.finditer(source):
            ref = next(group for group in match.groups() if group)
            if is_local_ref(ref):
                assets.add(normalize_site_path(ref, base_dir_rel))
    return sorted(assets)


def http_json(url, payload=None, method=None, timeout=10):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                parsed = None
            return response.status, parsed, body
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace") if error.fp else ""
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = None
        return error.code, parsed, body


class LeaderboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.server = subprocess.Popen(
            ["node", str(ROOT / "dev-server.mjs"), str(cls.port)],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            for _ in range(80):
                if cls.server.poll() is not None:
                    raise RuntimeError(f"Local server stopped: {cls.server.stdout.read()}")
                try:
                    with urllib.request.urlopen(cls.base, timeout=1) as response:
                        if response.status == 200:
                            break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.1)
            else:
                raise RuntimeError("Local server did not start")
        except Exception:
            cls.server.terminate()
            cls.server.wait(timeout=10)
            raise
        cls.browser = None
        cls.browser_error = None
        cls.playwright = None
        if PLAYWRIGHT_AVAILABLE:
            try:
                cls.playwright = sync_playwright().start()
                cls.browser = cls.playwright.chromium.launch(headless=True)
            except Exception as exc:
                cls.browser_error = exc
                if cls.playwright is not None:
                    try:
                        cls.playwright.stop()
                    except Exception:
                        pass
                    cls.playwright = None
        else:
            cls.browser_error = PLAYWRIGHT_IMPORT_ERROR

    @classmethod
    def tearDownClass(cls):
        if cls.browser is not None:
            cls.browser.close()
        if cls.playwright is not None:
            cls.playwright.stop()
        cls.server.terminate()
        cls.server.wait(timeout=10)
        if cls.server.stdout:
            cls.server.stdout.close()

    def require_browser(self):
        if self.browser is None:
            reason = self.browser_error or "Playwright is not installed"
            self.skipTest(f"E2E skipped: Playwright/Chromium unavailable ({reason})")
        return self.browser

    def new_context(self, **kwargs):
        browser = self.require_browser()
        return browser.new_context(**kwargs)

    def watch_page(self, page, errors, console_errors, external):
        page.on("pageerror", lambda error: errors.append(str(error)))

        def on_console(message):
            try:
                if message.type == "error":
                    console_errors.append(message.text)
            except Exception:
                pass

        page.on("console", on_console)

        def local_only(route):
            url = route.request.url
            if url.startswith(self.base + "/") or url.startswith("data:") or url.startswith("blob:"):
                route.continue_()
            else:
                external.append(url)
                route.abort()

        page.route("**/*", local_only)

    @staticmethod
    def favicon_benign(text):
        lowered = str(text).lower()
        # favicon 404s and Chrome's "navigator.vibrate blocked" policy message
        # are benign and not app errors.
        return "favicon" in lowered or "navigator.vibrate" in lowered

    def wait_for_hub(self, page):
        page.goto(self.base, wait_until="domcontentloaded")
        page.wait_for_selector("#ddHubStart", state="visible", timeout=20000)

    def start_mode_from_hub(self, page, mode, doctrine="surveillance_directorate", seed=None):
        self.wait_for_hub(page)
        if seed:
            # Pin the campaign seed so week-1 events (and thus the AP economy)
            # are deterministic. FIELD-1 yields a week-1 event with no AP delta.
            page.locator("#ddHubSeedInput").fill(seed)
        page.locator(f'.ddm-mode[data-mode="{mode}"]').click()
        if doctrine:
            page.locator(f'.ddm-doctrine[data-doctrine="{doctrine}"]').click()
        page.locator("#ddHubStart").click()

    def enter_operations_wave(self, page):
        self.start_mode_from_hub(page, "operations", "surveillance_directorate")
        page.wait_for_function("window.G && window.G.phase === 'briefing'", timeout=20000)
        page.wait_for_selector("#dispatchScreen .ddm-opt", state="visible", timeout=10000)
        page.locator("#dispatchScreen .ddm-opt").first.click()
        page.wait_for_function("window.G && window.G.phase === 'plan'", timeout=10000)
        page.wait_for_selector('.ddh-commit[data-commit-mode="operations"]', state="visible", timeout=10000)
        page.locator('.ddh-commit[data-commit-mode="operations"]').click()
        page.wait_for_function("window.G && window.G.phase === 'wave'", timeout=10000)

    # ------------------------------------------------------------------
    # 1. Static bundle integrity (no browser required for asset checks)
    # ------------------------------------------------------------------
    def test_site_index_loads_core_css_and_module_script(self):
        index = SITE / "index.html"
        self.assertTrue(index.is_file(), "site/index.html is missing")
        html = index.read_text(encoding="utf-8")
        for ref in ("./css/tokens.css", "./css/layout.css", "./css/components.css"):
            self.assertIn(ref, html, f"site/index.html does not reference {ref}")
        self.assertRegex(
            html,
            r'<script\s+type="module"\s+src="\./js/main\.js"\s*>',
            "site/index.html does not load ./js/main.js as a module",
        )

    def test_every_local_asset_resolves_on_disk_and_over_http(self):
        assets = collect_assets()
        self.assertTrue(assets, "no local assets discovered in site/")
        for rel in assets:
            target = SITE / rel
            self.assertTrue(target.is_file(), f"local asset missing on disk: {rel}")
        for rel in assets:
            url = f"{self.base}/{rel.as_posix()}"
            try:
                with urllib.request.urlopen(url, timeout=5) as response:
                    status = response.status
                    content_type = response.headers.get("content-type", "")
                    response.read()
            except urllib.error.URLError as exc:
                self.fail(f"dev-server failed for {rel}: {exc}")
            suffix = rel.suffix.lower()
            self.assertEqual(status, 200, f"{rel}: expected 200, got {status}")
            if suffix in (".js", ".mjs"):
                self.assertTrue(
                    content_type.startswith("application/javascript"),
                    f"{rel}: expected application/javascript, got {content_type!r}",
                )
            elif suffix == ".css":
                self.assertTrue(
                    content_type.startswith("text/css"),
                    f"{rel}: expected text/css, got {content_type!r}",
                )
            elif suffix == ".html":
                self.assertTrue(
                    content_type.startswith("text/html"),
                    f"{rel}: expected text/html, got {content_type!r}",
                )

    def test_zero_emojis_across_site_bundle(self):
        offenders = []
        for path in all_site_text_files():
            text = path.read_text(encoding="utf-8", errors="replace")
            for lineno, line in enumerate(text.splitlines(), start=1):
                match = EMOJI_RE.search(line)
                if match:
                    offenders.append(f"{path.relative_to(ROOT)}:{lineno}: U+{ord(match.group(0)):04X}")
        self.assertEqual(offenders, [], "emoji characters found in site bundle")

    def test_leaderboard_api_host_mapping_source(self):
        source = (SITE / "js" / "leaderboard.js").read_text(encoding="utf-8")

        # Rule 1: production custom domain -> custom API origin.
        self.assertRegex(source, r"const PROD_API = 'https://dengue-api\.datajoget\.my\.id'")
        self.assertRegex(
            source,
            r"host === 'dengue\.datajoget\.my\.id'\)\s*return PROD_API",
        )
        # Rule 2: any workers.dev subdomain -> production API origin.
        self.assertRegex(source, r"endsWith\('\.workers\.dev'\)\)\s*return PROD_API")
        # Rule 3: localhost / 127.0.0.1 -> same-origin ("") so dev-server /api/* is used.
        self.assertRegex(source, r"LOCAL_HOSTNAMES = new Set\(\['localhost', '127\.0\.0\.1'\]\)")
        self.assertRegex(source, r"LOCAL_HOSTNAMES\.has\(host\)\)\s*return ''")

        # Simulate the resolution rules in pure Python as a logic cross-check.
        def resolve_lb_api(host):
            if host in {"localhost", "127.0.0.1"}:
                return ""
            if host == "dengue.datajoget.my.id":
                return "https://dengue-api.datajoget.my.id"
            if host.endswith(".workers.dev"):
                return "https://dengue-api.datajoget.my.id"
            return ""

        self.assertEqual(resolve_lb_api("dengue.datajoget.my.id"), "https://dengue-api.datajoget.my.id")
        self.assertEqual(resolve_lb_api("dengue-leaderboard.widagdo1994.workers.dev"), "https://dengue-api.datajoget.my.id")
        self.assertEqual(resolve_lb_api("localhost"), "")
        self.assertEqual(resolve_lb_api("127.0.0.1"), "")

    # ------------------------------------------------------------------
    # 5a. Bundle + zero emoji + zero console errors (E2E)
    # ------------------------------------------------------------------
    def test_static_site_bundle_and_zero_emoji(self):
        # Asset + emoji assertions reused from the integrity tests above.
        self.test_site_index_loads_core_css_and_module_script()
        self.test_every_local_asset_resolves_on_disk_and_over_http()
        self.test_zero_emojis_across_site_bundle()

        context = self.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        errors, console_errors, external = [], [], []
        self.watch_page(page, errors, console_errors, external)
        try:
            page.goto(self.base, wait_until="domcontentloaded")
            page.wait_for_selector("#ddHubStart", state="visible", timeout=20000)
            # Switch modes in-page; each must boot without errors.
            for mode in ("operations", "crisis_board", "blitz"):
                page.evaluate(
                    "(mode) => { if (window.DD && typeof window.DD.startMode === 'function') window.DD.startMode(mode, {}); }",
                    mode,
                )
                page.wait_for_function(
                    "(mode) => window.G && window.G.mode === mode",
                    arg=mode,
                    timeout=10000,
                )
                page.wait_for_timeout(250)
            page.evaluate("window.DD && window.DD.exitToHub && window.DD.exitToHub()")
            page.wait_for_timeout(250)
            # Fresh load per mode via quick-boot param, then back to hub.
            for mode in ("operations", "crisis_board", "blitz"):
                page.goto(f"{self.base}/?mode={mode}", wait_until="domcontentloaded")
                page.wait_for_function(
                    "(mode) => window.G && window.G.mode === mode",
                    arg=mode,
                    timeout=10000,
                )
                page.wait_for_timeout(250)
        finally:
            context.close()
        benign = self.favicon_benign
        real_errors = [e for e in errors if not benign(e)]
        real_console = [e for e in console_errors if not benign(e)]
        self.assertEqual(real_errors, [], "pageerror events on load / mode switches")
        self.assertEqual(real_console, [], "console.error events on load / mode switches")
        self.assertEqual(external, [], "network requests attempted outside the local server")

    def test_no_gameplay_disclaimers_in_hud_panel_or_phase_screens(self):
        context = self.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        try:
            self.wait_for_hub(page)
            regions = page.evaluate(
                """(ids) => {
                    const out = {};
                    for (const id of ids) {
                        const el = document.getElementById(id);
                        out[id] = el ? (el.textContent || '') : null;
                    }
                    return out;
                }""",
                list(GAMEPLAY_REGION_IDS),
            )
        finally:
            context.close()
        for region_id, content in (regions or {}).items():
            self.assertIsNotNone(content, f"#{region_id} not present in DOM")
            lowered = content.lower()
            for disclaimer in DISCLAIMER_STRINGS:
                self.assertNotIn(
                    disclaimer.lower(),
                    lowered,
                    f"disclaimer string {disclaimer!r} leaked into #{region_id}",
                )

    # ------------------------------------------------------------------
    # 5b. Mode 1 (operations) full flow + leaderboard submission
    # ------------------------------------------------------------------
    def test_mode1_operations_phone_flow_and_leaderboard(self):
        context = self.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        errors, console_errors, external = [], [], []
        self.watch_page(page, errors, console_errors, external)
        try:
            self.start_mode_from_hub(page, "operations", "surveillance_directorate")
            page.wait_for_function(
                "window.G && window.G.phase === 'briefing' && window.G.mode === 'operations'",
                timeout=20000,
            )
            scenario = page.evaluate("window.G && window.G.scenario")
            self.assertEqual(scenario, "solo_basin")

            page.wait_for_selector("#dispatchScreen .ddm-opt", state="visible", timeout=10000)
            page.locator("#dispatchScreen .ddm-opt").first.click()
            page.wait_for_function("window.G && window.G.phase === 'plan'", timeout=10000)

            page.wait_for_selector('.ddh-commit[data-commit-mode="operations"]', state="visible", timeout=10000)
            page.locator('.ddh-commit[data-commit-mode="operations"]').click()
            page.wait_for_function(
                "window.G && window.G.phase === 'wave' && window.W && typeof window.W.total === 'number'",
                timeout=10000,
            )
            wave_total = page.evaluate("window.W.total")
            self.assertIsInstance(wave_total, (int, float))

            page.wait_for_function("window.__ddHudLangBound === true", timeout=20000)
            page.evaluate("window.G.score = 12345; window.gameOver('hospital')")
            page.wait_for_selector("#endScreen", state="visible", timeout=15000)

            # Submit via the leaderboard screen (canonical #lbNameInput path).
            # openLeaderboard() dismisses #endScreen, so the board is reachable directly.
            page.locator("#ddViewLeaderboard").click()
            page.wait_for_selector("#lbNameInput", state="visible", timeout=10000)
            page.locator("#lbNameInput").fill("Local Tester")
            with page.expect_response(
                lambda response: "/api/submit" in response.url
                and response.request.method == "POST",
                timeout=10000,
            ) as response_info:
                page.locator("#lbSubmitBtn").click()
            response = response_info.value
            self.assertIn(response.status, (200, 201))
            self.assertTrue(response.json().get("ok"))
            page.wait_for_function(
                "(document.getElementById('lbStatusMsg') || {}).textContent?.includes('Submitted')",
                timeout=10000,
            )
        finally:
            context.close()

        status, payload, _body = http_json(f"{self.base}/api/top?mode=operations&limit=50")
        self.assertEqual(status, 200)
        rows = (payload or {}).get("rows") or []
        self.assertTrue(
            any(row.get("name") == "Local Tester" and row.get("score") == 12345 for row in rows),
            f"operations top does not contain the submitted row: {rows}",
        )
        self.assertTrue(all(row.get("mode") == "operations" for row in rows))
        benign = self.favicon_benign
        self.assertEqual([e for e in errors if not benign(e)], [])
        self.assertEqual([e for e in console_errors if not benign(e)], [])

    # ------------------------------------------------------------------
    # 5c. Mode 2 (crisis_board) flow + API isolation
    # ------------------------------------------------------------------
    def test_mode2_crisis_board_flow_and_api(self):
        context = self.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        errors, console_errors, external = [], [], []
        self.watch_page(page, errors, console_errors, external)
        try:
            self.start_mode_from_hub(page, "crisis_board", "rapid_response_corps", seed="FIELD-1")
            page.wait_for_function(
                "window.G && window.G.mode === 'crisis_board'",
                timeout=20000,
            )
            # 3 AP economy visible in the command rail.
            page.wait_for_selector('.ddh-action[data-action="larvicide"]', state="visible", timeout=15000)
            panel_text = page.inner_text("#panel")
            self.assertRegex(panel_text, r"AP:\s*3\s*/\s*\d+")

            # Begin allocation, then toggle the Larvicide action (hotkey 2).
            page.keyboard.press("Enter")
            page.wait_for_selector(
                '.ddh-commit[data-commit-mode="crisis_board"]',
                state="visible",
                timeout=10000,
            )
            page.keyboard.press("2")
            page.wait_for_selector(
                '.ddh-action[data-action="larvicide"][aria-pressed="true"]',
                state="visible",
                timeout=10000,
            )
        finally:
            context.close()

        # Mode isolation: seed both boards, verify no cross-contamination.
        ops_name = "OPS-ISOLATION-TEST"
        cb_name = "CB-ISOLATION-TEST"
        blitz_name = "BLITZ-ISOLATION-PROBE"
        for name, mode, score in (
            (ops_name, "operations", 4321),
            (cb_name, "crisis_board", 4321),
            (blitz_name, "blitz", 4321),
        ):
            status, payload, _ = http_json(
                f"{self.base}/api/submit",
                payload={"name": name, "score": score, "mode": mode},
                method="POST",
            )
            self.assertIn(status, (200, 201), f"seed submit failed for {mode}: {payload}")
            self.assertTrue((payload or {}).get("ok"))

        status, cb_top, _ = http_json(f"{self.base}/api/top?mode=crisis_board&limit=50")
        self.assertEqual(status, 200)
        cb_rows = (cb_top or {}).get("rows") or []
        cb_names = [row.get("name") for row in cb_rows]
        self.assertIn(cb_name, cb_names)
        self.assertNotIn(ops_name, cb_names)
        self.assertNotIn(blitz_name, cb_names)
        self.assertTrue(all(row.get("mode") == "crisis_board" for row in cb_rows))

        status, ops_top, _ = http_json(f"{self.base}/api/top?mode=operations&limit=50")
        self.assertEqual(status, 200)
        ops_names = [row.get("name") for row in (ops_top or {}).get("rows") or []]
        self.assertIn(ops_name, ops_names)
        self.assertNotIn(cb_name, ops_names)

        benign = self.favicon_benign
        self.assertEqual([e for e in errors if not benign(e)], [])
        self.assertEqual([e for e in console_errors if not benign(e)], [])
        self.assertEqual(external, [])

    # ------------------------------------------------------------------
    # 5d. Mode 3 (blitz) flow + API isolation
    # ------------------------------------------------------------------
    def test_mode3_blitz_flow_and_api(self):
        context = self.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        errors, console_errors, external = [], [], []
        self.watch_page(page, errors, console_errors, external)
        blitz_score_name = "BLITZ-SCORE-TEST"
        try:
            self.start_mode_from_hub(page, "blitz", "rapid_response_corps")
            page.wait_for_function(
                "window.G && window.G.mode === 'blitz' && typeof window.G.timeLeft === 'number'",
                timeout=20000,
            )
            first = page.evaluate("window.G.timeLeft")
            page.wait_for_timeout(1500)
            second = page.evaluate("window.G.timeLeft")
            self.assertLess(second, first, "blitz countdown is not decreasing")
            self.assertLessEqual(first, 150.0)

            # #panel must be hidden in blitz (computed style).
            panel_display = page.evaluate(
                "getComputedStyle(document.getElementById('panel')).display"
            )
            self.assertEqual(panel_display, "none")

            # Submit a blitz score through the real end-screen flow.
            page.wait_for_function("window.__ddHudLangBound === true", timeout=20000)
            page.evaluate("window.G.score = 5555; window.gameOver('hospital')")
            page.wait_for_selector("#endScreen", state="visible", timeout=15000)
            page.locator("#ddViewLeaderboard").click()
            page.evaluate(
                "const e = document.getElementById('endScreen');"
                "if (e) { e.classList.add('hidden'); e.setAttribute('hidden', ''); e.hidden = true; }"
            )
            page.wait_for_selector("#lbNameInput", state="visible", timeout=10000)
            page.locator("#lbNameInput").fill(blitz_score_name)
            with page.expect_response(
                lambda response: "/api/submit" in response.url
                and response.request.method == "POST",
                timeout=10000,
            ) as response_info:
                page.locator("#lbSubmitBtn").click()
            response = response_info.value
            self.assertIn(response.status, (200, 201))
            self.assertTrue(response.json().get("ok"))
        finally:
            context.close()

        status, blitz_top, _ = http_json(f"{self.base}/api/top?mode=blitz&limit=50")
        self.assertEqual(status, 200)
        blitz_rows = (blitz_top or {}).get("rows") or []
        blitz_names = [row.get("name") for row in blitz_rows]
        self.assertIn(blitz_score_name, blitz_names)
        self.assertTrue(all(row.get("mode") == "blitz" for row in blitz_rows))

        for mode in ("operations", "crisis_board"):
            status, top, _ = http_json(f"{self.base}/api/top?mode={mode}")
            self.assertEqual(status, 200)
            names = [row.get("name") for row in (top or {}).get("rows") or []]
            self.assertNotIn(
                blitz_score_name,
                names,
                f"blitz submission leaked into {mode} leaderboard",
            )

        benign = self.favicon_benign
        self.assertEqual([e for e in errors if not benign(e)], [])
        self.assertEqual([e for e in console_errors if not benign(e)], [])
        self.assertEqual(external, [])

    # ------------------------------------------------------------------
    # 5e. Worker validation + offline handling
    # ------------------------------------------------------------------
    def test_worker_validation_and_offline_handling(self):
        submit_url = f"{self.base}/api/submit"

        # Invalid scores are rejected with 400.
        for bad_score in (0, -5, 99999999):
            status, payload, _ = http_json(
                submit_url,
                payload={"name": "INVALID-SHOULD-NOT-APPEAR", "score": bad_score},
                method="POST",
            )
            self.assertEqual(status, 400, f"score {bad_score} should be rejected, got {status}")

        # Invalid mode is rejected with 400 on both endpoints.
        status, _payload, _ = http_json(
            submit_url,
            payload={"name": "BAD-MODE", "score": 100, "mode": "bogus"},
            method="POST",
        )
        self.assertEqual(status, 400)
        status, _payload, _ = http_json(f"{self.base}/api/top?mode=bogus")
        self.assertEqual(status, 400)

        # Omitted mode defaults to operations.
        status, payload, _ = http_json(
            submit_url,
            payload={"name": "DEFAULT-MODE-TEST", "score": 1234},
            method="POST",
        )
        self.assertIn(status, (200, 201))
        self.assertTrue((payload or {}).get("ok"))
        self.assertEqual((payload or {}).get("mode"), "operations")

        status, payload, _ = http_json(f"{self.base}/api/top")
        self.assertEqual(status, 200)
        self.assertEqual((payload or {}).get("mode"), "operations")

        # The rejected rows must not appear on the board (default limit 20).
        status, payload, _ = http_json(f"{self.base}/api/top?mode=operations")
        self.assertEqual(status, 200)
        names = [row.get("name") for row in (payload or {}).get("rows") or []]
        self.assertNotIn("INVALID-SHOULD-NOT-APPEAR", names)
        self.assertIn("DEFAULT-MODE-TEST", names)

        # Offline banner: abort /api/top and confirm the fallback copy renders.
        context = self.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        page.route(re.compile(r".*/api/top.*"), lambda route: route.abort())
        try:
            page.goto(f"{self.base}/?mode=blitz", wait_until="domcontentloaded")
            page.wait_for_function("window.G && window.G.mode === 'blitz'", timeout=20000)
            page.wait_for_function("window.__ddHudLangBound === true", timeout=20000)
            page.evaluate("window.G.score = 100; window.gameOver('hospital')")
            page.wait_for_selector("#endScreen", state="visible", timeout=15000)
            page.locator("#ddViewLeaderboard").click()
            page.evaluate(
                "const e = document.getElementById('endScreen');"
                "if (e) { e.classList.add('hidden'); e.setAttribute('hidden', ''); e.hidden = true; }"
            )
            page.wait_for_selector("#lbRows", state="visible", timeout=10000)
            page.wait_for_selector(f"text={LEADERBOARD_OFFLINE_TEXT}", timeout=10000)
        finally:
            context.close()

    # ------------------------------------------------------------------
    # 5f. EpiKD drawer isolation
    # ------------------------------------------------------------------
    def test_epikd_drawer_isolation(self):
        context = self.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        errors, console_errors, external = [], [], []
        self.watch_page(page, errors, console_errors, external)
        try:
            # Drawer must not be open on load or when a wave starts.
            self.enter_operations_wave(page)
            self.assertEqual(page.locator(".epikd-drawer.open").count(), 0)
            self.assertEqual(page.locator("#epikdLabDrawer:visible").count(), 0)

            # Open via its HUD button (hud.js renders .ddh-epikd).
            page.wait_for_selector(".ddh-epikd", state="visible", timeout=10000)
            page.locator(".ddh-epikd").click()
            page.wait_for_selector(".epikd-drawer.open", state="visible", timeout=10000)
            page.wait_for_selector("text=model_kda_17.pt", state="visible", timeout=10000)

            # HUD must not carry waterfall/audit strings while drawer is open.
            hud_text = page.inner_text("#hud")
            panel_text = page.inner_text("#panel")
            for region, text in (("#hud", hud_text), ("#panel", panel_text)):
                self.assertIsNone(
                    re.search(r"(?i)(waterfall|attribution ledger|nb2|model_kda)", text),
                    f"waterfall/model strings leaked into {region}",
                )

            # Close via the drawer close control.
            page.locator(".epikd-drawer.open [data-epikd-close]").click()
            page.wait_for_function(
                "document.querySelectorAll('.epikd-drawer.open').length === 0",
                timeout=10000,
            )
        finally:
            context.close()

        benign = self.favicon_benign
        self.assertEqual([e for e in errors if not benign(e)], [])
        self.assertEqual([e for e in console_errors if not benign(e)], [])
        self.assertEqual(external, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
