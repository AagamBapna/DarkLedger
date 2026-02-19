#!/usr/bin/env bash
# ============================================================
# Agentic Shadow-Cap — Canton Network Demo Runner
# ============================================================
# Starts the full demo against Canton Network participant endpoints:
# 1) Build DAR
# 2) Bootstrap participants (DAR upload + party map + seed)
# 3) Start v1 compatibility gateway
# 4) Start market API + seller/buyer agents
#
# Defaults are LocalNet endpoints:
#   provider: http://127.0.0.1:3975
#   user:     http://127.0.0.1:2975
#
# Override with:
#   CANTON_PROVIDER_URL=...
#   CANTON_USER_URL=...
#   CANTON_PROVIDER_TOKEN / CANTON_USER_TOKEN / CANTON_JWT_TOKEN
# ============================================================

set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

CANTON_PROVIDER_URL="${CANTON_PROVIDER_URL:-http://127.0.0.1:3975}"
CANTON_USER_URL="${CANTON_USER_URL:-http://127.0.0.1:2975}"
CANTON_GATEWAY_PORT="${CANTON_GATEWAY_PORT:-8081}"
MARKET_API_PORT="${MARKET_API_PORT:-8090}"
CANTON_NETWORK_MODE="${CANTON_NETWORK_MODE:-local}"

CANTON_ALLOW_INSECURE_TOKEN="${CANTON_ALLOW_INSECURE_TOKEN:-$([ "$CANTON_NETWORK_MODE" = "local" ] && echo true || echo false)}"
CANTON_INSECURE_SECRET="${CANTON_INSECURE_SECRET:-unsafe}"
CANTON_INSECURE_AUDIENCE="${CANTON_INSECURE_AUDIENCE:-https://canton.network.global}"
CANTON_INSECURE_SUB="${CANTON_INSECURE_SUB:-ledger-api-user}"

SELLER_AGENT_PARTY="${SELLER_AGENT_PARTY:-SellerAgent}"
SELLER_PARTY="${SELLER_PARTY:-Seller}"
BUYER_AGENT_PARTY="${BUYER_AGENT_PARTY:-BuyerAgent}"
BUYER_PARTY="${BUYER_PARTY:-Buyer}"
TARGET_INSTRUMENT="${TARGET_INSTRUMENT:-COMPANY-SERIES-A}"

PYTHON_BIN="${PYTHON_BIN:-${PROJECT_DIR}/.venv/bin/python}"

step() { echo -e "\n${CYAN}==> $1${NC}"; }
ok() { echo -e "  ${GREEN}OK${NC} $1"; }
warn() { echo -e "  ${YELLOW}WARNING${NC} $1"; }

