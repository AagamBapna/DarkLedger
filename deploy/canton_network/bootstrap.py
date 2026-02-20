#!/usr/bin/env python3
"""Bootstrap Agentic Shadow-Cap on Canton Network DevNet/TestNet validators.

This script:
1) Uploads DAR to provider + user participants (JSON Ledger API v2)
2) Allocates required parties
3) Persists alias->partyId mapping for the v1 compatibility gateway
4) Seeds deterministic demo contracts (asset, cash, trade intent)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import uuid
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx

def _csv_list(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


PROVIDER_ALIASES = _csv_list(
    os.getenv("CANTON_PROVIDER_ALIASES", "Seller,SellerAgent,Company,Outsider")
)
USER_ALIASES = _csv_list(
    os.getenv("CANTON_USER_ALIASES", "Buyer,BuyerAgent")
)

PARTY_SCALAR_FIELDS: set[str] = {
    "party",
    "owner",
    "issuer",
    "seller",
    "sellerAgent",
    "buyer",
    "buyerAgent",
    "agent",
    "postingAgent",
    "submitter",
}
PARTY_LIST_FIELDS: set[str] = {
    "actAs",
    "readAs",
    "discoverableBy",
    "witnessParties",
    "signatories",
    "observers",
    "parties",
}


@dataclass
class Node:
    name: str
    url: str
    token: str
    aliases: list[str]
    synchronizer_id: str = ""
    user_id: str = ""
    identity_provider_id: str = ""


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _b64url_bytes(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _b64url_json(value: dict[str, Any]) -> str:
    return _b64url_bytes(json.dumps(value, separators=(",", ":")).encode("utf-8"))


def _make_insecure_token(side: str) -> str:
    mode = os.getenv("CANTON_INSECURE_TOKEN_MODE", "hs256-unsafe").strip().lower()
    if mode in {"hs256", "hs256-unsafe", "unsafe"}:
        secret = os.getenv("CANTON_INSECURE_SECRET", "unsafe")
        audience = os.getenv(
            f"CANTON_{side.upper()}_AUDIENCE",
            os.getenv("CANTON_INSECURE_AUDIENCE", "https://canton.network.global"),
        )
        subject = os.getenv(
            f"CANTON_{side.upper()}_SUB",
            os.getenv("CANTON_INSECURE_SUB", "ledger-api-user"),
        )
        header = {"alg": "HS256", "typ": "JWT"}
        payload = {"sub": subject, "aud": audience}
        unsigned = f"{_b64url_json(header)}.{_b64url_json(payload)}".encode("utf-8")
        signature = hmac.new(secret.encode("utf-8"), unsigned, hashlib.sha256).digest()
        return f"{unsigned.decode('utf-8')}.{_b64url_bytes(signature)}"

    claim: dict[str, Any] = {
        "ledgerId": os.getenv("CANTON_INSECURE_LEDGER_ID", "sandbox"),
        "applicationId": "shadow-cap-bootstrap",
        "admin": True,
        "actAs": [],
        "readAs": [],
    }
    header = {"alg": "none", "typ": "JWT"}
    payload = {"https://daml.com/ledger-api": claim}
    return f"{_b64url_json(header)}.{_b64url_json(payload)}."


def _normalize_token(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    if raw.lower().startswith("bearer "):
        return raw
    return f"Bearer {raw}"


def _headers(token: str, *, content_type: str | None = None) -> dict[str, str]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = _normalize_token(token)
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _print_step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def _fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def _request(
    node: Node,
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    data: bytes | None = None,
    content_type: str | None = None,
    timeout: float = 30.0,
) -> httpx.Response:
    url = f"{node.url.rstrip('/')}/{path.lstrip('/')}"
    headers = _headers(node.token, content_type=content_type)
    with httpx.Client(timeout=timeout) as client:
        return client.request(method, url, json=json_body, params=params, content=data, headers=headers)


def _json_or_text(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return resp.text


def _expect_ok(resp: httpx.Response, context: str) -> dict[str, Any]:
    if resp.status_code >= 400:
        detail = _json_or_text(resp)
        _fail(f"{context} failed ({resp.status_code}): {detail}")
    data = _json_or_text(resp)
    if isinstance(data, dict):
        return data
    return {"value": data}


def _extract_first_json_blob(text: str) -> dict[str, Any] | None:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end < 0 or end <= start:
        return None
    snippet = text[start : end + 1]
    try:
        parsed = json.loads(snippet)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return None
    return None


def inspect_package_id(dar_path: Path) -> str:
    cmd = ["dpm", "damlc", "inspect-dar", str(dar_path), "--json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    combined = f"{proc.stdout}\n{proc.stderr}"
    payload = _extract_first_json_blob(combined)
    if not payload:
        preview = combined.strip().replace("\n", " ")
        if len(preview) > 500:
            preview = preview[:500] + "..."
        _fail(f"Unable to parse package id from inspect-dar output for {dar_path}. Output: {preview}")
    package_id = (payload.get("main_package_id") or "").strip()
    if not package_id:
        _fail(f"main_package_id missing in inspect-dar output for {dar_path}")
    return package_id


def discover_synchronizer_id(node: Node) -> str:
    resp = _request(node, "GET", "/v2/state/connected-synchronizers")
    data = _expect_ok(resp, f"{node.name}: get connected synchronizers")
    synchronizers = data.get("connectedSynchronizers")
    if not isinstance(synchronizers, list) or not synchronizers:
        _fail(f"{node.name}: no connectedSynchronizers returned")
    first = synchronizers[0]
    if not isinstance(first, dict):
        _fail(f"{node.name}: invalid connectedSynchronizers payload")
    sync_id = str(first.get("synchronizerId", "")).strip()
    if not sync_id:
        _fail(f"{node.name}: synchronizerId missing in connectedSynchronizers")
    return sync_id


def discover_user(node: Node) -> tuple[str, str]:
    resp = _request(node, "GET", "/v2/authenticated-user")
    if resp.status_code >= 400:
        # This can happen with unsafe/no-auth setups; user/idp can be overridden explicitly.
        return "", ""
    data = _json_or_text(resp)
    if not isinstance(data, dict):
        return "", ""
    user = data.get("user")
    if not isinstance(user, dict):
        return "", ""
    user_id = str(user.get("id", "")).strip()
    idp = str(user.get("identityProviderId", "")).strip()
    return user_id, idp


def _extract_known_version_package_id(detail: Any) -> str | None:
    if not isinstance(detail, dict):
        return None
    if str(detail.get("code", "")).strip() != "KNOWN_PACKAGE_VERSION":
        return None

    context = detail.get("context")
    if isinstance(context, dict):
        second = context.get("secondPackage")
        if isinstance(second, str):
            match = re.search(r"\b([0-9a-f]{64})\b", second)
            if match:
                return match.group(1)

    cause = str(detail.get("cause", ""))
    ids = re.findall(r"\b([0-9a-f]{64})\b", cause)
    if len(ids) >= 2:
        return ids[1]
    if ids:
        return ids[0]
    return None


def upload_dar(node: Node, dar_path: Path) -> str | None:
    data = dar_path.read_bytes()
    resp = _request(
        node,
        "POST",
        "/v2/packages",
        data=data,
        content_type="application/octet-stream",
        timeout=120.0,
    )
    if resp.status_code < 400:
        return
    detail = _json_or_text(resp)
    detail_text = json.dumps(detail, sort_keys=True).lower() if not isinstance(detail, str) else detail.lower()
    if resp.status_code in {400, 409} and (
        "already" in detail_text or "duplicate" in detail_text or "exists" in detail_text
    ):
        print(f"[dar] {node.name}: package already uploaded, continuing", flush=True)
        return None
    known_version_pkg = _extract_known_version_package_id(detail)
    if known_version_pkg:
        print(
            f"[dar] {node.name}: package name/version already vetted, using existing package {known_version_pkg}",
            flush=True,
        )
        return known_version_pkg
    _fail(f"{node.name}: DAR upload failed ({resp.status_code}): {detail}")
    return None


def list_parties(node: Node, filter_party: str | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    page_token = ""
    while True:
        params: dict[str, Any] = {"pageSize": 200}
        if page_token:
            params["pageToken"] = page_token
        if filter_party:
            params["filter-party"] = filter_party
        resp = _request(node, "GET", "/v2/parties", params=params)
        data = _expect_ok(resp, f"{node.name}: list parties")
        page = data.get("partyDetails")
        if isinstance(page, list):
            for item in page:
                if isinstance(item, dict):
                    out.append(item)
        page_token = str(data.get("nextPageToken", "") or "").strip()
        if not page_token:
            break
    return out


def resolve_existing_party_id(node: Node, alias: str) -> str | None:
    parties = list_parties(node, filter_party=alias)
    exact: str | None = None
    fallback: str | None = None
    for details in parties:
        party = str(details.get("party", "")).strip()
        if not party:
            continue
        if party == alias:
            exact = party
            break
        if party.startswith(f"{alias}::"):
            exact = party
            break
        if alias.lower() in party.lower() and fallback is None:
            fallback = party
    return exact or fallback


def allocate_party(node: Node, alias: str, synchronizer_id: str, user_id: str, idp: str) -> str:
    body = {
        "partyIdHint": alias,
        "synchronizerId": synchronizer_id,
    }
    if idp:
        body["identityProviderId"] = idp
    if user_id:
        body["userId"] = user_id
    resp = _request(node, "POST", "/v2/parties", json_body=body)
    if resp.status_code < 400:
        data = _json_or_text(resp)
        if isinstance(data, dict):
            details = data.get("partyDetails")
            if isinstance(details, dict):
                party = str(details.get("party", "")).strip()
                if party:
                    return party

    existing = resolve_existing_party_id(node, alias)
    if existing:
        return existing

    detail = _json_or_text(resp)
    _fail(f"{node.name}: allocate party '{alias}' failed ({resp.status_code}): {detail}")
    return ""


def _map_parties(value: Any, mapping: dict[str, str]) -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if k in PARTY_SCALAR_FIELDS:
                if isinstance(v, str):
                    out[k] = mapping.get(v, v)
                else:
                    out[k] = v
            elif k in PARTY_LIST_FIELDS:
                if isinstance(v, list):
                    out[k] = [mapping.get(x, x) if isinstance(x, str) else x for x in v]
                else:
                    out[k] = v
            else:
                out[k] = _map_parties(v, mapping)
        return out
    if isinstance(value, list):
        return [_map_parties(v, mapping) for v in value]
    return value


def _template_id(package_id: str, bare: str) -> str:
    return f"{package_id}:{bare}" if bare.count(":") == 1 else bare


def _ledger_end(node: Node) -> int:
    resp = _request(node, "GET", "/v2/state/ledger-end")
    data = _expect_ok(resp, f"{node.name}: get ledger end")
    try:
        return int(data.get("offset", 0))
    except Exception:
        return 0


def _query_active_template(node: Node, party: str, template_id: str) -> list[dict[str, Any]]:
    body = {
        "activeAtOffset": _ledger_end(node),
        "verbose": True,
        "filter": {
            "filtersByParty": {
                party: {
                    "cumulative": [
                        {
                            "identifierFilter": {
                                "TemplateFilter": {
                                    "value": {
                                        "templateId": template_id,
                                        "includeCreatedEventBlob": False,
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        },
    }
    resp = _request(node, "POST", "/v2/state/active-contracts", json_body=body)
    data = _expect_ok(resp, f"{node.name}: query active contracts")
    rows: list[dict[str, Any]] = []
    if not isinstance(data, list):
        return rows
    for item in data:
        if not isinstance(item, dict):
            continue
        entry = item.get("contractEntry")
        if not isinstance(entry, dict):
            continue
        active = entry.get("JsActiveContract")
        if not isinstance(active, dict):
            continue
        created = active.get("createdEvent")
        if not isinstance(created, dict):
            continue
        cid = created.get("contractId")
        payload = created.get("createArgument", {})
        if isinstance(cid, str) and isinstance(payload, dict):
            rows.append({"contractId": cid, "payload": payload})
    return rows


def _submit_create(node: Node, act_as_party: str, template_id: str, payload: dict[str, Any]) -> str:
    body = {
        "commandId": f"shadowcap-bootstrap-{uuid.uuid4().hex}",
        "actAs": [act_as_party],
        "readAs": [act_as_party],
        "commands": [
            {
                "CreateCommand": {
                    "templateId": template_id,
                    "createArguments": payload,
                }
            }
        ],
        "deduplicationPeriod": {"Empty": {}},
    }
    resp = _request(node, "POST", "/v2/commands/submit-and-wait-for-transaction-tree", json_body=body)
    data = _expect_ok(resp, f"{node.name}: submit create command")
    tree = data.get("transactionTree")
    if not isinstance(tree, dict):
        _fail(f"{node.name}: transactionTree missing in create response")
    events_by_id = tree.get("eventsById")
    if not isinstance(events_by_id, dict):
        _fail(f"{node.name}: eventsById missing in create response")

    for event in events_by_id.values():
        if not isinstance(event, dict):
            continue
        created_tree = event.get("CreatedTreeEvent")
        if not isinstance(created_tree, dict):
            continue
        created_val = created_tree.get("value")
        if not isinstance(created_val, dict):
            continue
        cid = created_val.get("contractId")
        if isinstance(cid, str) and cid:
            return cid

    _fail(f"{node.name}: no created contract id found in create response")
    return ""


def _ensure_seed_data(
    provider: Node,
    party_map: dict[str, str],
    package_id: str,
) -> None:
    issuer = party_map["Company"]
    seller = party_map["Seller"]
    seller_agent = party_map["SellerAgent"]
    buyer = party_map["Buyer"]

    instrument = os.getenv("DEMO_INSTRUMENT", "COMPANY-SERIES-A")
    currency = os.getenv("DEMO_CURRENCY", "USD")
    asset_qty = Decimal(os.getenv("DEMO_ASSET_QTY", "5000.0"))
    cash_amount = Decimal(os.getenv("DEMO_CASH_AMOUNT", "500000.0"))
    intent_qty = Decimal(os.getenv("DEMO_INTENT_QTY", "1500.0"))
    intent_min_price = Decimal(os.getenv("DEMO_INTENT_MIN_PRICE", "95.0"))

    asset_tid = _template_id(package_id, "AgenticShadowCap.Market:AssetHolding")
    cash_tid = _template_id(package_id, "AgenticShadowCap.Market:CashHolding")
    intent_tid = _template_id(package_id, "AgenticShadowCap.Market:TradeIntent")

    assets = _query_active_template(provider, issuer, asset_tid)
    has_asset = False
    for row in assets:
        payload = row["payload"]
        if payload.get("owner") == seller and payload.get("instrument") == instrument:
            try:
                if Decimal(str(payload.get("quantity", "0"))) >= asset_qty:
                    has_asset = True
                    break
            except Exception:
                pass
    if not has_asset:
        cid = _submit_create(
            provider,
            issuer,
            asset_tid,
            {
                "owner": seller,
                "issuer": issuer,
                "instrument": instrument,
                "quantity": str(asset_qty),
            },
        )
        print(f"[seed] created AssetHolding {cid}", flush=True)
    else:
        print("[seed] asset holding already present", flush=True)

    cashes = _query_active_template(provider, issuer, cash_tid)
    has_cash = False
    for row in cashes:
        payload = row["payload"]
        if payload.get("owner") == buyer and payload.get("currency") == currency:
            try:
                if Decimal(str(payload.get("amount", "0"))) >= cash_amount:
                    has_cash = True
                    break
            except Exception:
                pass
    if not has_cash:
        cid = _submit_create(
            provider,
            issuer,
            cash_tid,
            {
                "owner": buyer,
                "issuer": issuer,
                "currency": currency,
                "amount": str(cash_amount),
            },
        )
        print(f"[seed] created CashHolding {cid}", flush=True)
    else:
        print("[seed] cash holding already present", flush=True)

    intents = _query_active_template(provider, seller, intent_tid)
    has_intent = False
    for row in intents:
        payload = row["payload"]
        if (
            payload.get("seller") == seller
            and payload.get("sellerAgent") == seller_agent
            and payload.get("instrument") == instrument
        ):
            has_intent = True
            break

    if not has_intent:
        cid = _submit_create(
            provider,
            seller,
            intent_tid,
            {
                "issuer": issuer,
                "seller": seller,
                "sellerAgent": seller_agent,
                "instrument": instrument,
                "quantity": str(intent_qty),
                "minPrice": str(intent_min_price),
            },
        )
        print(f"[seed] created TradeIntent {cid}", flush=True)
    else:
        print("[seed] trade intent already present", flush=True)


def main() -> int:
    # Network mode validation
    network_mode = os.getenv("CANTON_NETWORK_MODE", "local").strip().lower()
    _print_step(f"Network mode: {network_mode.upper()}")
    if network_mode in {"devnet", "testnet", "mainnet", "public"}:
        has_any_token = bool(
            os.getenv("CANTON_PROVIDER_TOKEN", "").strip()
            or os.getenv("CANTON_USER_TOKEN", "").strip()
            or os.getenv("CANTON_JWT_TOKEN", "").strip()
        )
        if not has_any_token:
            _fail(
                f"CANTON_NETWORK_MODE={network_mode} requires authentication. "
                f"Set CANTON_PROVIDER_TOKEN + CANTON_USER_TOKEN or CANTON_JWT_TOKEN."
            )

    shared_token = os.getenv("CANTON_JWT_TOKEN", "").strip()
    allow_insecure_token = _env_bool(
        "CANTON_ALLOW_INSECURE_TOKEN",
        network_mode not in {"devnet", "testnet", "mainnet", "public"},
    )

    provider = Node(
        name="provider",
        url=os.getenv("CANTON_PROVIDER_URL", "http://127.0.0.1:3975"),
        token=os.getenv("CANTON_PROVIDER_TOKEN", shared_token),
        aliases=PROVIDER_ALIASES,
    )
    user = Node(
        name="user",
        url=os.getenv("CANTON_USER_URL", "http://127.0.0.1:2975"),
        token=os.getenv("CANTON_USER_TOKEN", shared_token),
        aliases=USER_ALIASES,
    )

    if not provider.token and allow_insecure_token:
        provider.token = _make_insecure_token("provider")
    if not user.token and allow_insecure_token:
        user.token = _make_insecure_token("user")

    dar_path = Path(os.getenv("CANTON_DAR_PATH", "daml/.daml/dist/agentic-shadow-cap-0.1.0.dar"))
    map_path = Path(os.getenv("CANTON_PARTY_MAP_PATH", "deploy/canton_network/party_map.json"))
    package_path = Path(os.getenv("CANTON_PACKAGE_ID_PATH", "deploy/canton_network/package_id.txt"))

    if not dar_path.exists():
        _fail(f"DAR file not found: {dar_path}")

    _print_step("Inspecting DAR")
    package_id = inspect_package_id(dar_path)
    print(f"Package ID: {package_id}", flush=True)

    _print_step("Discovering synchronizer IDs")
    provider.synchronizer_id = os.getenv("CANTON_PROVIDER_SYNCHRONIZER_ID", "").strip() or discover_synchronizer_id(provider)
    user.synchronizer_id = os.getenv("CANTON_USER_SYNCHRONIZER_ID", "").strip() or discover_synchronizer_id(user)
    print(f"provider synchronizer: {provider.synchronizer_id}", flush=True)
    print(f"user synchronizer:     {user.synchronizer_id}", flush=True)

    _print_step("Discovering authenticated users (if token-based auth is enabled)")
    discovered_provider_user, discovered_provider_idp = discover_user(provider)
    discovered_user_user, discovered_user_idp = discover_user(user)

    provider.user_id = os.getenv("CANTON_PROVIDER_USER_ID", discovered_provider_user).strip()
    provider.identity_provider_id = os.getenv("CANTON_PROVIDER_IDP", discovered_provider_idp).strip()
    user.user_id = os.getenv("CANTON_USER_USER_ID", discovered_user_user).strip()
    user.identity_provider_id = os.getenv("CANTON_USER_IDP", discovered_user_idp).strip()

    print(
        f"provider user/idp: {provider.user_id or '<empty>'} / {provider.identity_provider_id or '<empty>'}",
        flush=True,
    )
    print(
        f"user user/idp:     {user.user_id or '<empty>'} / {user.identity_provider_id or '<empty>'}",
        flush=True,
    )

    _print_step("Uploading DAR to both participants")
    provider_existing_pkg = upload_dar(provider, dar_path)
    user_existing_pkg = upload_dar(user, dar_path)
    existing_ids = [pkg for pkg in [provider_existing_pkg, user_existing_pkg] if pkg]
    if existing_ids:
        existing = existing_ids[0]
        if any(pkg != existing for pkg in existing_ids):
            _fail(f"Participants reported different existing package ids: {existing_ids}")
        if existing != package_id:
            print(
                f"[dar] Using already-vetted package id {existing} instead of local DAR id {package_id}",
                flush=True,
            )
            package_id = existing
    print("DAR upload complete", flush=True)

    _print_step("Allocating / resolving parties")
    party_map: dict[str, str] = {}
    for alias in provider.aliases:
        party_map[alias] = allocate_party(
            provider,
            alias,
            synchronizer_id=provider.synchronizer_id,
            user_id=provider.user_id,
            idp=provider.identity_provider_id,
        )
        print(f"provider {alias:12s} -> {party_map[alias]}", flush=True)

    for alias in user.aliases:
        party_map[alias] = allocate_party(
            user,
            alias,
            synchronizer_id=user.synchronizer_id,
            user_id=user.user_id,
            idp=user.identity_provider_id,
        )
        print(f"user     {alias:12s} -> {party_map[alias]}", flush=True)

    map_path.parent.mkdir(parents=True, exist_ok=True)
    map_path.write_text(json.dumps(party_map, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    package_path.parent.mkdir(parents=True, exist_ok=True)
    package_path.write_text(package_id + "\n", encoding="utf-8")

    _print_step("Seeding demo contracts")
    _ensure_seed_data(provider, party_map, package_id)

    _print_step("Bootstrap complete")
    print(f"Party map:  {map_path}", flush=True)
    print(f"Package ID: {package_path}", flush=True)
    print("", flush=True)
    print("Use these env vars when running the gateway/demo:", flush=True)
    print(f"  export CANTON_PROVIDER_URL={provider.url}", flush=True)
    print(f"  export CANTON_USER_URL={user.url}", flush=True)
    if provider.token:
        print("  export CANTON_PROVIDER_TOKEN=<redacted>", flush=True)
    if user.token:
        print("  export CANTON_USER_TOKEN=<redacted>", flush=True)
    print(f"  export CANTON_PACKAGE_ID={package_id}", flush=True)
    print(f"  export CANTON_PARTY_MAP_PATH={map_path}", flush=True)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
