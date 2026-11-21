#!/usr/bin/env bash
# Serve bling-viewer through bling-proxy.py and open it in Chrome.
#
# Usage: bling.sh [port]   (default 3000)
#
# Starts the proxy only if nothing is listening on the port yet, detached so it
# outlives this script's terminal or launcher. Proxy log: ${TMPDIR:-/tmp}/bling-proxy.log

viewer=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)   # follows a symlink, e.g. from ~/bin
port=${1:-3000}
log=${TMPDIR:-/tmp}/bling-proxy.log
url="http://localhost:$port/"

detach() {
    if command -v setsid >/dev/null; then
        setsid nohup "$@" </dev/null
    else
        nohup "$@" </dev/null   # macOS has no setsid
    fi
}

if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "Starting proxy on port $port (log: $log)"
    (cd "$viewer" && detach python3 bling-proxy.py "$port" >"$log" 2>&1 &)
    sleep 1
fi

if command -v google-chrome >/dev/null; then
    detach google-chrome --incognito --user-data-dir=/tmp/blink-test "$url" >/dev/null 2>&1 &
elif [ "$(uname)" = Darwin ]; then
    open -na "Google Chrome" --args --incognito --user-data-dir=/tmp/blink-test "$url"
else
    echo "Open $url in a browser"
fi
