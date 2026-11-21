#!/usr/bin/env python3
"""Serve bling-viewer and relay Blink API calls so the browser needs no CORS bypass.

Requests for /https://<host>/<path> are forwarded to https://<host>/<path> and the
response is returned with permissive CORS headers. Everything else is served as a
static file from this directory. Standard library only.

Blink's OAuth v2 login (PKCE, cookies, CSRF token scraped from HTML) can't run in
the browser, so it is done here behind three local JSON endpoints:

  POST /auth/login    {email, password, hardware_id?} -> tokens | {2fa_required, session}
  POST /auth/verify   {session, pin}                  -> tokens
  POST /auth/refresh  {refresh_token, hardware_id}    -> tokens

"tokens" is {access_token, refresh_token, expires_in, hardware_id, tier, account_id}.

Usage: bling-proxy.py [port]   (default 3000, listens on 127.0.0.1)
"""
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

# Only relay to Blink's servers so this can't be used as an open proxy.
ALLOWED_HOST = re.compile(r"(^|\.)immedia-semi\.com$")

DROP_REQUEST = {"host", "origin", "referer", "connection", "accept-encoding",
                "content-length", "keep-alive", "upgrade", "te"}
DROP_RESPONSE = {"connection", "transfer-encoding", "keep-alive", "content-length",
                 "content-encoding", "upgrade"}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect)


# --- Blink OAuth v2 (mirrors fronzbot/blinkpy) -------------------------------

OAUTH_BASE = "https://api.oauth.blink.com"
OAUTH_AUTHORIZE = OAUTH_BASE + "/oauth/v2/authorize"
OAUTH_SIGNIN = OAUTH_BASE + "/oauth/v2/signin"
OAUTH_2FA_VERIFY = OAUTH_BASE + "/oauth/v2/2fa/verify"
OAUTH_TOKEN = OAUTH_BASE + "/oauth/token"
TIER_INFO = "https://rest-prod.immedia-semi.com/api/v1/users/tier_info"
OAUTH_CLIENT_ID = "ios"
OAUTH_SCOPE = "client"
OAUTH_REDIRECT_URI = "immedia-blink://applinks.blink.com/signin/callback"
BROWSER_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
              "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1")
TOKEN_UA = "Blink/2511191620 CFNetwork/3860.200.71 Darwin/25.1.0"
API_UA = "27.0ANDROID_28373244"
HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"

PENDING_TTL = 600  # seconds a login may wait for its 2FA pin
pending = {}       # session id -> OAuthLogin awaiting 2FA
pending_lock = threading.Lock()


class AuthError(Exception):
    def __init__(self, message, status=401):
        super().__init__(message)
        self.status = status


class CsrfParser(HTMLParser):
    """Pull csrf-token out of <script id="oauth-args" type="application/json">."""

    def __init__(self):
        super().__init__()
        self.token = None
        self._in = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self._in = tag == "script" and a.get("id") == "oauth-args"

    def handle_data(self, data):
        if self._in:
            try:
                self.token = json.loads(data).get("csrf-token")
            except (ValueError, AttributeError):
                pass
            self._in = False

    def handle_endtag(self, tag):
        self._in = False


def fetch(op, url, data=None, headers=None, method=None):
    """Make a request; return (status, headers, body) without raising on non-2xx."""
    if isinstance(data, dict):
        data = urlencode(data).encode()
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with op.open(req, timeout=30) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.headers, e.read()
    except Exception as e:
        raise AuthError(f"Cannot reach Blink: {e}", 502)


def as_json(body):
    try:
        return json.loads(body)
    except ValueError:
        return {}


