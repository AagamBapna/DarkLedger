#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Backward-compatible wrapper.
exec "${PROJECT_DIR}/deploy/canton_network/run_canton_network_demo.sh" "$@"
