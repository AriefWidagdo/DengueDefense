"""Local browser checks for the game and leaderboard. No cloud writes.

Run from MainGame with: python -m unittest discover -s tests -v
Requires Playwright's Chromium and Node.js 22.5 or newer.
"""

import json
import socket
import subprocess
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
GAME_HTML = (ROOT / "index.html").read_bytes()


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
            cls.playwright = sync_playwright().start()
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except Exception:
            cls.server.terminate()
            cls.server.wait(timeout=10)
            raise

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.server.stdout.close()

    def test_game_and_deploy_copy_match(self):
        self.assertEqual(GAME_HTML, (ROOT / "site" / "index.html").read_bytes())

    def test_phone_game_submits_and_displays_local_score(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        page = context.new_page()
        errors = []
        external = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def local_only(route):
            if route.request.url.startswith(self.base + "/"):
                route.continue_()
            else:
                external.append(route.request.url)
                route.abort()

        page.route("**/*", local_only)
        try:
            page.goto(self.base, wait_until="domcontentloaded")
            page.locator("#titleScreen .btn.amber").click()
            page.locator("#mutGrid .mut").nth(0).click()
            page.locator("#mutGrid .mut").nth(1).click()
            page.locator("#mutGoBtn").click()
            page.wait_for_selector("#dispatchScreen:not(.hidden)")
            page.locator("#dispatchScreen .opt.a").click()
            page.wait_for_function("G.phase === 'plan'")
            self.assertTrue(page.locator("#dForecast").inner_text().strip())
            page.locator("#goBtn").click()
            page.wait_for_function("G.phase === 'wave' && W && W.total > 0")
            page.wait_for_function("G.phase === 'report' || G.phase === 'end'", timeout=40000)

            # Skip the remaining months; exercise the real end screen and submit button.
            page.evaluate("G.score = 12345; gameOver('hospital')")
            page.locator("#lbNameInput").fill("Local Tester")
            page.locator("#endSheet button[onclick*=submitAndOpen]").click()
            page.wait_for_selector("#leaderboardScreen:not(.hidden)")
            page.get_by_text("Local Tester", exact=True).wait_for()
            self.assertIn("12,345", page.locator("#lbRows").inner_text())
            rows = page.evaluate("async () => (await (await fetch('/api/top')).json()).rows")
            self.assertTrue(any(row["name"] == "Local Tester" and row["score"] == 12345 for row in rows))
            page.reload(wait_until="domcontentloaded")
            page.locator('#titleScreen button[onclick="openLeaderboard()"]').click()
            page.get_by_text("Local Tester", exact=True).wait_for()
            self.assertEqual(errors, [])
            self.assertEqual(external, [])
        finally:
            context.close()

    def test_bad_score_is_rejected_by_local_worker(self):
        payload = json.dumps({"name": "Local Invalid", "score": 0}).encode()
        request = urllib.request.Request(
            self.base + "/api/submit", data=payload, headers={"Content-Type": "application/json"}
        )
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request)
        self.assertEqual(error.exception.code, 400)
        with urllib.request.urlopen(self.base + "/api/top") as response:
            rows = json.load(response)["rows"]
        self.assertFalse(any(row["name"] == "Local Invalid" for row in rows))

    def test_offline_message_does_not_promise_score_sync(self):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        page = context.new_page()
        page.route("**/api/top", lambda route: route.fulfill(status=503, body="Unavailable"))
        try:
            page.goto(self.base, wait_until="domcontentloaded")
            page.locator('#titleScreen button[onclick="openLeaderboard()"]').click()
            page.get_by_text("Leaderboard unavailable. Check your connection and try again.").wait_for()
            self.assertNotIn("sync later", page.locator("#lbRows").inner_text())
        finally:
            context.close()

    def check_hosted_routes(self, override, expected_base):
        context = self.browser.new_context(viewport={"width": 390, "height": 844})
        if override:
            context.add_init_script(f"window.LB_API = {json.dumps(override)};")
        page = context.new_page()
        requests = []
        unexpected = []
        origin = "https://game-test.workers.dev/index.html"
        cors = {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "Content-Type",
        }

        def intercept(route):
            url, method = route.request.url, route.request.method
            if url == origin:
                route.fulfill(status=200, body=GAME_HTML, content_type="text/html")
            elif url in (expected_base + "/top", expected_base + "/submit"):
                if method == "OPTIONS":
                    route.fulfill(status=204, headers=cors)
                    return
                requests.append((method, url))
                result = {"ok": True, "rank": 1} if method == "POST" else {"rows": []}
                route.fulfill(status=200, body=json.dumps(result), content_type="application/json", headers=cors)
            else:
                unexpected.append(url)
                route.abort()

        page.route("**/*", intercept)
        try:
            page.goto(origin, wait_until="domcontentloaded")
            page.evaluate("""async () => {
                G = freshState('local-check', []);
                G.score = 123;
                await submitScore('Test');
                await fetchTop();
            }""")
            self.assertEqual(requests, [
                ("POST", expected_base + "/submit"),
                ("GET", expected_base + "/top"),
            ])
            self.assertEqual(unexpected, [])
        finally:
            context.close()

    def test_hosted_game_uses_leaderboard_worker_api_path(self):
        self.check_hosted_routes(None, "https://dengue-leaderboard.widagdo1994.workers.dev/api")

    def test_explicit_api_override_is_respected(self):
        self.check_hosted_routes("https://scores.invalid/api/", "https://scores.invalid/api")


if __name__ == "__main__":
    unittest.main(verbosity=2)
