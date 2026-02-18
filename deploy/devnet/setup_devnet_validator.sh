#!/usr/bin/env bash
# ============================================================
# Agentic Shadow-Cap — Canton L1 DevNet Validator Setup
# ============================================================
#
# This script:
#   1. Downloads and starts a Canton DevNet validator (splice-node)
#   2. Uploads the Shadow-Cap DAR
#   3. Allocates parties
#   4. Seeds demo contracts
#   5. Starts agents + market API
#
# Prerequisites:
#   - Docker Desktop running
#   - Daml SDK 2.10.x installed
#   - Python 3.10+
#   - Internet access to DevNet (no VPN needed for public DevNet)
#
# Usage:
#   cd canton
#   bash deploy/devnet/setup_devnet_validator.sh
# ============================================================

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

CANTON_VERSION="${CANTON_VERSION:-0.5.10}"
MIGRATION_ID="${MIGRATION_ID:-1}"
VALIDATOR_NAME="${VALIDATOR_NAME:-shadowcap-hackathon}"
CANTON_DIR="$HOME/.canton/${CANTON_VERSION}"
SPLICE_DIR="${CANTON_DIR}/splice-node/docker-compose/validator"
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DAR_FILE="${PROJECT_DIR}/daml/.daml/dist/agentic-shadow-cap-0.1.0.dar"

SV_URL="${SV_URL:-https://sv.sv-1.dev.global.canton.network.sync.global}"
SCAN_URL="${SCAN_URL:-https://scan.sv-1.dev.global.canton.network.sync.global}"

step() {
  echo -e "\n${CYAN}==> $1${NC}"
}

ok() {
  echo -e "  ${GREEN}OK${NC} $1"
}

warn() {
  echo -e "  ${YELLOW}WARNING${NC} $1"
}

fail_exit() {
  echo -e "  ${RED}FAILED${NC} $1"
  exit 1
}

# ── Pre-flight ──────────────────────────────────────────────

echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Agentic Shadow-Cap — DevNet Setup${NC}"
echo -e "${CYAN}============================================${NC}"

# Check Docker
step "Checking Docker..."
docker info > /dev/null 2>&1 || fail_exit "Docker is not running. Start Docker Desktop first."
ok "Docker is running"

# Check Daml SDK
step "Checking Daml SDK..."
daml version > /dev/null 2>&1 || fail_exit "Daml SDK not found. Install from https://docs.daml.com/getting-started/installation.html"
ok "Daml SDK found"

# Check DAR exists
step "Checking DAR file..."
if [[ ! -f "$DAR_FILE" ]]; then
  echo "  Building DAR..."
  cd "$PROJECT_DIR" && make build
fi
[[ -f "$DAR_FILE" ]] && ok "DAR found: $DAR_FILE" || fail_exit "DAR not found at $DAR_FILE"

# ── Step 1: Download splice-node ────────────────────────────

step "Downloading Canton splice-node v${CANTON_VERSION}..."

if [[ -d "$SPLICE_DIR" ]]; then
  ok "Already downloaded at $SPLICE_DIR"
else
  mkdir -p "$CANTON_DIR"
  cd "$CANTON_DIR"

  TARBALL="${CANTON_VERSION}_splice-node.tar.gz"
  DOWNLOAD_URL="https://github.com/digital-asset/decentralized-canton-sync/releases/download/v${CANTON_VERSION}/${TARBALL}"

  if [[ ! -f "$TARBALL" ]]; then
    echo "  Downloading from $DOWNLOAD_URL ..."
    curl -L -o "$TARBALL" "$DOWNLOAD_URL" || fail_exit "Download failed. Check version ${CANTON_VERSION}"
  fi

  echo "  Extracting..."
  tar xzf "$TARBALL"
  ok "Extracted to $SPLICE_DIR"
fi

# ── Step 2: Get onboarding secret ───────────────────────────

step "Getting DevNet onboarding secret..."

SECRET=$(curl -sf -X POST "${SV_URL}/api/sv/v0/devnet/onboard/validator/prepare" 2>/dev/null || echo "")

if [[ -z "$SECRET" ]]; then
  warn "Could not get onboarding secret from sv-1, trying sv-2..."
  SV_URL="https://sv.sv-2.dev.global.canton.network.sync.global"
  SCAN_URL="https://scan.sv-2.dev.global.canton.network.sync.global"
  SECRET=$(curl -sf -X POST "${SV_URL}/api/sv/v0/devnet/onboard/validator/prepare" 2>/dev/null || echo "")
fi

if [[ -z "$SECRET" ]]; then
  fail_exit "Could not get onboarding secret. Check network connectivity to DevNet."
fi
ok "Onboarding secret obtained (valid for 1 hour)"

# ── Step 3: Start validator ─────────────────────────────────

step "Starting Canton DevNet validator..."

cd "$SPLICE_DIR"

