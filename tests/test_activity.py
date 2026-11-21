"""Activity pane tests: the real viewer in headless Chrome against a fake Blink backend.

tests/activity_harness.html loads index.html with tests/fake_blink.js injected, which
answers the app's API calls from canned responses, opens Activity and reports what was
drawn. No network or Blink account needed; requires Google Chrome or Chromium.

    python3 -m unittest discover tests
"""
import html
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = next((shutil.which(c) for c in ("google-chrome", "chromium", "chromium-browser")
               if shutil.which(c)), None)

spec = importlib.util.spec_from_file_location("bling_proxy", os.path.join(ROOT, "bling-proxy.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)


@unittest.skipUnless(CHROME, "needs Google Chrome or Chromium")
class ActivityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bp.Handler.log_message = lambda *a: None
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(bp.Handler, directory=ROOT))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def run_activity(self, fixture):
        profile = tempfile.mkdtemp(prefix="bling-activity-test-")
        try:
            dom = subprocess.run(
                [CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                 f"--user-data-dir={profile}", "--virtual-time-budget=10000", "--dump-dom",
                 f"{self.base}/tests/activity_harness.html?fixture={fixture}"],
                capture_output=True, text=True, timeout=90).stdout
        finally:
            shutil.rmtree(profile, ignore_errors=True)
        m = re.search(r'<pre id="test-result">(.*?)</pre>', dom, re.S)
        self.assertIsNotNone(m, "harness produced no result")
        return json.loads(html.unescape(m.group(1)))

    def test_lists_clips(self):
        r = self.run_activity("clips")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["toasts"], [])
        self.assertEqual(r["items"], 3)
        self.assertIn("5 minutes ago", r["tableText"])
        self.assertIn("GET /api/v1/accounts/1/media/changed?since=1970-01-01T00:00:00+0000&page=1",
                      r["requests"])
        for clip in (101, 102, 103):
            self.assertIn(f"GET /api/v2/accounts/1/media/thumb/{clip}_s.jpg", r["requests"])
        # The newest clip is selected and its video fetched.
        self.assertIn("GET /api/v2/accounts/1/media/clip/101.mp4", r["requests"])

    def test_no_clips_says_so(self):
        # "empty" is Blink's real response for an account without cloud clips.
        for fixture in ("empty", "deleted"):
            with self.subTest(fixture=fixture):
                r = self.run_activity(fixture)
                self.assertEqual(r["errors"], [])
                self.assertEqual(r["items"], 0)
                self.assertEqual(r["videoText"], "No clips in Blink's cloud storage for this account.")
                self.assertGreaterEqual(r["emptyContrast"], 3, f"message hard to see: {r['emptyColor']} on {r['emptyBackground']}")

    def test_unexpected_response_says_so(self):
        r = self.run_activity("nomedia")
        self.assertEqual(r["items"], 0)
        self.assertIn("unexpected response", r["videoText"])

    def test_server_error_shows_toast(self):
        r = self.run_activity("error500")
        self.assertEqual(r["items"], 0)
        self.assertEqual(len(r["toasts"]), 1, r)
        self.assertTrue(r["toasts"][0].startswith("Activity request failed (500"), r["toasts"])


if __name__ == "__main__":
    unittest.main()
