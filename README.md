# Agentic Shadow-Cap

Confidential AI-assisted secondary share trading dApp on Canton L1, built with Daml contracts and dpm workflows.

## Canton L1 Privacy Bounty Fit

### Bounty Summary

Track goal: Build a dApp on Canton L1 using Daml and dpm, with strong privacy-first design.

Bounty category:
- Launch MVP on Testnet or Mainnet
- Feature Usage
- Meaningful Open Source Contribution
- Early Stage Startup

Prize pool:
- Total: $8,000
- Winners: 3 projects
- 1st: $5,000
- 2nd: $2,000
- 3rd: $1,000

Note from bounty brief: prizes can be adjusted or withheld if qualifying submissions are too few or do not meet criteria.

### Submission Artifacts (fill these before final submission)

- GitHub repo: `https://github.com/<org-or-user>/canton`
- Live demo URL: `https://<your-demo-url>`
- 2-5 minute demo video: `https://<video-link>`

### Requirement Coverage

| Bounty Requirement | How this repo addresses it |
|---|---|
| Functional deployment on Canton L1 Devnet | `make devnet` + `make devnet-demo` bootstraps and runs the app stack against Canton L1 local devnet setup. |
| Meaningful Daml usage | Core business logic is implemented in Daml templates and choices in `daml/src/AgenticShadowCap/Market.daml`. |
| Open source | Public repo structure, Apache 2.0 license, readable source across contracts/agents/UI. |
| Clear documentation | This README includes setup, install, run, privacy model, and demo instructions. |
| Privacy model explanation | Party-level visibility matrix is documented below and backed by tests. |
| Working demo | Local demo path (`make demo`) plus Canton L1 path (`make devnet-demo`), with UI perspective switching to show privacy boundaries. |
| 2-5 minute demo video | Video checklist is included below for submission completeness. |

## What This dApp Does

Agentic Shadow-Cap is a private OTC-style flow for secondary market deals:

1. Seller posts a private intent.
2. Agents publish blind discovery signals (no public order book, no public price/size broadcast).
3. Issuer matches counterparties into a private negotiation channel.
4. Both sides commit and reveal terms.
5. Issuer approves and starts settlement.
6. Settlement and audit records are written with party-scoped visibility.

## Privacy Model (Who Can See What)

Canton privacy is enforced through Daml stakeholders (signatories + observers). Unauthorized parties see nothing.

| Contract Template | Seller | SellerAgent | Buyer | BuyerAgent | Issuer (Company) | Outsider/Public |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `AssetHolding` | Observer |  |  |  | Signatory |  |
| `CashHolding` |  |  | Observer |  | Signatory |  |
| `TradeIntent` | Signatory | Observer | Observer |  | Observer |  |
| `DiscoveryInterest` | Owner observer (if owner) | Signatory (if posting agent) | Owner observer (if owner) | Targeted observer (if included in `discoverableBy`) | Observer |  |
| `CommittedTerms` | Observer | Observer | Observer | Observer | Observer |  |
| `PrivateNegotiation` | Observer | Observer | Observer | Observer | Signatory |  |
| `TradeSettlement` | Observer | Observer | Observer | Observer | Signatory |  |
| `TradeAuditRecord` | Observer | Observer | Observer | Observer | Signatory |  |
| `AgentDecisionLog` | Owner observer | Signatory (agent) |  |  |  |  |

Key point: an outsider/public party is not a stakeholder on private contracts, so visibility is zero.

## Quick Start (Local)

### Prerequisites

- `dpm` (Digital Asset Package Manager)
- Java 17+
- Python 3.10+
- Node.js 18+
- Docker Desktop (required for Canton L1 devnet path)

Install dpm:

```bash
curl -fsSL https://get.digitalasset.com/install/install.sh | sh
dpm --version
```

### Fastest Demo Run

```bash
make demo
```

This starts a local sandbox-backed backend and UI.

