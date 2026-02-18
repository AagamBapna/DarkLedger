# Agent Architecture

Autonomous Python agents for the Agentic Shadow-Cap dark pool. Each agent acts as a legal representative for its principal (Seller or Buyer), making real-time pricing and negotiation decisions on the Canton ledger.

---

## Overview

Agents are **event-driven, dazl-based ledger streaming** applications. They maintain long-lived connections to their respective Canton participant nodes and react to contract lifecycle events in real time.

```
┌─────────────────────────────────────────────────────┐
│                   Seller Agent                       │
│                                                      │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐│
│  │ Repricing │   │Discovery │   │   Negotiation    ││
│  │   Loop    │   │  Loop    │   │     Loop         ││
│  └─────┬────┘   └─────┬────┘   └────────┬─────────┘│
│        │              │                  │           │
│        └──────────────┼──────────────────┘           │
│                       │                              │
│              ┌────────▼─────────┐                    │
│              │   dazl Connection │                    │
│              │   (gRPC stream)   │                    │
│              └────────┬─────────┘                    │
└───────────────────────┼──────────────────────────────┘
                        │
                        ▼
              Canton Participant Node
```

### Seller Agent (`seller_agent.py`)

1. **Streams** `TradeIntent` contracts visible to `SellerAgent`
2. **Reprices** intents based on external market volatility feed
3. **Posts** sell-side `DiscoveryInterest` signals (no price or volume)
4. **Negotiates** in `PrivateNegotiation` — submits terms, accepts or counters buyer offers

### Buyer Agent (`buyer_agent.py`)

1. **Watches** for sell-side `DiscoveryInterest` signals matching target instrument
2. **Posts** buy-side `DiscoveryInterest` when a matching sell signal appears
3. **Negotiates** in `PrivateNegotiation` — accepts seller terms within ceiling, or counters

---

## Decision Pipeline

```
Market Data Feed (JSON/CSV)
        │
        ▼
┌─────────────────────────┐
│  Load market_volatility  │
│  from feed file          │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  LLM Analysis (optional) │  ← OPENAI_API_KEY
│  • Strategy selection     │  Falls back to rule-based
│  • Risk assessment        │  logic if unavailable
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Price Decision          │
│  Seller: volatility →    │  Bands: ±3-10% of minPrice
│    price adjustment      │
│  Buyer: volatility →     │  Bands: ±3-5% of ceiling
│    bid ceiling           │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Ledger Action           │
│  • exerciseCmd via dazl  │
│  • UpdatePrice           │
│  • SubmitSellerTerms     │
│  • AcceptByBuyer         │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  On-chain Audit Log      │
│  AgentDecisionLog        │
│  (agent + owner only)    │
└─────────────────────────┘
```

---

## Market Feed Format

The agents read external market data from a JSON or CSV file. The feed is polled every `AGENT_POLL_SECONDS` seconds.

### JSON schema (`mock_market_feed.json`)

Single object:

```json
{
  "timestamp": "2026-02-18T00:00:00Z",
  "market_volatility": 0.34,
  "source": "mock-shadowcap-feed"
}
```

Array of snapshots (latest entry used):

```json
[
  { "timestamp": "2026-02-18T00:00:00Z", "market_volatility": 0.20, "source": "..." },
  { "timestamp": "2026-02-18T01:00:00Z", "market_volatility": 0.34, "source": "..." }
]
```

### CSV format

```csv
timestamp,market_volatility,source
2026-02-18T00:00:00Z,0.34,mock-shadowcap-feed
```

| Field | Type | Description |
|---|---|---|
| `timestamp` | ISO 8601 string | When the snapshot was taken |
| `market_volatility` | Float (0.0–1.0) | Current volatility index; drives repricing bands |
| `source` | String | Feed source identifier |

---

## Environment Variables

### Seller Agent