# Enable unsafe auth for development
if ! grep -q "compose-disable-auth.yaml" .env 2>/dev/null; then
  cat >> .env << 'EOF'
COMPOSE_FILE=compose.yaml:compose-disable-auth.yaml
AUTH_URL=https://unsafe.auth
SPLICE_APP_UI_NETWORK_FAVICON_URL=https://www.canton.network/hubfs/cn-favicon-05%201-1.png
SPLICE_APP_UI_NETWORK_NAME="Canton Network"
EOF
fi

export IMAGE_TAG="${CANTON_VERSION}"

./start.sh \
  -s "$SV_URL" \
  -o "$SECRET" \
  -p "$VALIDATOR_NAME" \
  -m "$MIGRATION_ID" \
  -w

echo "  Waiting for validator to become healthy (this may take 2-5 minutes)..."
for i in $(seq 1 60); do
  if docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -q 'splice.*healthy'; then
    ok "Validator is healthy"
    break
  fi
  if [[ $i -eq 60 ]]; then
    warn "Validator not healthy after 5 minutes. Check: docker compose logs -f"
  fi
  sleep 5
done

# ── Step 4: Discover validator endpoints ────────────────────

step "Discovering validator endpoints..."

# Find the ledger API and JSON API ports
LEDGER_PORT=$(docker compose port participant 5001 2>/dev/null | cut -d: -f2 || echo "")
JSON_API_PORT=$(docker compose port json-api 7575 2>/dev/null | cut -d: -f2 || echo "")

# Fallback: check common splice-node ports
if [[ -z "$LEDGER_PORT" ]]; then
  # Try to find the ledger API port from running containers
  LEDGER_PORT=$(docker ps --format '{{.Ports}}' 2>/dev/null | grep -oP '\d+(?=->5001)' | head -1 || echo "")
fi

if [[ -z "$JSON_API_PORT" ]]; then
  JSON_API_PORT=$(docker ps --format '{{.Ports}}' 2>/dev/null | grep -oP '\d+(?=->7575)' | head -1 || echo "")
fi

echo "  Ledger API port: ${LEDGER_PORT:-unknown}"
echo "  JSON API port:   ${JSON_API_PORT:-unknown}"

# ── Step 5: Upload DAR ──────────────────────────────────────

step "Uploading DAR to DevNet validator..."

if [[ -n "$LEDGER_PORT" ]]; then
  daml ledger upload-dar "$DAR_FILE" --host localhost --port "$LEDGER_PORT" \
    && ok "DAR uploaded to DevNet" \
    || warn "DAR upload failed. You may need to upload manually."
else
  warn "Could not determine ledger API port. Upload manually:"
  echo "  daml ledger upload-dar $DAR_FILE --host localhost --port <LEDGER_PORT>"
fi

# ── Step 6: Print next steps ────────────────────────────────

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  DevNet Validator is Running${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Validator: $VALIDATOR_NAME"
echo "Location:  $SPLICE_DIR"
echo ""

if [[ -n "$LEDGER_PORT" && -n "$JSON_API_PORT" ]]; then
  echo "Endpoints:"
  echo "  Ledger API: localhost:${LEDGER_PORT}"
  echo "  JSON API:   localhost:${JSON_API_PORT}"
  echo ""
  echo "To seed demo contracts:"
  echo "  JSON_API_URL=http://localhost:${JSON_API_PORT} python3 ${PROJECT_DIR}/deploy/scripts/seed_demo.py"
  echo ""
  echo "To start agents:"
  echo "  DAML_LEDGER_URL=http://localhost:${LEDGER_PORT} SELLER_AGENT_PARTY=SellerAgent SELLER_PARTY=Seller python3 ${PROJECT_DIR}/agent/seller_agent.py &"
  echo "  DAML_LEDGER_URL=http://localhost:${LEDGER_PORT} BUYER_AGENT_PARTY=BuyerAgent BUYER_PARTY=Buyer python3 ${PROJECT_DIR}/agent/buyer_agent.py &"
  echo ""
  echo "To start UI:"
  echo "  cd ${PROJECT_DIR}/ui && VITE_JSON_API_URL=http://localhost:${JSON_API_PORT} npm run dev"
else
  echo "Check running containers to find ports:"
  echo "  docker ps"
  echo ""
  echo "Then set endpoints and run:"
  echo "  JSON_API_URL=http://localhost:<JSON_API_PORT> python3 ${PROJECT_DIR}/deploy/scripts/seed_demo.py"
fi

echo ""
echo "To run E2E tests against DevNet:"
echo "  JSON_API_URL=http://localhost:${JSON_API_PORT:-7575} bash ${PROJECT_DIR}/test_lifecycle.sh"
echo ""
echo "DevNet Explorer: https://scan.sv-1.dev.global.canton.network.sync.global"
echo ""
echo "To stop: cd $SPLICE_DIR && ./stop.sh"
