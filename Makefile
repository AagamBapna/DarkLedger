.PHONY: build dpm-build dpm-test up down parties upload seed controls-reset agents agents-stop ui ui-stop sandbox demo demo-docker demo-stop clean status test test-daml test-e2e test-lifecycle devnet devnet-demo devnet-down canton-network-bootstrap canton-network-demo demo-web-venv demo-web-backend dpm-install

DAML_DIR   := daml
DEPLOY_DIR := deploy
AGENT_DIR  := agent
UI_DIR     := ui
DAR_FILE   := $(DAML_DIR)/.daml/dist/agentic-shadow-cap-0.1.0.dar
PYTHON     := python3

# Network mode: local | devnet | testnet | mainnet
CANTON_NETWORK_MODE ?= local

# Configurable party aliases
SELLER_PARTY       ?= Seller
SELLER_AGENT_PARTY ?= SellerAgent
BUYER_PARTY        ?= Buyer
BUYER_AGENT_PARTY  ?= BuyerAgent
ISSUER_PARTY       ?= Company

# Configurable instrument defaults
DEMO_INSTRUMENT    ?= COMPANY-SERIES-A
TARGET_INSTRUMENT  ?= $(DEMO_INSTRUMENT)

# Configurable ports (local Docker mode)
SELLER_PORT := 5011
BUYER_PORT  := 5021
ISSUER_PORT := 5031
SELLER_HTTP_PORT := 5013
BUYER_HTTP_PORT  := 5023
ISSUER_HTTP_PORT := 5033
CANTON_VERSION ?= 0.5.10

# Prefer dpm when available, but keep compatibility with daml assistant.
define ensure_daml_cmd
DAML_CMD=""; \
if command -v dpm >/dev/null 2>&1; then \
	DAML_CMD="dpm"; \
elif [ -x "$$HOME/.dpm/bin/dpm" ]; then \
	DAML_CMD="$$HOME/.dpm/bin/dpm"; \
elif command -v daml >/dev/null 2>&1; then \
	DAML_CMD="daml"; \
fi; \
if [ -z "$$DAML_CMD" ]; then \
	echo "ERROR: neither dpm nor daml is installed."; \
	echo "Run 'make dpm-install' or install Daml SDK 3.4.x."; \
	exit 127; \
fi
endef

define ensure_dpm_cmd
DPM_CMD=""; \
if command -v dpm >/dev/null 2>&1; then \
	DPM_CMD="dpm"; \
elif [ -x "$$HOME/.dpm/bin/dpm" ]; then \
	DPM_CMD="$$HOME/.dpm/bin/dpm"; \
fi; \
if [ -z "$$DPM_CMD" ]; then \
	echo "ERROR: dpm is required for this target but is not installed."; \
	echo "Run 'make dpm-install' and ensure $$HOME/.dpm/bin is on PATH."; \
	exit 127; \
fi
endef

# ─── Build ────────────────────────────────────────────────────────────────────
build:
	@echo "==> Building Daml package..."
	@$(ensure_daml_cmd); \
		echo "==> Using $$DAML_CMD"; \
		cd $(DAML_DIR) && $$DAML_CMD build
	@echo "==> DAR built: $(DAR_FILE)"

dpm-build:
	@echo "==> Building Daml package with dpm..."
	@$(ensure_dpm_cmd); \
		echo "==> Using $$DPM_CMD"; \
		cd $(DAML_DIR) && $$DPM_CMD build
	@echo "==> DAR built: $(DAR_FILE)"

