# Canton Network Integration

This folder contains the Canton Network runtime bridge for this project:

- `bootstrap.py`: Upload DAR (v2 API), allocate/resolve parties, write party map, and seed demo contracts.
- `v1_gateway.py`: v1-compatible API (`/v1/query|create|exercise|parties`) backed by Canton JSON API v2.
- `run_canton_network_demo.sh`: Full runner (build + bootstrap + gateway + market API + agents).

## Why this exists

Canton participant APIs on DevNet/TestNet expose JSON Ledger API v2, while this project UI/scripts/agents are built around v1-style JSON calls. The gateway provides compatibility so existing app logic can run unchanged.

## Quick start

1) Start your Canton validator or LocalNet so participant endpoints are reachable.

2) Run:

```bash
make canton-network-demo
```

Defaults:
- Provider participant API: `http://127.0.0.1:3975`
- User participant API: `http://127.0.0.1:2975`
- Gateway: `http://127.0.0.1:8081`
- Market API: `http://127.0.0.1:8090`
- Network mode: `local` (set `CANTON_NETWORK_MODE=devnet|testnet|mainnet|public` for shared/public networks)

3) Start UI:

```bash
cd ui
npm install
VITE_JSON_API_URL=http://localhost:8081 \
VITE_MARKET_API_URL=http://localhost:8090 \
VITE_JSON_API_USE_INSECURE_TOKEN=false npm run dev
```

## Auth

Supported env vars:

- `CANTON_PROVIDER_TOKEN`, `CANTON_USER_TOKEN` (preferred)
- `CANTON_JWT_TOKEN` (shared token for both sides)
- `CANTON_ALLOW_INSECURE_TOKEN=true` (default in scripts)
- `CANTON_PROVIDER_ALIASES`, `CANTON_USER_ALIASES` (comma-separated party alias sets)

For LocalNet with unsafe auth, if no token is provided, scripts auto-generate HS256 tokens (`secret=unsafe`, `aud=https://canton.network.global`, `sub=ledger-api-user`).

For `devnet/testnet/mainnet/public` mode, tokens are required and the runner exits if missing.

## Party map outputs

Bootstrap writes:

- `deploy/canton_network/party_map.json`
- `deploy/canton_network/package_id.txt`

Gateway uses these so aliases like `Seller` and `Buyer` map to actual Canton party IDs.
