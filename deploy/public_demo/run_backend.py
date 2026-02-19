#!/usr/bin/env python3
"""Run a no-Docker backend for the public web demo.

Starts:
1) DPM sandbox (with JSON API enabled)
2) Market API
3) Seller and buyer agents (optional)
4) Public gateway (`/ledger/*` and `/market/*`)
"""

from __future__ import annotations

import json
import os
import signal
import shutil
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
V1_GATEWAY_PORT = int(os.getenv("V1_GATEWAY_PORT", "8081"))
ADMIN_API_PORT = int(os.getenv("ADMIN_API_PORT", "6870"))
SEQUENCER_PUBLIC_PORT = int(os.getenv("SEQUENCER_PUBLIC_PORT", "6871"))
SEQUENCER_ADMIN_PORT = int(os.getenv("SEQUENCER_ADMIN_PORT", "6872"))
MEDIATOR_ADMIN_PORT = int(os.getenv("MEDIATOR_ADMIN_PORT", "6873"))
BOOTSTRAP_SCRIPT = os.getenv("BOOTSTRAP_SCRIPT", "AgenticShadowCap.MvpScript:mvpBootstrap")
SKIP_BUILD = os.getenv("SKIP_BUILD", "false").lower() == "true"
SKIP_SEED = os.getenv("SKIP_SEED", "true").lower() == "true"
RUN_AGENTS = os.getenv("RUN_AGENTS", "true").lower() != "false"
PACKAGE_ID_OVERRIDE = os.getenv("PACKAGE_ID", "").strip()
DA_CLI = os.getenv("DA_CLI", "").strip()


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


def _available_port(preferred: int) -> int:
    # Use preferred port when free; otherwise ask the OS for any free port.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _resolve_da_cli() -> str:
    if DA_CLI:
        return DA_CLI
    dpm_from_path = shutil.which("dpm")
    if dpm_from_path:
        return dpm_from_path
    home_dpm = Path.home() / ".dpm/bin/dpm"
    if home_dpm.exists() and home_dpm.is_file() and os.access(home_dpm, os.X_OK):
        return str(home_dpm)
    daml_from_path = shutil.which("daml")
    if daml_from_path:
        return daml_from_path
    if not DA_CLI:
        raise RuntimeError("Neither dpm nor daml is installed; cannot run backend.")
    return DA_CLI


def _is_dpm_cli(cli: str) -> bool:
    return Path(cli).name == "dpm"


def _script_command(dar_path: Path) -> list[str]:
    da_cli = _resolve_da_cli()
    if _is_dpm_cli(da_cli):
        return [
            da_cli,
            "script",
            "--dar",
            str(dar_path),
            "--script-name",
            BOOTSTRAP_SCRIPT,
            "--ledger-host",
            "127.0.0.1",
            "--ledger-port",
            str(LEDGER_PORT),
            "--upload-dar",
            "true",
            "--wall-clock-time",
        ]
    return [
        da_cli,
        "script",
        "--dar",
        str(dar_path),
        "--script-name",
        BOOTSTRAP_SCRIPT,
        "--ledger-host",
        "127.0.0.1",
        "--ledger-port",
        str(LEDGER_PORT),
        "--upload-dar",
        "true",
        "--wall-clock-time",
    ]


def _sandbox_command() -> list[str]:
    da_cli = _resolve_da_cli()
    admin_port = _available_port(ADMIN_API_PORT)
    sequencer_public_port = _available_port(SEQUENCER_PUBLIC_PORT)
    sequencer_admin_port = _available_port(SEQUENCER_ADMIN_PORT)
    mediator_admin_port = _available_port(MEDIATOR_ADMIN_PORT)
    _log(
        "sandbox ports: "
        f"admin={admin_port} sequencer_public={sequencer_public_port} "
        f"sequencer_admin={sequencer_admin_port} mediator_admin={mediator_admin_port}"
    )
    if _is_dpm_cli(da_cli):
        return [
            da_cli,
            "sandbox",
            "--ledger-api-port",
            str(LEDGER_PORT),
            "--admin-api-port",
            str(admin_port),
            "--sequencer-public-port",
            str(sequencer_public_port),
            "--sequencer-admin-port",
            str(sequencer_admin_port),
            "--mediator-admin-port",
            str(mediator_admin_port),
            "--json-api-port",
            str(JSON_API_PORT),
        ]
    return [
        da_cli,
        "sandbox",
        "--port",
        str(LEDGER_PORT),
        "--admin-api-port",
        str(admin_port),
        "--sequencer-public-port",
        str(sequencer_public_port),
        "--sequencer-admin-port",
        str(sequencer_admin_port),
        "--mediator-admin-port",
        str(mediator_admin_port),
        "--json-api-port",
        str(JSON_API_PORT),
    ]


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


def _discover_package_id() -> str:
    if PACKAGE_ID_OVERRIDE:
        return PACKAGE_ID_OVERRIDE

    da_cli = _resolve_da_cli()
    output = _run_capture_stdout([da_cli, "damlc", "inspect-dar", str(DAR_FILE), "--json"])
    payload = json.loads(output)
    package_id = (payload.get("main_package_id") or "").strip()
    if not package_id:
        raise RuntimeError("Could not determine main_package_id from inspect-dar output")
    return package_id


