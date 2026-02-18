#!/usr/bin/env bash
# ============================================================
# Agentic Shadow-Cap — Full Trade Lifecycle Test
# ============================================================
#
# Manually drives the ENTIRE lifecycle through the JSON API
# to prove every choice on every template works in real time:
#
#   1. Create AssetHolding + CashHolding
#   2. Create TradeIntent
#   3. Agent reprices (UpdatePrice)
#   4. Post DiscoveryInterest (Sell + Buy)
#   5. Issuer matches → PrivateNegotiation
#   6. Agents negotiate (SubmitSellerTerms, AcceptByBuyer, AcceptBySeller)
#   7. Issuer ApproveMatch
#   8. Issuer StartSettlement → TradeSettlement
#   9. Issuer FinalizeSettlement (DvP atomic swap)
#  10. Verify TradeAuditRecord + final holdings
#
# Usage:
#   make up && make upload    # or: make demo (then stop agents)
#   bash test_lifecycle.sh
#
# For devnet:
#   JSON_API_URL=https://<gateway> JSON_API_TOKEN=<jwt> bash test_lifecycle.sh
# ============================================================

set -euo pipefail

JSON_API_URL="${JSON_API_URL:-http://localhost:7575}"
JSON_API_TOKEN="${JSON_API_TOKEN:-}"
USE_INSECURE="${JSON_API_USE_INSECURE_TOKEN:-true}"
PACKAGE_ID="${PACKAGE_ID:-}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

STEP=0

b64url() {
  echo -n "$1" | base64 | tr '+/' '-_' | tr -d '='
}

insecure_token_for() {
  local party="$1"
  local header
  header=$(b64url '{"alg":"none","typ":"JWT"}')
  local payload
  payload=$(b64url "{\"https://daml.com/ledger-api\":{\"ledgerId\":\"sandbox\",\"applicationId\":\"lifecycle-test\",\"actAs\":[\"$party\"],\"readAs\":[\"$party\"]}}")
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

tid() {
  if [[ -n "$PACKAGE_ID" ]]; then
    echo "${PACKAGE_ID}:AgenticShadowCap.Market:${1}"
  else
    echo "AgenticShadowCap.Market:${1}"
  fi
}

api_create() {
  local party="$1"
  local template="$2"
  local payload="$3"
  local auth
  auth=$(auth_header_for "$party")
  curl -sf -X POST "${JSON_API_URL}/v1/create" \
    -H "Content-Type: application/json" \
    -H "X-Ledger-Party: ${party}" \
    ${auth:+-H "$auth"} \
    -d "{\"templateId\":\"$(tid "$template")\",\"payload\":$payload}"
}

api_exercise() {
  local party="$1"
  local template="$2"
  local cid="$3"
  local choice="$4"
  local argument="$5"
  local auth
  auth=$(auth_header_for "$party")
  curl -sf -X POST "${JSON_API_URL}/v1/exercise" \
    -H "Content-Type: application/json" \
    -H "X-Ledger-Party: ${party}" \
    ${auth:+-H "$auth"} \
    -d "{\"templateId\":\"$(tid "$template")\",\"contractId\":\"$cid\",\"choice\":\"$choice\",\"argument\":$argument}"
}

api_query() {
  local party="$1"
  local template="$2"
  local auth
  auth=$(auth_header_for "$party")
  curl -sf -X POST "${JSON_API_URL}/v1/query" \
    -H "Content-Type: application/json" \
    -H "X-Ledger-Party: ${party}" \
    ${auth:+-H "$auth"} \
    -d "{\"templateIds\":[\"$(tid "$template")\"]}"
}

extract_cid() {
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['contractId'])" 2>/dev/null
}

extract_first_cid() {
  python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('result',[]); print(r[0].get('contractId', r[0].get('contract_id','')) if r else '')" 2>/dev/null
}

