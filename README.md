# Agentic Shadow-Cap

**Confidential AI-powered dark pool for secondary market equity trading on Canton Network.**

AI agents autonomously negotiate private trades using Daml smart contracts, with full sub-transaction privacy — no public order book, no open pools, no DeFi patterns. Canton's privacy model ensures only stakeholders see their data.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Seller Node  │     │ Buyer Node   │     │ Issuer Node  │
│  :5011       │     │  :5021       │     │  :5031       │
│              │     │              │     │              │
│ SellerAgent  │     │ BuyerAgent   │     │  Company     │
│ (Python+LLM) │     │ (Python+LLM) │     │ (Compliance) │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                   ┌────────┴────────┐
                   │  Canton Domain  │
                   │  (Privacy Layer)│
                   └─────────────────┘
```

### Privacy Model
- **TradeIntent**: Visible only to Seller + SellerAgent + Issuer
- **DiscoveryInterest**: Blind signal — no price/volume. Only instrument + side
- **PrivateNegotiation**: Created only after match. Visible only to matched parties + Issuer
- **TradeSettlement**: DvP atomic swap with immutable audit trail
- **AgentDecisionLog**: AI reasoning logged on-ledger per agent

### AI Agent Architecture
Each agent uses an **LLM advisor** (GPT-4o-mini) for pricing and negotiation decisions, with graceful fallback to rule-based logic when no API key is set. Every decision is logged on-ledger in `AgentDecisionLog` contracts, creating an auditable trail of AI reasoning.

## Quick Start

### One-Command Demo (requires Docker + Daml SDK)
```bash
make demo
```

### Sandbox Demo (no Docker needed)
```bash
make sandbox
```

### Manual Setup
```bash
# 1. Build Daml contracts
make build

# 2. Start Canton nodes (Docker)
make up

# 3. Upload DAR to all nodes
make upload

# 4. Start AI agents + market event API
make agents

# 5. Start React dashboard
make ui
```

Open http://localhost:5173 to see the dashboard.

## Repository Layout

```
daml/src/AgenticShadowCap/
├── Market.daml          # Core templates: TradeIntent, DiscoveryInterest,
│                        # PrivateNegotiation, TradeSettlement, AssetHolding,
│                        # CashHolding, TradeAuditRecord, AgentDecisionLog
└── MvpScript.daml       # End-to-end workflow simulation

agent/
├── seller_agent.py      # Seller's autonomous AI legal representative
├── buyer_agent.py       # Buyer's autonomous AI legal representative
├── llm_advisor.py       # LLM-powered pricing + negotiation advisor
├── market_api.py        # FastAPI sidecar for market event injection
├── mock_market_feed.json
└── requirements.txt

ui/                      # React + TypeScript + Vite + Tailwind
├── src/views/
│   ├── OwnerView.tsx    # Private holdings + agent activity + news injector
│   ├── MarketView.tsx   # Zero-data view until match found
│   ├── ComplianceView.tsx # ROFR approval + DvP settlement visualization
│   └── AgentLogsView.tsx  # AI decision reasoning panel (on-ledger logs)
└── src/components/
    ├── NewsInjector.tsx  # Inject market events to trigger agents live
    └── MatchFoundToast.tsx

deploy/
├── docker-compose.yml   # Canton domain + 3 participant nodes + nginx proxy
├── canton/              # Per-node configs and bootstrap scripts
└── json-api/nginx.conf  # Routes requests by X-Ledger-Party header
```

## Workflow

1. **Seller** posts a private `TradeIntent` (visible only to Seller, Agent, Issuer)
2. **Seller Agent** reprices based on market data + LLM reasoning
3. **Agents** post blind `DiscoveryInterest` signals (no price/volume exposed)
4. **Issuer** matches opposite interests → creates `PrivateNegotiation`
5. **Agents** negotiate privately, logging every decision on-ledger
6. **Issuer** exercises `ApproveMatch` (ROFR/compliance gate)
7. **Issuer** starts and finalizes `TradeSettlement` (DvP atomic swap)
8. Immutable `TradeAuditRecord` created on settlement

## Key Features

- **No Public Order Book**: Discovery uses blind signaling only
- **AI-Powered Agents**: LLM advisor with rule-based fallback
- **On-Ledger Decision Audit**: Every AI decision logged with reasoning
- **DvP Settlement**: Real asset + cash swap with change returned
- **Live Market Events**: Inject news events from the UI to trigger agents
- **Perspective Switching**: See the ledger as different parties
- **Time-Bounded Negotiations**: Auto-expire stale negotiations
- **Contract Keys**: Prevent duplicate discovery signals

## Configuration

### Environment Variables (Agents)
| Variable | Default | Description |
|---|---|---|
| `DAML_LEDGER_URL` | `http://localhost:5011` | Canton node gRPC endpoint |
| `SELLER_AGENT_PARTY` | `SellerAgent` | Party ID for seller agent |
| `OPENAI_API_KEY` | (none) | OpenAI key for LLM decisions |
| `AGENT_POLL_SECONDS` | `5` | Polling interval |
| `MARKET_FEED_PATH` | `./agent/mock_market_feed.json` | Market data feed path |

### Environment Variables (UI)
| Variable | Default | Description |
|---|---|---|
| `VITE_JSON_API_URL` | `http://localhost:7575` | JSON API proxy URL |
| `VITE_MARKET_API_URL` | `http://localhost:8090` | Market event API URL |

## License

Apache 2.0
