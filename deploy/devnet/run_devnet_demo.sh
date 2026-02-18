#!/usr/bin/env bash
set -euo pipefail

# Required:
#   SELLER_LEDGER_HOST SELLER_LEDGER_PORT
#   BUYER_LEDGER_HOST  BUYER_LEDGER_PORT
#   ISSUER_LEDGER_HOST ISSUER_LEDGER_PORT
#   JSON_API_URL
#
# Optional:
#   JSON_API_TOKEN
#   PACKAGE_ID

required=(
  SELLER_LEDGER_HOST SELLER_LEDGER_PORT
  BUYER_LEDGER_HOST BUYER_LEDGER_PORT
  ISSUER_LEDGER_HOST ISSUER_LEDGER_PORT
  JSON_API_URL
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "[devnet] missing env: $name" >&2
    exit 1
  fi
done

echo "[devnet] building DAR..."
make build

DAR_PATH="daml/.daml/dist/agentic-shadow-cap-0.1.0.dar"
if [[ ! -f "$DAR_PATH" ]]; then
  echo "[devnet] DAR not found: $DAR_PATH" >&2
  exit 1
fi

echo "[devnet] uploading DAR to seller participant..."
daml ledger upload-dar "$DAR_PATH" --host "$SELLER_LEDGER_HOST" --port "$SELLER_LEDGER_PORT"
echo "[devnet] uploading DAR to buyer participant..."
daml ledger upload-dar "$DAR_PATH" --host "$BUYER_LEDGER_HOST" --port "$BUYER_LEDGER_PORT"
echo "[devnet] uploading DAR to issuer participant..."
daml ledger upload-dar "$DAR_PATH" --host "$ISSUER_LEDGER_HOST" --port "$ISSUER_LEDGER_PORT"

echo "[devnet] seeding contracts via JSON API..."
python3 deploy/scripts/seed_demo.py

cat <<'EOF'
[devnet] bootstrap complete.

Next:
1) Start market API:
   AGENT_CONTROL_PATH=agent/agent_controls.json MARKET_FEED_PATH=agent/mock_market_feed.json \
   uvicorn agent.market_api:app --host 0.0.0.0 --port 8090

2) Start seller agent:
   DAML_LEDGER_URL=http://$SELLER_LEDGER_HOST:$SELLER_LEDGER_PORT \
   SELLER_AGENT_PARTY=SellerAgent SELLER_PARTY=Seller \
   AGENT_CONTROL_PATH=agent/agent_controls.json \
   python3 agent/seller_agent.py

3) Start buyer agent:
   DAML_LEDGER_URL=http://$BUYER_LEDGER_HOST:$BUYER_LEDGER_PORT \
   BUYER_AGENT_PARTY=BuyerAgent BUYER_PARTY=Buyer TARGET_INSTRUMENT=COMPANY-SERIES-A \
   AGENT_CONTROL_PATH=agent/agent_controls.json \
   python3 agent/buyer_agent.py

4) Start UI:
   cd ui && VITE_JSON_API_URL=$JSON_API_URL VITE_MARKET_API_URL=http://localhost:8090 npm run dev
EOF
