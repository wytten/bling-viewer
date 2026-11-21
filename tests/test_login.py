"""Login tests for bling-proxy.py's /auth/* endpoints, against a fake Blink OAuth server.

The fake follows the flow blinkpy documents: authorize (session cookie) -> sign-in page
(CSRF token) -> sign-in (412 = 2FA needed, redirect = done) -> 2FA verify (sets a
long-lived cookie when remember_me=true) -> authorize redirect with a code -> token
exchange checked against the PKCE challenge -> tier_info. No network needed.

    python3 -m unittest discover tests
"""
import base64
import hashlib
import importlib.util
import json
import os
import secrets
import shutil
import stat
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMAIL, PASSWORD, PIN = "user@example.com", "s3cret", "123456"

spec = importlib.util.spec_from_file_location("bling_proxy", os.path.join(ROOT, "bling-proxy.py"))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)


class FakeBlink:
    """State shared by the fake OAuth handler."""

    def __init__(self):
        self.sessions = {}         # session cookie -> {challenge, hardware_id, authed}
        self.remember_tokens = {}  # remember cookie -> hardware_id it was issued for
        self.codes = {}            # auth code -> session
        self.pins_asked = 0
        self.remember_me_values = []
        self.token_hardware_ids = []


class FakeBlinkHandler(BaseHTTPRequestHandler):
    blink = None
    # How sign-in reports "done, no PIN needed": real Blink answered 201 for a remembered
    # device (2026-11-21); blinkpy expects a redirect.
    signin_ok = 201

    def log_message(self, *a):
        pass

    def cookies(self):
        out = {}
        for part in (self.headers.get("Cookie") or "").split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                out[k] = v
        return out

    def form(self):
        n = int(self.headers.get("Content-Length") or 0)
        return {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}

    def reply(self, status, body=b"", headers=()):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def session(self):
        return self.blink.sessions.get(self.cookies().get("sess"))

    def do_GET(self):
        url = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/oauth/v2/authorize" and "code_challenge" in q:
            old = self.session()
            if old:  # like Blink: a live session cookie is reused, not replaced
                return self.reply(200, "<html>authorize</html>")
            sid = secrets.token_hex(8)
            self.blink.sessions[sid] = {"challenge": q["code_challenge"], "hardware_id": q["hardware_id"],
                                        "authed": False}
            self.reply(200, "<html>authorize</html>",
                       [("Set-Cookie", f"sess={sid}; Path=/; Max-Age=1200"),       # persistent, like blink-public-session
                        ("Set-Cookie", f"csrf-protection={sid}; Path=/oauth/v2; Max-Age=86400")])
        elif url.path == "/oauth/v2/authorize":
            s = self.session()
            if not s or not s["authed"]:
                return self.reply(401, "not signed in")
            code = secrets.token_hex(8)
            self.blink.codes[code] = s
            s["used"] = True
            self.reply(302, headers=[("Location", f"{bp.OAUTH_REDIRECT_URI}?code={code}&state=x")])
        elif url.path == "/oauth/v2/signin":
            s = self.session()
            if not s:
                return self.reply(400, "no session")
            s["csrf"] = secrets.token_hex(8)
            self.reply(200, '<html><script id="oauth-args" type="application/json">'
                            + json.dumps({"csrf-token": s["csrf"]}) + "</script></html>")
        elif url.path == "/api/v1/users/tier_info":
            if not (self.headers.get("Authorization") or "").startswith("Bearer at-"):
                return self.reply(401, {"message": "Unauthorized Access"})
            self.reply(200, {"tier": "u000", "account_id": 42})
        else:
            self.reply(404, "no fake for " + self.path)

    def do_POST(self):
        url = urlsplit(self.path)
        f = self.form()
        s = self.session()
        if url.path == "/oauth/v2/signin":
            if not s or f.get("csrf-token") != s.get("csrf"):
                return self.reply(403, {"message": "bad csrf"})
            if s.get("used"):
                return self.reply(401, {"message": "Invalid credentials"})  # what a stale session got from Blink
            if f.get("username", "").strip() != EMAIL or f.get("password") != PASSWORD:
                return self.reply(401, {"message": "Invalid credentials"})
            if "remember" in self.cookies() and self.cookies()["remember"] not in self.blink.remember_tokens:
                return self.reply(401, {"message": "Invalid credentials"})  # unknown device cookie
            remembered = self.blink.remember_tokens.get(self.cookies().get("remember"))
            if remembered and remembered == s["hardware_id"]:
                s["authed"] = True
                if self.signin_ok == 201:
                    return self.reply(201, {"status": "auth-completed"})
                return self.reply(302, headers=[("Location", "/oauth/v2/authorize")])
            self.blink.pins_asked += 1
            self.reply(412, {"tsv_state": "pending"})
        elif url.path == "/oauth/v2/2fa/verify":
            if not s or f.get("csrf-token") != s.get("csrf"):
                return self.reply(403, {"message": "bad csrf"})
            if f.get("2fa_code") != PIN:
                return self.reply(400, {"message": "Invalid pin"})
            self.blink.remember_me_values.append(f.get("remember_me"))
            s["authed"] = True
            headers = []
            if f.get("remember_me") == "true":
                token = secrets.token_hex(8)
                self.blink.remember_tokens[token] = s["hardware_id"]
                headers.append(("Set-Cookie", f"remember={token}; Path=/; Max-Age=2592000"))
            self.reply(201, {"status": "auth-completed"}, headers)
        elif url.path == "/oauth/token":
            self.blink.token_hardware_ids.append(f.get("hardware_id"))
            if f.get("grant_type") == "authorization_code":
                sess = self.blink.codes.pop(f.get("code"), None)
                challenge = base64.urlsafe_b64encode(
                    hashlib.sha256(f.get("code_verifier", "").encode()).digest()).decode().rstrip("=")
                if not sess or challenge != sess["challenge"] or f.get("hardware_id") != sess["hardware_id"]:
                    return self.reply(400, {"error_description": "bad code"})
            elif f.get("grant_type") == "refresh_token":
                if not f.get("refresh_token", "").startswith("rt-"):
                    return self.reply(401, {"error_description": "bad refresh token"})
            else:
                return self.reply(400, {"error_description": "bad grant"})
            self.reply(200, {"access_token": "at-" + secrets.token_hex(4),
                             "refresh_token": "rt-" + secrets.token_hex(4), "expires_in": 3600})
        else:
            self.reply(404, "no fake for " + self.path)


