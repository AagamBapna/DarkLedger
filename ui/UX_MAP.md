# Agentic Shadow-Cap Dashboard (React UX Map)

## UX Principles
- No global order book, no public depth chart, no pooled liquidity screen.
- Every panel is scoped to the logged-in party and their Canton participant.
- "Market View" is intentionally empty until a private match is created.

## App Shell
- Top bar:
  - Party selector (`Seller`, `SellerAgent`, `Buyer`, `BuyerAgent`, `Company`)
  - Participant endpoint indicator (`seller-node`, `buyer-node`, `issuer-node`)
  - Connectivity status (Ledger API + Agent heartbeat)
- Left nav:
  - `Owner View`
  - `Market View`
  - `Compliance`
  - `Agent Logs`

## Owner View (private-by-default)
- Cards:
  - `Private Holdings`: position + available quantity
  - `Active Trade Intents`: instrument, quantity, `minPrice`, last agent update time
  - `Negotiation Status`: if any active `PrivateNegotiation` contract exists
- Timeline:
  - Agent actions (`UpdatePrice`, `SubmitSellerTerms`, `AcceptBySeller`)
  - Issuer actions (`ApproveMatch`, settlement status changes)
- Controls:
  - Manual override for `minPrice`
  - Toggle "agent auto-reprice" on/off

## Market View (zero-knowledge stance)
- Before match:
  - Full-screen placeholder: `No discoverable market data`
  - Explanation copy:
    - "Discovery uses private interest signaling only."
    - "Price and volume remain hidden until direct match."
- On private match event:
  - Notification banner: `Match Found`
  - Minimal details: instrument and counterparty pseudonym
  - CTA: `Open Negotiation Channel`

## Compliance View (issuer only)
- Queue of pending `PrivateNegotiation` contracts:
  - both-side acceptance status
  - terms present/not present
- ROFR action:
  - `ApproveMatch` button
  - Audit memo input (optional)
- Settlement monitor:
  - `TradeSettlement` contracts and finalization status

## Agent Logs View
- Streaming log table:
  - source (`market-feed`, `seller-agent`, `ledger-event`)
  - decision (`repriced`, `skipped`, `submitted-choice`)
  - metadata (volatility, old/new minPrice, contract id)

## Suggested React Component Map
- `src/App.tsx`
- `src/layout/AppShell.tsx`
- `src/views/OwnerView.tsx`
- `src/views/MarketView.tsx`
- `src/views/ComplianceView.tsx`
- `src/views/AgentLogsView.tsx`
- `src/components/MatchFoundToast.tsx`
- `src/components/TradeIntentTable.tsx`
- `src/lib/ledgerClient.ts`
- `src/lib/agentEventBridge.ts`

## Data Contracts Consumed by UI
- `TradeIntent` (owner + seller agent + issuer visibility)
- `PrivateNegotiation` (created only after matched interests)
- `TradeSettlement` (post-approval settlement record)