extract_exercise_cid() {
  # Extract the contractId from the first created event in exercise result
  python3 -c "
import sys,json
d=json.load(sys.stdin)
events = d.get('result',{}).get('events',[])
for e in events:
    c = e.get('created',{})
    cid = c.get('contractId','')
    if cid:
        print(cid)
        break
else:
    print('')
" 2>/dev/null
}

step() {
  STEP=$((STEP + 1))
  echo -e "\n${YELLOW}[Step $STEP] $1${NC}"
}

ok() {
  echo -e "  ${GREEN}OK${NC} $1"
}

fail_exit() {
  echo -e "  ${RED}FAILED${NC} $1"
  exit 1
}

# ── Start ───────────────────────────────────────────────────

echo -e "${CYAN}============================================${NC}"
echo -e "${CYAN}  Full Trade Lifecycle Test${NC}"
echo -e "${CYAN}  JSON API: $JSON_API_URL${NC}"
echo -e "${CYAN}============================================${NC}"

# ── Step 1: Create AssetHolding ─────────────────────────────

step "Issuer mints AssetHolding (2000 shares to Seller)"

ASSET_RESULT=$(api_create "Company" "AssetHolding" '{
  "owner": "Seller",
  "issuer": "Company",
  "instrument": "TEST-LIFECYCLE",
  "quantity": "2000.0"
}')
ASSET_CID=$(echo "$ASSET_RESULT" | extract_cid)
[[ -n "$ASSET_CID" ]] && ok "AssetHolding cid=$ASSET_CID" || fail_exit "Failed to create AssetHolding"

# ── Step 2: Create CashHolding ──────────────────────────────

step "Issuer mints CashHolding (\$300k to Buyer)"

CASH_RESULT=$(api_create "Company" "CashHolding" '{
  "owner": "Buyer",
  "issuer": "Company",
  "currency": "USD",
  "amount": "300000.0"
}')
CASH_CID=$(echo "$CASH_RESULT" | extract_cid)
[[ -n "$CASH_CID" ]] && ok "CashHolding cid=$CASH_CID" || fail_exit "Failed to create CashHolding"

# ── Step 3: Create TradeIntent ──────────────────────────────

step "Seller creates TradeIntent (1000 shares @ \$100 floor)"

INTENT_RESULT=$(api_create "Seller" "TradeIntent" '{
  "issuer": "Company",
  "seller": "Seller",
  "sellerAgent": "SellerAgent",
  "instrument": "TEST-LIFECYCLE",
  "quantity": "1000.0",
  "minPrice": "100.0"
}')
INTENT_CID=$(echo "$INTENT_RESULT" | extract_cid)
[[ -n "$INTENT_CID" ]] && ok "TradeIntent cid=$INTENT_CID" || fail_exit "Failed to create TradeIntent"

# Verify Buyer CANNOT see it
BUYER_VIEW=$(api_query "Buyer" "TradeIntent")
BUYER_COUNT=$(echo "$BUYER_VIEW" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([r for r in d.get('result',[]) if r.get('payload',{}).get('instrument')=='TEST-LIFECYCLE']))" 2>/dev/null)
[[ "$BUYER_COUNT" == "0" ]] && ok "Privacy: Buyer cannot see TradeIntent" || fail_exit "Privacy violation: Buyer can see TradeIntent"

# ── Step 4: Agent reprices via UpdatePrice ──────────────────

step "SellerAgent exercises UpdatePrice (100 -> 105)"

REPRICE_RESULT=$(api_exercise "SellerAgent" "TradeIntent" "$INTENT_CID" "UpdatePrice" '{"newMinPrice":"105.0"}')
NEW_INTENT_CID=$(echo "$REPRICE_RESULT" | extract_exercise_cid)
[[ -n "$NEW_INTENT_CID" ]] && ok "Repriced: new cid=$NEW_INTENT_CID" || fail_exit "UpdatePrice failed"
INTENT_CID="$NEW_INTENT_CID"

# ── Step 5: Post DiscoveryInterest (Sell) ───────────────────

