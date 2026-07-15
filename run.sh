#!/usr/bin/env bash
# PixelRuller launcher.
#   ./run.sh          start the app and open it in the browser
#   ./run.sh --grid   capture immediately and show the pixel-counting grid
#   ./run.sh --no-open / --port N   see server.py
cd "$(dirname "$0")"
exec python3 server.py "$@"
