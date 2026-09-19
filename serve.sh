#!/bin/sh
#
# Serve NYC Childcare Finder over http://localhost instead of file://.
#
# Why this exists: OpenStreetMap's tile server returns an "Access blocked / App
# is not following the tile usage policy" image to requests that arrive without
# an HTTP Referer. A page opened with file:// sends none (browsers omit it for
# file origins), so the map can come up blank or covered in block tiles. Served
# from http://localhost the browser sends "Referer: http://localhost:PORT/",
# which OSM accepts.
#
# Usage:  ./serve.sh [port]
#
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"

# --- find a usable Python 3 -------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1 &&
     python -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' 2>/dev/null; then
  PYTHON=python
else
  cat >&2 <<'EOF'
error: no Python 3 found.

Serve this folder with any static web server, for example:
  npx --yes serve -l 8000 .
  php -S localhost:8000
  ruby -run -e httpd . -p 8000
EOF
  exit 1
fi

# --- choose a port ----------------------------------------------------------
PORT=${1:-}
if [ -z "$PORT" ]; then
  PORT=$("$PYTHON" - <<'EOF'
import socket, sys
for candidate in (8000, 8080, 8081, 5500, 3000):
    try:
        probe = socket.socket()
        probe.bind(('127.0.0.1', candidate))
        probe.close()
        print(candidate)
        sys.exit()
    except OSError:
        continue
probe = socket.socket()
probe.bind(('127.0.0.1', 0))
print(probe.getsockname()[1])
probe.close()
EOF
)
fi

URL="http://localhost:$PORT/"

printf 'Serving %s\n' "$DIR"
printf 'Open          %s\n' "$URL"
printf 'Stop with     Ctrl+C\n\n'

# --- open a browser once the server is up -----------------------------------
(
  sleep 1
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  elif command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$URL"
  fi
) >/dev/null 2>&1 &

# Bind to loopback only: this is a local preview, not a public server.
exec "$PYTHON" -m http.server "$PORT" --bind 127.0.0.1