generate_unsafe_token() {
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

wait_for_http() {
  local url="$1"
  local timeout="${2:-120}"
  local start
  start="$(date +%s)"
  while true; do
    if curl -fsS -m 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if (( "$(date +%s)" - start > timeout )); then
      return 1
    fi
    sleep 2
  done
}

echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Agentic Shadow-Cap — Canton Network Demo${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo "  Provider API: $CANTON_PROVIDER_URL"
echo "  User API:     $CANTON_USER_URL"
echo "  Mode:         $CANTON_NETWORK_MODE"
echo ""

step "Checking participant connectivity"
wait_for_http "${CANTON_PROVIDER_URL%/}/v2/version" 30 || {
  echo "  FAILED provider participant not reachable: ${CANTON_PROVIDER_URL%/}/v2/version"
  exit 1
}
wait_for_http "${CANTON_USER_URL%/}/v2/version" 30 || {
  echo "  FAILED user participant not reachable: ${CANTON_USER_URL%/}/v2/version"
  exit 1
}
ok "Both participant APIs are reachable"

step "Preparing Python runtime"
if [[ ! -x "$PYTHON_BIN" ]]; then
  python3 -m venv "${PROJECT_DIR}/.venv"
  PYTHON_BIN="${PROJECT_DIR}/.venv/bin/python"
fi
"$PYTHON_BIN" -m pip install -q --upgrade pip
"$PYTHON_BIN" -m pip install -q -r "${PROJECT_DIR}/agent/requirements.txt"
ok "Python deps installed"

step "Ensuring auth tokens"
if [[ -z "${CANTON_PROVIDER_TOKEN:-}" && -z "${CANTON_USER_TOKEN:-}" && -z "${CANTON_JWT_TOKEN:-}" ]]; then
  if [[ "${CANTON_NETWORK_MODE}" =~ ^(devnet|testnet|mainnet|public)$ ]]; then
    echo "  FAILED missing CANTON_PROVIDER_TOKEN/CANTON_USER_TOKEN (or CANTON_JWT_TOKEN) for mode=${CANTON_NETWORK_MODE}"
    exit 1
  fi
  if [[ "${CANTON_ALLOW_INSECURE_TOKEN}" == "true" ]]; then
    SHARED_TOKEN="$(generate_unsafe_token)"
    export CANTON_PROVIDER_TOKEN="$SHARED_TOKEN"
    export CANTON_USER_TOKEN="$SHARED_TOKEN"
    ok "Generated unsafe HS256 token for local/dev setup"
  else
    warn "No token provided. Set CANTON_PROVIDER_TOKEN / CANTON_USER_TOKEN / CANTON_JWT_TOKEN."
  fi
fi

step "Building DAR"
cd "$PROJECT_DIR"
make build
ok "DAR build completed"

step "Bootstrapping on Canton participant APIs"
export CANTON_NETWORK_MODE CANTON_PROVIDER_URL CANTON_USER_URL
export CANTON_ALLOW_INSECURE_TOKEN CANTON_INSECURE_SECRET CANTON_INSECURE_AUDIENCE CANTON_INSECURE_SUB
"$PYTHON_BIN" "${PROJECT_DIR}/deploy/canton_network/bootstrap.py"
ok "DAR upload + party allocation + seed complete"

step "Stopping stale local demo processes"
pkill -f "deploy.canton_network.v1_gateway:app" >/dev/null 2>&1 || true
pkill -f "agent.market_api:app" >/dev/null 2>&1 || true
pkill -f "agent/seller_agent.py" >/dev/null 2>&1 || true
pkill -f "agent/buyer_agent.py" >/dev/null 2>&1 || true
ok "Old processes cleared"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

PACKAGE_ID_FILE="${PROJECT_DIR}/deploy/canton_network/package_id.txt"
if [[ -f "$PACKAGE_ID_FILE" ]]; then
  export CANTON_PACKAGE_ID="$(cat "$PACKAGE_ID_FILE" | tr -d '\n')"
fi
export CANTON_PARTY_MAP_PATH="${PROJECT_DIR}/deploy/canton_network/party_map.json"

step "Starting v1 compatibility gateway"
"$PYTHON_BIN" -m uvicorn deploy.canton_network.v1_gateway:app --host 0.0.0.0 --port "$CANTON_GATEWAY_PORT" &
PIDS+=($!)
wait_for_http "http://127.0.0.1:${CANTON_GATEWAY_PORT}/status" 45 || {
  echo "  FAILED gateway did not become healthy"
  exit 1
}
ok "Gateway is live at http://localhost:${CANTON_GATEWAY_PORT}"

step "Resetting agent controls"
printf '{\n  "seller_auto_reprice": true,\n  "buyer_auto_reprice": true\n}\n' > "${PROJECT_DIR}/agent/agent_controls.json"
ok "Agent controls reset"

step "Starting market API"
MARKET_FEED_PATH="${PROJECT_DIR}/agent/mock_market_feed.json" \
AGENT_CONTROL_PATH="${PROJECT_DIR}/agent/agent_controls.json" \
"$PYTHON_BIN" -m uvicorn agent.market_api:app --host 0.0.0.0 --port "$MARKET_API_PORT" &
PIDS+=($!)
wait_for_http "http://127.0.0.1:${MARKET_API_PORT}/status" 45 || {
  echo "  FAILED market API did not become healthy"
  exit 1
}
ok "Market API is live at http://localhost:${MARKET_API_PORT}"

step "Starting seller agent"
PYTHONUNBUFFERED=1 \
CANTON_NETWORK_MODE="${CANTON_NETWORK_MODE}" \
DAML_LEDGER_MODE=http-json \
DAML_HTTP_JSON_URL="http://127.0.0.1:${CANTON_GATEWAY_PORT}" \
SELLER_AGENT_PARTY="${SELLER_AGENT_PARTY}" \
SELLER_PARTY="${SELLER_PARTY}" \
MARKET_FEED_PATH="${PROJECT_DIR}/agent/mock_market_feed.json" \
AGENT_CONTROL_PATH="${PROJECT_DIR}/agent/agent_controls.json" \
"$PYTHON_BIN" "${PROJECT_DIR}/agent/seller_agent.py" &
PIDS+=($!)
ok "Seller agent started"

step "Starting buyer agent"
PYTHONUNBUFFERED=1 \
CANTON_NETWORK_MODE="${CANTON_NETWORK_MODE}" \
DAML_LEDGER_MODE=http-json \
DAML_HTTP_JSON_URL="http://127.0.0.1:${CANTON_GATEWAY_PORT}" \
BUYER_AGENT_PARTY="${BUYER_AGENT_PARTY}" \
BUYER_PARTY="${BUYER_PARTY}" \
TARGET_INSTRUMENT="${TARGET_INSTRUMENT}" \
MARKET_FEED_PATH="${PROJECT_DIR}/agent/mock_market_feed.json" \
AGENT_CONTROL_PATH="${PROJECT_DIR}/agent/agent_controls.json" \
"$PYTHON_BIN" "${PROJECT_DIR}/agent/buyer_agent.py" &
PIDS+=($!)
ok "Buyer agent started"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Canton Network Demo is LIVE${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  JSON API (v1-compatible): http://localhost:${CANTON_GATEWAY_PORT}"
echo "  Market API:               http://localhost:${MARKET_API_PORT}"
echo ""
echo "  UI command:"
echo "    cd ui && npm install"
echo "    VITE_JSON_API_URL=http://localhost:${CANTON_GATEWAY_PORT} \\"
echo "      VITE_MARKET_API_URL=http://localhost:${MARKET_API_PORT} \\"
echo "      VITE_JSON_API_USE_INSECURE_TOKEN=false npm run dev"
echo ""
echo "  Press Ctrl+C to stop gateway/agents started by this script."
echo ""

wait
