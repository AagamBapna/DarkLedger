# Deployment Guide (Canton + Agentic Shadow-Cap)

## Prerequisites
- **dpm** (`dpm` CLI on PATH)
- **Java 17+** (required by Daml tooling)
- **Docker** + **Docker Compose**
- **Python 3.10+** with pip
- **Node.js 18+** with npm

## Quick Start

```bash
# From repo root — one command to launch everything:
make demo
```

This will: build DAR → start Canton nodes + JSON API proxy → upload DAR → seed demo contracts → start agents → start UI.

## Step-by-Step

### 1) Build Daml Package
```bash
make build
# or manually:
cd daml && dpm build
```

### 2) Start Canton Nodes
```bash
make up
# or manually:
docker compose -f deploy/docker-compose.yml up -d domain seller-participant buyer-participant issuer-participant json-api-proxy
```

Node layout:
- **Seller node**: Ledger API `localhost:5011`, Admin `localhost:5012`
- **Buyer node**: Ledger API `localhost:5021`, Admin `localhost:5022`
- **Issuer node**: Ledger API `localhost:5031`, Admin `localhost:5032`
- **JSON API proxy**: `localhost:7575` (routes by `X-Ledger-Party` header)

### 3) Upload DAR
```bash
make upload
```

### 4) Start AI Agents
### 4) Seed Demo Contracts
```bash
make seed
```

### 5) Start AI Agents
```bash
make agents
```

This starts:
- **Seller agent** on port 5011 (reprices + posts discovery + negotiates)
- **Buyer agent** on port 5021 (watches discovery + posts buy signals + negotiates)
- **Market event API** on port 8090 (FastAPI sidecar for news injection)

Optional: set `OPENAI_API_KEY` for LLM-powered decisions:
```bash
export OPENAI_API_KEY=sk-...
make agents
```

### 6) Start React UI
```bash
make ui
```

Open http://localhost:5173

### 7) Privacy Verification

1. Switch to **Seller** perspective → see TradeIntents, holdings
2. Switch to **Buyer** perspective → seller `TradeIntent` remains invisible
3. Switch to **BuyerAgent** perspective → blind sell `DiscoveryInterest` is visible (instrument+side only)
4. Switch to **Company** perspective → see compliance queue and settlement actions
5. Use **News Event Injector** and auto-reprice toggle to drive/verify live agent behavior

### 8) Sandbox Demo (No Docker)

```bash
make sandbox
```

Runs the full lifecycle locally via `dpm script`.

### 9) Shutdown

```bash
make down        # stop Docker containers
make agents-stop # stop Python agents
make ui-stop     # stop Vite dev server
```

### 10) Check Status

```bash
make status
```

## Canton L1 Devnet

See `deploy/devnet/README.md` for the Devnet deployment runbook and submission evidence checklist.
