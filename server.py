#!/usr/bin/env python3
"""PixelRuller — a zero-dependency pixel-measuring tool for Linux/Wayland (KDE).

The Python side only captures the desktop (via `spectacle`) and writes annotated
images to disk. All the interactive measuring happens in the browser canvas.

Usage:
    python3 server.py            # start the app and open it in the browser
    python3 server.py --grid     # start, auto-capture and show the counting grid
    python3 server.py --no-open  # start without launching a browser
    python3 server.py --port N   # listen on a specific port (default: auto)
    python3 server.py --print-ai-skill  # print the complete AI usage guide
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
ASSETS_DIR = os.path.join(ROOT, "Assets")
SAVE_SUBDIR = "PixelRuller"
APP_NAME = "PixelRuller"
APP_VERSION = "0.0.2"
AI_SKILL_PATH = os.path.join(ROOT, "AI_SKILL.md")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def pictures_dir():
    """Best-effort resolution of the user's Pictures directory (locale-aware)."""
    try:
        out = subprocess.run(
            ["xdg-user-dir", "PICTURES"], capture_output=True, text=True, timeout=5
        )
        path = out.stdout.strip()
        if path and os.path.isdir(path):
            return path
    except Exception:
        pass
    for candidate in ("Pictures", "Εικόνες"):
        path = os.path.join(os.path.expanduser("~"), candidate)
        if os.path.isdir(path):
            return path
    return os.path.expanduser("~")


def save_dir():
    d = os.path.join(pictures_dir(), SAVE_SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def capture_screenshot():
    """Capture the full desktop and return raw PNG bytes, or raise on failure."""
    fd, tmp = tempfile.mkstemp(suffix=".png", prefix="pixelruller_")
    os.close(fd)
    try:
        # -b background, -n no notification, -f fullscreen, -S drop window shadows
        result = subprocess.run(
            ["spectacle", "-b", "-n", "-f", "-o", tmp],
            capture_output=True,
            timeout=30,
        )
        if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
            raise RuntimeError(
                "spectacle produced no image. stderr:\n"
                + result.stderr.decode("utf-8", "replace")
            )
        with open(tmp, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def unique_path(name, ext=".png"):
    """Return a non-clobbering path inside the PixelRuller folder for `name`."""
    base = "".join(c for c in (name or "measurement") if c.isalnum() or c in " _-").strip()
    base = base.replace(" ", "_") or "measurement"
    directory = save_dir()
    candidate = os.path.join(directory, base + ext)
    i = 2
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{base}_{i}{ext}")
        i += 1
    return candidate


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep the console quiet

    def _send(self, code, body, content_type="application/json"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/assets":
            self.handle_assets_list()
            return
        if path.startswith("/assets/"):
            self.serve_static(ASSETS_DIR, path[len("/assets/"):])
            return
        if path == "/":
            path = "/index.html"
        self.serve_static(WEB_DIR, path.lstrip("/"))

    def serve_static(self, base, rel):
        # Serve a file from `base`, confined to it (path-traversal guard).
        full = os.path.normpath(os.path.join(base, urllib.parse.unquote(rel)))
        if os.path.commonpath([full, base]) != base or not os.path.isfile(full):
            self._send(404, "not found", "text/plain")
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as fh:
            self._send(200, fh.read(), CONTENT_TYPES.get(ext, "application/octet-stream"))

    def handle_assets_list(self):
        # List asset files (currently SVGs) as {name, src} relative to Assets/.
        items = []
        svg_dir = os.path.join(ASSETS_DIR, "SVGs")
        if os.path.isdir(svg_dir):
            for fn in sorted(os.listdir(svg_dir)):
                if fn.lower().endswith(".svg"):
                    items.append({"name": os.path.splitext(fn)[0], "src": "SVGs/" + fn})
        self._send(200, json.dumps({"icons": items}))

    def do_POST(self):
        if self.path == "/capture":
            self.handle_capture()
        elif self.path == "/save":
            self.handle_save()
        elif self.path == "/save-json":
            self.handle_save_json()
        elif self.path == "/save-text":
            self.handle_save_text()
        else:
            self._send(404, json.dumps({"error": "unknown endpoint"}))

    def handle_capture(self):
        try:
            png = capture_screenshot()
        except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
            self._send(500, json.dumps({"error": str(exc)}))
            return
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        self._send(200, json.dumps({"image": data_url}))

    def handle_save(self):
        try:
            payload = self._read_json()
            data_url = payload["dataUrl"]
            name = payload.get("name", "measurement")
            header, _, b64 = data_url.partition(",")
            if "image/png" not in header:
                raise ValueError("expected a PNG data URL")
            png = base64.b64decode(b64)
            path = unique_path(name)
            with open(path, "wb") as fh:
                fh.write(png)
        except Exception as exc:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(exc)}))
            return
        self._send(200, json.dumps({"path": path}))

    def handle_save_json(self):
        try:
            payload = self._read_json()
            name = payload.get("name", "measurement")
            data = payload.get("data", payload)
            path = unique_path(name, ext=".json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
        except Exception as exc:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(exc)}))
            return
        self._send(200, json.dumps({"path": path}))

    def handle_save_text(self):
        try:
            payload = self._read_json()
            name = payload.get("name", "flow")
            text = payload.get("text", "")
            raw = "".join(c for c in str(payload.get("ext", "txt")).lstrip(".") if c.isalnum())[:8]
            ext = "." + (raw or "txt")
            path = unique_path(name, ext=ext)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
        except Exception as exc:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(exc)}))
            return
        self._send(200, json.dumps({"path": path}))


def main():
    args = sys.argv[1:]
    if "--version" in args:
        print(f"{APP_NAME} {APP_VERSION}")
        return
    if "--ai-skill-path" in args:
        print(AI_SKILL_PATH)
        return
    if "--print-ai-skill" in args:
        try:
            with open(AI_SKILL_PATH, encoding="utf-8") as fh:
                print(fh.read(), end="")
        except OSError as exc:
            print(f"Could not read {AI_SKILL_PATH}: {exc}", file=sys.stderr)
            raise SystemExit(1) from exc
        return
    open_browser = "--no-open" not in args
    grid = "--grid" in args
    port = 0
    if "--port" in args:
        port = int(args[args.index("--port") + 1])

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    actual_port = server.server_address[1]
    url = f"http://127.0.0.1:{actual_port}/"
    if grid:
        url += "?mode=grid"

    print(f"{APP_NAME} {APP_VERSION} running at {url}")
    print(f"Saving annotated images to: {save_dir()}")
    print("Press Ctrl+C to stop.")

    if open_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.shutdown()


if __name__ == "__main__":
    main()
