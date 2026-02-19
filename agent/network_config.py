"""Network mode detection and auth validation for Agentic Shadow-Cap."""

from __future__ import annotations

import os
import sys

VALID_MODES = {"local", "devnet", "testnet", "mainnet"}
PUBLIC_MODES = {"testnet", "mainnet"}


def get_network_mode() -> str:
    mode = os.getenv("CANTON_NETWORK_MODE", "local").strip().lower()
    if mode not in VALID_MODES:
        print(
            f"[config] WARNING: CANTON_NETWORK_MODE='{mode}' is not recognized. "
            f"Valid values: {', '.join(sorted(VALID_MODES))}. Defaulting to 'local'.",
            file=sys.stderr,
        )
        mode = "local"
    return mode


def is_public_network() -> bool:
    return get_network_mode() in PUBLIC_MODES


def require_auth_for_public_network(component: str = "agent") -> None:
    """Fail fast if required auth is missing on public networks."""
    mode = get_network_mode()
    if mode not in PUBLIC_MODES:
        return

    has_provider_token = bool(os.getenv("CANTON_PROVIDER_TOKEN", "").strip())
    has_user_token = bool(os.getenv("CANTON_USER_TOKEN", "").strip())
    has_jwt_token = bool(os.getenv("CANTON_JWT_TOKEN", "").strip())
    has_http_token = bool(os.getenv("DAML_HTTP_JSON_TOKEN", "").strip())

    has_any_token = has_provider_token or has_user_token or has_jwt_token or has_http_token

    if not has_any_token:
        print(
            f"\n{'='*60}\n"
            f"  FATAL: {component} cannot start on {mode} without authentication.\n"
            f"\n"
            f"  CANTON_NETWORK_MODE={mode} requires at least one of:\n"
            f"    - CANTON_PROVIDER_TOKEN + CANTON_USER_TOKEN\n"
            f"    - CANTON_JWT_TOKEN (shared token)\n"
            f"    - DAML_HTTP_JSON_TOKEN (for http-json mode)\n"
            f"\n"
            f"  For local development, set CANTON_NETWORK_MODE=local\n"
            f"{'='*60}\n",
            file=sys.stderr,
        )
        raise SystemExit(1)

    required_urls = []
    if mode in PUBLIC_MODES:
        provider_url = os.getenv("CANTON_PROVIDER_URL", "").strip()
        user_url = os.getenv("CANTON_USER_URL", "").strip()
        if provider_url and ("localhost" in provider_url or "127.0.0.1" in provider_url):
            required_urls.append(("CANTON_PROVIDER_URL", provider_url))
        if user_url and ("localhost" in user_url or "127.0.0.1" in user_url):
            required_urls.append(("CANTON_USER_URL", user_url))

    if required_urls:
        names = ", ".join(f"{name}={url}" for name, url in required_urls)
        print(
            f"[config] WARNING: {mode} mode but endpoints point to localhost: {names}. "
            f"Are you sure this is correct?",
            file=sys.stderr,
        )


def allow_insecure_tokens() -> bool:
    mode = get_network_mode()
    if mode in PUBLIC_MODES:
        return False
    explicit = os.getenv("CANTON_ALLOW_INSECURE_TOKEN", "").strip().lower()
    if explicit in {"0", "false", "no", "off"}:
        return False
    return True


def print_network_banner(component: str = "agent") -> None:
    mode = get_network_mode()
    print(f"[config] {component} starting in {mode.upper()} mode")
    if mode in PUBLIC_MODES:
        print(f"[config] Insecure tokens DISABLED (public network)")
    else:
        print(f"[config] Insecure tokens allowed (local/dev)")