- UI: [http://localhost:5173](http://localhost:5173)
- Backend status: [http://localhost:8080/status](http://localhost:8080/status)

### Stop Local Demo

```bash
make demo-stop
```

### Build and Test Daml (dpm)

```bash
make dpm-build
make dpm-test
```

Current suite includes 22 Daml script tests, including privacy regression checks.

## Canton L1 Devnet Run (Bounty Requirement Path)

### 1. Bootstrap Devnet

```bash
make build
make devnet
```

### 2. Start App Runtime Against Devnet

```bash
make devnet-demo
```

### 3. Start UI

```bash
cd ui
npm install
VITE_JSON_API_URL=http://localhost:8081 \
VITE_MARKET_API_URL=http://localhost:8090 \
VITE_JSON_API_USE_INSECURE_TOKEN=false \
VITE_CANTON_NETWORK_MODE=devnet \
npm run dev
```

### 4. Optional Lifecycle Verification

```bash
JSON_API_URL=http://localhost:8081 bash test_lifecycle.sh
```

### 5. Stop Devnet

```bash
make devnet-down
```

## Testnet/Mainnet Mode

For authenticated environments:

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

## UI/UX Requirement Coverage

This project follows the web dApp submission path:

- Functional web UI with party selector.
- Clear indication of active party context.
- Visibility differences per party shown live in views.
- Responsive layout for desktop and mobile.
- Publishable frontend (`ui/`) and backend (`deploy/public_demo/`) for a public demo URL.

Public demo deployment sketch:

1. Start backend from `deploy/public_demo/` on a public host.
2. Deploy `ui/` to a static host (for example Vercel).
3. Set proxy/env vars so `/api/ledger` and `/api/market` route to backend.

## 2-5 Minute Demo Video Checklist

Include these in the video:

1. Party switcher and privacy boundaries.
2. Discovery -> negotiation -> approval -> settlement flow.
3. Proof that outsider/public sees no private contracts.
4. Commit/reveal behavior and issuer approval step.
5. Audit trail and final settlement state.
6. Evidence it is running on Canton L1 devnet/testnet/mainnet.

## Judging Alignment

| Judging Area | Evidence in this repo |
|---|---|
| Technical implementation | Daml contracts + tests, typed agent/UI code, reproducible Make targets. |
| Privacy model innovation | Targeted discovery visibility, private negotiation channel, outsider-zero visibility behavior. |
| Utility and impact | Private OTC-style flow relevant to institutional or enterprise confidential workflows. |
| Documentation and demo quality | Clear setup/run instructions, privacy matrix, testing commands, devnet path, demo checklist. |

## Example Use Cases This Maps To

- Private DeFi / confidential lending style negotiations
- B2B private marketplace and blind auction-like discovery
- Supply chain or enterprise bilateral negotiation workflows
- Healthcare or identity-like role-scoped data sharing patterns

## Impact on Canton Ecosystem

- Demonstrates practical enterprise privacy patterns on Canton L1.
- Provides a reproducible reference for developers onboarding to Daml + dpm.
- Supplies testable patterns for privacy-sensitive app design.

## Recruitment Opportunity Note

Per the bounty brief, teams may have opportunities to meet with POCs during the hackathon.

## Useful Resources

- Builder resources: [https://github.com/Jatinp26/canton-hackathon-101](https://github.com/Jatinp26/canton-hackathon-101)
- Canton ecosystem: [https://www.canton.network/ecosystem](https://www.canton.network/ecosystem)
- Get started quickstart: [https://github.com/digital-asset/cn-quickstart](https://github.com/digital-asset/cn-quickstart)
- Mentoring + community: [https://discord.com/invite/HMy2hQZySN](https://discord.com/invite/HMy2hQZySN)

## Repository Layout

```text
daml/
  src/AgenticShadowCap/Market.daml         # Core Daml templates and choices

daml-test/
  src/AgenticShadowCap/Tests.daml           # Test scenarios
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
