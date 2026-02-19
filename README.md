# Agentic Shadow-Cap

**Confidential AI-powered dark pool for secondary market equity trading on Canton Network.**

AI agents autonomously negotiate private trades using Daml smart contracts, with full sub-transaction privacy — no public order book, no open pools, no DeFi patterns. Canton's privacy model ensures only stakeholders see their data.

## Why This Matters

Traditional secondary markets for institutional assets (private equity, pre-IPO shares, venture fund stakes) suffer from two problems:

1. **Information leakage**: Public order books reveal trading intent, enabling front-running and adverse selection.
2. **Manual negotiation**: Trades require weeks of back-and-forth between legal teams.

**Agentic Shadow-Cap** solves both by combining Canton's sub-transaction privacy with autonomous AI agents that act as "legal representatives" — discovering counterparties, negotiating prices, and settling trades atomically, all without exposing any information to unauthorized observers.

## Architecture

```
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│  Seller Participant│    │  Buyer Participant  │    │ Issuer Participant │
│    Node :5011      │    │    Node :5021       │    │    Node :5031      │
│                    │    │                     │    │                    │
│  Seller Party      │    │  Buyer Party        │    │  Company Party     │
│  SellerAgent Party │    │  BuyerAgent Party   │    │  (Compliance/ROFR) │
│                    │    │                     │    │                    │
│  ┌──────────────┐  │    │  ┌──────────────┐   │    │                    │
│  │ Python Agent │  │    │  │ Python Agent │   │    │                    │
│  │ (LLM+Rules)  │  │    │  │ (LLM+Rules)  │   │    │                    │
│  └──────────────┘  │    │  └──────────────┘   │    │                    │
└─────────┬──────────┘    └─────────┬───────────┘    └─────────┬──────────┘
          │                        │                           │
          └────────────────────────┼───────────────────────────┘
                                   │
                          ┌────────┴────────┐
                          │  Canton Domain  │
                          │  (Privacy Layer)│
                          │   :5018-5019    │
                          └─────────────────┘

         ┌──────────────────────────────────────────┐
         │        Nginx Proxy :7575                 │
         │  Routes by X-Ledger-Party header         │
         │  Seller/SellerAgent → seller-node:5013   │
         │  Buyer/BuyerAgent   → buyer-node:5023    │
         │  Company            → issuer-node:5033   │
         └──────────────────────────────────────────┘

         ┌──────────────────────────────────────────┐
         │     React Dashboard :5173                │
         │  Party Perspective Switcher              │
         │  Owner | Market | Compliance | Agent Logs│
         └──────────────────────────────────────────┘
```

## Privacy Model — What Each Party Sees

This is the core innovation. Canton's sub-transaction privacy ensures **no global ledger state** — each party only sees contracts they are a stakeholder of.

