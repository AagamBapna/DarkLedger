# Canton L1 Devnet Runbook

This runbook describes how to run Agentic Shadow-Cap on Canton L1 Devnet infrastructure (instead of local Docker).

## 1) Prerequisites

- Access to three Devnet participants (seller, buyer, issuer) with:
  - Ledger API (gRPC) endpoints
  - JSON API endpoints (or a shared routed gateway)
  - Party IDs enabled (`Seller`, `SellerAgent`, `Buyer`, `BuyerAgent`, `Company`)
- Daml SDK 2.10.x (`daml` CLI)
- Python 3.10+
- Node.js 18+

## 2) Build DAR

```bash
make build
```

DAR output:

`daml/.daml/dist/agentic-shadow-cap-0.1.0.dar`

## 3) Upload DAR to Devnet Participants

Set your Devnet ledger endpoints:

```bash
export SELLER_LEDGER_HOST=<seller-ledger-host>
export SELLER_LEDGER_PORT=<seller-ledger-port>
export BUYER_LEDGER_HOST=<buyer-ledger-host>
export BUYER_LEDGER_PORT=<buyer-ledger-port>
export ISSUER_LEDGER_HOST=<issuer-ledger-host>
export ISSUER_LEDGER_PORT=<issuer-ledger-port>
```

Upload:

```bash
daml ledger upload-dar daml/.daml/dist/agentic-shadow-cap-0.1.0.dar --host "$SELLER_LEDGER_HOST" --port "$SELLER_LEDGER_PORT"
daml ledger upload-dar daml/.daml/dist/agentic-shadow-cap-0.1.0.dar --host "$BUYER_LEDGER_HOST" --port "$BUYER_LEDGER_PORT"
daml ledger upload-dar daml/.daml/dist/agentic-shadow-cap-0.1.0.dar --host "$ISSUER_LEDGER_HOST" --port "$ISSUER_LEDGER_PORT"
```

Or run the automated bootstrap:

```bash
deploy/devnet/run_devnet_demo.sh
```

## 4) Seed Devnet Demo Contracts

Use the seed script against your Devnet JSON API gateway:

```bash
export JSON_API_URL=<devnet-json-api-url>
export JSON_API_TOKEN=<jwt-with-party-rights>   # recommended for devnet
python3 deploy/scripts/seed_demo.py
```

If your deployment uses package ID-qualified template IDs:

```bash
export PACKAGE_ID=<uploaded-dar-package-id>
python3 deploy/scripts/seed_demo.py
```

## 5) Run Agents Against Devnet

Seller agent:

```bash
export DAML_LEDGER_URL=http://<seller-ledger-host>:<seller-ledger-port>
export SELLER_AGENT_PARTY=SellerAgent
export SELLER_PARTY=Seller
export AGENT_CONTROL_PATH=agent/agent_controls.json
python3 agent/seller_agent.py
```

Buyer agent:

```bash
export DAML_LEDGER_URL=http://<buyer-ledger-host>:<buyer-ledger-port>
export BUYER_AGENT_PARTY=BuyerAgent
export BUYER_PARTY=Buyer
export TARGET_INSTRUMENT=COMPANY-SERIES-A
export AGENT_CONTROL_PATH=agent/agent_controls.json
python3 agent/buyer_agent.py
```

Market API:

```bash
export MARKET_FEED_PATH=agent/mock_market_feed.json
export AGENT_CONTROL_PATH=agent/agent_controls.json
uvicorn agent.market_api:app --host 0.0.0.0 --port 8090
```

## 6) Run UI Against Devnet

```bash
cd ui
VITE_JSON_API_URL=<devnet-json-api-url> \
VITE_MARKET_API_URL=http://localhost:8090 \
npm run dev
```

## 7) Submission Evidence Checklist

- Screenshot/video of:
  - Seller perspective with private `TradeIntent`
  - Buyer perspective without seller private order details
  - BuyerAgent perspective seeing only blind targeted discovery signal
  - Company perspective approving and finalizing settlement
  - Agent logs (`AgentDecisionLog`) with reasoning
- Tx/contract IDs for at least one full settlement lifecycle
- Link to deployed UI demo URL and public source repo