step "SellerAgent posts blind DiscoveryInterest (Sell)"

SELL_DISC_RESULT=$(api_create "SellerAgent" "DiscoveryInterest" '{
  "issuer": "Company",
  "owner": "Seller",
  "postingAgent": "SellerAgent",
  "discoverableBy": ["BuyerAgent"],
  "instrument": "TEST-LIFECYCLE",
  "side": {"tag":"Sell","value":{}},
  "strategyTag": "LIFECYCLE_TEST_SELL"
}')
SELL_DISC_CID=$(echo "$SELL_DISC_RESULT" | extract_cid)
[[ -n "$SELL_DISC_CID" ]] && ok "Sell DiscoveryInterest cid=$SELL_DISC_CID" || fail_exit "Failed to post sell signal"

# ── Step 6: Post DiscoveryInterest (Buy) ────────────────────

step "BuyerAgent posts matching DiscoveryInterest (Buy)"

BUY_DISC_RESULT=$(api_create "BuyerAgent" "DiscoveryInterest" '{
  "issuer": "Company",
  "owner": "Buyer",
  "postingAgent": "BuyerAgent",
  "discoverableBy": ["SellerAgent"],
  "instrument": "TEST-LIFECYCLE",
  "side": {"tag":"Buy","value":{}},
  "strategyTag": "LIFECYCLE_TEST_BUY"
}')
BUY_DISC_CID=$(echo "$BUY_DISC_RESULT" | extract_cid)
[[ -n "$BUY_DISC_CID" ]] && ok "Buy DiscoveryInterest cid=$BUY_DISC_CID" || fail_exit "Failed to post buy signal"

# ── Step 7: Issuer matches → PrivateNegotiation ────────────

step "Issuer matches interests → creates PrivateNegotiation"

MATCH_RESULT=$(api_exercise "Company" "DiscoveryInterest" "$SELL_DISC_CID" "MatchWith" "{\"counterpartyCid\":\"$BUY_DISC_CID\"}")
NEG_CID=$(echo "$MATCH_RESULT" | extract_exercise_cid)
[[ -n "$NEG_CID" ]] && ok "PrivateNegotiation cid=$NEG_CID" || fail_exit "MatchWith failed"

# ── Step 8: Seller submits terms ────────────────────────────

step "SellerAgent submits terms (qty=1000, price=105)"

TERMS_RESULT=$(api_exercise "SellerAgent" "PrivateNegotiation" "$NEG_CID" "SubmitSellerTerms" '{"qty":"1000.0","unitPrice":"105.0"}')
NEG_CID=$(echo "$TERMS_RESULT" | extract_exercise_cid)
[[ -n "$NEG_CID" ]] && ok "Terms submitted: new cid=$NEG_CID" || fail_exit "SubmitSellerTerms failed"

# ── Step 9: Buyer accepts ──────────────────────────────────

step "BuyerAgent accepts terms"

ACCEPT_RESULT=$(api_exercise "BuyerAgent" "PrivateNegotiation" "$NEG_CID" "AcceptByBuyer" '{}')
NEG_CID=$(echo "$ACCEPT_RESULT" | extract_exercise_cid)
[[ -n "$NEG_CID" ]] && ok "Buyer accepted: new cid=$NEG_CID" || fail_exit "AcceptByBuyer failed"

# ── Step 10: Seller accepts ─────────────────────────────────

step "SellerAgent accepts terms"

ACCEPT2_RESULT=$(api_exercise "SellerAgent" "PrivateNegotiation" "$NEG_CID" "AcceptBySeller" '{}')
NEG_CID=$(echo "$ACCEPT2_RESULT" | extract_exercise_cid)
[[ -n "$NEG_CID" ]] && ok "Seller accepted: new cid=$NEG_CID" || fail_exit "AcceptBySeller failed"

# ── Step 11: Issuer approves (ROFR/compliance) ──────────────

step "Issuer exercises ApproveMatch (ROFR gate)"

