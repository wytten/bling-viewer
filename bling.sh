#!/usr/bin/env bash
# Serve bling-viewer through bling-proxy.py and open it in Chrome.
#
# Usage: bling.sh [start|stop|restart] [port]   (default: start, port 3000)
#
#   start    start the proxy if nothing is listening on the port, then open the viewer
#   stop     stop the proxy
#   restart  stop and start the proxy (e.g. after changing bling-proxy.py); reload the page
#
# The proxy runs detached so it outlives this script's terminal or launcher.
# Proxy log: ${TMPDIR:-/tmp}/bling-proxy.log

viewer=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)   # follows a symlink, e.g. from ~/bin
action=start
case "$1" in
    start|stop|restart) action=$1; shift ;;
esac
port=${1:-3000}
log=${TMPDIR:-/tmp}/bling-proxy.log
url="http://localhost:$port/"

# Matches "python3 bling-proxy.py <port>" (and a bare "bling-proxy.py" for the default port).
if [ "$port" = 3000 ]; then
    pattern='bling-proxy\.py( 3000)?$'
else
    pattern="bling-proxy\\.py $port\$"
fi

detach() {
    if command -v setsid >/dev/null; then
        setsid nohup "$@" </dev/null
    else
        nohup "$@" </dev/null   # macOS has no setsid
    fi
}

listening() {
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

stop_proxy() {
    if ! pgrep -f "$pattern" >/dev/null; then
        echo "No proxy running on port $port"
        return
    fi
    pkill -f "$pattern"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        listening || { echo "Stopped proxy on port $port"; return; }
        sleep 0.5
    done
    echo "Proxy on port $port didn't stop; try: pkill -9 -f '$pattern'" >&2
    return 1
}

start_proxy() {
    if listening; then
        return
    fi
    echo "Starting proxy on port $port (log: $log)"
    (cd "$viewer" && detach python3 bling-proxy.py "$port" >"$log" 2>&1 &)
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        listening && return
        sleep 0.2
    done
    echo "Proxy didn't start; see $log" >&2
    return 1
}

case $action in
    stop)
        stop_proxy
        exit
        ;;
    restart)
        stop_proxy || exit 1
        start_proxy
        exit
        ;;
esac

start_proxy || exit 1

if command -v google-chrome >/dev/null; then
    detach google-chrome --incognito --user-data-dir=/tmp/blink-test "$url" >/dev/null 2>&1 &
elif [ "$(uname)" = Darwin ]; then
    open -na "Google Chrome" --args --incognito --user-data-dir=/tmp/blink-test "$url"
else
    echo "Open $url in a browser"
fi