| Variable | Default | Description |
|---|---|---|
| `DAML_LEDGER_URL` | `http://localhost:5011` | Canton participant ledger API URL |
| `SELLER_AGENT_PARTY` | `SellerAgent` | Daml party identifier for the seller agent |
| `TRADE_INTENT_TEMPLATE` | `AgenticShadowCap.Market:TradeIntent` | Fully qualified template ID |
| `DISCOVERY_TEMPLATE` | `AgenticShadowCap.Market:DiscoveryInterest` | Discovery template ID |
| `NEGOTIATION_TEMPLATE` | `AgenticShadowCap.Market:PrivateNegotiation` | Negotiation template ID |
| `MARKET_FEED_PATH` | `./agent/mock_market_feed.json` | Path to volatility feed file |
| `AGENT_POLL_SECONDS` | `5` | Polling interval for repricing / negotiation loops |
| `MIN_TICK_CHANGE` | `0.01` | Minimum price change to trigger an update |
| `SELLER_DISCOVERY_STRATEGY` | `SELL_WHISPER` | Strategy tag for discovery interests |
| `SELLER_COUNTER_MARKUP` | `1.00` | Markup multiplier for counter-offers |
| `OPENAI_API_KEY` | — | OpenAI API key (optional; enables LLM decisions) |
| `LOG_LEVEL` | `INFO` | Logging verbosity |

### Buyer Agent

| Variable | Default | Description |
|---|---|---|
| `DAML_LEDGER_URL` | `http://localhost:5021` | Canton participant ledger API URL |
| `BUYER_AGENT_PARTY` | `BuyerAgent` | Daml party identifier for the buyer agent |
| `BUYER_PARTY` | `Buyer` | Daml party identifier for the buyer principal |
| `TARGET_INSTRUMENT` | `COMPANY-SERIES-A` | Instrument to watch for discovery signals |
| `DISCOVERY_TEMPLATE` | `AgenticShadowCap.Market:DiscoveryInterest` | Discovery template ID |
| `NEGOTIATION_TEMPLATE` | `AgenticShadowCap.Market:PrivateNegotiation` | Negotiation template ID |
| `MARKET_FEED_PATH` | `./agent/mock_market_feed.json` | Path to volatility feed file |
| `AGENT_POLL_SECONDS` | `5` | Polling interval |
| `BUYER_MAX_PRICE` | `110.00` | Maximum acceptable unit price |
| `BUYER_DEFAULT_QTY` | `1000.00` | Default quantity for counter-offers |
| `BUYER_DISCOVERY_STRATEGY` | `BUY_WHISPER` | Strategy tag for discovery interests |
| `OPENAI_API_KEY` | — | OpenAI API key (optional) |
| `LOG_LEVEL` | `INFO` | Logging verbosity |

---

## Running Agents Standalone

### Using a virtual environment

```bash
cd /path/to/canton

python3 -m venv .venv
source .venv/bin/activate
pip install -r agent/requirements.txt
```

**Start seller agent:**

```bash
export DAML_LEDGER_URL=http://localhost:5011
export MARKET_FEED_PATH=agent/mock_market_feed.json
python agent/seller_agent.py
```

**Start buyer agent** (separate terminal):

```bash
export DAML_LEDGER_URL=http://localhost:5021
export MARKET_FEED_PATH=agent/mock_market_feed.json
python agent/buyer_agent.py
```

### Using Docker Compose

```bash
docker compose -f deploy/docker-compose.yml --profile agent up seller-agent buyer-agent
```

This automatically sets all environment variables from the `docker-compose.yml` service definitions.

---

## Repricing Logic

The seller agent applies volatility-band repricing:

| Volatility Range | Price Factor | Effect |
|---|---|---|
| ≥ 0.45 (high) | 0.90 | Lower floor to improve execution |
| 0.30 – 0.44 | 0.95 | Moderate floor reduction |
| 0.09 – 0.29 | 1.00 | No change |
| ≤ 0.08 (low) | 1.03 | Raise floor in calm markets |

The buyer agent applies a simpler ceiling adjustment:

| Volatility Range | Price Factor | Effect |
|---|---|---|
| ≥ 0.45 (high) | 1.05 | Raise ceiling to compete |
| 0.11 – 0.44 | 1.00 | No change |
| ≤ 0.10 (low) | 0.97 | Lower ceiling, tighten bid |
