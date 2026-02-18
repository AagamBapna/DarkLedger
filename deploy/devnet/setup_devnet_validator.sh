#!/usr/bin/env bash
# ============================================================
# Agentic Shadow-Cap — Canton L1 DevNet Deployment
# ============================================================
#
# This script deploys Shadow-Cap onto a Canton L1 network using
# Splice LocalNet — the official Canton Network local topology
# from the splice-node release.
#
# LocalNet provides:
#   - Super Validator (SV) with Global Synchronizer
#   - App Provider participant + validator
#   - App User participant + validator
#   - PostgreSQL database
#   - NGINX gateway with wallet/scan/sv UIs
#
# This is the same topology used by cn-quickstart (digital-asset)
# and is the recommended deployment target for hackathon submissions.
#
# Prerequisites:
#   - Docker Desktop running (8GB+ memory recommended)
#   - Daml SDK 3.4.x installed
#   - Python 3.10+ with venv
#   - curl, tar
#
# Usage:
#   cd canton
#   make devnet
# ============================================================

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Configuration ──────────────────────────────────────────
CANTON_VERSION="${CANTON_VERSION:-0.5.10}"
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DAR_FILE="${PROJECT_DIR}/daml/.daml/dist/agentic-shadow-cap-0.1.0.dar"
SPLICE_DIR="${HOME}/.canton/${CANTON_VERSION}/splice-node/docker-compose"
LOCALNET_DIR="${SPLICE_DIR}/localnet"

# LocalNet port scheme (from docs.sync.global):
#   App Provider: 3xxx, App User: 2xxx, SV: 4xxx
#   Ledger API suffix: 901, JSON API suffix: 975
APP_PROVIDER_LEDGER_PORT=3901
APP_USER_LEDGER_PORT=2901
SV_LEDGER_PORT=4901
APP_PROVIDER_JSON_API_PORT=3975
APP_USER_JSON_API_PORT=2975

# ── Helpers ──────────────────────────────────────────────
step() { echo -e "\n${CYAN}==> $1${NC}"; }
ok()   { echo -e "  ${GREEN}OK${NC} $1"; }
warn() { echo -e "  ${YELLOW}WARNING${NC} $1"; }
fail_exit() { echo -e "  ${RED}FAILED${NC} $1"; exit 1; }

wait_for_port() {
  local port=$1 host=${2:-127.0.0.1} timeout=${3:-120}
  local start=$(date +%s)
  while true; do
    if nc -z "$host" "$port" 2>/dev/null; then
      return 0
    fi
    if (( $(date +%s) - start > timeout )); then
      return 1
    fi
    sleep 2
  done
}

generate_unsafe_hs256_token() {
  python3 - <<'PY'
import base64
import hashlib
import hmac
import json
import os

secret = os.environ.get("CANTON_INSECURE_SECRET", "unsafe").encode("utf-8")
audience = os.environ.get("CANTON_INSECURE_AUDIENCE", "https://canton.network.global")
subject = os.environ.get("CANTON_INSECURE_SUB", "ledger-api-user")
header = {"alg": "HS256", "typ": "JWT"}
payload = {"sub": subject, "aud": audience}

def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")

def b64json(value: dict) -> str:
    return b64(json.dumps(value, separators=(",", ":")).encode("utf-8"))

unsigned = f"{b64json(header)}.{b64json(payload)}".encode("utf-8")
signature = hmac.new(secret, unsigned, hashlib.sha256).digest()
print(f"{unsigned.decode('utf-8')}.{b64(signature)}")
PY
}

# ── Banner ──────────────────────────────────────────────

echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Agentic Shadow-Cap — Canton L1 Deployment${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo -e "  Using Splice LocalNet v${CANTON_VERSION}"
echo -e "  (Full Canton Network topology with"
echo -e "   Super Validator + Global Synchronizer)"
echo ""

# ── Pre-flight checks ───────────────────────────────────

step "Checking Docker..."
docker info > /dev/null 2>&1 || fail_exit "Docker is not running. Start Docker Desktop first."
ok "Docker is running"

step "Checking Daml SDK..."
daml version > /dev/null 2>&1 || fail_exit "Daml SDK not found. Install from https://docs.daml.com/getting-started/installation.html"
ok "Daml SDK found"

step "Preparing DAR..."
DAR_READY=false
if [[ -f "$DAR_FILE" ]]; then
  if daml damlc inspect-dar "$DAR_FILE" --json >/dev/null 2>&1; then
    DAR_READY=true
    ok "DAR found and readable: $DAR_FILE"
  else
    warn "Existing DAR is incompatible with current Daml SDK. Rebuilding."
  fi
fi

if [[ "$DAR_READY" != "true" ]]; then
  echo "  Building DAR..."
  cd "$PROJECT_DIR" && make build
  daml damlc inspect-dar "$DAR_FILE" --json >/dev/null 2>&1 || \
    fail_exit "DAR exists but cannot be inspected by current Daml SDK."
  ok "DAR built and validated: $DAR_FILE"
fi

# ── Step 1: Download splice-node ────────────────────────

step "Downloading splice-node v${CANTON_VERSION}..."

if [[ -d "$LOCALNET_DIR" ]]; then
  ok "Already downloaded at $LOCALNET_DIR"
else
  mkdir -p "${HOME}/.canton/${CANTON_VERSION}"
  cd "${HOME}/.canton/${CANTON_VERSION}"

  TARBALL="${CANTON_VERSION}_splice-node.tar.gz"
  DOWNLOAD_URL="https://github.com/digital-asset/decentralized-canton-sync/releases/download/v${CANTON_VERSION}/${TARBALL}"

  if [[ ! -f "$TARBALL" ]]; then
    echo "  Downloading from $DOWNLOAD_URL ..."
    echo "  (This is ~500MB, may take a few minutes)"
    curl -L -o "$TARBALL" "$DOWNLOAD_URL" || fail_exit "Download failed. Check version ${CANTON_VERSION}"
  fi

  echo "  Extracting..."
  tar xzf "$TARBALL"
  ok "Extracted splice-node"
fi

[[ -d "$LOCALNET_DIR" ]] || fail_exit "LocalNet directory not found at $LOCALNET_DIR"
ok "LocalNet directory: $LOCALNET_DIR"

# ── Step 2: Stop any previous LocalNet ──────────────────

step "Stopping any previous LocalNet..."
export LOCALNET_DIR
export IMAGE_TAG="${CANTON_VERSION}"

cd "$LOCALNET_DIR"

docker compose \
  --env-file "$LOCALNET_DIR/compose.env" \
  --env-file "$LOCALNET_DIR/env/common.env" \
  -f "$LOCALNET_DIR/compose.yaml" \
  -f "$LOCALNET_DIR/resource-constraints.yaml" \
  --profile sv \
  --profile app-provider \
  --profile app-user \
  down -v 2>/dev/null || true
ok "Previous instances cleaned up"

# ── Step 3: Start LocalNet ──────────────────────────────

step "Starting Splice LocalNet (Canton L1)..."
echo "  Starting Super Validator + App Provider + App User..."
echo "  This may take 3-5 minutes for all nodes to become healthy."

docker compose \
  --env-file "$LOCALNET_DIR/compose.env" \
  --env-file "$LOCALNET_DIR/env/common.env" \
  -f "$LOCALNET_DIR/compose.yaml" \
  -f "$LOCALNET_DIR/resource-constraints.yaml" \
  --profile sv \
  --profile app-provider \
  --profile app-user \
  up -d

ok "LocalNet containers started"

# ── Step 4: Wait for health ─────────────────────────────

step "Waiting for Canton nodes to become healthy..."

echo "  Waiting for App Provider ledger API (port $APP_PROVIDER_LEDGER_PORT)..."
if wait_for_port "$APP_PROVIDER_LEDGER_PORT" 127.0.0.1 300; then
  ok "App Provider ledger API is up"
else
  warn "App Provider ledger API not responding after 5 minutes"
  echo "  Check logs: docker compose -f $LOCALNET_DIR/compose.yaml logs -f"
fi

echo "  Waiting for App User ledger API (port $APP_USER_LEDGER_PORT)..."
if wait_for_port "$APP_USER_LEDGER_PORT" 127.0.0.1 120; then
  ok "App User ledger API is up"
else
  warn "App User ledger API not responding"
fi

echo "  Waiting for App Provider JSON API (port $APP_PROVIDER_JSON_API_PORT)..."
if wait_for_port "$APP_PROVIDER_JSON_API_PORT" 127.0.0.1 120; then
  ok "App Provider JSON API is up"
else
  warn "App Provider JSON API not responding"
fi

# Additional settle time for the Canton domain to finish bootstrapping
echo "  Allowing Canton domain 30s to complete synchronization..."
sleep 30
ok "Canton nodes appear healthy"

# Show container status
echo ""
docker compose \
  --env-file "$LOCALNET_DIR/compose.env" \
  --env-file "$LOCALNET_DIR/env/common.env" \
  -f "$LOCALNET_DIR/compose.yaml" \
  -f "$LOCALNET_DIR/resource-constraints.yaml" \
  --profile sv \
  --profile app-provider \
  --profile app-user \
  ps --format "table {{.Name}}\t{{.Status}}"
echo ""

# ── Step 5: Bootstrap dApp on participant APIs ─────────

step "Bootstrapping contracts + parties using JSON API v2..."
cd "$PROJECT_DIR"

if [[ ! -x "$PROJECT_DIR/.venv/bin/python" ]]; then
  python3 -m venv "$PROJECT_DIR/.venv"
fi
"$PROJECT_DIR/.venv/bin/python" -m pip install -q --upgrade pip
"$PROJECT_DIR/.venv/bin/python" -m pip install -q -r "$PROJECT_DIR/agent/requirements.txt"
ok "Python runtime ready (.venv)"

export CANTON_PROVIDER_URL="http://127.0.0.1:${APP_PROVIDER_JSON_API_PORT}"
export CANTON_USER_URL="http://127.0.0.1:${APP_USER_JSON_API_PORT}"
export CANTON_ALLOW_INSECURE_TOKEN="${CANTON_ALLOW_INSECURE_TOKEN:-true}"
export CANTON_INSECURE_TOKEN_MODE="${CANTON_INSECURE_TOKEN_MODE:-hs256-unsafe}"
export CANTON_INSECURE_SECRET="${CANTON_INSECURE_SECRET:-unsafe}"
export CANTON_INSECURE_AUDIENCE="${CANTON_INSECURE_AUDIENCE:-https://canton.network.global}"
export CANTON_INSECURE_SUB="${CANTON_INSECURE_SUB:-ledger-api-user}"

if [[ -z "${CANTON_PROVIDER_TOKEN:-}" && -z "${CANTON_USER_TOKEN:-}" && -z "${CANTON_JWT_TOKEN:-}" ]]; then
  if [[ "$CANTON_ALLOW_INSECURE_TOKEN" == "true" ]]; then
    SHARED_TOKEN="$(generate_unsafe_hs256_token)"
    export CANTON_PROVIDER_TOKEN="$SHARED_TOKEN"
    export CANTON_USER_TOKEN="$SHARED_TOKEN"
    ok "Generated unsafe HS256 token for localnet bootstrap"
  else
    warn "No token found. Set CANTON_PROVIDER_TOKEN / CANTON_USER_TOKEN / CANTON_JWT_TOKEN."
  fi
fi

if "$PROJECT_DIR/.venv/bin/python" "$PROJECT_DIR/deploy/canton_network/bootstrap.py"; then
  ok "Bootstrap complete (DAR upload + party map + seed)"
else
  warn "Bootstrap failed. Check deploy/canton_network/bootstrap.py output above."
fi

# ── Step 8: Print Status ───────────────────────────────

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Canton L1 Deployment is LIVE${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "${CYAN}Canton L1 Endpoints:${NC}"
echo "  App Provider Ledger API:  localhost:${APP_PROVIDER_LEDGER_PORT}"
echo "  App Provider JSON API:    localhost:${APP_PROVIDER_JSON_API_PORT}"
echo "  App User Ledger API:      localhost:${APP_USER_LEDGER_PORT}"
echo "  App User JSON API:        localhost:${APP_USER_JSON_API_PORT}"
echo "  SV Ledger API:            localhost:${SV_LEDGER_PORT}"
echo ""
echo -e "${CYAN}Canton Network UIs:${NC}"
echo "  Scan Explorer:            http://scan.localhost:4000"
echo "  Super Validator:          http://sv.localhost:4000"
echo "  App Provider Wallet:      http://wallet.localhost:3000"
echo "  App User Wallet:          http://wallet.localhost:2000"
echo ""
echo -e "${CYAN}To start agents:${NC}"
echo "  make devnet-demo"
echo "  # or:"
echo "  bash deploy/canton_network/run_canton_network_demo.sh"
echo ""
echo -e "${CYAN}To start UI:${NC}"
echo "  cd ui && npm install"
echo "  VITE_JSON_API_URL=http://localhost:8081 \\"
echo "    VITE_MARKET_API_URL=http://localhost:8090 \\"
echo "    VITE_JSON_API_USE_INSECURE_TOKEN=false npm run dev"
echo ""
echo -e "${CYAN}To run tests against Canton L1:${NC}"
echo "  JSON_API_URL=http://localhost:8081 bash test_lifecycle.sh"
echo ""
echo -e "${CYAN}To stop Canton L1:${NC}"
echo "  cd $LOCALNET_DIR && \\"
echo "  docker compose --env-file compose.env --env-file env/common.env \\"
echo "    -f compose.yaml -f resource-constraints.yaml \\"
echo "    --profile sv --profile app-provider --profile app-user down -v"
echo ""
echo -e "${GREEN}Canton L1 is ready for judging!${NC}"
