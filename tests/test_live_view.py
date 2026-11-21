"""Live view tests for bling-proxy.py, run against a fake Blink "immis" stream server.

No network or Blink account needed; requires ffmpeg and openssl on PATH.

    python3 -m unittest discover tests
"""
import importlib.util
import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_SECONDS = 8

spec = importlib.util.spec_from_file_location("bling_proxy", os.path.join(ROOT, "bling-proxy.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)


class FakeImmisServer(threading.Thread):
    """Accept one TLS client, record its auth header, then stream test.ts as immis packets."""

    def __init__(self, workdir):
        super().__init__(daemon=True)
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.load_cert_chain(os.path.join(workdir, "cert.pem"), os.path.join(workdir, "key.pem"))
        with open(os.path.join(workdir, "test.ts"), "rb") as f:
            self.data = f.read()
        self.sock = socket.create_server(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.header = b""
        self.keepalives = 0
        self.stats = 0
        self.closed = threading.Event()

    def run(self):
        conn, _ = self.sock.accept()
        s = self.ctx.wrap_socket(conn, server_side=True)
        while len(self.header) < 122:
            self.header += s.recv(122 - len(self.header))
        threading.Thread(target=self.read_client, args=(s,), daemon=True).start()
        try:
            # A non-video packet first; the proxy must skip it.
            s.sendall(b"\x01" + (0).to_bytes(4, "big") + (5).to_bytes(4, "big") + b"junk!")
            chunk = 188 * 7
            delay = TS_SECONDS / (len(self.data) / chunk)  # roughly real time
            for seq, i in enumerate(range(0, len(self.data), chunk), 1):
                p = self.data[i:i + chunk]
                s.sendall(b"\x00" + seq.to_bytes(4, "big") + len(p).to_bytes(4, "big") + p)
                time.sleep(delay)
        except OSError:
            pass  # proxy hung up
        finally:
            self.closed.wait(5)
            s.close()
            self.sock.close()

    def read_client(self, s):
        try:
            while True:
                b = s.recv(4096)
                if not b:
                    break
                self.keepalives += b.count(b"\x0a\x00\x00\x00")
                self.stats += b.count(b"\x12\x00\x00\x03\xe8")
        except OSError:
            pass
        self.closed.set()


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("openssl"), "needs ffmpeg and openssl")
class LiveViewTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workdir = tempfile.mkdtemp(prefix="bling-live-test-")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y",
                        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15",
                        "-f", "lavfi", "-i", "sine=frequency=440", "-t", str(TS_SECONDS),
                        "-c:v", "libx264", "-g", "15", "-c:a", "aac", "-f", "mpegts",
                        os.path.join(cls.workdir, "test.ts")], check=True)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=localhost",
                        "-keyout", os.path.join(cls.workdir, "key.pem"),
                        "-out", os.path.join(cls.workdir, "cert.pem")],
                       check=True, capture_output=True)
        bp.Handler.log_message = lambda *a: None  # keep test output quiet
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(bp.Handler, directory=ROOT))
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        shutil.rmtree(cls.workdir, ignore_errors=True)

    def setUp(self):
        self.idle = bp.LIVE_IDLE

    def tearDown(self):
        bp.LIVE_IDLE = self.idle
        for stream in list(bp.streams.values()):
            stream.stop()

    def post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=10) as r:
                return r.status, r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError as e:
            return e.code, None, b""

    def start_request(self, fake, **overrides):
        body = {"camera_id": 555, "network_id": 1, "serial": "G8T1ABCDEF",
                "server": f"immis://127.0.0.1:{fake.port}/CONN1234567890__IMDS_x?client_id=42",
                "command_id": None, "polling_interval": 15, "token": "x", "region": "u022"}
        body.update(overrides)
        return body

    def wait_for(self, cond, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if cond():
                return True
            time.sleep(0.1)
        return False

    def test_auth_header_layout(self):
        h = bp.immis_auth_header("G8T1ABCDEF", "42", "CONN1234567890")
        self.assertEqual(len(h), 122)
        self.assertEqual(h[:4], b"\x00\x00\x00\x28")
        self.assertEqual(h[4:8], (16).to_bytes(4, "big"))
        self.assertEqual(h[8:24].rstrip(b"\0"), b"G8T1ABCDEF")
        self.assertEqual(int.from_bytes(h[24:28], "big"), 42)
        self.assertEqual(h[28:30], b"\x01\x08")
        self.assertEqual(h[30:34], (64).to_bytes(4, "big"))
        self.assertEqual(h[34:98], bytes(64))
        self.assertEqual(h[102:118].rstrip(b"\0"), b"CONN1234567890")
        self.assertEqual(h[118:], b"\x00\x00\x00\x01")

    def test_stream_to_hls_and_stop(self):
        fake = FakeImmisServer(self.workdir)
        fake.start()
        status, resp = self.post("/live/start", self.start_request(fake))
        self.assertEqual(status, 200, resp)
        self.assertEqual(resp, {"camera_id": 555, "url": "live/555/index.m3u8"})

        # The proxy authenticated the way Blink expects.
        self.assertEqual(fake.header, bp.immis_auth_header("G8T1ABCDEF", "42", "CONN1234567890"))

        # A playable HLS stream appears.
        segments = []

        def have_segments():
            status, ctype, body = self.get("/" + resp["url"])
            segments[:] = [l for l in body.decode().splitlines() if l and not l.startswith("#")]
            return status == 200 and len(segments) >= 2

        self.assertTrue(self.wait_for(have_segments), "no HLS segments produced")
        status, ctype, seg = self.get(f"/live/555/{segments[-1]}")
        self.assertEqual((status, ctype), (200, "video/mp2t"))
        self.assertEqual(seg[:1], b"\x47")
        if shutil.which("ffprobe"):
            probe = subprocess.run(["ffprobe", "-loglevel", "error", "-show_entries",
                                    "stream=codec_name", "-of", "csv=p=0", "-"],
                                   input=seg, capture_output=True, check=True)
            self.assertEqual(set(probe.stdout.decode().split()), {"aac", "h264"})

        # Keep-alive and latency packets were sent.
        self.assertTrue(self.wait_for(lambda: fake.keepalives >= 1 and fake.stats >= 2))

        stream = bp.streams["555"]
        status, _ = self.post("/live/stop", {"camera_id": 555})
        self.assertEqual(status, 200)
        self.assertNotIn("555", bp.streams)
        self.assertFalse(os.path.exists(stream.dir))
        self.assertIsNotNone(stream.ffmpeg.poll(), "ffmpeg still running")
        self.assertTrue(fake.closed.wait(5), "stream connection not closed")
        self.assertEqual(self.get("/" + resp["url"])[0], 404)

    def test_idle_stream_stops(self):
        bp.LIVE_IDLE = 2
        fake = FakeImmisServer(self.workdir)
        fake.start()
        status, resp = self.post("/live/start", self.start_request(fake))
        self.assertEqual(status, 200, resp)
        stream = bp.streams["555"]
        self.assertTrue(self.wait_for(lambda: stream.stop_event.is_set(), timeout=8),
                        "idle stream kept running")
        self.assertTrue(self.wait_for(lambda: not os.path.exists(stream.dir)), "temp dir not removed")

    def test_rejects_bad_requests(self):
        fake = FakeImmisServer(self.workdir)  # never started; requests are rejected before connecting
        status, resp = self.post("/live/start", self.start_request(fake, server="https://example.com/x"))
        self.assertEqual(status, 502)
        self.assertIn("Unsupported live view server", resp["message"])
        status, resp = self.post("/live/start", self.start_request(fake, serial=""))
        self.assertEqual(status, 400)
        status, resp = self.post("/live/start", {"camera_id": 555})
        self.assertEqual(status, 400)
        fake.sock.close()

    def test_live_files_only_from_running_streams(self):
        self.assertEqual(self.get("/live/999/index.m3u8")[0], 404)
        self.assertEqual(self.get("/live/555/..%2f..%2fetc%2fpasswd")[0], 404)
        self.assertEqual(self.get("/live/555/index.txt")[0], 404)


if __name__ == "__main__":
    unittest.main()
