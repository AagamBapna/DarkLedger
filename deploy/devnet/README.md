# Canton L1 DevNet Deployment

Deploy Agentic Shadow-Cap to the real Canton L1 DevNet (Global Synchronizer).

## Architecture Difference

| | Local (make demo) | DevNet (make devnet) |
|---|---|---|
| Canton nodes | 3 local Docker containers | 1 splice-node validator on L1 |
| Domain | Local domain container | Global Synchronizer |
| Privacy | Protocol-enforced (same) | Protocol-enforced (same) |
| Persistence | In-memory (resets on stop) | DevNet state (persistent) |
| Network | localhost only | Public Canton L1 DevNet |

## Quick Start (One Command)

```bash
make devnet
```

This will:
1. Download splice-node v0.5.10
2. Get an onboarding secret from the DevNet Super Validator
3. Start a Canton validator connected to the Global Synchronizer
4. Upload the Shadow-Cap DAR
5. Print endpoints for agents + UI

## Manual Step-by-Step

### 1. Prerequisites

- Docker Desktop running
- Daml SDK 2.10.x
- Python 3.10+
- Internet access (no VPN needed for public DevNet)

### 2. Download splice-node

```bash
VERSION="0.5.10"
MIGRATION_ID="1"
mkdir -p ~/.canton/${VERSION}
cd ~/.canton/${VERSION}

wget https://github.com/digital-asset/decentralized-canton-sync/releases/download/v${VERSION}/${VERSION}_splice-node.tar.gz
tar xzf ${VERSION}_splice-node.tar.gz
cd splice-node/docker-compose/validator
```

### 3. Get onboarding secret

```bash
SECRET=$(curl -X POST https://sv.sv-1.dev.global.canton.network.sync.global/api/sv/v0/devnet/onboard/validator/prepare)
```

Secret is valid for 1 hour. If sv-1 is unavailable, use sv-2.

### 4. Start validator

```bash
# Enable development auth mode
echo "COMPOSE_FILE=compose.yaml:compose-disable-auth.yaml" >> .env
echo 'AUTH_URL=https://unsafe.auth' >> .env

export IMAGE_TAG=0.5.10

./start.sh \
  -s "https://sv.sv-1.dev.global.canton.network.sync.global" \
  -o "${SECRET}" \
  -p "shadowcap-hackathon" \
  -m "1" \
  -w
```

Wait 2-5 minutes for the validator to become healthy:
```bash
docker ps --format '{{.Names}}: {{.Status}}' | grep splice
```

### 5. Find your endpoints

```bash
# Find ledger API and JSON API ports
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep splice
```

Look for ports mapped to 5001 (ledger API) and 7575 (JSON API).

### 6. Build and upload DAR

```bash
cd ~/canton  # back to project root
make build
daml ledger upload-dar daml/.daml/dist/agentic-shadow-cap-0.1.0.dar --host localhost --port <LEDGER_PORT>
```

### 7. Seed demo contracts

```bash
JSON_API_URL=http://localhost:<JSON_API_PORT> python3 deploy/scripts/seed_demo.py
```

### 8. Start agents

```bash
# Seller agent
DAML_LEDGER_URL=http://localhost:<LEDGER_PORT> \
  SELLER_AGENT_PARTY=SellerAgent SELLER_PARTY=Seller \
  AGENT_CONTROL_PATH=agent/agent_controls.json \
  MARKET_FEED_PATH=agent/mock_market_feed.json \
  python3 agent/seller_agent.py &

# Buyer agent
DAML_LEDGER_URL=http://localhost:<LEDGER_PORT> \
  BUYER_AGENT_PARTY=BuyerAgent BUYER_PARTY=Buyer \
  TARGET_INSTRUMENT=COMPANY-SERIES-A \
  AGENT_CONTROL_PATH=agent/agent_controls.json \
  MARKET_FEED_PATH=agent/mock_market_feed.json \
  python3 agent/buyer_agent.py &

# Market API
MARKET_FEED_PATH=agent/mock_market_feed.json \
  AGENT_CONTROL_PATH=agent/agent_controls.json \
  uvicorn agent.market_api:app --host 0.0.0.0 --port 8090 &
```

### 9. Start UI

```bash
cd ui
VITE_JSON_API_URL=http://localhost:<JSON_API_PORT> \
  VITE_MARKET_API_URL=http://localhost:8090 \
  npm run dev
```

### 10. Run E2E tests against DevNet

```bash
JSON_API_URL=http://localhost:<JSON_API_PORT> bash test_lifecycle.sh
```

## Verify on DevNet Explorer

After running the lifecycle, check:
- https://scan.sv-1.dev.global.canton.network.sync.global

Your transactions will appear on the Global Synchronizer.

## Submission Checklist

- [ ] Validator running and healthy on DevNet
- [ ] DAR uploaded to DevNet participant
- [ ] Demo contracts seeded (AssetHolding, CashHolding, TradeIntent)
- [ ] `test_lifecycle.sh` passes against DevNet endpoints
- [ ] UI accessible and showing party-specific views
- [ ] Screenshot/video of:
  - Seller perspective showing private TradeIntent
  - Public perspective showing ZERO contracts
  - Company (compliance) approving and settling
  - Agent logs with AI reasoning
- [ ] DevNet explorer showing transactions

## Troubleshooting

### "Cannot connect to Docker daemon"
Start Docker Desktop from Applications.

### Onboarding secret fails
Try sv-2 instead of sv-1:
```bash
SECRET=$(curl -X POST https://sv.sv-2.dev.global.canton.network.sync.global/api/sv/v0/devnet/onboard/validator/prepare)
```

### Validator not becoming healthy
```bash
docker compose logs -f validator  # check for errors
```

### DAR upload fails
Ensure the ledger API port is correct:
```bash
docker ps | grep 5001  # find the mapped port
```

## Stop Everything

```bash
cd ~/.canton/0.5.10/splice-node/docker-compose/validator
./stop.sh
```