| Contract | Seller | SellerAgent | Buyer | BuyerAgent | Issuer (Company) | Public/Outsider |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **AssetHolding** (Seller's shares) | Observer | - | - | - | Signatory | - |
| **CashHolding** (Buyer's cash) | - | - | Observer | - | Signatory | - |
| **TradeIntent** (sell directive) | Signatory | Observer | - | - | Observer | - |
| **DiscoveryInterest** (blind signal) | Observer | Signatory | - | Targeted | Observer | - |
| **PrivateNegotiation** | Observer | Observer | Observer | Observer | Signatory | - |
| **TradeSettlement** | Observer | Observer | Observer | Observer | Signatory | - |
| **TradeAuditRecord** | Observer | Observer | Observer | Observer | Signatory | - |
| **AgentDecisionLog** | Observer | Signatory | - | - | - | - |

**Key insight**: The "Public" perspective in the UI shows **zero contracts** — demonstrating that an unauthorized observer cannot see any market activity whatsoever.

## Quick Start

### Prerequisites
- [dpm (Digital Asset Package Manager)](https://docs.digitalasset.com/build/3.4/getting-started/installation.html)
- Java 17+ (required by Daml tooling)
- [Docker + Docker Compose](https://docs.docker.com/get-docker/)
- [Node.js 18+](https://nodejs.org/) (for the React UI)
- Python 3.10+ (for agents)

### One-Command Demo (requires Docker + dpm)
```bash
make demo
```
This will: build Daml → start Canton nodes → upload DAR → seed data → start agents → start UI.

Open http://localhost:5173 to see the dashboard.

### Sandbox Demo (no Docker needed)
```bash
make sandbox
```
Runs the full Daml workflow on a local sandbox (no multi-node privacy separation).

### Manual Step-by-Step
```bash
# 1. Build Daml contracts
make build

# 2. Start Canton nodes (Docker)
make up

# 3. Upload DAR to all nodes
make upload

# 4. Seed deterministic demo data (holdings + trade intent)
make seed

# 5. Start AI agents + market event API
make agents

# 6. Start React dashboard
make ui
```

### Stopping
```bash
make agents-stop   # Stop Python agents
make ui-stop       # Stop Vite dev server
make down          # Stop Docker containers
```

### Public Web Demo (No Docker)
Use this path if you only need a publicly accessible web dApp URL with party-visibility proof.

```bash
# 1. Prepare venv + Python deps
make demo-web-venv

# 2. Start backend (sandbox + json-api + agents + market-api + gateway)
make demo-web-backend
```

Then run the UI in another terminal:

```bash
cd ui
npm install
VITE_JSON_API_URL=http://localhost:8080/ledger \
VITE_MARKET_API_URL=http://localhost:8080/market \
npm run dev
```

For public deployment:
- Deploy backend process from `deploy/public_demo/` on a host with a public URL.
- Deploy `ui/` to Vercel.
- Set Vercel env vars:
  - `BACKEND_PUBLIC_URL=https://<your-backend-url>`
  - `VITE_JSON_API_URL=/api/ledger`
  - `VITE_MARKET_API_URL=/api/market`
  - `VITE_JSON_API_USE_INSECURE_TOKEN=true`
- Use the Vercel URL as your demo URL.

## Daml Smart Contracts (8 Templates)

All contracts are in `daml/src/AgenticShadowCap/Market.daml`:

| Template | Purpose | Key Choices |
|---|---|---|
| **AssetHolding** | Equity ownership | `TransferAsset`, `SplitAsset` |
| **CashHolding** | Cash/currency balance | `TransferCash`, `SplitCash` |
| **TradeIntent** | Seller's private sell directive | `UpdatePrice`, `ArchiveIntent` |
| **DiscoveryInterest** | Blind market signal (no price/volume) | `MatchWith`, `CancelInterest`, `RetireForMatch` |
| **PrivateNegotiation** | Two-party negotiation channel | `SubmitSellerTerms`, `SubmitBuyerTerms`, `AcceptBySeller`, `AcceptByBuyer`, `ApproveMatch`, `StartSettlement` |
| **TradeSettlement** | Atomic DvP swap | `FinalizeSettlement` (real DvP), `SimpleFinalizeSettlement` (audit-only) |
| **TradeAuditRecord** | Immutable settlement record | (none - append-only) |
| **AgentDecisionLog** | AI reasoning audit trail | (none - append-only) |

### Test Coverage
20 passing test cases covering:
- Happy-path full lifecycle (with and without DvP)
- Privacy: TradeIntent invisible to Buyer
- Privacy: Negotiation invisible to outsiders
- Privacy: Discovery signal scoped to targeted parties
- Validation: zero/negative quantities, zero prices
- Validation: ApproveMatch requires both-party acceptance
- Validation: same-side matching and self-matching blocked
- Rejection: mid-flight negotiation archival
- Asset split and transfer

## Python AI Agents

### Agent Framework (`agent/base_agent.py`)
Both agents extend `BaseAgent`, which provides:
- dual connection modes: `dazl` (gRPC) or `http-json` via v1 compatibility gateway
- Concurrent async loop execution
- Market data + agent control loading
- Ledger query/create/exercise with retry
- On-ledger decision logging

### Seller Agent (`agent/seller_agent.py`)
- **Repricing loop**: Monitors `TradeIntent` contracts. Uses LLM (or rule-based fallback) to adjust `minPrice` based on:
  - Market volatility (from `mock_market_feed.json`)
  - **News sentiment**: If "negative" → increase minPrice by 5%. If "very_negative" → archive intent.
  - Absolute floor protection: never drops below 60% of original price.
- **Discovery loop**: Automatically posts `DiscoveryInterest` (Sell) for each active intent — revealing only instrument + side (no price/volume).
- **Negotiation loop**: Submits initial terms, evaluates counteroffers, accepts or counters.

### Buyer Agent (`agent/buyer_agent.py`)
- **Discovery loop**: Monitors for sell-side `DiscoveryInterest` signals. Posts matching buy signal when mandate matches.
- **Negotiation loop**: Evaluates seller terms against dynamic `maxPrice` ceiling. Accepts if within range, counters at ceiling otherwise.
- Absolute ceiling protection: never exceeds 140% of original max price.

### LLM Advisor (`agent/llm_advisor.py`)
- Calls OpenAI GPT-4o-mini for pricing/negotiation decisions
- Graceful fallback to rule-based logic when no API key is set
- Every decision logged on-ledger in `AgentDecisionLog`

### Market Event API (`agent/market_api.py`)
FastAPI sidecar on port 8090:
- `POST /market-event` — Inject events (earnings, SEC investigation, crash, etc.)
- `GET /status` — Agent health + current feed state
- `GET /events` — List available event types
- `GET/POST /agent-config` — Toggle auto-repricing per agent

## React Dashboard

### Perspective Switcher
Switch between parties to see Canton's privacy model in action:

| Perspective | What You See |
|---|---|
| **Seller / SellerAgent** | Private holdings, trade intents, active negotiations, agent activity timeline, news injector |
| **Buyer / BuyerAgent** | Cash holdings, negotiations where buyer is involved |
| **Company (Issuer)** | All negotiations for compliance review, ROFR approval buttons, DvP settlement monitor, audit trail |
| **Public** | **NOTHING** — zero contracts, zero holdings. Canton's privacy proven. |

### Views
- **Owner View**: Holdings, trade intents with manual price override, private negotiations, news event injector, agent activity timeline
- **Market View**: Zero-data until a match is found (no public order book)
- **Compliance View**: Negotiation approval queue, DvP settlement visualization with step progress, immutable audit trail
- **Agent Logs View**: On-ledger AI decision reasoning with expandable market context details

## Deployment

### Docker Compose (`deploy/docker-compose.yml`)
8 services:
- **domain**: Canton domain (public/admin API)
- **seller-participant**: Seller + SellerAgent parties
- **buyer-participant**: Buyer + BuyerAgent parties
- **issuer-participant**: Company (Issuer) party
- **seller-agent**: Python seller agent (profile: agent)
- **buyer-agent**: Python buyer agent (profile: agent)
- **market-api**: FastAPI event injection (profile: agent)
- **json-api-proxy**: Nginx routing by `X-Ledger-Party` header

### Makefile Targets
| Target | Description |
|---|---|
| `make build` | Compile Daml package |
| `make up` | Start Canton nodes |
| `make down` | Stop all containers |
| `make upload` | Upload DAR to all nodes |
| `make seed` | Create demo contracts |
| `make agents` | Start seller + buyer agents + market API |
| `make agents-stop` | Stop agent processes |
| `make ui` | Start React dev server |
| `make demo` | Full end-to-end workflow |
| `make sandbox` | Local sandbox demo (no Docker) |
| `make devnet` | Deploy to Canton L1 (Splice LocalNet) |
| `make devnet-demo` | Start Canton demo runtime against participant APIs |
| `make canton-network-bootstrap` | DAR upload + party map + seed on Canton v2 APIs |
| `make canton-network-demo` | Start gateway + agents + market API for Canton |
| `make devnet-down` | Stop Canton L1 |
| `make status` | Show running processes |
| `make clean` | Remove build artifacts |

## Repository Layout

```
daml/
├── daml.yaml                    # SDK 3.4.10, parties, dependencies
├── src/AgenticShadowCap/
│   ├── Market.daml              # 8 templates — the dark pool logic
│   ├── MvpScript.daml           # End-to-end workflow simulation
│   └── Tests.daml               # 20 test scenarios
└── .daml/dist/                  # Compiled DAR

agent/
├── base_agent.py                # BaseAgent class (dazl + http-json modes)
├── seller_agent.py              # SellerAgent (extends BaseAgent)
├── buyer_agent.py               # BuyerAgent (extends BaseAgent)
├── llm_advisor.py               # LLM pricing + negotiation advisor
├── common.py                    # Shared utilities
├── market_api.py                # FastAPI market event injection sidecar
├── mock_market_feed.json        # Simulated market data
├── agent_controls.json          # Auto-reprice toggles
└── requirements.txt             # dazl, httpx, fastapi, uvicorn

ui/
├── src/
│   ├── App.tsx                  # Root: polling, party switching, state
│   ├── views/                   # OwnerView, MarketView, ComplianceView, AgentLogsView
│   ├── components/              # NewsInjector, MatchFoundToast
│   ├── lib/ledgerClient.ts      # JSON API client with party-based routing
│   ├── types/contracts.ts       # TypeScript interfaces for all Daml contracts
│   └── context/PartyContext.tsx  # Party state management
├── tailwind.config.ts
└── package.json

deploy/
├── docker-compose.yml           # 8-service Canton deployment
├── canton/                      # Node configs + bootstrap scripts
├── canton_network/              # Canton v2 bootstrap + v1 compatibility gateway
├── json-api/nginx.conf          # Party-based request routing
├── scripts/seed_demo.py         # Deterministic demo seeding
└── devnet/                      # Canton L1 Devnet deployment guide
```

## Workflow

1. **Issuer** mints `AssetHolding` (5000 shares to Seller) and `CashHolding` ($500k to Buyer)
2. **Seller** creates `TradeIntent` (1500 shares at $95 floor) — visible only to Seller + Agent + Issuer
3. **Seller Agent** reprices based on market data + news sentiment + LLM reasoning
4. **Seller Agent** posts blind `DiscoveryInterest` (Sell) — reveals only instrument + side
5. **Buyer Agent** detects sell signal, posts matching `DiscoveryInterest` (Buy)
6. **Issuer** matches opposite interests → creates `PrivateNegotiation`
7. **Agents** negotiate privately, logging every decision on-ledger with reasoning
8. Both agents accept terms → **Issuer** exercises `ApproveMatch` (ROFR/compliance gate)
9. **Issuer** starts settlement → exercises `FinalizeSettlement` (DvP atomic swap)
10. `TradeAuditRecord` created — immutable settlement record visible to all parties

## dpm (Digital Asset Package Manager)

This repository now uses [dpm](https://docs.digitalasset.com/build/3.4/dpm/dpm.html) as the primary Daml CLI for all build/test flows and sandbox/bootstrap helper flows.

| Command | What It Does |
|---|---|
| `make dpm-install` | Install dpm via official installer |
| `make build` | Build DAR using `dpm build` |
| `make test-daml` | Run Daml tests using `dpm test` |

Install dpm:

```bash
curl -fsSL https://get.digitalasset.com/install/install.sh | sh
dpm --version
```

## Migration Note

- Replaced legacy Daml Assistant (`daml`) build/test/script/sandbox/inspect invocations with `dpm` commands.
- Replaced `daml ledger upload-dar` usage with participant JSON API v2 package upload in `make upload`.
- Kept DAR artifact path unchanged at `daml/.daml/dist/agentic-shadow-cap-0.1.0.dar` for deployment compatibility.

## Configuration

### Network Modes

`CANTON_NETWORK_MODE` controls authentication behavior across all components:

| Mode | Insecure Tokens | Auth Required | Use Case |
|---|---|---|---|
| `local` (default) | Allowed | No | Local Docker development |
| `devnet` | Allowed | No | Canton L1 LocalNet |
| `testnet` | **Blocked** | **Yes** | Canton TestNet |
| `mainnet` | **Blocked** | **Yes** | Canton MainNet |

In `testnet`/`mainnet`, agents/gateway/bootstrap **fail fast** with clear errors if auth tokens are missing.

### Environment Variables (Network)
| Variable | Default | Description |
|---|---|---|
| `CANTON_NETWORK_MODE` | `local` | Network mode (see above) |
| `CANTON_PROVIDER_URL` | `http://127.0.0.1:3975` | Provider participant JSON API |
| `CANTON_USER_URL` | `http://127.0.0.1:2975` | User participant JSON API |
| `CANTON_PROVIDER_TOKEN` | (none) | JWT for provider participant |
| `CANTON_USER_TOKEN` | (none) | JWT for user participant |
| `CANTON_JWT_TOKEN` | (none) | Shared JWT (both participants) |

### Environment Variables (Agents)
| Variable | Default | Description |
|---|---|---|
| `DAML_LEDGER_URL` | `http://localhost:5011` | gRPC endpoint (dazl mode) |
| `DAML_LEDGER_MODE` | `dazl` | `dazl` or `http-json` |
| `DAML_HTTP_JSON_URL` | (none) | v1 gateway endpoint |
| `SELLER_PARTY` | `Seller` | Seller party alias (configurable) |
| `SELLER_AGENT_PARTY` | `SellerAgent` | Seller agent party alias |
| `BUYER_PARTY` | `Buyer` | Buyer party alias |
| `BUYER_AGENT_PARTY` | `BuyerAgent` | Buyer agent party alias |
| `ISSUER_PARTY` | `Company` | Issuer/compliance party alias |
| `DEMO_INSTRUMENT` | `COMPANY-SERIES-A` | Instrument name |
| `OPENAI_API_KEY` | (none) | OpenAI key for LLM decisions (optional) |

### Environment Variables (UI)
| Variable | Default | Description |
|---|---|---|
| `VITE_JSON_API_URL` | `http://localhost:7575` | JSON API / gateway URL |
| `VITE_MARKET_API_URL` | `http://localhost:8090` | Market event API URL |
| `VITE_CANTON_NETWORK_MODE` | `local` | Controls UI endpoint labels |
| `VITE_JSON_API_USE_INSECURE_TOKEN` | `true` | Use insecure JWT tokens |
| `VITE_POLL_INTERVAL_MS` | `3000` | UI polling interval |

## Deployment Paths

### Path 1: Local Docker (Quick Test)
```bash
make demo    # One command: build + nodes + upload + seed + agents + UI
# Open http://localhost:5173
```

### Path 2: Canton L1 LocalNet (Recommended for Hackathon)
```bash
make devnet           # Download splice-node, start LocalNet, bootstrap
make devnet-demo      # Start v1 gateway + agents + market API

# Start UI (separate terminal)
cd ui && npm install
VITE_JSON_API_URL=http://localhost:8081 \
  VITE_MARKET_API_URL=http://localhost:8090 \
  VITE_JSON_API_USE_INSECURE_TOKEN=false \
  VITE_CANTON_NETWORK_MODE=devnet npm run dev

make devnet-down      # Stop Canton L1
```

### Path 3: Public TestNet / MainNet
```bash
export CANTON_NETWORK_MODE=testnet
export CANTON_PROVIDER_URL=https://<provider>
export CANTON_USER_URL=https://<user>
export CANTON_PROVIDER_TOKEN=<jwt>
export CANTON_USER_TOKEN=<jwt>

make build && make canton-network-bootstrap
make canton-network-demo

cd ui && npm install
VITE_JSON_API_URL=http://localhost:8081 \
  VITE_CANTON_NETWORK_MODE=testnet npm run dev
```

### Canton L1 Key Ports
| Service | Port |
|---|---|
| App Provider Ledger API | `localhost:3901` |
| App Provider JSON API | `localhost:3975` |
| App User Ledger API | `localhost:2901` |
| v1 compatibility gateway | `localhost:8081` |
| Market API | `localhost:8090` |
| Scan Explorer | `http://scan.localhost:4000` |

For full deployment steps see `deploy/devnet/README.md`.

## Troubleshooting

| Problem | Solution |
|---|---|
| Cannot connect to Docker | Start Docker Desktop |
| Nodes not healthy | `docker ps -a` + `docker logs <container>` |
| DAR upload fails | Ensure port is open: `nc -z localhost 5011` |
| Memory issues (Canton L1) | Docker Desktop > Settings > Resources > Memory > 8GB+ |
| "FATAL: cannot start on testnet" | Set `CANTON_PROVIDER_TOKEN` + `CANTON_USER_TOKEN` or use `CANTON_NETWORK_MODE=local` |
| Agent not connecting | Check `DAML_LEDGER_MODE` and matching URL |
| UI shows "degraded" | Verify JSON API is running: `curl http://localhost:7575/v1/parties` |

## License

Apache 2.0