# ─── dpm (Digital Asset Package Manager) ─────────────────────────────────────
dpm-install:
	@echo "==> Installing dpm (Digital Asset Package Manager)..."
	@command -v dpm >/dev/null 2>&1 && { echo "  dpm already installed:"; dpm --version 2>/dev/null || true; } || { \
		echo "  Installing dpm..."; \
		curl -fsSL https://get.digitalasset.com/install/install.sh | sh || { \
			echo "  ERROR: dpm auto-install failed. Install manually: curl https://get.digitalasset.com/install/install.sh | sh"; \
			exit 1; \
		}; \
		command -v dpm >/dev/null 2>&1 || [ -x "$$HOME/.dpm/bin/dpm" ] || { \
			echo "  ERROR: dpm installed but is not on PATH. Add $$HOME/.dpm/bin to PATH."; \
			exit 1; \
		}; \
		echo "  dpm installed:"; \
		(command -v dpm >/dev/null 2>&1 && dpm --version 2>/dev/null || "$$HOME/.dpm/bin/dpm" --version 2>/dev/null) || true; \
	}

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
	$(PYTHON) $(DEPLOY_DIR)/scripts/upload_dar.py \
		--dar $(DAR_FILE) \
		--url http://localhost:$(SELLER_HTTP_PORT)/v2/packages \
		--url http://localhost:$(BUYER_HTTP_PORT)/v2/packages \
		--url http://localhost:$(ISSUER_HTTP_PORT)/v2/packages
	@echo "==> DAR uploaded to all nodes."

seed:
	@echo "==> Seeding demo contracts (holdings + trade intent)..."
	CANTON_NETWORK_MODE=$(CANTON_NETWORK_MODE) \
		ISSUER_PARTY=$(ISSUER_PARTY) \
		SELLER_PARTY=$(SELLER_PARTY) \
		SELLER_AGENT_PARTY=$(SELLER_AGENT_PARTY) \
		BUYER_PARTY=$(BUYER_PARTY) \
		DEMO_INSTRUMENT=$(DEMO_INSTRUMENT) \
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
	PYTHONUNBUFFERED=1 \
		CANTON_NETWORK_MODE=$(CANTON_NETWORK_MODE) \
		DAML_LEDGER_URL=http://localhost:$(SELLER_PORT) \
		SELLER_AGENT_PARTY=$(SELLER_AGENT_PARTY) \
		SELLER_PARTY=$(SELLER_PARTY) \
		MARKET_FEED_PATH=$(AGENT_DIR)/mock_market_feed.json \
		AGENT_CONTROL_PATH=$(AGENT_DIR)/agent_controls.json \
		$(PYTHON) $(AGENT_DIR)/seller_agent.py &
	@echo "==> Starting buyer agent..."
	PYTHONUNBUFFERED=1 \
		CANTON_NETWORK_MODE=$(CANTON_NETWORK_MODE) \
		DAML_LEDGER_URL=http://localhost:$(BUYER_PORT) \
		BUYER_AGENT_PARTY=$(BUYER_AGENT_PARTY) \
		BUYER_PARTY=$(BUYER_PARTY) \
		TARGET_INSTRUMENT=$(TARGET_INSTRUMENT) \
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
	cd $(UI_DIR) && npm install
	@nohup sh -c "cd $(UI_DIR) && npm run dev -- --host 127.0.0.1 --port 5173" >/tmp/canton_ui.log 2>&1 &
	@sleep 2
	@echo "==> UI available at http://localhost:5173"

ui-stop:
	-pkill -f "vite" 2>/dev/null

# ─── Sandbox Demo (no Docker needed) ────────────────────────────────────────
sandbox:
	@echo "==> Starting local sandbox demo..."
	$(MAKE) build
	@echo "==> Starting Daml sandbox..."
	@$(ensure_daml_cmd); \
		echo "==> Using $$DAML_CMD"; \
		cd $(DAML_DIR) && $$DAML_CMD sandbox --port 6865 --dar .daml/dist/agentic-shadow-cap-0.1.0.dar &
	@sleep 15
	@echo "==> Running MvpScript..."
	@$(ensure_daml_cmd); \
		echo "==> Using $$DAML_CMD"; \
		if [ "$$DAML_CMD" = "dpm" ]; then \
			cd $(DAML_DIR) && $$DAML_CMD script --dar .daml/dist/agentic-shadow-cap-0.1.0.dar \
				--script-name AgenticShadowCap.MvpScript:mvpBootstrap \
				--ledger-host localhost --port 6865 --wall-clock-time; \
		else \
			cd $(DAML_DIR) && $$DAML_CMD script --dar .daml/dist/agentic-shadow-cap-0.1.0.dar \
				--script-name AgenticShadowCap.MvpScript:mvpBootstrap \
				--ledger-host localhost --ledger-port 6865 --wall-clock-time; \
		fi
	@echo "==> Sandbox demo complete. Full lifecycle executed."

