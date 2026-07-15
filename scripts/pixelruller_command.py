#!/usr/bin/env python3
"""Send one design command to an open local PixelRuller editor."""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def request_json(url, *, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        detail = json.loads(raw) if raw else {"error": str(exc)}
        return exc.code, detail


def render_result(result):
    message = str(result.get("msg", ""))
    if not (sys.stdout.isatty() and result.get("data", {}).get("kind") in {"tree", "selection"}):
        return message
    return "\n".join(
        f"\033[1;36m{line}\033[0m" if line.startswith("▶") else line
        for line in message.splitlines()
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="+", help="PixelRuller command, quoted as one shell argument when it contains spaces")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--no-wait", action="store_true", help="queue the command and print its id")
    args = parser.parse_args()
    base = f"http://127.0.0.1:{args.port}"
    command = " ".join(args.command).strip()

    try:
        status, queued = request_json(base + "/api/commands", payload={"command": command})
    except OSError as exc:
        parser.error(f"cannot reach PixelRuller on port {args.port}: {exc}")
    if status != 202:
        parser.error(queued.get("error", f"server returned HTTP {status}"))
    item_id = queued["id"]
    if args.no_wait:
        print(item_id)
        return 0

    deadline = time.monotonic() + max(0.1, args.timeout)
    url = base + "/api/commands/result?" + urllib.parse.urlencode({"id": item_id})
    while time.monotonic() < deadline:
        status, response = request_json(url)
        if status == 200 and response.get("status") == "complete":
            result = response.get("result", {})
            print(render_result(result))
            return 0 if result.get("ok") else 1
        if status not in {200, 202}:
            parser.error(response.get("error", f"server returned HTTP {status}"))
        time.sleep(0.1)
    parser.error("command timed out; keep a canvas design open in PixelRuller")


if __name__ == "__main__":
    raise SystemExit(main())
