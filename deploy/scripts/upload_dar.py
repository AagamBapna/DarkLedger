#!/usr/bin/env python3
"""Upload a DAR to one or more Canton participant JSON API v2 endpoints."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib import error, request


def _is_duplicate_upload(http_code: int, body: str) -> bool:
    if http_code not in {400, 409}:
        return False
    text = body.lower()
    return any(token in text for token in ("already", "duplicate", "exists", "known_package_version"))


def _upload_once(url: str, dar_bytes: bytes, token: str | None) -> None:
    headers = {"Content-Type": "application/octet-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = request.Request(url=url, data=dar_bytes, headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=120) as resp:
            if 200 <= resp.status < 300:
                print(f"[upload] ok {url}")
                return
            raise RuntimeError(f"unexpected HTTP status {resp.status} for {url}")
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if _is_duplicate_upload(exc.code, body):
            print(f"[upload] already uploaded {url}")
            return
        raise RuntimeError(f"{url} -> HTTP {exc.code}: {body}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"{url} -> network error: {exc}") from exc


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dar", required=True, type=Path, help="Path to DAR file.")
    parser.add_argument(
        "--url",
        action="append",
        required=True,
        help="Participant package upload URL (repeat for multiple nodes).",
    )
    parser.add_argument(
        "--token",
        default="",
        help="Optional bearer token for all upload URLs.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()

    dar_path: Path = args.dar
    if not dar_path.is_file():
        print(f"ERROR: DAR not found: {dar_path}", file=sys.stderr)
        return 1

    try:
        dar_bytes = dar_path.read_bytes()
    except OSError as exc:
        print(f"ERROR: failed reading DAR {dar_path}: {exc}", file=sys.stderr)
        return 1

    token = args.token.strip()
    try:
        for url in args.url:
            _upload_once(url, dar_bytes, token if token else None)
    except Exception as exc:
        detail = str(exc)
        try:
            payload = json.loads(detail)
            detail = json.dumps(payload)
        except Exception:
            pass
        print(f"ERROR: {detail}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
