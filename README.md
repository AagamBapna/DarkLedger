# Agentic Shadow-Cap

Confidential AI-assisted secondary share trading dApp on Canton L1, built with Daml contracts and `dpm` workflows.

## Why This Project Fits The Bounty

This project is a privacy-first Canton L1 dApp with meaningful Daml usage and a runnable MVP:

- Uses native Daml smart contracts for the full trade lifecycle (not wrappers around another chain).
- Demonstrates Canton privacy by design through stakeholder-scoped visibility on every contract.
- Ships as open source with reproducible commands for build, test, and demo runs.
- Includes a working web UI where each party sees different ledger state based on Canton visibility rules.

## Project Overview

Agentic Shadow-Cap implements a private OTC-style flow:

1. Seller creates a private `TradeIntent`.
2. Agents publish blind `DiscoveryInterest` signals (no public order book leak).
3. Issuer matches two compatible interests into a private `PrivateNegotiation` channel.
4. Both sides negotiate, commit, and reveal terms.
5. Issuer approves and starts settlement.
6. Settlement and audit artifacts are recorded with party-scoped visibility.

## Technical Extensions: Lending + Auctions

Beyond the base secondary-share flow, the project includes two advanced privacy-market modules that reuse Canton-style privacy boundaries and execution semantics.

### 1) Privacy-Scoped Lending Desk

The lending surface is implemented in:

- `ui/src/views/CreditLendingView.tsx`
- `ui/src/hooks/useCreditLendingData.ts`
- `ui/src/lib/creditLendingApi.ts`
- `ui/src/views/AdvancedLendingLab.tsx`

Architecture details:

- `useCreditLendingData` runs an auth/data state machine (`checking`, `authenticated`, `unauthenticated`, `no-backend`) and switches between live API mode and deterministic demo mode.
- `creditLendingApi.ts` defines a typed command/query adapter for private credit workflows (`/loans/request`, `/loans/offer`, `/market/lender-bids`, `/market/borrower-asks`, `/market/matched-proposals`, `/orderbook`, repayment and default flows).
- In the app workspace, `LendingWorkspaceView` currently runs the lending desk in guided demo mode (`forceDemo`) so privacy behavior and lifecycle UX stay reproducible during demos.
- `AdvancedLendingLab` adds a local matching/risk engine with:
  - price-time matching for borrower/lender orders,
  - order types (`GTC`, `IOC`, `FOK`),
  - health-factor based margin monitoring,
  - liquidation events under stress haircuts,
  - syndicated tranche modeling and secondary tranche transfers.

How this relates to Canton privacy:

- Party-scoped lending state mirrors Canton’s stakeholder visibility model: each participant sees only its own requests, offers, loans, and risk context.
- The desk emphasizes selective disclosure rather than global credit-state broadcast.

### 2) Commit-Reveal Dark Auction Engine

The auction module is implemented in:

- `ui/src/views/DarkAuctionView.tsx`

Auction mechanics:

- Multi-phase auction state machine: `Idle -> Commit -> Reveal -> Settled`.
- Buyers submit blind commitments using WebCrypto SHA-256 over tuple payloads `(rfqId | bidder | price | nonce)`.
- Reveal phase recomputes hashes and hard-fails mismatches/timeouts as disqualifications.
- Reserve-price gating enforces issuer policy constraints before winner selection.
- Settlement selects best qualified price and emits a structured proof object (`winner`, `qualifiedBids`, `disqualifiedBids`, `proofHash`) exportable as JSON.

How this relates to Canton privacy:

- Commit/reveal maps directly to Canton’s privacy-first execution style: private intent first, bounded disclosure later.
- Auction telemetry is designed for verifiable confidentiality proofs (who committed, who revealed, and why bids were rejected) without exposing raw intent before reveal.

## Privacy Model (Party Visibility)

Canton privacy is enforced through Daml signatories and observers. Unauthorized parties are not stakeholders and therefore cannot see private contracts.

| Contract Template | Seller | SellerAgent | Buyer | BuyerAgent | Issuer (Company) | Outsider/Public |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `AssetHolding` | Observer |  |  |  | Signatory |  |
| `CashHolding` |  |  | Observer |  | Signatory |  |
| `TradeIntent` | Signatory | Observer | Observer |  | Observer |  |
| `DiscoveryInterest` | Owner observer (if owner) | Signatory (if posting agent) | Owner observer (if owner) | Targeted observer (`discoverableBy`) | Observer |  |
| `CommittedTerms` | Observer | Observer | Observer | Observer | Observer |  |
| `PrivateNegotiation` | Observer | Observer | Observer | Observer | Signatory |  |
| `TradeSettlement` | Observer | Observer | Observer | Observer | Signatory |  |
| `TradeAuditRecord` | Observer | Observer | Observer | Observer | Signatory |  |
| `AgentDecisionLog` | Owner observer | Signatory (agent) |  |  |  |  |

## Daml Contracts

Core contracts are in `daml/src/AgenticShadowCap/Market.daml`:

- `AssetHolding`
- `CashHolding`
- `TradeIntent`
- `DiscoveryInterest`
- `CommittedTerms`
- `PrivateNegotiation`
- `TradeSettlement`
- `TradeAuditRecord`
- `AgentDecisionLog`

## Quick Start (Local Demo)

### Prerequisites

- `dpm`
- Java 17+
- Python 3.10+
- Node.js 18+
- Docker Desktop (needed for Canton L1 path)

Install `dpm`:

```bash
curl -fsSL https://get.digitalasset.com/install/install.sh | sh
dpm --version
```

### One-command local demo

```bash
make demo
```

- UI: [http://localhost:5173](http://localhost:5173)
- Backend status: [http://localhost:8080/status](http://localhost:8080/status)

Stop demo:

```bash
make demo-stop
```

## Canton L1 Devnet Run

```bash
make build
make devnet
make devnet-demo
```

Start UI in another terminal:

```bash
cd ui
npm install
VITE_JSON_API_URL=http://localhost:8081 \
VITE_MARKET_API_URL=http://localhost:8090 \
VITE_JSON_API_USE_INSECURE_TOKEN=false \
VITE_CANTON_NETWORK_MODE=devnet \
npm run dev
```

Stop devnet:

```bash
make devnet-down
```

## Testnet/Mainnet Mode

```bash
export CANTON_NETWORK_MODE=testnet
export CANTON_PROVIDER_URL=https://<provider-json-api>
export CANTON_USER_URL=https://<user-json-api>
export CANTON_PROVIDER_TOKEN=<jwt>
export CANTON_USER_TOKEN=<jwt>

make build
make canton-network-bootstrap
make canton-network-demo
```

## Build And Test

```bash
make dpm-build
make dpm-test
```

The Daml test suite includes lifecycle, validation, and privacy regression scenarios.

## UI Notes

The web UI is in `ui/` and includes party perspective switching so judges can observe Canton's privacy model directly (for example, outsider/public perspective has no visibility into private deal contracts).

## Repository Layout

```text
daml/
  src/AgenticShadowCap/Market.daml

daml-test/
  src/AgenticShadowCap/Tests.daml
  src/AgenticShadowCap/PrivacyRegression.daml

agent/
  seller_agent.py
  buyer_agent.py
  market_api.py

ui/
  src/

deploy/
  devnet/
  public_demo/
  canton_network/
```

## License

Apache 2.0