def _bootstrap_and_seed(package_id: str) -> None:
    script_cmd = _script_command(DAR_FILE)
    max_attempts = 30
    for attempt in range(1, max_attempts + 1):
        _log(f"run bootstrap script (attempt {attempt}/{max_attempts})")
        completed = subprocess.run(
            script_cmd,
            cwd=str(DAML_DIR),
            text=True,
            capture_output=True,
        )
        if completed.stdout:
            print(completed.stdout, end="")
        if completed.stderr:
            print(completed.stderr, end="", file=sys.stderr)
        if completed.returncode == 0:
            break
        combined = f"{completed.stdout}\n{completed.stderr}"
        if (
            "PARTY_ALLOCATION_WITHOUT_CONNECTED_SYNCHRONIZER" in combined
            or "PACKAGE_SERVICE_CANNOT_AUTODETECT_SYNCHRONIZER" in combined
            or "no synchronizers currently connected" in combined
            or "PACKAGE_SELECTION_FAILED" in combined
        ):
            _log("sandbox not fully connected yet; retrying bootstrap in 2s")
            time.sleep(2)
            continue
        if "Party already exists" in combined:
            _log("bootstrap parties already allocated; continuing")
            break
        raise subprocess.CalledProcessError(
            completed.returncode,
            script_cmd,
            output=completed.stdout,
            stderr=completed.stderr,
        )
    else:
        raise RuntimeError("bootstrap script did not succeed before timeout")

    da_cli = _resolve_da_cli()
    if SKIP_SEED:
        _log("SKIP_SEED=true, skipping deploy/scripts/seed_demo.py")
        return

    seed_env = dict(os.environ)
    seed_json_api_url = f"http://127.0.0.1:{JSON_API_PORT}"
    if not _is_dpm_cli(da_cli):
        seed_json_api_url = f"http://127.0.0.1:{V1_GATEWAY_PORT}"
    seed_env.update(
        {
            "JSON_API_URL": seed_json_api_url,
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
        da_cli = _resolve_da_cli()
        _log(f"using toolchain: {da_cli}")
        run_agents = RUN_AGENTS
        if not SKIP_BUILD:
            _run_blocking([da_cli, "build"], cwd=DAML_DIR)
        else:
            _log("SKIP_BUILD=true, reusing existing DAR")

        if not DAR_FILE.exists():
            raise FileNotFoundError(f"Missing DAR file: {DAR_FILE}")

        package_id = _discover_package_id()
        _log(f"package ID: {package_id}")

        sandbox = _start_process(
            "dpm-sandbox",
            _sandbox_command(),
            cwd=DAML_DIR,
        )
        processes.append(sandbox)
        _wait_for_port(LEDGER_PORT)
        _wait_for_port(JSON_API_PORT)

        v1_gateway_env = {
            "CANTON_PROVIDER_URL": f"http://127.0.0.1:{JSON_API_PORT}",
            "CANTON_USER_URL": f"http://127.0.0.1:{JSON_API_PORT}",
            "CANTON_ALLOW_INSECURE_TOKEN": "true",
            "CANTON_INSECURE_TOKEN_MODE": "legacy",
            "CANTON_TRUST_CLIENT_AUTH": "false",
            "CANTON_PROVIDER_PARTIES": "Seller,SellerAgent,Company",
            "CANTON_USER_PARTIES": "Buyer,BuyerAgent",
            "CANTON_PACKAGE_ID": package_id,
        }
        v1_gateway = _start_process(
            "v1-gateway",
            [
                sys.executable,
                "-m",
                "uvicorn",
                "deploy.canton_network.v1_gateway:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(V1_GATEWAY_PORT),
            ],
            env=v1_gateway_env,
        )
        processes.append(v1_gateway)
        _wait_for_port(V1_GATEWAY_PORT)

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

        if run_agents:
            # dazl gRPC package-service calls are not compatible with this sandbox setup.
            # Route agents through HTTP JSON APIs instead.
            agent_common_env: dict[str, str]
            agent_common_env = {
                "DAML_LEDGER_MODE": "http-json",
                "DAML_HTTP_JSON_URL": f"http://127.0.0.1:{V1_GATEWAY_PORT}",
                "DAML_HTTP_JSON_ALLOW_INSECURE_TOKEN": "false",
            }
            seller_agent_env = {
                "PYTHONUNBUFFERED": "1",
                "DAML_LEDGER_URL": f"http://127.0.0.1:{LEDGER_PORT}",
                "SELLER_AGENT_PARTY": "SellerAgent",
                "SELLER_PARTY": "Seller",
                "MARKET_FEED_PATH": str(ROOT / "agent/mock_market_feed.json"),
                "AGENT_CONTROL_PATH": str(ROOT / "agent/agent_controls.json"),
                **agent_common_env,
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
                **agent_common_env,
            }
            buyer_agent = _start_process(
                "buyer-agent",
                [sys.executable, "agent/buyer_agent.py"],
                env=buyer_agent_env,
            )
            processes.append(buyer_agent)
        else:
            _log("RUN_AGENTS=false, skipping seller/buyer agent processes")

        ledger_upstream = f"http://127.0.0.1:{V1_GATEWAY_PORT}"
        gateway_env = {
            "LEDGER_API_URL": ledger_upstream,
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
