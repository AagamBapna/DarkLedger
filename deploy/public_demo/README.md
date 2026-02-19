# Public Web Demo (No Docker)

This path deploys the project as a public web dApp with party-based visibility, without Docker.

## What it starts

`deploy/public_demo/run_backend.py` starts:

1. dpm sandbox on `LEDGER_PORT` (default `6865`)
2. JSON API (started by dpm sandbox) on `JSON_API_PORT` (default `7575`)
3. Market API on `MARKET_API_PORT` (default `8090`)
4. Seller + Buyer agents (enabled by default)
5. Public gateway on `PUBLIC_PORT` (default `8080`)
6. Auto package-ID discovery + seed/bootstrap with party ID resolution

The gateway exposes:

- `/ledger/*` -> Daml JSON API
- `/market/*` -> Market API
- `/status` -> health summary

The gateway automatically prefixes unqualified template IDs for
`AgenticShadowCap.Market:*` requests, so the UI does not need `VITE_PACKAGE_ID`.

Set `RUN_AGENTS=false` to disable seller/buyer agent processes.

## Local run

Prerequisites:

- `dpm` CLI installed and available on PATH
- Java 17+ (required by Daml tooling)
- Python 3.10+
- Node 18+ (for UI)

From repo root:

```bash
./deploy/public_demo/start_backend.sh
```

Then in another terminal:

```bash
cd ui
npm install
npm run dev
```

For local UI, use:

- `VITE_JSON_API_URL=http://localhost:8080/ledger`
- `VITE_MARKET_API_URL=http://localhost:8080/market`

## Backend host deployment

Deploy this repo to any Linux host (VM, Railway, Render, Fly, etc.) and run:

```bash
./deploy/public_demo/start_backend.sh
```

Expose port `8080` publicly.

Expected public backend URL:

```text
https://your-backend-host.example.com
```

## Vercel UI deployment

Deploy `ui/` to Vercel.

Set these Vercel environment variables:

- `BACKEND_PUBLIC_URL=https://your-backend-host.example.com`
- `VITE_JSON_API_URL=/api/ledger`
- `VITE_MARKET_API_URL=/api/market`
- `VITE_JSON_API_USE_INSECURE_TOKEN=true`

The UI API routes in `ui/api/` proxy requests to `BACKEND_PUBLIC_URL`, so browser calls stay same-origin on the demo URL.

## Demo checklist (for judging)

On the public Vercel URL:

1. Open the party selector and switch between `Seller`, `Buyer`, `Company`, `Public`.
2. Show that each party sees different data.
3. Show that `Public` sees no private contracts.
4. Open Compliance view as `Company` and show settlement/compliance controls.
5. Optionally inject a market event (Owner view) and show logs update.