def exchange(data):
    """POST to the token endpoint and add the account's tier and id."""
    status, _, body = fetch(opener, OAUTH_TOKEN, data, {
        "User-Agent": TOKEN_UA, "Accept": "*/*",
        "Content-Type": "application/x-www-form-urlencoded"})
    tokens = as_json(body)
    if status != 200 or "access_token" not in tokens:
        raise AuthError(tokens.get("error_description") or tokens.get("message")
                        or f"Token request failed ({status})")
    status, _, body = fetch(opener, TIER_INFO, headers={
        "User-Agent": API_UA, "Authorization": "Bearer " + tokens["access_token"]})
    tier = as_json(body)
    if status != 200 or "tier" not in tier:
        raise AuthError(f"Could not get account tier ({status})", 502)
    return {
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token"),
        "expires_in": tokens.get("expires_in", 3600),
        "hardware_id": data["hardware_id"],
        "tier": tier["tier"],
        "account_id": tier["account_id"],
    }


class OAuthLogin:
    """One Authorization Code + PKCE login, with its own cookie jar."""

    def __init__(self, hardware_id=None):
        try:
            self.hardware_id = str(uuid.UUID(hardware_id)).upper()
        except (TypeError, ValueError):
            self.hardware_id = str(uuid.uuid4()).upper()  # Blink wants a UUID
        self.verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
        self.challenge = base64.urlsafe_b64encode(
            hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip("=")
        jar = http.cookiejar.CookieJar()
        self.follow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.nofollow = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
        self.csrf = None
        self.created = time.time()

    def _form_headers(self):
        return {"User-Agent": BROWSER_UA, "Accept": "*/*", "Origin": OAUTH_BASE,
                "Referer": OAUTH_SIGNIN, "Content-Type": "application/x-www-form-urlencoded"}

    def start(self, email, password):
        """Return tokens, or None if a 2FA pin is needed."""
        params = urlencode({
            "app_brand": "blink", "app_version": "50.1", "client_id": OAUTH_CLIENT_ID,
            "code_challenge": self.challenge, "code_challenge_method": "S256",
            "device_brand": "Apple", "device_model": "iPhone16,1", "device_os_version": "26.1",
            "hardware_id": self.hardware_id, "redirect_uri": OAUTH_REDIRECT_URI,
            "response_type": "code", "scope": OAUTH_SCOPE})
        page = {"User-Agent": BROWSER_UA, "Accept": HTML_ACCEPT, "Accept-Language": "en-US,en;q=0.9"}
        status, _, _ = fetch(self.follow, f"{OAUTH_AUTHORIZE}?{params}", headers=page)
        if status != 200:
            raise AuthError(f"Authorize request failed ({status})", 502)

        status, _, body = fetch(self.follow, OAUTH_SIGNIN, headers=page)
        parser = CsrfParser()
        parser.feed(body.decode("utf-8", "replace"))
        if status != 200 or not parser.token:
            raise AuthError(f"Could not load Blink sign-in page ({status})", 502)
        self.csrf = parser.token

        status, _, body = fetch(self.nofollow, OAUTH_SIGNIN, {
            "username": email, "password": password, "csrf-token": self.csrf},
            self._form_headers())
        if status in (301, 302, 303, 307, 308):
            return self.finish()
        resp = as_json(body)
        if status == 412 or (status == 202 and (resp.get("tsv_state") or resp.get("tsv_methods")
                                                 or resp.get("next_time_in_secs"))):
            return None
        raise AuthError(resp.get("message") or f"Blink rejected the sign-in ({status}); check email and password")

    def verify(self, pin):
        status, _, body = fetch(self.follow, OAUTH_2FA_VERIFY, {
            "2fa_code": pin, "csrf-token": self.csrf, "remember_me": "false"},
            self._form_headers())
        if status != 201 or as_json(body).get("status") != "auth-completed":
            raise AuthError(as_json(body).get("message") or "Invalid pin")
        return self.finish()

    def finish(self):
        status, headers, _ = fetch(self.nofollow, OAUTH_AUTHORIZE, headers={
            "User-Agent": BROWSER_UA, "Accept": "*/*", "Referer": OAUTH_SIGNIN})
        code = parse_qs(urlsplit(headers.get("Location", "")).query).get("code", [None])[0]
        if status not in (301, 302, 303, 307, 308) or not code:
            raise AuthError(f"No authorization code from Blink ({status})", 502)
        return exchange({
            "app_brand": "blink", "client_id": OAUTH_CLIENT_ID, "code": code,
            "code_verifier": self.verifier, "grant_type": "authorization_code",
            "hardware_id": self.hardware_id, "redirect_uri": OAUTH_REDIRECT_URI,
            "scope": OAUTH_SCOPE})


def auth_login(req):
    if not req.get("email") or not req.get("password"):
        raise AuthError("Email and password are required", 400)
    login = OAuthLogin(req.get("hardware_id"))
    tokens = login.start(req["email"], req["password"])
    if tokens:
        return tokens
    sid = secrets.token_urlsafe(16)
    with pending_lock:
        now = time.time()
        for k in [k for k, v in pending.items() if now - v.created > PENDING_TTL]:
            del pending[k]
        pending[sid] = login
    return {"2fa_required": True, "session": sid}


def auth_verify(req):
    with pending_lock:
        login = pending.get(req.get("session"))
    if not login or time.time() - login.created > PENDING_TTL:
        raise AuthError("Login expired, sign in again")
    tokens = login.verify(str(req.get("pin", "")).strip())
    with pending_lock:
        pending.pop(req.get("session"), None)
    return tokens


def auth_refresh(req):
    if not req.get("refresh_token") or not req.get("hardware_id"):
        raise AuthError("refresh_token and hardware_id are required", 400)
    return exchange({
        "grant_type": "refresh_token", "refresh_token": req["refresh_token"],
        "client_id": OAUTH_CLIENT_ID, "scope": OAUTH_SCOPE,
        "hardware_id": req["hardware_id"]})


AUTH_ROUTES = {"/auth/login": auth_login, "/auth/verify": auth_verify,
               "/auth/refresh": auth_refresh}


class Handler(SimpleHTTPRequestHandler):
    def _is_relay(self):
        return re.match(r"^/https?://", self.path) is not None

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        self.relay() if self._is_relay() else super().do_GET()

    def do_HEAD(self):
        self.relay() if self._is_relay() else super().do_HEAD()

    def do_POST(self):
        if self.path in AUTH_ROUTES:
            self.auth(AUTH_ROUTES[self.path])
        elif self._is_relay():
            self.relay()
        else:
            self.send_error(405)

    def do_PUT(self):
        self.relay() if self._is_relay() else self.send_error(405)

    do_DELETE = do_PATCH = do_PUT

    def auth(self, fn):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
            status, result = 200, fn(req)
        except ValueError:
            status, result = 400, {"message": "Bad JSON"}
        except AuthError as e:
            status, result = e.status, {"message": str(e)}
        data = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def relay(self):
        url = self.path[1:]
        host = urlsplit(url).hostname or ""
        if not ALLOWED_HOST.search(host):
            self.send_error(403, f"Host not allowed: {host}")
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in DROP_REQUEST and not k.lower().startswith("sec-")}
        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)

        try:
            resp = opener.open(req, timeout=60)
        except urllib.error.HTTPError as e:
            resp = e  # non-2xx: pass status and body through unchanged
        except Exception as e:
            self.send_error(502, f"Upstream error: {e}")
            return

        with resp:
            data = resp.read()
            self.send_response(resp.status)
            for k, v in resp.headers.items():
                if k.lower() in DROP_RESPONSE or k.lower().startswith("access-control-"):
                    continue
                if k.lower() == "location" and re.match(r"^https?://", v):
                    v = "/" + v
                self.send_header(k, v)
            for k, v in CORS.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    root = os.path.dirname(os.path.abspath(__file__))
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=root))
    print(f"bling-viewer on http://localhost:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
