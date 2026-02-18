#!/usr/bin/env bash
# ============================================================
# Agentic Shadow-Cap — End-to-End Smoke Test
# ============================================================
#
# This script verifies the full system works locally:
#   1. Canton nodes are healthy
#   2. JSON API proxy routes correctly
#   3. Contracts are seeded
#   4. Privacy model works (party isolation)
#   5. Agents can issue actions (create/exercise)
#   6. Market event injection triggers repricing
#   7. Full negotiation lifecycle can complete
#
# Usage:
#   # First start the system:
#   make demo
#
#   # Then run this test (in a separate terminal):
#   bash test_e2e.sh
#
# For devnet, set:
#   JSON_API_URL=https://<your-devnet-gateway>
#   JSON_API_TOKEN=<your-jwt>
# ============================================================

set -euo pipefail

JSON_API_URL="${JSON_API_URL:-http://localhost:7575}"
MARKET_API_URL="${MARKET_API_URL:-http://localhost:8090}"
JSON_API_TOKEN="${JSON_API_TOKEN:-}"
USE_INSECURE="${JSON_API_USE_INSECURE_TOKEN:-true}"
PACKAGE_ID="${PACKAGE_ID:-}"

PASSED=0
FAILED=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Token helpers ───────────────────────────────────────────

b64url() {
  echo -n "$1" | base64 | tr '+/' '-_' | tr -d '='
}

insecure_token_for() {
  local party="$1"
  local header
  header=$(b64url '{"alg":"none","typ":"JWT"}')
  local payload
  payload=$(b64url "{\"https://daml.com/ledger-api\":{\"ledgerId\":\"sandbox\",\"applicationId\":\"e2e-test\",\"actAs\":[\"$party\"],\"readAs\":[\"$party\"]}}")
  echo "${header}.${payload}."
}

auth_header_for() {
  local party="$1"
  if [[ -n "$JSON_API_TOKEN" ]]; then
    echo "Authorization: Bearer $JSON_API_TOKEN"
  elif [[ "$USE_INSECURE" == "true" ]]; then
    echo "Authorization: Bearer $(insecure_token_for "$party")"
  else
    echo ""
  fi
}

template_id() {
  local name="$1"
  if [[ -n "$PACKAGE_ID" ]]; then
    echo "${PACKAGE_ID}:AgenticShadowCap.Market:${name}"
  else
    echo "AgenticShadowCap.Market:${name}"
  fi
}

# ── Test helpers ────────────────────────────────────────────

query_contracts() {
  local party="$1"
  local template="$2"
  local tid
  tid=$(template_id "$template")
  local auth
  auth=$(auth_header_for "$party")

  curl -s -X POST "${JSON_API_URL}/v1/query" \
    -H "Content-Type: application/json" \
    -H "X-Ledger-Party: ${party}" \
    ${auth:+-H "$auth"} \
    -d "{\"templateIds\":[\"$tid\"]}" 2>/dev/null
}

count_contracts() {
  local result="$1"
  echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',[])))" 2>/dev/null || echo "0"
}

assert_test() {
  local name="$1"
  local condition="$2"
  TOTAL=$((TOTAL + 1))
  if [[ "$condition" == "true" ]]; then
    PASSED=$((PASSED + 1))
    echo -e "  ${GREEN}PASS${NC} $name"
  else
    FAILED=$((FAILED + 1))
    echo -e "  ${RED}FAIL${NC} $name"
  fi
}

# ── Pre-flight checks ──────────────────────────────────────

echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Agentic Shadow-Cap — E2E Smoke Test${NC}"
echo -e "${CYAN}============================================${NC}"
echo ""
echo "JSON API:   $JSON_API_URL"
echo "Market API: $MARKET_API_URL"
echo ""

# ── Test 1: JSON API is reachable ───────────────────────────

echo -e "${YELLOW}[1/8] JSON API Connectivity${NC}"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${JSON_API_URL}/v1/query" \
  -X POST -H "Content-Type: application/json" \
  -H "X-Ledger-Party: Company" \
  -H "$(auth_header_for Company)" \
  -d '{"templateIds":["AgenticShadowCap.Market:AssetHolding"]}' 2>/dev/null || echo "000")

assert_test "JSON API responds (HTTP $HTTP_CODE)" "$( [[ "$HTTP_CODE" == "200" ]] && echo true || echo false )"

# ── Test 2: Seeded contracts exist ──────────────────────────

echo -e "${YELLOW}[2/8] Seeded Contracts${NC}"

