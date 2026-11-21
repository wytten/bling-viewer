#!/usr/bin/env python3
"""Serve bling-viewer and relay Blink API calls so the browser needs no CORS bypass.

Requests for /https://<host>/<path> are forwarded to https://<host>/<path> and the
response is returned with permissive CORS headers. Everything else is served as a
static file from this directory. Standard library only.

Usage: bling-proxy.py [port]   (default 3000, listens on 127.0.0.1)
"""
import os
import re
import sys
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

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
        self.relay() if self._is_relay() else self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_POST

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