class LoginTest(unittest.TestCase):
    def setUp(self):
        self.blink = FakeBlink()
        handler = type("H", (FakeBlinkHandler,), {"blink": self.blink})
        self.fake = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        base = f"http://127.0.0.1:{self.fake.server_address[1]}"
        threading.Thread(target=self.fake.serve_forever, daemon=True).start()

        self.saved = {k: getattr(bp, k) for k in
                      ("OAUTH_BASE", "OAUTH_AUTHORIZE", "OAUTH_SIGNIN", "OAUTH_2FA_VERIFY",
                       "OAUTH_TOKEN", "TIER_INFO", "REMEMBER_DIR", "PUBLIC")}
        bp.OAUTH_BASE = base
        bp.OAUTH_AUTHORIZE = base + "/oauth/v2/authorize"
        bp.OAUTH_SIGNIN = base + "/oauth/v2/signin"
        bp.OAUTH_2FA_VERIFY = base + "/oauth/v2/2fa/verify"
        bp.OAUTH_TOKEN = base + "/oauth/token"
        bp.TIER_INFO = base + "/api/v1/users/tier_info"
        self.config = tempfile.mkdtemp(prefix="bling-login-test-")
        bp.REMEMBER_DIR = os.path.join(self.config, "bling-viewer")

        bp.Handler.log_message = lambda *a: None
        self.proxy = ThreadingHTTPServer(("127.0.0.1", 0), partial(bp.Handler, directory=ROOT))
        self.base = f"http://127.0.0.1:{self.proxy.server_address[1]}"
        threading.Thread(target=self.proxy.serve_forever, daemon=True).start()

    def tearDown(self):
        for server in (self.proxy, self.fake):
            server.shutdown()
            server.server_close()
        for k, v in self.saved.items():
            setattr(bp, k, v)
        shutil.rmtree(self.config, ignore_errors=True)

    def post(self, path, body):
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def login(self, email=EMAIL, password=PASSWORD, pin=PIN, remember=False, hardware_id=None):
        """Log in like the page does; returns (tokens, asked_for_pin)."""
        status, r = self.post("/auth/login", {"email": email, "password": password, "hardware_id": hardware_id})
        self.assertEqual(status, 200, r)
        if not r.get("2fa_required"):
            return r, False
        status, r = self.post("/auth/verify", {"session": r["session"], "pin": pin, "remember": remember})
        self.assertEqual(status, 200, r)
        return r, True

    def device_files(self):
        return [os.path.join(bp.REMEMBER_DIR, n) for n in ("device.json", "cookies.lwp")]

    def test_login_with_pin(self):
        tokens, asked = self.login()
        self.assertTrue(asked)
        self.assertTrue(tokens["access_token"].startswith("at-"))
        self.assertTrue(tokens["refresh_token"].startswith("rt-"))
        self.assertEqual((tokens["tier"], tokens["account_id"], tokens["expires_in"]), ("u000", 42, 3600))
        self.assertEqual(self.blink.remember_me_values, ["false"])
        self.assertFalse(any(os.path.exists(p) for p in self.device_files()))

    def test_without_remember_pin_is_asked_every_time(self):
        self.login()
        _, asked = self.login()
        self.assertTrue(asked)
        self.assertEqual(self.blink.pins_asked, 2)

    def test_remember_skips_pin_next_time(self):
        first, asked = self.login(remember=True)
        self.assertTrue(asked)
        self.assertEqual(self.blink.remember_me_values, ["true"])
        for path in self.device_files():
            self.assertTrue(os.path.exists(path), path)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600, path)
        self.assertEqual(stat.S_IMODE(os.stat(bp.REMEMBER_DIR).st_mode), 0o700)

        # A fresh (e.g. incognito) browser has no hardware_id; the proxy supplies the remembered one.
        second, asked = self.login()
        self.assertFalse(asked, "pin asked again")
        self.assertEqual(self.blink.pins_asked, 1)
        self.assertEqual(second["hardware_id"], first["hardware_id"])
        self.assertNotEqual(second["access_token"], first["access_token"])

        # Still remembered on the third login (cookies re-saved).
        _, asked = self.login()
        self.assertFalse(asked)

    def test_remembered_signin_reported_by_redirect(self):
        FakeBlinkHandler.signin_ok = 302
        try:
            self.login(remember=True)
            _, asked = self.login()
            self.assertFalse(asked)
        finally:
            FakeBlinkHandler.signin_ok = 201

    def test_saved_cookies_exclude_session_and_csrf(self):
        self.login(remember=True)
        with open(self.device_files()[1]) as f:
            saved = f.read()
        self.assertIn("remember=", saved)
        self.assertNotIn("sess=", saved)
        self.assertNotIn("csrf-protection=", saved)

    def test_stale_session_in_old_cookie_file_is_ignored(self):
        # A cookie file saved by an earlier version still holds the session and CSRF cookies.
        first, _ = self.login(remember=True)
        os.remove(self.device_files()[1])
        login = bp.OAuthLogin(EMAIL)
        login.start(PASSWORD)  # leaves a used session in its jar
        login.jar.save(self.device_files()[1])
        second, asked = self.login()
        self.assertEqual(second["hardware_id"], first["hardware_id"])

    def test_remembered_device_is_per_email(self):
        self.login(remember=True)
        status, r = self.post("/auth/login", {"email": "other@example.com", "password": PASSWORD})
        self.assertEqual(status, 401)  # unknown user at the fake, but no remembered cookies were used
        with open(self.device_files()[0]) as f:
            self.assertEqual(json.load(f)["email"], EMAIL)

    def test_unticking_after_remember_fails_forgets(self):
        self.login(remember=True)
        self.blink.remember_tokens.clear()  # Blink stops honouring the cookie
        _, asked = self.login(remember=False)
        self.assertTrue(asked)
        self.assertFalse(any(os.path.exists(p) for p in self.device_files()))

    def test_wrong_pin_and_password(self):
        status, r = self.post("/auth/login", {"email": EMAIL, "password": "wrong"})
        self.assertEqual(status, 401)
        self.assertEqual(r["message"], "Invalid credentials")
        status, r = self.post("/auth/login", {"email": EMAIL, "password": PASSWORD})
        status, r = self.post("/auth/verify", {"session": r["session"], "pin": "000000", "remember": True})
        self.assertEqual(status, 401)
        self.assertEqual(r["message"], "Invalid pin")
        self.assertFalse(any(os.path.exists(p) for p in self.device_files()))

    def test_refresh(self):
        tokens, _ = self.login()
        status, r = self.post("/auth/refresh", {"refresh_token": tokens["refresh_token"],
                                                "hardware_id": tokens["hardware_id"]})
        self.assertEqual(status, 200, r)
        self.assertNotEqual(r["access_token"], tokens["access_token"])
        self.assertEqual(r["hardware_id"], tokens["hardware_id"])
        status, r = self.post("/auth/refresh", {"refresh_token": "bogus", "hardware_id": tokens["hardware_id"]})
        self.assertEqual(status, 401)

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=20) as r:
            return json.loads(r.read())

    def test_last_login_is_remembered(self):
        self.assertEqual(self.get("/auth/last-login"), {})
        status, _ = self.post("/auth/login", {"email": EMAIL, "password": "wrong"})
        self.assertEqual(status, 401)
        self.assertEqual(self.get("/auth/last-login"), {}, "saved after a failed login")
        self.login(email="  " + EMAIL + " ")  # PIN login; whitespace trimmed
        self.assertEqual(self.get("/auth/last-login"), {"email": EMAIL})
        path = os.path.join(bp.REMEMBER_DIR, "last-login.json")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_last_login_survives_forgetting_the_device(self):
        self.login(remember=True)
        self.blink.remember_tokens.clear()
        self.login(remember=False)  # forgets the device
        self.assertFalse(os.path.exists(self.device_files()[0]))
        self.assertEqual(self.get("/auth/last-login"), {"email": EMAIL})

    def test_last_login_falls_back_to_remembered_device(self):
        self.login(remember=True)
        os.remove(os.path.join(bp.REMEMBER_DIR, "last-login.json"))  # e.g. remembered before last-login existed
        self.assertEqual(self.get("/auth/last-login"), {"email": EMAIL})

    def test_public_keeps_no_email_and_remembers_no_computer(self):
        bp.PUBLIC = True
        _, asked = self.login(remember=True)
        self.assertTrue(asked)
        _, asked = self.login(remember=True)
        self.assertTrue(asked, "PIN skipped on a public proxy")
        self.assertEqual(self.get("/auth/last-login"), {"public": True})
        self.assertFalse(os.path.exists(bp.REMEMBER_DIR), "something saved on a public proxy")

    def test_public_ignores_a_device_remembered_before(self):
        self.login(remember=True)
        bp.PUBLIC = True
        _, asked = self.login()
        self.assertTrue(asked)

    def test_expired_or_unknown_session(self):
        status, r = self.post("/auth/verify", {"session": "nope", "pin": PIN})
        self.assertEqual(status, 401)
        self.assertIn("sign in again", r["message"])


if __name__ == "__main__":
    unittest.main()