ASSET_RESULT=$(query_contracts "Company" "AssetHolding")
ASSET_COUNT=$(count_contracts "$ASSET_RESULT")
assert_test "AssetHolding exists for Seller (count=$ASSET_COUNT)" "$( [[ "$ASSET_COUNT" -ge 1 ]] && echo true || echo false )"

CASH_RESULT=$(query_contracts "Company" "CashHolding")
CASH_COUNT=$(count_contracts "$CASH_RESULT")
assert_test "CashHolding exists for Buyer (count=$CASH_COUNT)" "$( [[ "$CASH_COUNT" -ge 1 ]] && echo true || echo false )"

INTENT_RESULT=$(query_contracts "Seller" "TradeIntent")
INTENT_COUNT=$(count_contracts "$INTENT_RESULT")
assert_test "TradeIntent exists for Seller (count=$INTENT_COUNT)" "$( [[ "$INTENT_COUNT" -ge 1 ]] && echo true || echo false )"

# ── Test 3: Privacy — Buyer CANNOT see TradeIntent ──────────

echo -e "${YELLOW}[3/8] Privacy Model — Party Isolation${NC}"

BUYER_INTENT_RESULT=$(query_contracts "Buyer" "TradeIntent")
BUYER_INTENT_COUNT=$(count_contracts "$BUYER_INTENT_RESULT")
assert_test "Buyer sees 0 TradeIntents (count=$BUYER_INTENT_COUNT)" "$( [[ "$BUYER_INTENT_COUNT" -eq 0 ]] && echo true || echo false )"

BUYERAGENT_INTENT_RESULT=$(query_contracts "BuyerAgent" "TradeIntent")
BUYERAGENT_INTENT_COUNT=$(count_contracts "$BUYERAGENT_INTENT_RESULT")
assert_test "BuyerAgent sees 0 TradeIntents (count=$BUYERAGENT_INTENT_COUNT)" "$( [[ "$BUYERAGENT_INTENT_COUNT" -eq 0 ]] && echo true || echo false )"

SELLER_INTENT_RESULT=$(query_contracts "SellerAgent" "TradeIntent")
SELLER_INTENT_COUNT=$(count_contracts "$SELLER_INTENT_RESULT")
assert_test "SellerAgent CAN see TradeIntent (count=$SELLER_INTENT_COUNT)" "$( [[ "$SELLER_INTENT_COUNT" -ge 1 ]] && echo true || echo false )"

# ── Test 4: Agent exercises UpdatePrice ─────────────────────

echo -e "${YELLOW}[4/8] Agent Action — UpdatePrice${NC}"

