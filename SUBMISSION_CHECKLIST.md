# Submission Checklist — Agentic Shadow-Cap

Canton Privacy dApp Track: *Build a dApp on Canton L1 using Daml & dpm that demonstrates creativity and innovation while focusing on Canton Network's privacy first model.*

## Required Links

| Artifact | URL |
|---|---|
| **GitHub Repository** | `https://github.com/<your-org>/canton` |
| **Live Demo URL** | `https://<your-demo>.vercel.app` |
| **Demo Video (2-5 min)** | `https://youtu.be/<video-id>` |
| **Scan Explorer TX Links** | `http://scan.localhost:4000` (LocalNet) |

---

## Bounty Requirements — Pass/Fail

### 1. Functional Deployment
| Requirement | Status | Evidence |
|---|---|---|
| Deployed on Canton L1 Devnet | [ ] | `make devnet && make devnet-demo` |
| Working end-to-end flow | [ ] | Video timestamp: `0:00` |
| Accessible demo URL | [ ] | Link above |

### 2. Meaningful Daml Usage
| Requirement | Status | Evidence |
|---|---|---|
| Smart contracts written in Daml | [x] | `daml/src/AgenticShadowCap/Market.daml` — 8 templates |
| Not wrappers around other chains | [x] | Native Canton privacy model, sub-transaction privacy |
| Privacy model correctly implemented | [x] | 5-party model with signatory/observer separation |
| 20 Daml test scenarios passing | [x] | `make test-daml` |

### 3. dpm Usage
| Requirement | Status | Evidence |
|---|---|---|
| dpm installed | [ ] | `make dpm-install` |
| `dpm build` compiles DAR | [ ] | `make dpm-build` |
| `dpm test` runs test suite | [ ] | `make dpm-test` |

### 4. Open Source
| Requirement | Status | Evidence |
|---|---|---|
| Public GitHub repository | [ ] | Link above |
| Accessible, reviewable code | [x] | Apache 2.0 license |
| No secrets committed | [x] | `.gitignore` excludes `.env`, credentials |

### 5. Documentation
| Requirement | Status | Evidence |
|---|---|---|
| Clear README with setup/install | [x] | `README.md` |
| Privacy model explanation | [x] | Privacy Model table in README |
| Data visibility per party | [x] | 6 perspectives documented |

### 6. Working Demo
| Requirement | Status | Evidence |
|---|---|---|
| 2-5 minute video | [ ] | Link above |
| Live demonstration | [ ] | Demo URL above |
| Shows core functionality | [ ] | Video script below |

### 7. UI/UX Requirements
| Requirement | Status | Evidence |
|---|---|---|
| Functional web interface | [x] | React + Tailwind dashboard |
| Clear party indication | [x] | Party selector in header |
| Data visibility controls | [x] | Public perspective shows zero contracts |
| Responsive design | [x] | Tailwind responsive classes |
| Published to accessible URL | [ ] | Vercel deployment |

---

## Judging Criteria — Self-Assessment

### Technical Implementation (Weight: High)
- [x] Proper use of Daml (8 templates, typed choices, ensure/assert guards)
- [x] Correct Canton privacy model (signatory/observer separation per contract)
- [x] Code quality (typed Python agents, TypeScript React, Daml tests)
- [x] dpm integration (build, test targets)

### Privacy Model Innovation (Weight: High)
- [x] Sub-transaction privacy: Each party only sees contracts they are stakeholders of
- [x] Blind discovery: DiscoveryInterest reveals only instrument+side, never price/volume
- [x] Private negotiation: Two-party channels invisible to outsiders
- [x] Public perspective: Demonstrates zero-knowledge for unauthorized observers
- [x] Agent audit trail: On-ledger decision logs visible only to agent+owner

### Utility & Impact (Weight: Medium)
- [x] Real-world problem: Secondary market information leakage
- [x] Autonomous AI agents reduce negotiation from weeks to minutes
- [x] Compliance gate (ROFR/right of first refusal) for issuer
- [x] Atomic DvP settlement prevents counterparty risk

### Documentation & Demo Quality (Weight: Medium)
- [x] Comprehensive README with architecture, privacy model, workflow
- [x] Multiple deployment paths (Docker, sandbox, Canton L1)
- [x] Environment-driven configuration
- [x] Reproducible with `make demo` or `make devnet`

---

## Judge Reproduction Commands

### LocalNet (Canton L1) — Recommended for Judges

```bash
# Prerequisites: Docker Desktop (8GB+ RAM), Daml SDK 3.4.x, Node.js 18+, Python 3.10+

# 1. Build and deploy to Canton L1
make build
make devnet           # Downloads splice-node, starts LocalNet, bootstraps

# 2. Start gateway + agents
make devnet-demo      # Starts v1 gateway, market API, seller/buyer agents

# 3. Start UI
cd ui && npm install
VITE_JSON_API_URL=http://localhost:8081 \
  VITE_MARKET_API_URL=http://localhost:8090 \
  VITE_JSON_API_USE_INSECURE_TOKEN=false \
  VITE_CANTON_NETWORK_MODE=devnet \
  npm run dev

# 4. Run lifecycle test
JSON_API_URL=http://localhost:8081 bash test_lifecycle.sh

# 5. Stop everything
make devnet-down
```

### Public TestNet/MainNet

```bash
# Set credentials
export CANTON_NETWORK_MODE=testnet
export CANTON_PROVIDER_URL=<provider-json-api-url>
export CANTON_USER_URL=<user-json-api-url>
export CANTON_PROVIDER_TOKEN=<jwt>
export CANTON_USER_TOKEN=<jwt>

# Build and bootstrap
make build
make canton-network-bootstrap

# Start demo
make canton-network-demo
```

### Local Docker (Quick Test)

```bash
make demo    # One command: build + nodes + upload + seed + agents + UI
# Open http://localhost:5173
```

---

## Demo Video Script (2-5 minutes)

### 0:00 — Introduction (30s)
- Problem: Information leakage in secondary markets
- Solution: AI agents + Canton privacy = confidential dark pool

### 0:30 — Architecture (30s)
- Show architecture diagram
- Explain 3 participant nodes + privacy domain
- Point out 5 party model

### 1:00 — Seller Perspective (45s)
- Show Seller's private holdings and trade intent
- Show agent repricing based on market data
- Inject a market event (e.g., SEC investigation)
- Show agent reacting to news sentiment

### 1:45 — Buyer Perspective (30s)
- Switch to Buyer — show they CANNOT see Seller's trade intent
- Show only cash holdings visible

### 2:15 — Agent Negotiation (45s)
- Show DiscoveryInterest signals (blind — no price/volume)
- Show PrivateNegotiation channel created
- Show agent decision logs with reasoning

### 3:00 — Public Perspective (30s)
- Switch to Public — show ZERO contracts
- Explain Canton's sub-transaction privacy

### 3:30 — Compliance & Settlement (30s)
- Switch to Company (Issuer)
- Show ApproveMatch button
- Show DvP settlement
- Show immutable audit trail

### 4:00 — Canton L1 Deployment (30s)
- Show Scan Explorer with transactions
- Show dpm build output
- Mention reproducible deployment

### 4:30 — Wrap-up (30s)
- Summary of privacy innovation
- Link to repo and demo