# ─── Full Demo ───────────────────────────────────────────────────────────────
demo:
	@echo "============================================"
	@echo "  Agentic Shadow-Cap — Full Demo (Sandbox)"
	@echo "============================================"
	$(MAKE) demo-web-venv
	@echo "==> Starting backend (sandbox + market API + agents + gateway)..."
	@pkill -f "deploy/public_demo/run_backend.py" 2>/dev/null || true
	@pkill -f "dpm sandbox" 2>/dev/null || true
	@pkill -f "daml sandbox" 2>/dev/null || true
	@pkill -f "canton-enterprise.*sandbox" 2>/dev/null || true
	@for p in 6865 6870 6871 6872 6873 7575; do \
		lsof -ti tcp:$$p | xargs kill -9 2>/dev/null || true; \
	done
	@nohup .venv/bin/python deploy/public_demo/run_backend.py >/tmp/canton_backend.log 2>&1 &
	@sleep 4
	$(MAKE) ui
	@echo ""
	@echo "============================================"
	@echo "  Demo is LIVE"
	@echo "  UI:      http://localhost:5173"
	@echo "  Backend: http://localhost:8080/status"
	@echo "  Logs:    tail -f /tmp/canton_backend.log"
	@echo "============================================"

demo-docker:
	@echo "==> Legacy multi-node Canton Docker topology is currently incompatible."
	@echo "==> Running stable full demo path instead."
	$(MAKE) demo

demo-stop:
	@echo "==> Stopping demo services..."
	-pkill -f "deploy/public_demo/run_backend.py" 2>/dev/null
	-pkill -f "daml sandbox" 2>/dev/null
	-pkill -f "dpm sandbox" 2>/dev/null
	-pkill -f "canton-enterprise.*sandbox" 2>/dev/null
	$(MAKE) agents-stop
	$(MAKE) ui-stop
	@echo "==> Demo services stopped."

# ─── Testing ────────────────────────────────────────────────────────────────
test-daml:
	@echo "==> Running Daml tests..."
	@$(ensure_daml_cmd); \
		echo "==> Using $$DAML_CMD"; \
		cd $(DAML_DIR) && $$DAML_CMD test
	@echo "==> All Daml tests passed."

dpm-test:
	@echo "==> Running Daml tests with dpm..."
	@$(ensure_dpm_cmd); \
		echo "==> Using $$DPM_CMD"; \
		cd $(DAML_DIR) && $$DPM_CMD test
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
	@LOCALNET_DIR="$${HOME}/.canton/$(CANTON_VERSION)/splice-node/docker-compose/localnet" && \
	 IMAGE_TAG=$(CANTON_VERSION) && \
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
	@echo ""
	@echo "==> Backend/UI processes:"
	@ps aux | grep -E "(run_backend.py|uvicorn deploy.public_demo.gateway|vite --host 127.0.0.1 --port 5173)" | grep -v grep || echo "  (none running)"

# ─── Clean ───────────────────────────────────────────────────────────────────
clean:
	@echo "==> Cleaning build artifacts..."
	rm -rf $(DAML_DIR)/.daml
	rm -rf $(UI_DIR)/node_modules $(UI_DIR)/dist
	rm -rf .venv __pycache__ $(AGENT_DIR)/__pycache__
	@echo "==> Clean."
