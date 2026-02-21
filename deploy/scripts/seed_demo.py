#!/usr/bin/env python3
"""
Seed deterministic demo contracts via Canton JSON API.

Creates (if missing):
1) Seller AssetHolding
2) Buyer CashHolding
3) Seller TradeIntent
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from decimal import Decimal
from typing import Any

JSON_API_URL = os.getenv("JSON_API_URL", "http://localhost:7575")
PACKAGE_ID = os.getenv("PACKAGE_ID", "")
STATIC_TOKEN = os.getenv("JSON_API_TOKEN", "")

# Network mode determines insecure token defaults
NETWORK_MODE = os.getenv("CANTON_NETWORK_MODE", "local").strip().lower()
_insecure_default = "true" if NETWORK_MODE in {"local", "devnet"} else "false"
USE_INSECURE_TOKEN = os.getenv("JSON_API_USE_INSECURE_TOKEN", _insecure_default).lower() == "true"

ISSUER = os.getenv("ISSUER_PARTY", "Company")
SELLER = os.getenv("SELLER_PARTY", "Seller")
SELLER_AGENT = os.getenv("SELLER_AGENT_PARTY", "SellerAgent")
BUYER = os.getenv("BUYER_PARTY", "Buyer")
INSTRUMENT = os.getenv("DEMO_INSTRUMENT", "COMPANY-SERIES-A")
CURRENCY = os.getenv("DEMO_CURRENCY", "USD")

ASSET_QTY = Decimal(os.getenv("DEMO_ASSET_QTY", "5000.0"))
CASH_AMOUNT = Decimal(os.getenv("DEMO_CASH_AMOUNT", "500000.0"))
INTENT_QTY = Decimal(os.getenv("DEMO_INTENT_QTY", "1500.0"))
INTENT_MIN_PRICE = Decimal(os.getenv("DEMO_INTENT_MIN_PRICE", "95.0"))

_PARTY_ID_CACHE: dict[str, str] = {}
_PARTIES_RESOLVED = False


def b64url(value: str) -> str:
    raw = base64.urlsafe_b64encode(value.encode("utf-8")).decode("utf-8")
    return raw.rstrip("=")


def insecure_token_for_party(party: str) -> str:
    header = {"alg": "none", "typ": "JWT"}
    payload = {
        "https://daml.com/ledger-api": {
            "ledgerId": "sandbox",
            "applicationId": "shadow-cap-seed",
            "actAs": [party],
            "readAs": [party],
        }
    }
    return f"{b64url(json.dumps(header))}.{b64url(json.dumps(payload))}."


def insecure_admin_token() -> str:
    header = {"alg": "none", "typ": "JWT"}
    payload = {
        "https://daml.com/ledger-api": {
            "ledgerId": "sandbox",
            "applicationId": "shadow-cap-seed",
            "admin": True,
            "actAs": [],
            "readAs": [],
        }
    }
    return f"{b64url(json.dumps(header))}.{b64url(json.dumps(payload))}."


def party_id(party: str) -> str:
    return _PARTY_ID_CACHE.get(party, party)


def auth_header_for_party(party: str) -> str | None:
    if STATIC_TOKEN:
        return STATIC_TOKEN
    if USE_INSECURE_TOKEN:
        return insecure_token_for_party(party_id(party))
    return None


def template_id(name: str) -> str:
    prefix = f"{PACKAGE_ID}:" if PACKAGE_ID else ""
    return f"{prefix}AgenticShadowCap.Market:{name}"


def post_json(party: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
    token = auth_header_for_party(party)
    resolved_party = party_id(party)
    req = urllib.request.Request(
        f"{JSON_API_URL}{path}",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Ledger-Party", resolved_party)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode("utf-8")
            return json.loads(data)
    except urllib.error.HTTPError as ex:
        payload = ex.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{path} failed ({ex.code}) for {resolved_party}: {payload}") from ex


def resolve_party_ids() -> None:
    global _PARTIES_RESOLVED
    if _PARTIES_RESOLVED:
        return

    token = STATIC_TOKEN or insecure_admin_token()
    req = urllib.request.Request(f"{JSON_API_URL}/v1/parties", method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        _PARTY_ID_CACHE.update({
            ISSUER: ISSUER,
            SELLER: SELLER,
            SELLER_AGENT: SELLER_AGENT,
            BUYER: BUYER,
        })
        _PARTIES_RESOLVED = True
        return

    for item in data.get("result", []):
        identifier = item.get("identifier")
        display_name = item.get("displayName")
        if isinstance(identifier, str) and identifier:
            _PARTY_ID_CACHE[identifier] = identifier
            if isinstance(display_name, str) and display_name:
                _PARTY_ID_CACHE[display_name] = identifier

    for fallback in (ISSUER, SELLER, SELLER_AGENT, BUYER):
        _PARTY_ID_CACHE.setdefault(fallback, fallback)
    _PARTIES_RESOLVED = True


def query_template(party: str, tid: str) -> list[dict[str, Any]]:
    response = post_json(party, "/v1/query", {"templateIds": [tid]})
    return response.get("result", [])


def create_contract(party: str, tid: str, payload: dict[str, Any]) -> str:
    response = post_json(party, "/v1/create", {"templateId": tid, "payload": payload})
    return (response.get("result") or {}).get("contractId", "")


def decimal_of(value: Any) -> Decimal:
    return Decimal(str(value))


def ensure_asset_holding() -> None:
    issuer = party_id(ISSUER)
    seller = party_id(SELLER)
    tid = template_id("AssetHolding")
    existing = query_template(issuer, tid)
    for item in existing:
        payload = item.get("payload", {})
        if (
            payload.get("owner") == seller
            and payload.get("instrument") == INSTRUMENT
            and decimal_of(payload.get("quantity", "0")) >= ASSET_QTY
        ):
            print(f"[seed] asset holding already present for {seller} ({INSTRUMENT})")
            return

    cid = create_contract(issuer, tid, {
        "owner": seller,
        "issuer": issuer,
        "instrument": INSTRUMENT,
        "quantity": str(ASSET_QTY),
    })
    print(f"[seed] created AssetHolding cid={cid}")


def ensure_cash_holding() -> None:
    issuer = party_id(ISSUER)
    buyer = party_id(BUYER)
    tid = template_id("CashHolding")
    existing = query_template(issuer, tid)
    for item in existing:
        payload = item.get("payload", {})
        if (
            payload.get("owner") == buyer
            and payload.get("currency") == CURRENCY
            and decimal_of(payload.get("amount", "0")) >= CASH_AMOUNT
        ):
            print(f"[seed] cash holding already present for {buyer} ({CURRENCY})")
            return

    cid = create_contract(issuer, tid, {
        "owner": buyer,
        "issuer": issuer,
        "currency": CURRENCY,
        "amount": str(CASH_AMOUNT),
    })
    print(f"[seed] created CashHolding cid={cid}")


def ensure_trade_intent() -> None:
    issuer = party_id(ISSUER)
    seller = party_id(SELLER)
    seller_agent = party_id(SELLER_AGENT)
    buyer = party_id(BUYER)
    tid = template_id("TradeIntent")
    existing = query_template(seller, tid)
    for item in existing:
        payload = item.get("payload", {})
        if (
            payload.get("seller") == seller
            and payload.get("sellerAgent") == seller_agent
            and payload.get("instrument") == INSTRUMENT
        ):
            print(f"[seed] trade intent already present for {seller} ({INSTRUMENT})")
            return

    cid = create_contract(seller, tid, {
        "issuer": issuer,
        "seller": seller,
        "sellerAgent": seller_agent,
        "buyer": buyer,
        "instrument": INSTRUMENT,
        "quantity": str(INTENT_QTY),
        "minPrice": str(INTENT_MIN_PRICE),
    })
    print(f"[seed] created TradeIntent cid={cid}")


def main() -> int:
    print(f"[seed] JSON API: {JSON_API_URL}")
    print(f"[seed] Network mode: {NETWORK_MODE.upper()}")
    if NETWORK_MODE in {"testnet", "mainnet"} and not STATIC_TOKEN:
        print(
            f"[seed] ERROR: CANTON_NETWORK_MODE={NETWORK_MODE} requires JSON_API_TOKEN. "
            f"Set JSON_API_TOKEN or use CANTON_NETWORK_MODE=local for local development.",
            file=sys.stderr,
        )
        return 1
    resolve_party_ids()
    print(
        "[seed] party map:"
        f" Company={party_id(ISSUER)}"
        f" Seller={party_id(SELLER)}"
        f" SellerAgent={party_id(SELLER_AGENT)}"
        f" Buyer={party_id(BUYER)}"
    )
    ensure_asset_holding()
    ensure_cash_holding()
    ensure_trade_intent()
    print("[seed] done")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as ex:
        print(f"[seed] error: {ex}", file=sys.stderr)
        raise SystemExit(1)
