"""Relay and serving tests for bling-proxy.py, against a fake upstream that echoes requests.

Covers what matters when the viewer runs behind a reverse proxy under a path (e.g.
/blink/ behind Apache with basic auth): the basic auth and X-Forwarded-* headers never
reach Blink, Blink's token travels as X-Blink-Authorization, a merged "https:/" still
relays, and redirects carry X-Forwarded-Prefix. Also /version. No network needed.

    python3 -m unittest discover tests
"""
import importlib.util
import json
import os
import re
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

spec = importlib.util.spec_from_file_location("bling_proxy", os.path.join(ROOT, "bling-proxy.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


NO_REDIRECT = urllib.request.build_opener(_NoRedirect)


class EchoHandler(BaseHTTPRequestHandler):
    """Answers with the request's path and headers; /redirect redirects."""

    def do_GET(self):
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "https://rest-u011.immedia-semi.com/elsewhere")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = json.dumps({"path": self.path, "headers": dict(self.headers.items())}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), EchoHandler)
        self.upstream_url = f"http://127.0.0.1:{self.upstream.server_address[1]}"
        threading.Thread(target=self.upstream.serve_forever, daemon=True).start()

        self.saved_host = bp.ALLOWED_HOST
        bp.ALLOWED_HOST = re.compile(r"^127\.0\.0\.1$")
        bp.Handler.log_message = lambda *a: None
        self.root = None
        self.start_proxy(ROOT)

    def start_proxy(self, root):
        self.proxy = ThreadingHTTPServer(("127.0.0.1", 0), partial(bp.Handler, directory=root))
        self.base = f"http://127.0.0.1:{self.proxy.server_address[1]}"
        threading.Thread(target=self.proxy.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in (self.proxy, self.upstream):
            server.shutdown()
            server.server_close()
        bp.ALLOWED_HOST = self.saved_host
        if self.root:
            shutil.rmtree(self.root)

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with NO_REDIRECT.open(req, timeout=10) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_token_and_headers_sent_upstream(self):
        status, _, body = self.get("/" + self.upstream_url + "/api/x", {
            "Authorization": "Basic dXNlcjpzaXRlLXBhc3N3b3Jk",  # the reverse proxy's basic auth
            "X-Blink-Authorization": "Bearer blink-token",
            "X-Forwarded-For": "203.0.113.9",
            "X-Forwarded-Prefix": "/blink",
            "X-Other": "kept",
        })
        self.assertEqual(status, 200)
        sent = {k.lower(): v for k, v in json.loads(body)["headers"].items()}
        self.assertEqual(sent["authorization"], "Bearer blink-token")
        self.assertNotIn("x-blink-authorization", sent)
        self.assertFalse([k for k in sent if k.startswith("x-forwarded-")])
        self.assertEqual(sent["x-other"], "kept")

    def test_basic_auth_alone_is_not_sent_upstream(self):
        status, _, body = self.get("/" + self.upstream_url + "/api/x",
                                   {"Authorization": "Basic dXNlcjpzaXRlLXBhc3N3b3Jk"})
        self.assertEqual(status, 200)
        sent = {k.lower() for k in json.loads(body)["headers"]}
        self.assertNotIn("authorization", sent)

    def test_merged_slashes_still_relay(self):
        status, _, body = self.get("/" + self.upstream_url.replace("://", ":/") + "/api/x")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/api/x")

    def test_redirect_carries_forwarded_prefix(self):
        status, headers, _ = self.get("/" + self.upstream_url + "/redirect",
                                      {"X-Forwarded-Prefix": "/blink/"})
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/blink/https://rest-u011.immedia-semi.com/elsewhere")

    def test_redirect_without_prefix(self):
        _, headers, _ = self.get("/" + self.upstream_url + "/redirect")
        self.assertEqual(headers["Location"], "/https://rest-u011.immedia-semi.com/elsewhere")

    def test_bad_forwarded_prefix_is_ignored(self):
        _, headers, _ = self.get("/" + self.upstream_url + "/redirect",
                                 {"X-Forwarded-Prefix": "//evil.example"})
        self.assertEqual(headers["Location"], "/https://rest-u011.immedia-semi.com/elsewhere")

    def test_version_from_file(self):
        self.proxy.shutdown()
        self.proxy.server_close()
        self.root = tempfile.mkdtemp(prefix="bling-relay-test-")
        with open(os.path.join(self.root, "VERSION"), "w") as f:
            f.write("abc1234\n")
        self.start_proxy(self.root)
        status, headers, body = self.get("/version")
        self.assertEqual((status, body), (200, b"abc1234"))
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_version_from_git(self):
        status, _, body = self.get("/version")
        self.assertEqual(status, 200)
        if shutil.which("git") and os.path.isdir(os.path.join(ROOT, ".git")) \
                and not os.path.exists(os.path.join(ROOT, "VERSION")):
            self.assertRegex(body.decode(), r"^[0-9a-f]{7,}$")


if __name__ == "__main__":
    unittest.main()
