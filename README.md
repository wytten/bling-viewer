# Bling viewer
A web viewer for Blink Home Security cameras: thumbnails, battery and temperature for every camera
on each network, live view, and a list of recorded clips to watch or download.

This fork runs without Bling Desktop.[^desktop] A small Python proxy, `bling-proxy.py`, serves the
viewer and handles everything a browser can't do against Blink's servers by itself, so it works in
an ordinary Chrome window on Linux or macOS.

## Quick start
Requirements: Python 3, Google Chrome, and `ffmpeg` (live view only).

Save this as `bling.sh`, point `viewer` at your clone, and run it:

```sh
#!/bin/zsh
# Serve bling-viewer through its proxy (bling-proxy.py, stdlib only) and open it
# in Chrome, so no --disable-web-security is needed.

viewer=~/projects/github/src/bling-viewer
port=3000

if ! ss -ltn | grep -q ":$port "; then
    (cd $viewer && python3 bling-proxy.py $port >/dev/null 2>&1 &)
    sleep 1
fi

google-chrome --incognito --user-data-dir=/tmp/blink-test "http://localhost:$port/" >/dev/null 2>&1 &
```

It starts the proxy only if nothing is listening on the port yet. After pulling changes to
`bling-proxy.py`, stop the running proxy so the script starts the new one. Changes to `index.html`
or `js/` only need a page reload.

You can also run the proxy by hand: `./bling-proxy.py [port]` (default 3000, listens on
127.0.0.1 only), then open `http://localhost:3000/`.

## What bling-proxy.py does
* **Relays API calls.** The page requests `/https://rest-<region>.immedia-semi.com/...` and the
  proxy forwards it, adding CORS headers. Only `immedia-semi.com` hosts are relayed, so it can't be
  used as an open proxy.
* **Signs in with Blink's OAuth.** Blink retired the old `/api/v5/account/login` endpoint (it now
  answers "An app update is required"). Current Blink apps use OAuth 2.0 with PKCE at
  `api.oauth.blink.com`, which involves cookies, a CSRF token scraped from HTML and redirects that a
  web page can't follow. The proxy does that flow behind `/auth/login`, `/auth/verify` (the 2FA PIN
  Blink emails or texts you) and `/auth/refresh`. The flow mirrors
  [blinkpy](https://github.com/fronzbot/blinkpy).
* **Streams live view.** Blink sends live video over its own "immis" protocol, which browsers can't
  play. `/live/start` connects to the camera's stream, sends Blink's keep-alives, and pipes the
  video through `ffmpeg` into an HLS playlist under `/live/<camera_id>/`, which the page plays with
  hls.js. A stream stops when you click stop, when Blink ends the session, or 30 seconds after the
  page stops fetching it.
* **Serves the viewer.** Everything else is served as static files from the repository.

It uses only the Python standard library.

## Changes from upstream
Besides the proxy, the viewer itself was updated for Blink's current API:

* API calls send `Authorization: Bearer <token>` instead of the retired `TOKEN_AUTH` header.
* The session is kept in the browser's `localStorage` and refreshed before the token expires, so a
  reload doesn't need a new login. The same device ID is reused on later logins.
* Thumbnails work with Blink's current formats (full `/api/v3/media/...` paths, or bare timestamps
  that need the camera's product type from the homescreen).
* Live view uses Blink's v6 endpoint (v2 for Minis and doorbells) and the proxy instead of Bling
  Desktop.
* Buttons and icons have tooltips.

## Security
Everything runs on your machine. Your email and password go from the page to the proxy on
`127.0.0.1` and from there only to Blink's sign-in servers. Neither stores them. The access and
refresh tokens Blink returns are kept in the browser's `localStorage`. `bling.sh` uses an incognito
window, so they're discarded when you close Chrome, and you'll sign in (and possibly enter a 2FA PIN)
again next time.

## Tests
```sh
python3 -m unittest discover tests
```
The tests run the proxy against a fake Blink live view server. They need `ffmpeg` and `openssl`,
but no network or Blink account.

## Screenshots
### Networks
Check current thumbnail, battery status and temperature for all cameras of each network

![](img/example1.png)
### Activity
View and download all videos

![](img/example2.png)

[^desktop]: The original [lurume84/bling-viewer](https://github.com/lurume84/bling-viewer) was
    built as the front end of [Bling Desktop](https://github.com/lurume84/bling-desktop), a Windows
    app (a modified Chromium Embedded Framework browser) that downloads the viewer, lifts browser
    CORS restrictions, converts live view streams, and backs up videos. Upstream's other option was to
    launch Chrome with `--disable-web-security --user-data-dir=<path to viewer>`. Neither is needed
    with `bling-proxy.py`, and both rely on the old Blink login that no longer works.
