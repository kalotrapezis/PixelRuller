#!/usr/bin/env python3
"""PixelRuller — a zero-dependency pixel-measuring and UI-design tool for Linux.

The Python side uses the first compatible desktop screenshot command it finds
and writes annotated images to disk. All interactive work happens in the browser.

Usage:
    python3 server.py            # start the app and open it in the browser
    python3 server.py --grid     # start, auto-capture and show the counting grid
    python3 server.py --no-open  # start without launching a browser
    python3 server.py --port N   # listen on a specific port (default: auto)
    python3 server.py --print-ai-skill  # print the complete AI usage guide
    python3 server.py --screenshot-backends  # list detected capture tools
"""

import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
ASSETS_DIR = os.path.join(ROOT, "Assets")
SAVE_SUBDIR = "PixelRuller"
APP_NAME = "PixelRuller"
APP_VERSION = "0.0.3"
AI_SKILL_PATH = os.path.join(ROOT, "AI_SKILL.md")


class CommandBroker:
    """Thread-safe localhost queue shared by the CLI and the open editor."""

    def __init__(self):
        self._lock = threading.Lock()
        self._items = {}
        self._order = []

    def enqueue(self, command):
        command = str(command or "").strip()
        if not command:
            raise ValueError("command is required")
        if len(command) > 4096:
            raise ValueError("command is too long")
        item_id = uuid.uuid4().hex
        with self._lock:
            self._items[item_id] = {
                "id": item_id, "command": command, "status": "queued",
                "created": time.time(),
            }
            self._order.append(item_id)
            self._prune_locked()
        return item_id

    def take_next(self):
        with self._lock:
            for item_id in self._order:
                item = self._items.get(item_id)
                if item and item["status"] == "queued":
                    item["status"] = "running"
                    item["started"] = time.time()
                    return {"id": item_id, "command": item["command"]}
        return None

    def complete(self, item_id, result):
        with self._lock:
            item = self._items.get(str(item_id))
            if not item:
                return False
            item["status"] = "complete"
            item["result"] = result
            item["finished"] = time.time()
            self._prune_locked()
            return True

    def result(self, item_id):
        with self._lock:
            item = self._items.get(str(item_id))
            if not item:
                return None
            out = {"id": item["id"], "status": item["status"]}
            if item["status"] == "complete":
                out["result"] = item.get("result", {})
            return out

    def _prune_locked(self):
        cutoff = time.time() - 300
        stale = [item_id for item_id in self._order
                 if self._items[item_id]["status"] == "complete"
                 and self._items[item_id].get("finished", 0) < cutoff]
        for item_id in stale:
            self._items.pop(item_id, None)
        if stale:
            stale_set = set(stale)
            self._order = [item_id for item_id in self._order if item_id not in stale_set]


COMMAND_BROKER = CommandBroker()

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


SCREENSHOT_TOOLS = (
    ("Spectacle", "spectacle", lambda out: ["spectacle", "-b", "-n", "-f", "-o", out]),
    ("GNOME Screenshot", "gnome-screenshot", lambda out: ["gnome-screenshot", "-f", out]),
    ("MATE Screenshot", "mate-screenshot", lambda out: ["mate-screenshot", "-f", out]),
    ("XFCE Screenshooter", "xfce4-screenshooter", lambda out: ["xfce4-screenshooter", "-f", "-s", out]),
    ("Grim", "grim", lambda out: ["grim", out]),
    ("Flameshot", "flameshot", lambda out: ["flameshot", "full", "-p", out]),
    ("Scrot", "scrot", lambda out: ["scrot", "-o", out]),
    ("Maim", "maim", lambda out: ["maim", out]),
    ("Shutter", "shutter", lambda out: ["shutter", "-f", "-e", "-n", "-o", out]),
)


def screenshot_commands(output_path):
    """Yield available (display name, argv) capture backends in preference order."""
    custom = os.environ.get("PIXELRULLER_SCREENSHOT_COMMAND", "").strip()
    if custom:
        rendered = custom.replace("{output}", output_path)
        argv = shlex.split(rendered)
        if "{output}" not in custom:
            argv.append(output_path)
        if argv:
            yield "Custom command", argv
    for name, executable, command in SCREENSHOT_TOOLS:
        if shutil.which(executable):
            yield name, command(output_path)


