#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if ! command -v dpm >/dev/null 2>&1; then
  echo "dpm is required but not found on PATH"
  echo "Install dpm first, then rerun this script."
  exit 1
fi

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r agent/requirements.txt

exec python deploy/public_demo/run_backend.py