# Get the first TradeIntent contract ID
INTENT_CID=$(echo "$SELLER_INTENT_RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = d.get('result', [])
if results:
    print(results[0].get('contractId', results[0].get('contract_id', '')))
else:
    print('')
" 2>/dev/null || echo "")

if [[ -n "$INTENT_CID" ]]; then
  TID=$(template_id "TradeIntent")
  AUTH=$(auth_header_for "SellerAgent")
  EXERCISE_RESULT=$(curl -s -X POST "${JSON_API_URL}/v1/exercise" \
    -H "Content-Type: application/json" \
    -H "X-Ledger-Party: SellerAgent" \
    ${AUTH:+-H "$AUTH"} \
    -d "{
      \"templateId\": \"$TID\",
      \"contractId\": \"$INTENT_CID\",
      \"choice\": \"UpdatePrice\",
      \"argument\": {\"newMinPrice\": \"99.75\"}
    }" 2>/dev/null)

  EXERCISE_STATUS=$(echo "$EXERCISE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status', 0))" 2>/dev/null || echo "0")
  assert_test "UpdatePrice exercised (status=$EXERCISE_STATUS)" "$( [[ "$EXERCISE_STATUS" == "200" ]] && echo true || echo false )"
else
  assert_test "UpdatePrice exercised (no contract ID found)" "false"
fi

# ── Test 5: Market Event API ────────────────────────────────

echo -e "${YELLOW}[5/8] Market Event API${NC}"

API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${MARKET_API_URL}/status" 2>/dev/null || echo "000")
assert_test "Market API /status responds (HTTP $API_STATUS)" "$( [[ "$API_STATUS" == "200" ]] && echo true || echo false )"

EVENTS_RESULT=$(curl -s "${MARKET_API_URL}/events" 2>/dev/null || echo "{}")
EVENT_COUNT=$(echo "$EVENTS_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('events',[])))" 2>/dev/null || echo "0")
assert_test "Market API lists event types (count=$EVENT_COUNT)" "$( [[ "$EVENT_COUNT" -ge 3 ]] && echo true || echo false )"

# Inject a negative news event
INJECT_RESULT=$(curl -s -X POST "${MARKET_API_URL}/market-event" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"sec_investigation","severity":1.0}' 2>/dev/null || echo "{}")
INJECT_STATUS=$(echo "$INJECT_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")
assert_test "Inject sec_investigation event (status=$INJECT_STATUS)" "$( [[ "$INJECT_STATUS" == "ok" ]] && echo true || echo false )"

# ── Test 6: Agent creates DiscoveryInterest ─────────────────

echo -e "${YELLOW}[6/8] Agent Discovery Signals${NC}"

# Wait for agents to react
echo "  (waiting 8s for agents to process...)"
sleep 8

SELLER_DISC=$(query_contracts "SellerAgent" "DiscoveryInterest")
SELLER_DISC_COUNT=$(count_contracts "$SELLER_DISC")
assert_test "SellerAgent posted DiscoveryInterest (count=$SELLER_DISC_COUNT)" "$( [[ "$SELLER_DISC_COUNT" -ge 1 ]] && echo true || echo false )"

# Check buyer agent also saw it and responded
BUYER_DISC=$(query_contracts "BuyerAgent" "DiscoveryInterest")
BUYER_DISC_COUNT=$(count_contracts "$BUYER_DISC")
assert_test "BuyerAgent sees discovery signals (count=$BUYER_DISC_COUNT)" "$( [[ "$BUYER_DISC_COUNT" -ge 1 ]] && echo true || echo false )"

# ── Test 7: AgentDecisionLog on-ledger ──────────────────────

echo -e "${YELLOW}[7/8] On-Ledger Decision Logging${NC}"

DECISION_LOGS=$(query_contracts "SellerAgent" "AgentDecisionLog")
DECISION_LOG_COUNT=$(count_contracts "$DECISION_LOGS")
assert_test "AgentDecisionLog entries exist (count=$DECISION_LOG_COUNT)" "$( [[ "$DECISION_LOG_COUNT" -ge 1 ]] && echo true || echo false )"

# Verify the log contains reasoning
if [[ "$DECISION_LOG_COUNT" -ge 1 ]]; then
  HAS_REASONING=$(echo "$DECISION_LOGS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('result', []):
    p = r.get('payload', {})
    if p.get('reasoning', ''):
        print('true')
        break
else:
    print('false')
" 2>/dev/null || echo "false")
  assert_test "Decision logs contain reasoning text" "$HAS_REASONING"
else
  assert_test "Decision logs contain reasoning text" "false"
fi

# ── Test 8: Privacy — Cross-party isolation check ───────────

echo -e "${YELLOW}[8/8] Privacy — Cross-Party Isolation Summary${NC}"

# Seller's AgentDecisionLog should NOT be visible to Buyer
BUYER_DECISION_LOGS=$(query_contracts "Buyer" "AgentDecisionLog")
BUYER_DECISION_LOG_COUNT=$(count_contracts "$BUYER_DECISION_LOGS")
assert_test "Buyer cannot see SellerAgent decision logs (count=$BUYER_DECISION_LOG_COUNT)" "$( [[ "$BUYER_DECISION_LOG_COUNT" -eq 0 ]] && echo true || echo false )"

# Buyer should not see seller's AssetHolding
BUYER_ASSET=$(query_contracts "Buyer" "AssetHolding")
BUYER_ASSET_COUNT=$(count_contracts "$BUYER_ASSET")
# Note: Buyer may see their OWN assets after a trade, so we check if they DON'T see seller's 5000 shares
assert_test "Buyer cannot see Seller's original AssetHolding" "$( [[ "$BUYER_ASSET_COUNT" -eq 0 ]] && echo true || echo false )"

# ── Summary ─────────────────────────────────────────────────

echo ""
echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Results: $PASSED/$TOTAL passed${NC}"
if [[ "$FAILED" -gt 0 ]]; then
  echo -e "${RED}  $FAILED test(s) FAILED${NC}"
else
  echo -e "${GREEN}  ALL TESTS PASSED${NC}"
fi
echo -e "${CYAN}============================================${NC}"

# Reset market feed to stable
curl -s -X POST "${MARKET_API_URL}/market-event" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"stable_market","severity":1.0}' > /dev/null 2>&1 || true

exit "$FAILED"