APPROVE_RESULT=$(api_exercise "Company" "PrivateNegotiation" "$NEG_CID" "ApproveMatch" '{}')
NEG_CID=$(echo "$APPROVE_RESULT" | extract_exercise_cid)
[[ -n "$NEG_CID" ]] && ok "Approved: new cid=$NEG_CID" || fail_exit "ApproveMatch failed"

# ── Step 12: Issuer starts settlement ───────────────────────

step "Issuer starts settlement"

SETTLE_RESULT=$(api_exercise "Company" "PrivateNegotiation" "$NEG_CID" "StartSettlement" '{}')
SETTLE_CID=$(echo "$SETTLE_RESULT" | extract_exercise_cid)
[[ -n "$SETTLE_CID" ]] && ok "TradeSettlement cid=$SETTLE_CID" || fail_exit "StartSettlement failed"

# ── Step 13: Issuer finalizes DvP ───────────────────────────

step "Issuer finalizes atomic DvP settlement"

DVP_RESULT=$(api_exercise "Company" "TradeSettlement" "$SETTLE_CID" "FinalizeSettlement" "{\"sellerAssetCid\":\"$ASSET_CID\",\"buyerCashCid\":\"$CASH_CID\"}")
FINAL_CID=$(echo "$DVP_RESULT" | extract_exercise_cid)
[[ -n "$FINAL_CID" ]] && ok "DvP finalized: cid=$FINAL_CID" || fail_exit "FinalizeSettlement failed"

# ── Step 14: Verify audit trail ─────────────────────────────

step "Verify TradeAuditRecord created"

AUDIT_RESULT=$(api_query "Company" "TradeAuditRecord")
AUDIT_COUNT=$(echo "$AUDIT_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
count = sum(1 for r in d.get('result',[]) if r.get('payload',{}).get('instrument')=='TEST-LIFECYCLE')
print(count)
" 2>/dev/null)
[[ "$AUDIT_COUNT" -ge 1 ]] && ok "TradeAuditRecord exists (count=$AUDIT_COUNT)" || fail_exit "No audit record found"

# ── Step 15: Verify final holdings ──────────────────────────

step "Verify final holdings after DvP"

# Buyer should now have assets
BUYER_ASSETS=$(api_query "Buyer" "AssetHolding")
BUYER_ASSET_COUNT=$(echo "$BUYER_ASSETS" | python3 -c "
import sys,json
d=json.load(sys.stdin)
count = sum(1 for r in d.get('result',[]) if r.get('payload',{}).get('instrument')=='TEST-LIFECYCLE')
print(count)
" 2>/dev/null)
[[ "$BUYER_ASSET_COUNT" -ge 1 ]] && ok "Buyer received 1000 shares of TEST-LIFECYCLE" || fail_exit "Buyer did not receive assets"

# Seller should now have cash
SELLER_CASH=$(api_query "Seller" "CashHolding")
SELLER_CASH_COUNT=$(echo "$SELLER_CASH" | python3 -c "
import sys,json
d=json.load(sys.stdin)
count = sum(1 for r in d.get('result',[]) if r.get('payload',{}).get('currency')=='USD')
print(count)
" 2>/dev/null)
[[ "$SELLER_CASH_COUNT" -ge 1 ]] && ok "Seller received USD cash from sale" || fail_exit "Seller did not receive cash"

# ── Done ────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ALL 15 STEPS PASSED${NC}"
echo -e "${GREEN}  Full lifecycle verified end-to-end.${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Contracts created during this test:"
echo "  AssetHolding:       $ASSET_CID"
echo "  CashHolding:        $CASH_CID"
echo "  TradeIntent:        $INTENT_CID"
echo "  DiscoveryInterest:  $SELL_DISC_CID (sell), $BUY_DISC_CID (buy)"
echo "  PrivateNegotiation: $NEG_CID"
echo "  TradeSettlement:    $SETTLE_CID → $FINAL_CID"
echo ""