def detected_screenshot_backends():
    """Return names of capture tools currently available on PATH."""
    names = []
    if os.environ.get("PIXELRULLER_SCREENSHOT_COMMAND", "").strip():
        names.append("Custom command")
    names.extend(name for name, executable, _ in SCREENSHOT_TOOLS if shutil.which(executable))
    return names


def capture_screenshot():
    """Capture the full desktop and return (raw PNG bytes, backend name)."""
    fd, tmp = tempfile.mkstemp(suffix=".png", prefix="pixelruller_")
    os.close(fd)
    os.remove(tmp)  # capture tools should create the output themselves
    try:
        attempts = []
        commands = list(screenshot_commands(tmp))
        if not commands:
            raise RuntimeError(
                "No compatible screenshot tool found. Install Spectacle, "
                "GNOME Screenshot, MATE Screenshot, XFCE Screenshooter, Grim, "
                "Flameshot, Scrot, Maim, or Shutter; or set "
                "PIXELRULLER_SCREENSHOT_COMMAND with an {output} placeholder."
            )
        for name, command in commands:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
                result = subprocess.run(
                    command, capture_output=True, text=True, timeout=30, check=False
                )
                if result.returncode == 0 and os.path.isfile(tmp) and os.path.getsize(tmp) > 8:
                    with open(tmp, "rb") as fh:
                        png = fh.read()
                    if png.startswith(b"\x89PNG\r\n\x1a\n"):
                        return png, name
                    attempts.append(f"{name}: output was not PNG")
                else:
                    detail = (result.stderr or result.stdout or "no image produced").strip()
                    attempts.append(f"{name}: {detail[:240]}")
            except (OSError, subprocess.TimeoutExpired) as exc:
                attempts.append(f"{name}: {exc}")
        raise RuntimeError("Screenshot capture failed. " + " | ".join(attempts))
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
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if path == "/api/commands/next":
            item = COMMAND_BROKER.take_next()
            self._send(200, json.dumps(item)) if item else self._send(204, b"")
            return
        if path == "/api/commands/result":
            item = COMMAND_BROKER.result((query.get("id") or [""])[0])
            if not item:
                self._send(404, json.dumps({"error": "unknown command id"}))
            else:
                self._send(200 if item["status"] == "complete" else 202, json.dumps(item))
            return
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
        if self.path == "/api/commands":
            self.handle_command_enqueue()
        elif self.path == "/api/commands/result":
            self.handle_command_result()
        elif self.path == "/capture":
            self.handle_capture()
        elif self.path == "/save":
            self.handle_save()
        elif self.path == "/save-json":
            self.handle_save_json()
        elif self.path == "/save-text":
            self.handle_save_text()
        else:
            self._send(404, json.dumps({"error": "unknown endpoint"}))

    def handle_command_enqueue(self):
        try:
            item_id = COMMAND_BROKER.enqueue(self._read_json().get("command"))
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, json.dumps({"error": str(exc)}))
            return
        self._send(202, json.dumps({"id": item_id, "status": "queued"}))

    def handle_command_result(self):
        try:
            payload = self._read_json()
            item_id = payload.pop("id")
        except (KeyError, json.JSONDecodeError) as exc:
            self._send(400, json.dumps({"error": f"invalid result: {exc}"}))
            return
        if not COMMAND_BROKER.complete(item_id, payload):
            self._send(404, json.dumps({"error": "unknown command id"}))
            return
        self._send(200, json.dumps({"id": item_id, "status": "complete"}))

    def handle_capture(self):
        try:
            png, backend = capture_screenshot()
        except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
            self._send(500, json.dumps({"error": str(exc)}))
            return
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        self._send(200, json.dumps({"image": data_url, "backend": backend}))

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
    if "--screenshot-backends" in args:
        names = detected_screenshot_backends()
        print("\n".join(names) if names else "No compatible screenshot tools detected")
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
