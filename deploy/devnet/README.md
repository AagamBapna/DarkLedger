# Canton L1 Deployment (Splice LocalNet)

Deploy Agentic Shadow-Cap to a full Canton L1 network using Splice LocalNet.

## What is Splice LocalNet?

Splice LocalNet is the official local deployment of the Canton Network topology,
provided by the `splice-node` release from `digital-asset/decentralized-canton-sync`.

It runs the **same Canton protocol stack** used on the real Global Synchronizer,
including:
- **Super Validator (SV)** — operates the Global Synchronizer
- **App Provider** — participant + validator (hosts Seller / SellerAgent / Company)
- **App User** — participant + validator (hosts Buyer / BuyerAgent)
- **PostgreSQL** — persistent state
- **NGINX gateway** — routes to wallet/scan/sv UIs

This is the [recommended deployment target](https://docs.sync.global/app_dev/testing/localnet.html)
for Canton Network development and hackathon submissions.

## Architecture

| | Local (make demo) | Canton L1 (make devnet) |
|---|---|---|
| Canton nodes | 3 local Docker containers | Splice LocalNet (SV + 2 participants) |
| Domain | Local domain container | Global Synchronizer (SV-managed) |
| Privacy | Protocol-enforced | Protocol-enforced (same protocol) |
| Persistence | In-memory (resets) | PostgreSQL (persistent) |
| Network UIs | None | Scan Explorer, SV UI, Wallet UIs |
| Canton version | Custom docker-compose | splice-node v0.5.10 |

## Quick Start (One Command)

```bash
make devnet
```

This will:
1. Download splice-node v0.5.10 (~500MB)
2. Start Splice LocalNet (SV + App Provider + App User)
3. Wait for all Canton nodes to become healthy
4. Bootstrap via JSON Ledger API v2 (DAR upload + party map + seed)
5. Print endpoints for gateway + agents + UI

## Requirements

- **Docker Desktop** running with **8GB+ memory** allocated
- **Daml SDK 3.4.x**
- **Python 3.10+** (for agents)
- **Node.js 18+** (for React UI)
- **~2GB disk space** for Docker images

## Port Map

### Canton L1 Endpoints

| Service | Port | Purpose |
|---|---|---|
| App Provider Ledger API | 3901 | gRPC ledger (Seller-side) |
| App Provider JSON API | 3975 | HTTP JSON API (Seller-side) |
| App User Ledger API | 2901 | gRPC ledger (Buyer-side) |
| App User JSON API | 2975 | HTTP JSON API (Buyer-side) |
| SV Ledger API | 4901 | gRPC ledger (Compliance) |

### Canton Network UIs

| UI | URL | Purpose |
|---|---|---|
| Scan Explorer | http://scan.localhost:4000 | Transaction explorer |
| Super Validator | http://sv.localhost:4000 | SV management |
| App Provider Wallet | http://wallet.localhost:3000 | Provider wallet |
| App User Wallet | http://wallet.localhost:2000 | User wallet |

## Manual Step-by-Step

### 1. Download splice-node

```bash
VERSION="0.5.10"
mkdir -p ~/.canton/${VERSION}
cd ~/.canton/${VERSION}

curl -L -o ${VERSION}_splice-node.tar.gz \
  https://github.com/digital-asset/decentralized-canton-sync/releases/download/v${VERSION}/${VERSION}_splice-node.tar.gz

tar xzf ${VERSION}_splice-node.tar.gz
```

### 2. Start LocalNet

```bash
export LOCALNET_DIR=$PWD/splice-node/docker-compose/localnet
export IMAGE_TAG=0.5.10

docker compose \
  --env-file $LOCALNET_DIR/compose.env \
  --env-file $LOCALNET_DIR/env/common.env \
  -f $LOCALNET_DIR/compose.yaml \
  -f $LOCALNET_DIR/resource-constraints.yaml \
  --profile sv \
  --profile app-provider \
  --profile app-user \
  up -d
```

Wait 3-5 minutes for all nodes to become healthy.

### 3. Build and bootstrap on participant APIs

```bash
cd ~/canton
make build
make canton-network-bootstrap
```

### 4. Start gateway + agents

```bash
make canton-network-demo
```

### 5. Start UI

```bash
cd ui && npm install
VITE_JSON_API_URL=http://localhost:8081 \
  VITE_MARKET_API_URL=http://localhost:8090 \
  VITE_JSON_API_USE_INSECURE_TOKEN=false \
  npm run dev
```

## Verify Deployment

### Check Canton nodes
```bash
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E "(canton|splice|localnet)"
```

### Run tests
```bash
JSON_API_URL=http://localhost:8081 bash test_lifecycle.sh
```

### Check Scan Explorer
Open http://scan.localhost:4000 — your transactions will appear in the
Global Synchronizer explorer.

## Submission Checklist

- [ ] Canton L1 (LocalNet) running and healthy
- [ ] `deploy/canton_network/bootstrap.py` completed successfully
- [ ] `deploy/canton_network/party_map.json` generated
- [ ] Gateway running on `localhost:8081`
- [ ] Agents running and showing AI reasoning in logs
- [ ] UI accessible and showing party-specific views
- [ ] Scan Explorer showing Canton transactions
- [ ] Screenshot/video of:
  - Seller perspective showing private TradeIntent
  - Public perspective showing ZERO contracts
  - Company (compliance) approving and settling
  - Agent logs with AI reasoning
  - Scan Explorer transaction view

## Troubleshooting

### "Cannot connect to Docker daemon"
Start Docker Desktop from Applications.

### Nodes not becoming healthy
```bash
# Check container status
docker ps -a

# View logs for a specific container
docker logs <container-name> --tail 100
```

### DAR upload fails
Ensure the node is fully started:
```bash
# Check if port is open
nc -z localhost 3901 && echo "Port open" || echo "Port closed"
```

### Memory issues
Splice LocalNet requires ~6GB of RAM. In Docker Desktop:
Settings → Resources → Memory → Set to 8GB+

## Stop Everything

```bash
export LOCALNET_DIR=~/.canton/0.5.10/splice-node/docker-compose/localnet
export IMAGE_TAG=0.5.10

docker compose \
  --env-file $LOCALNET_DIR/compose.env \
  --env-file $LOCALNET_DIR/env/common.env \
  -f $LOCALNET_DIR/compose.yaml \
  -f $LOCALNET_DIR/resource-constraints.yaml \
  --profile sv \
  --profile app-provider \
  --profile app-user \
  down -v
```
