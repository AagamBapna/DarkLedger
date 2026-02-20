# Agentic Shadow-Cap Dashboard

React 18 + Vite + Tailwind CSS dashboard for the Agentic Shadow-Cap dark pool.

---

## Architecture

The dashboard implements a **perspective-based architecture**: every panel is scoped to the currently selected party and their Canton participant node. There is no global order book, no shared depth chart, and no pooled liquidity view. This mirrors the on-ledger privacy model — you only see what your party is authorized to see.

```
┌────────────────────────────────────────────────┐
│  App Shell                                      │
│  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Party       │  │ Connectivity Status      │  │
│  │ Selector    │  │ (Ledger API + Agent)     │  │
│  └─────────────┘  └─────────────────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │              View Router                  │   │
│  │  ┌──────────┬──────────┬──────────┬────┐ │   │
│  │  │  Owner   │  Market  │Compliance│Logs│ │   │
│  │  │  View    │  View    │  View    │View│ │   │
│  │  └──────────┴──────────┴──────────┴────┘ │   │
│  └──────────────────────────────────────────┘   │
│                       │                          │
│              Daml JSON API Client                │
│              (ledgerClient.ts)                    │
│                       │                          │
│              Nginx Proxy (:7575)                  │
│              X-Ledger-Party routing               │
└────────────────────────────────────────────────┘
```

---

## Views

### Owner View

The default view for `Seller`, `SellerAgent`, `Buyer`, and `BuyerAgent` parties.

- **Private Holdings**: Asset positions and available quantities
- **Active Trade Intents**: Instrument, quantity, `minPrice`, last agent update timestamp
- **Negotiation Status**: Active `PrivateNegotiation` contracts (if any)
- **Agent Timeline**: History of agent actions (`UpdatePrice`, `SubmitSellerTerms`, `AcceptBySeller`)
- **Manual Controls**: Override `minPrice`, toggle agent auto-reprice (writes to Market API `/agent-config`)

### Market View

Intentionally minimal — reflects the zero-knowledge stance of the dark pool.

- **Before match**: Full-screen placeholder: *"No discoverable market data"* with explanation that discovery uses private interest signaling only
- **On match**: Notification banner with instrument and pseudonymized counterparty, CTA to open the negotiation channel

### Compliance View

Available to the `Company` (issuer) party.

- **Pending Negotiations**: Queue of `PrivateNegotiation` contracts with acceptance status
- **ROFR Action**: `ApproveMatch` button
- **Atomic DvP Finalization**: `FinalizeSettlement` (requires eligible seller asset + buyer cash contracts)
- **Settlement Monitor**: `TradeSettlement` contracts and finalization status

### Agent Logs View

Streaming log table showing agent decision history.

- **Source**: `market-feed`, `seller-agent`, `buyer-agent`, `ledger-event`
- **Decision**: `repriced`, `skipped`, `submitted-choice`, `accepted`, `countered`
- **Metadata**: Volatility, old/new price, contract ID

### Privacy Theater Additions (Judge Mode)

- **Live visibility shock switch** in app shell:
  - Pick a contract/template and flip Seller vs Outsider instantly.
  - Demonstrates same contract ID visibility for authorized vs unauthorized party.
- **Red-team Outsider panel**:
  - `Try to spy` button runs outsider probes and logs `private-denied` outcomes.
- **Commit-reveal theater** in Live Flow:
  - Displays seller/buyer commitment hashes first.
  - Reveals exact qty/price only after both reveals (or issuer context).
- **Timeline replay mode**:
  - Animated `Intent -> Discovery -> Negotiation -> Approval -> Settlement` stepper.
  - Per-step “who can see this” badges.
- **Counterparty masking UX**:
  - Non-issuer negotiation views show pseudonyms (for example `Buyer-7F2A`).
  - Issuer/settlement context reveals real identities.
- **Privacy heatmap view**:
  - Party x template matrix with live green/red cells and counts.
- **Leak comparison panel**:
  - Side-by-side “public order-book leak world” vs Canton private execution.
- **Live invariant banners**:
  - `Outsider Visibility`, `Replay Attack`, `Expired Discovery`, and visibility-shock status.
- **Mobile polish**:
  - Touch-friendly party chips and responsive proof cards for phone walkthroughs.

### Quick Judge Script (2-5 min)

1. Run `Run Full Private Trade (Judge Mode)` in `Live Flow View`.
2. At first pause, use visibility shock switch (Seller -> Outsider).
3. Continue to commit/reveal pause and highlight hash-first theater.
4. Open `Privacy Matrix View` and point at Outsider row (zero/hidden).
5. Switch to Outsider and click `Try to spy` for private-denied logs.
6. Finish on settlement/compliance and audit output.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VITE_JSON_API_URL` | `http://localhost:7575` | Base URL for the JSON API proxy |
| `VITE_MARKET_API_URL` | `http://localhost:8090` | Market API URL (events + agent controls) |
| `VITE_JSON_API_USE_INSECURE_TOKEN` | `true` | Generate dev JWTs in-browser for party-scoped access |
| `VITE_POLL_INTERVAL_MS` | `3000` | Polling interval for contract queries (ms) |

Create a `.env` file in the `ui/` directory or set these via shell exports before running.

### Vercel Public Demo

This UI includes serverless proxy routes in `ui/api/`:

- `/api/ledger/*`
- `/api/market/*`

They forward to `BACKEND_PUBLIC_URL` at runtime. Set these in Vercel:

- `BACKEND_PUBLIC_URL=https://<your-backend-host>`
- `VITE_JSON_API_URL=/api/ledger`
- `VITE_MARKET_API_URL=/api/market`
- `VITE_JSON_API_USE_INSECURE_TOKEN=true`

`ui/vercel.json` is configured to keep API routes intact and fallback all other routes to `index.html`.

---

## Development

### Install dependencies

```bash
npm install
```

### Start development server

```bash
npm run dev
```

Opens at [http://localhost:5173](http://localhost:5173) with hot module replacement.

### Type check and build for production

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

---

## Key Files

| File | Purpose |
|---|---|
| `src/App.tsx` | Root component, view routing |
| `src/context/PartyContext.tsx` | Party selection state management |
| `src/lib/ledgerClient.ts` | Daml JSON API client with party-header injection |
| `src/views/OwnerView.tsx` | Private holdings + trade intents |
| `src/views/MarketView.tsx` | Zero-knowledge market view |
| `src/views/ComplianceView.tsx` | Issuer ROFR / settlement monitor |
| `src/views/AgentLogsView.tsx` | Agent decision log stream |
| `src/components/MatchFoundToast.tsx` | Match notification banner |
| `src/types/contracts.ts` | TypeScript type definitions for Daml contracts |

---

## Proxy Configuration

The UI sends all ledger API requests through the Nginx proxy at `:7575`. The proxy reads the `X-Ledger-Party` header to route to the correct Canton participant:

| Party | Routed To |
|---|---|
| `Seller`, `SellerAgent` | Seller Participant (`:5013`) |
| `Buyer`, `BuyerAgent` | Buyer Participant (`:5023`) |
| `Company` | Issuer Participant (`:5033`) |

The `ledgerClient.ts` module automatically sets this header based on the currently selected party in `PartyContext`.
