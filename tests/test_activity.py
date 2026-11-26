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

    def run_activity(self, fixture, action="", mode="", extra=""):
        profile = tempfile.mkdtemp(prefix="bling-activity-test-")
        try:
            dom = subprocess.run(
                [CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                 f"--user-data-dir={profile}", "--virtual-time-budget=30000", "--dump-dom",
                 f"{self.base}/tests/activity_harness.html?fixture={fixture}&action={action}&mode={mode}{extra}"],
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

    NO_CLIPS = "No clips found in Blink's cloud storage or on a Sync Module."

    def test_no_clips_says_so(self):
        # "empty" is Blink's real response for an account without cloud clips.
        for fixture in ("empty", "deleted", "localempty"):
            with self.subTest(fixture=fixture):
                r = self.run_activity(fixture)
                self.assertEqual(r["errors"], [])
                self.assertEqual(r["items"], 0)
                self.assertEqual(r["videoText"], self.NO_CLIPS)
                self.assertGreaterEqual(r["emptyContrast"], 3, f"message hard to see: {r['emptyColor']} on {r['emptyBackground']}")

    def test_unexpected_response_says_so(self):
        r = self.run_activity("nomedia")
        self.assertEqual(r["items"], 0)
        self.assertEqual(r["videoText"], self.NO_CLIPS)
        self.assertEqual(r["toasts"], ["Unexpected response for cloud clips (see the browser console)"])

    def local_requests(self, r):
        prefix = "/api/v1/accounts/1/networks/1/sync_modules/5/local_storage"
        return [q.replace(prefix, "LS") for q in r["requests"] if prefix in q]

    def test_lists_and_plays_local_storage_clips(self):
        r = self.run_activity("local")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["toasts"], [])
        self.assertEqual(r["items"], 2)
        self.assertEqual(r["localTiles"], 2)
        # Newest first; manifest camera names ("Frontdoor") mapped back to real names.
        self.assertTrue(r["clips"][0].startswith("Laundry – "), r["clips"])
        self.assertTrue(r["clips"][1].startswith("Front door – "), r["clips"])
        self.assertTrue(all(c.endswith("(Sync Module local storage)") for c in r["clips"]))
        # Manifest requested, command polled until complete, manifest fetched; then the newest
        # clip (5002) is uploaded on request and downloaded, and plays from a blob URL.
        self.assertEqual(self.local_requests(r), [
            "POST LS/manifest/request", "GET LS/manifest/request/900",
            "POST LS/manifest/77/clip/request/5002", "GET LS/manifest/77/clip/request/5002"])
        self.assertGreaterEqual(r["requests"].count("GET /network/1/command/900"), 2)
        self.assertGreaterEqual(r["requests"].count("GET /network/1/command/901"), 2)
        self.assertEqual(r["videoSrc"], "blob:...")
        # The inactive Sync Module (network 2) is left alone.
        self.assertFalse(any("sync_modules/6" in q for q in r["requests"]))

    def test_download_local_clips(self):
        r = self.run_activity("local", action="download")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["toasts"], [])
        names = sorted(d["name"] for d in r["downloads"])
        self.assertEqual(len(names), 2, r["downloads"])
        self.assertRegex(names[0], r"^Front door \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.mp4$")
        self.assertRegex(names[1], r"^Laundry \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.mp4$")
        self.assertTrue(all(d["href"] == "blob" for d in r["downloads"]))
        # Laundry (5002) was already fetched to play it, so only Front door (5001) is requested now.
        after = [q for q in r["requests"][r["requestsBeforeDownload"]:] if "clip/request" in q]
        self.assertEqual([q.rsplit("/", 1)[1] for q in after], ["5001", "5001"])  # POST then GET
        self.assertTrue(r["selected"].startswith("Laundry – "), r["selected"])  # download clicks didn't switch clips

    def test_cloud_clips_have_no_download_icon(self):
        r = self.run_activity("clips", action="download")
        self.assertEqual(r["downloads"], [])

    def test_login_form_prefills_last_login(self):
        r = self.run_activity("empty", mode="login")
        self.assertEqual(r["errors"], [])
        self.assertTrue(r["loginOpen"])
        self.assertIn("GET auth/last-login", r["requests"])
        self.assertEqual(r["userValue"], "test@example.com")
        self.assertTrue(r["userLabelFloats"], "label overlaps the prefilled name")
        self.assertEqual(r["focused"], "passwordInput")
        self.assertFalse(r["rememberHidden"])
        self.assertEqual(r["rememberLabel"], "Don't ask again on this computer")

    def test_login_form_prefers_this_browsers_last_login(self):
        r = self.run_activity("empty", mode="login", extra="&lastuser=me@example.com")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["userValue"], "me@example.com")
        self.assertTrue(r["userLabelFloats"])

    def test_public_proxy_remembers_in_the_browser(self):
        r = self.run_activity("empty", mode="login", extra="&proxy=public")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["userValue"], "")
        self.assertFalse(r["rememberHidden"])
        self.assertEqual(r["rememberLabel"], "Don't ask again in this browser")
        r = self.run_activity("empty", mode="login", extra="&proxy=public&lastuser=me@example.com")
        self.assertEqual(r["userValue"], "me@example.com")
        self.assertFalse(r["rememberHidden"])

    def test_busy_sync_module_is_retried(self):
        r = self.run_activity("localbusy")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["items"], 2)
        self.assertEqual(self.local_requests(r)[:3], [
            "POST LS/manifest/request", "GET LS/manifest/request/900", "GET LS/manifest/request/900"])

    def test_failed_sync_module_command_shows_toast(self):
        r = self.run_activity("localfail")
        self.assertEqual(r["items"], 0)
        self.assertEqual(r["toasts"], ["Sync Module command failed (999)"])
        self.assertEqual(r["videoText"], self.NO_CLIPS)

    def test_cloud_and_local_clips_are_merged_newest_first(self):
        r = self.run_activity("mixed")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["items"], 4)
        names = [c.split(" – ")[0] + (" (local)" if c.endswith("storage)") else "") for c in r["clips"]]
        # cloud 5 min, local 10 min, local 30 min, cloud 120 min
        self.assertEqual(names, ["Front door", "Laundry (local)", "Front door (local)", "Laundry"])
        self.assertEqual(r["videoSrc"], "data:...")  # newest (a cloud clip) selected

    def test_server_error_shows_toast(self):
        r = self.run_activity("error500")
        self.assertEqual(r["items"], 0)
        self.assertEqual(len(r["toasts"]), 1, r)
        self.assertTrue(r["toasts"][0].startswith("Activity request failed (500"), r["toasts"])


if __name__ == "__main__":
    unittest.main()
