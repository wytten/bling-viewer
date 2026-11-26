# Bling viewer
A web viewer for Blink Home Security cameras: thumbnails, battery and temperature for every camera
on each network, live view, and recorded clips to watch, from Blink's cloud storage or a Sync
Module's local (USB) storage.

This fork runs without Bling Desktop.[^desktop] A small Python proxy, `bling-proxy.py`, serves the
viewer and handles everything a browser can't do against Blink's servers by itself, so it works in
an ordinary Chrome window on Linux or macOS.

## Quick start
Requirements: Python 3, Google Chrome, and `ffmpeg` (live view only).

```sh
./bling.sh [port]            # start the proxy if needed and open the viewer (default port 3000)
./bling.sh restart [port]    # restart the proxy, e.g. after changing bling-proxy.py
./bling.sh stop [port]       # stop the proxy
```

`bling.sh` starts the proxy if nothing is listening on the port yet and opens the viewer in an
incognito Chrome window. The proxy runs detached (`setsid`/`nohup`), so it keeps running after
the script's terminal or launcher exits, and logs to `${TMPDIR:-/tmp}/bling-proxy.log`.

To launch it from anywhere, symlink it onto your `PATH`, e.g.
`ln -s "$PWD/bling.sh" ~/bin/bling.sh`; it finds the viewer through the symlink.

After pulling changes to `bling-proxy.py`, run `./bling.sh restart` and reload the page (you stay
signed in). Changes to `index.html` or `js/` only need a page reload.

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

### Behind a reverse proxy
The viewer can also be served under a path, e.g. `https://example.com/blink/` with Apache
forwarding `/blink/` to the proxy on `127.0.0.1`. Its URLs are relative to the page, and the
proxy prefixes relayed redirects with the `X-Forwarded-Prefix` header if the reverse proxy sets
one. The page sends Blink's token to the proxy as `X-Blink-Authorization`, so `Authorization` is
free for basic auth on the reverse proxy; the proxy never forwards that, or `X-Forwarded-*`, to
Blink. Serve it over HTTPS.

If anyone can reach it, run the proxy with `BLING_PUBLIC=1`. Otherwise it would fill in the last
email that signed in for every visitor, and its remembered device cookies would let a correct
password skip the 2FA PIN from any browser. Public, it saves neither: the box reads **Don't ask
again in this browser**, and ticking it hands Blink's device cookies and the device ID back to
that browser, in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie (`bling-device`) sent only to
the proxy's `/auth/`. Only that browser can then skip the PIN; every other one gets Blink's
sign-in with its PIN. Either way the page also remembers the last email itself, in the browser's
`localStorage`.

The drawer shows the short git commit the viewer is running from (`GET /version`). A copy deployed
without `.git` can provide it in a `VERSION` file.

## Changes from upstream
Besides the proxy, the viewer itself was updated for Blink's current API:

* API calls send `Authorization: Bearer <token>` instead of the retired `TOKEN_AUTH` header.
* The session is kept in the browser's `localStorage` and refreshed before the token expires, so a
  reload doesn't need a new login. The same device ID is reused on later logins.
* Thumbnails work with Blink's current formats (full `/api/v3/media/...` paths, or bare timestamps
  that need the camera's product type from the homescreen).
* Activity also lists clips on Sync Module local storage (USB), merged newest first with any cloud
  clips. The Sync Module is asked for its clip list when you open Activity, and a clip is uploaded
  from the module when you select it, so expect a few seconds' wait for each (the same calls
  blinkpy uses). Local clips have no thumbnails; the download icon on a local clip saves it as
  `<camera> <date time>.mp4` (a clip already fetched for playing isn't uploaded again).
* Live view uses Blink's v6 endpoint (v2 for Minis and doorbells) and the proxy instead of Bling
  Desktop.
* Buttons and icons have tooltips.

## Security
Everything runs on your machine. Your email and password go from the page to the proxy on
`127.0.0.1` and from there only to Blink's sign-in servers. Neither stores them. The access and
refresh tokens Blink returns are kept in the browser's `localStorage`. `bling.sh` uses an incognito
window, so they're discarded when you close Chrome and you'll sign in again next time.

Ticking **Don't ask again on this computer** when entering the 2FA PIN asks Blink to remember the
device, and the proxy saves the device's ID and Blink's long-lived device cookies (never its
session or CSRF cookies) in
`~/.config/bling-viewer/` (owner-only; `BLING_REMEMBER_DIR` overrides). Later logins with the same
email reuse them, so Blink can skip the PIN even from a fresh incognito window. Delete that directory
to forget the computer; entering a PIN with the box unticked also forgets it. (With
`BLING_PUBLIC=1` they're kept in the browser instead; see above. Clearing the site's cookies
forgets it there.)

The proxy also remembers the last email that signed in (`last-login.json` in the same directory) and
fills it into the login form.

## Tests
```sh
python3 -m unittest discover tests
```
No network or Blink account needed:

* `tests/test_live_view.py` runs the proxy against a fake Blink live view server (needs `ffmpeg`
  and `openssl`).
* `tests/test_login.py` runs the `/auth/*` login endpoints against a fake Blink OAuth server,
  including 2FA and "Don't ask again on this computer".
* `tests/test_relay.py` checks what reaches Blink through the relay (basic auth and
  `X-Forwarded-*` dropped, the token mapped from `X-Blink-Authorization`), redirects under a
  prefix, and `/version`.
* `tests/test_activity.py` loads the real viewer in headless Chrome with Blink's API faked by
  `tests/fake_blink.js`, opens Activity and checks cloud clips, Sync Module local storage clips
  (including a busy or failing module), both merged, no clips, unexpected responses and server
  errors (needs Google Chrome or Chromium).

Tests whose tools are missing are skipped.

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
