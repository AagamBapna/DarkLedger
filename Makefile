.PHONY: build up down parties upload seed controls-reset agents agents-stop ui ui-stop demo clean status test test-daml test-e2e test-lifecycle devnet devnet-demo devnet-down canton-network-bootstrap canton-network-demo demo-web-venv demo-web-backend

DAML_DIR   := daml
DEPLOY_DIR := deploy
AGENT_DIR  := agent
UI_DIR     := ui
DAR_FILE   := $(DAML_DIR)/.daml/dist/agentic-shadow-cap-0.1.0.dar
PYTHON     := python3

SELLER_PORT := 5011
BUYER_PORT  := 5021
ISSUER_PORT := 5031

# ─── Build ────────────────────────────────────────────────────────────────────
build:
	@echo "==> Building Daml package..."
	cd $(DAML_DIR) && daml build
	@echo "==> DAR built: $(DAR_FILE)"

# ─── Docker Compose ──────────────────────────────────────────────────────────
up:
	@echo "==> Starting Canton domain + participant nodes..."
	docker compose -f $(DEPLOY_DIR)/docker-compose.yml up -d domain seller-participant buyer-participant issuer-participant json-api-proxy
	@echo "==> Waiting for nodes to become healthy..."
	@sleep 20
	@echo "==> Nodes are up."

down:
	@echo "==> Stopping all containers..."
	docker compose -f $(DEPLOY_DIR)/docker-compose.yml down -v
	@echo "==> Done."

# ─── Party Allocation ────────────────────────────────────────────────────────
parties:
	@echo "==> Parties are auto-allocated by Canton bootstrap scripts."
	@echo "    Seller + SellerAgent on seller-participant"
	@echo "    Buyer + BuyerAgent on buyer-participant"
	@echo "    Company on issuer-participant"

# ─── DAR Upload ──────────────────────────────────────────────────────────────
upload:
	@echo "==> Uploading DAR to all participant nodes..."
	daml ledger upload-dar $(DAR_FILE) --host localhost --port $(SELLER_PORT)
	daml ledger upload-dar $(DAR_FILE) --host localhost --port $(BUYER_PORT)
	daml ledger upload-dar $(DAR_FILE) --host localhost --port $(ISSUER_PORT)
	@echo "==> DAR uploaded to all nodes."

seed:
	@echo "==> Seeding demo contracts (holdings + trade intent)..."
	python3 $(DEPLOY_DIR)/scripts/seed_demo.py
	@echo "==> Seed complete."

controls-reset:
	@echo "==> Resetting agent controls to defaults..."
	printf '{\n  "seller_auto_reprice": true,\n  "buyer_auto_reprice": true\n}\n' > $(AGENT_DIR)/agent_controls.json

# ─── Python Agents ───────────────────────────────────────────────────────────
agents:
	@echo "==> Installing Python dependencies..."
	$(PYTHON) -m pip install -q -r $(AGENT_DIR)/requirements.txt
	@echo "==> Starting seller agent..."
	PYTHONUNBUFFERED=1 DAML_LEDGER_URL=http://localhost:$(SELLER_PORT) \
		SELLER_AGENT_PARTY=SellerAgent \
		SELLER_PARTY=Seller \
		MARKET_FEED_PATH=$(AGENT_DIR)/mock_market_feed.json \
		AGENT_CONTROL_PATH=$(AGENT_DIR)/agent_controls.json \
		$(PYTHON) $(AGENT_DIR)/seller_agent.py &
	@echo "==> Starting buyer agent..."
	PYTHONUNBUFFERED=1 DAML_LEDGER_URL=http://localhost:$(BUYER_PORT) \
		BUYER_AGENT_PARTY=BuyerAgent \
		BUYER_PARTY=Buyer \
		TARGET_INSTRUMENT=COMPANY-SERIES-A \
		MARKET_FEED_PATH=$(AGENT_DIR)/mock_market_feed.json \
		AGENT_CONTROL_PATH=$(AGENT_DIR)/agent_controls.json \
		$(PYTHON) $(AGENT_DIR)/buyer_agent.py &
	@echo "==> Starting market event API..."
	MARKET_FEED_PATH=$(AGENT_DIR)/mock_market_feed.json \
		AGENT_CONTROL_PATH=$(AGENT_DIR)/agent_controls.json \
		$(PYTHON) -m uvicorn agent.market_api:app --host 0.0.0.0 --port 8090 &
	@echo "==> All agents running in background."

agents-stop:
	@echo "==> Stopping agents..."
	-pkill -f "seller_agent.py" 2>/dev/null
	-pkill -f "buyer_agent.py" 2>/dev/null
	-pkill -f "market_api:app" 2>/dev/null
	@echo "==> Agents stopped."

# ─── UI ──────────────────────────────────────────────────────────────────────
ui:
	@echo "==> Starting React dashboard..."
	cd $(UI_DIR) && npm install && npm run dev &
	@echo "==> UI available at http://localhost:5173"

ui-stop:
	-pkill -f "vite" 2>/dev/null

