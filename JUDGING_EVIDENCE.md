# Judging Evidence — Agentic Shadow-Cap

This document provides the evidence artifacts that judges can use to evaluate the submission.

---

## 1. Network Proof

- Network mode used: `<local/devnet/testnet/mainnet>`
- Provider endpoint: `<url>`
- User endpoint: `<url>`

### Verify Connectivity
```bash
curl -s <CANTON_PROVIDER_URL>/v2/version | python3 -m json.tool
curl -s <CANTON_USER_URL>/v2/version | python3 -m json.tool
```

- `GET /v2/version` provider output: `<paste>`
- `GET /v2/version` user output: `<paste>`

---

## 2. Runtime Health

### Gateway Status
```bash
curl -s http://localhost:8081/status | python3 -m json.tool
```
- Output: `<paste>`

### Market API Status
```bash
curl -s http://localhost:8090/status | python3 -m json.tool
```
- Output: `<paste>`

### Container / Process Status
```bash
make status
```
- Screenshot: `<add>`

---

## 3. Privacy Proof (Screenshots Required)

| Perspective | What to Capture | Screenshot |
|---|---|---|
| **Seller** | Private holdings + TradeIntent visible | `<add>` |
| **SellerAgent** | Same intents + agent decision logs | `<add>` |
| **Buyer** | Cash holdings only, NO trade intents | `<add>` |
| **BuyerAgent** | Discovery signals, negotiations when matched | `<add>` |
| **Company** | All negotiations, approval queue, audit trail | `<add>` |
| **Public** | **ZERO contracts — complete privacy proof** | `<add>` |

### Privacy Verification CLI Commands

```bash
# Seller sees TradeIntent
curl -s -X POST http://localhost:7575/v1/query \
  -H "Content-Type: application/json" \
  -H "X-Ledger-Party: Seller" \
  -d '{"templateIds":["AgenticShadowCap.Market:TradeIntent"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'TradeIntents visible to Seller: {len(d.get(\"result\",[]))}')"

# Buyer does NOT see TradeIntent
curl -s -X POST http://localhost:7575/v1/query \
  -H "Content-Type: application/json" \
  -H "X-Ledger-Party: Buyer" \
  -d '{"templateIds":["AgenticShadowCap.Market:TradeIntent"]}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'TradeIntents visible to Buyer: {len(d.get(\"result\",[]))}')"
# Expected: 0
```

---

## 4. Daml Test Results

```bash
make test-daml
```
- Output: `<paste — 20/20 tests should pass>`

---

## 5. dpm Evidence

```bash
make dpm-install   # Install dpm
make dpm-build     # Build DAR with dpm
make dpm-test      # Run tests with dpm
```
- Output: `<paste>`

---

## 6. Lifecycle Proof

```bash
# For Canton L1 (devnet)
JSON_API_URL=http://localhost:8081 \
  JSON_API_USE_INSECURE_TOKEN=false \
  bash test_lifecycle.sh
```
- Output summary: `<paste>`

---

## 7. Explorer Proof

- Scan Explorer URL: `http://scan.localhost:4000`
- Transaction IDs: `<add>`
- Screenshot of transaction list: `<add>`

---

## 8. Demo Video

- Video URL: `<add>`
- Duration: 2-5 minutes
- Includes:
  - [ ] Privacy proof (Public shows zero contracts)
  - [ ] End-to-end trade flow
  - [ ] Agent AI reasoning logs
  - [ ] Settlement with DvP
  - [ ] Party perspective switching
  - [ ] Canton L1 deployment evidence

---

## 9. Environment Configuration Evidence

```bash
# Show network mode fail-fast
CANTON_NETWORK_MODE=testnet python3 agent/seller_agent.py
# Expected: FATAL error about missing authentication

# Show configurable parties
SELLER_PARTY=CustomSeller make seed
# Expected: Seeds with custom party name
```
