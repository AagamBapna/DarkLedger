#!/usr/bin/env python3
"""Run a no-Docker backend for the public web demo.

Starts:
1) Daml sandbox
2) Daml JSON API
3) Market API
4) Seller and buyer agents (optional)
5) Public gateway (`/ledger/*` and `/market/*`)
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DAML_DIR = ROOT / "daml"
DAR_FILE = DAML_DIR / ".daml/dist/agentic-shadow-cap-0.1.0.dar"

LEDGER_PORT = int(os.getenv("LEDGER_PORT", "6865"))
JSON_API_PORT = int(os.getenv("JSON_API_PORT", "7575"))
MARKET_API_PORT = int(os.getenv("MARKET_API_PORT", "8090"))
PUBLIC_PORT = int(os.getenv("PUBLIC_PORT", "8080"))
BOOTSTRAP_SCRIPT = os.getenv("BOOTSTRAP_SCRIPT", "AgenticShadowCap.MvpScript:mvpBootstrap")
SKIP_BUILD = os.getenv("SKIP_BUILD", "false").lower() == "true"
SKIP_SEED = os.getenv("SKIP_SEED", "false").lower() == "true"
RUN_AGENTS = os.getenv("RUN_AGENTS", "true").lower() != "false"
PACKAGE_ID_OVERRIDE = os.getenv("PACKAGE_ID", "").strip()


@dataclass
class ManagedProcess:
    name: str
    popen: subprocess.Popen[str]


def _log(message: str) -> None:
    print(f"[demo-backend] {message}", flush=True)


def _run_blocking(command: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    _log(f"run: {' '.join(command)}")
    subprocess.run(command, cwd=str(cwd or ROOT), env=env, check=True)


def _run_capture_stdout(command: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    _log(f"run: {' '.join(command)}")
    completed = subprocess.run(
        command,
        cwd=str(cwd or ROOT),
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    if completed.stderr:
        print(completed.stderr, end="", file=sys.stderr)
    return completed.stdout


def _wait_for_port(port: int, host: str = "127.0.0.1", timeout_seconds: float = 90.0) -> None:
    start = time.time()
    while time.time() - start < timeout_seconds:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1.0)
            if sock.connect_ex((host, port)) == 0:
                return
        time.sleep(0.5)
    raise TimeoutError(f"Timed out waiting for {host}:{port}")


def _start_process(name: str, command: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> ManagedProcess:
    merged_env = dict(os.environ)
    if env:
        merged_env.update(env)
    _log(f"start: {name} -> {' '.join(command)}")
    popen = subprocess.Popen(command, cwd=str(cwd or ROOT), env=merged_env, text=True)
    return ManagedProcess(name=name, popen=popen)


def _retry_upload_dar() -> None:
    command = [
        "daml",
        "ledger",
        "upload-dar",
        str(DAR_FILE),
        "--host",
        "127.0.0.1",
        "--port",
        str(LEDGER_PORT),
    ]
    last_error: Exception | None = None
    for attempt in range(1, 21):
        try:
            _run_blocking(command)
            return
        except Exception as ex:  # pragma: no cover
            last_error = ex
            _log(f"upload DAR attempt {attempt}/20 failed; retrying in 2s")
            time.sleep(2)
    raise RuntimeError("Failed to upload DAR after retries") from last_error


def _discover_package_id() -> str:
    if PACKAGE_ID_OVERRIDE:
        return PACKAGE_ID_OVERRIDE

    output = _run_capture_stdout(["daml", "damlc", "inspect-dar", str(DAR_FILE), "--json"])
    payload = json.loads(output)
    package_id = (payload.get("main_package_id") or "").strip()
    if not package_id:
        raise RuntimeError("Could not determine main_package_id from inspect-dar output")
    return package_id


def _bootstrap_and_seed(package_id: str) -> None:
    _run_blocking(
        [
            "daml",
            "script",
            "--dar",
            str(DAR_FILE),
            "--script-name",
            BOOTSTRAP_SCRIPT,
            "--ledger-host",
            "127.0.0.1",
            "--ledger-port",
            str(LEDGER_PORT),
            "--wall-clock-time",
        ],
        cwd=DAML_DIR,
    )

    if SKIP_SEED:
        _log("SKIP_SEED=true, skipping deploy/scripts/seed_demo.py")
        return

    seed_env = dict(os.environ)
    seed_env.update(
        {
            "JSON_API_URL": f"http://127.0.0.1:{JSON_API_PORT}",
            "JSON_API_USE_INSECURE_TOKEN": "true",
            "PACKAGE_ID": package_id,
        }
    )
    _run_blocking([sys.executable, "deploy/scripts/seed_demo.py"], env=seed_env)


def _stop_processes(processes: list[ManagedProcess]) -> None:
    for managed in reversed(processes):
        if managed.popen.poll() is not None:
            continue
        _log(f"stop: {managed.name}")
        managed.popen.terminate()
        try:
            managed.popen.wait(timeout=8)
        except subprocess.TimeoutExpired:
            _log(f"kill: {managed.name}")
            managed.popen.kill()


def main() -> int:
    processes: list[ManagedProcess] = []

    def _shutdown_handler(signum: int, _frame: object) -> None:
        _log(f"received signal {signum}, shutting down")
        _stop_processes(processes)
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _shutdown_handler)
    signal.signal(signal.SIGTERM, _shutdown_handler)

    try:
        if not SKIP_BUILD:
            _run_blocking(["daml", "build"], cwd=DAML_DIR)
        else:
            _log("SKIP_BUILD=true, reusing existing DAR")

        if not DAR_FILE.exists():
            raise FileNotFoundError(f"Missing DAR file: {DAR_FILE}")

        package_id = _discover_package_id()
        _log(f"package ID: {package_id}")

        sandbox = _start_process("daml-sandbox", ["daml", "sandbox", "--port", str(LEDGER_PORT)], cwd=DAML_DIR)
        processes.append(sandbox)
        _wait_for_port(LEDGER_PORT)

        _retry_upload_dar()

        json_api = _start_process(
            "daml-json-api",
            [
                "daml",
                "json-api",
                "--ledger-host",
                "127.0.0.1",
                "--ledger-port",
                str(LEDGER_PORT),
                "--address",
                "127.0.0.1",
                "--http-port",
                str(JSON_API_PORT),
                "--allow-insecure-tokens",
            ],
        )
        processes.append(json_api)
        _wait_for_port(JSON_API_PORT)

        _bootstrap_and_seed(package_id)

        market_env = {
            "MARKET_FEED_PATH": str(ROOT / "agent/mock_market_feed.json"),
            "AGENT_CONTROL_PATH": str(ROOT / "agent/agent_controls.json"),
        }
        market_api = _start_process(
            "market-api",
            [
                sys.executable,
                "-m",
                "uvicorn",
                "agent.market_api:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(MARKET_API_PORT),
            ],
            env=market_env,
        )
        processes.append(market_api)
        _wait_for_port(MARKET_API_PORT)

        if RUN_AGENTS:
            seller_agent_env = {
                "PYTHONUNBUFFERED": "1",
                "DAML_LEDGER_URL": f"http://127.0.0.1:{LEDGER_PORT}",
                "SELLER_AGENT_PARTY": "SellerAgent",
                "SELLER_PARTY": "Seller",
                "MARKET_FEED_PATH": str(ROOT / "agent/mock_market_feed.json"),
                "AGENT_CONTROL_PATH": str(ROOT / "agent/agent_controls.json"),
            }
            seller_agent = _start_process(
                "seller-agent",
                [sys.executable, "agent/seller_agent.py"],
                env=seller_agent_env,
            )
            processes.append(seller_agent)

            buyer_agent_env = {
                "PYTHONUNBUFFERED": "1",
                "DAML_LEDGER_URL": f"http://127.0.0.1:{LEDGER_PORT}",
                "BUYER_AGENT_PARTY": "BuyerAgent",
                "BUYER_PARTY": "Buyer",
                "TARGET_INSTRUMENT": "COMPANY-SERIES-A",
                "MARKET_FEED_PATH": str(ROOT / "agent/mock_market_feed.json"),
                "AGENT_CONTROL_PATH": str(ROOT / "agent/agent_controls.json"),
            }
            buyer_agent = _start_process(
                "buyer-agent",
                [sys.executable, "agent/buyer_agent.py"],
                env=buyer_agent_env,
            )
            processes.append(buyer_agent)
        else:
            _log("RUN_AGENTS=false, skipping seller/buyer agent processes")

        gateway_env = {
            "LEDGER_API_URL": f"http://127.0.0.1:{JSON_API_PORT}",
            "MARKET_API_URL": f"http://127.0.0.1:{MARKET_API_PORT}",
            "CORS_ALLOW_ORIGINS": os.getenv("CORS_ALLOW_ORIGINS", "*"),
            "PACKAGE_ID": package_id,
        }
        gateway = _start_process(
            "public-gateway",
            [
                sys.executable,
                "-m",
                "uvicorn",
                "deploy.public_demo.gateway:app",
                "--host",
                "0.0.0.0",
                "--port",
                str(PUBLIC_PORT),
            ],
            env=gateway_env,
        )
        processes.append(gateway)
        _wait_for_port(PUBLIC_PORT)

        _log("backend is ready")
        _log(f"public gateway: http://localhost:{PUBLIC_PORT}")
        _log(f"health check:   http://localhost:{PUBLIC_PORT}/status")

        while True:
            for managed in processes:
                code = managed.popen.poll()
                if code is not None:
                    raise RuntimeError(f"{managed.name} exited unexpectedly with code {code}")
            time.sleep(2)

    except Exception as ex:
        _log(f"fatal: {ex}")
        _stop_processes(processes)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