# ─── Sandbox Demo (no Docker needed) ────────────────────────────────────────
sandbox:
	@echo "==> Starting local sandbox demo..."
	$(MAKE) build
	@echo "==> Starting Daml sandbox..."
	cd $(DAML_DIR) && daml sandbox --port 6865 &
	@sleep 15
	@echo "==> Uploading DAR to sandbox..."
	daml ledger upload-dar $(DAR_FILE) --host localhost --port 6865
	@echo "==> Running MvpScript..."
	cd $(DAML_DIR) && daml script --dar .daml/dist/agentic-shadow-cap-0.1.0.dar \
		--script-name AgenticShadowCap.MvpScript:mvpBootstrap \
		--ledger-host localhost --ledger-port 6865 --wall-clock-time
	@echo "==> Sandbox demo complete. Full lifecycle executed."

# ─── Full Demo ───────────────────────────────────────────────────────────────
demo:
	@echo "============================================"
	@echo "  Agentic Shadow-Cap — Full Demo"
	@echo "============================================"
	$(MAKE) build
	$(MAKE) up
	$(MAKE) upload
	$(MAKE) seed
	$(MAKE) controls-reset
	$(MAKE) agents
	$(MAKE) ui
	@echo ""
	@echo "============================================"
	@echo "  Demo is LIVE"
	@echo "  UI:     http://localhost:5173"
	@echo "  API:    http://localhost:8090/status"
	@echo "  Inject: http://localhost:8090/docs"
	@echo "============================================"

# ─── Testing ────────────────────────────────────────────────────────────────
test-daml:
	@echo "==> Running Daml tests..."
	cd $(DAML_DIR) && daml test
	@echo "==> All Daml tests passed."

test-e2e:
	@echo "==> Running E2E smoke test (requires running system)..."
	bash test_e2e.sh

test-lifecycle:
	@echo "==> Running full lifecycle test (requires running nodes, no agents needed)..."
	bash test_lifecycle.sh

test: test-daml
	@echo "==> Unit tests complete. For integration tests run: make test-e2e (with make demo running)"

devnet:
	@echo "==> Setting up Canton L1 (Splice LocalNet)..."
	bash $(DEPLOY_DIR)/devnet/setup_devnet_validator.sh

devnet-demo:
	@echo "==> Starting agents + UI against Canton L1..."
	bash $(DEPLOY_DIR)/devnet/run_devnet_demo.sh

devnet-down:
	@echo "==> Stopping Canton L1 (Splice LocalNet)..."
	@LOCALNET_DIR="$${HOME}/.canton/0.5.10/splice-node/docker-compose/localnet" && \
	 IMAGE_TAG=0.5.10 && \
	 export LOCALNET_DIR IMAGE_TAG && \
	 docker compose \
	   --env-file "$$LOCALNET_DIR/compose.env" \
	   --env-file "$$LOCALNET_DIR/env/common.env" \
	   -f "$$LOCALNET_DIR/compose.yaml" \
	   -f "$$LOCALNET_DIR/resource-constraints.yaml" \
	   --profile sv \
	   --profile app-provider \
	   --profile app-user \
	   down -v
	@echo "==> Canton L1 stopped."

# ─── Public Web Demo (no Docker) ───────────────────────────────────────────
demo-web-venv:
	@echo "==> Creating/updating local virtualenv..."
	$(PYTHON) -m venv .venv
	.venv/bin/python -m pip install --upgrade pip
	.venv/bin/python -m pip install -r $(AGENT_DIR)/requirements.txt
	@echo "==> Virtualenv ready: .venv"

demo-web-backend:
	@if [ ! -x .venv/bin/python ]; then \
		echo "==> Missing .venv. Run: make demo-web-venv"; \
		exit 1; \
	fi
	@echo "==> Starting no-Docker public demo backend..."
	.venv/bin/python deploy/public_demo/run_backend.py

canton-network-bootstrap: build
	@echo "==> Bootstrapping Canton Network participants..."
	@if [ ! -x .venv/bin/python ]; then \
		echo "==> Missing .venv. Run: make demo-web-venv"; \
		exit 1; \
	fi
	.venv/bin/python deploy/canton_network/bootstrap.py

canton-network-demo:
	@echo "==> Starting full Canton Network demo stack (gateway + agents + market API)..."
	bash deploy/canton_network/run_canton_network_demo.sh

# ─── Status ──────────────────────────────────────────────────────────────────
status:
	@echo "==> Docker containers:"
	@docker compose -f $(DEPLOY_DIR)/docker-compose.yml ps 2>/dev/null || echo "  (not running)"
	@echo ""
	@echo "==> Agent processes:"
	@ps aux | grep -E "(seller_agent|buyer_agent|market_api)" | grep -v grep || echo "  (none running)"

# ─── Clean ───────────────────────────────────────────────────────────────────
clean:
	@echo "==> Cleaning build artifacts..."
	rm -rf $(DAML_DIR)/.daml
	rm -rf $(UI_DIR)/node_modules $(UI_DIR)/dist
	rm -rf .venv __pycache__ $(AGENT_DIR)/__pycache__
	@echo "==> Clean."
