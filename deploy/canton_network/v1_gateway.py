#!/usr/bin/env python3
"""v1-compatible gateway for Canton JSON Ledger API v2 endpoints.

This service lets existing /v1/create|query|exercise clients (UI, scripts, agents)
run against Canton Network participants exposing only /v2 endpoints.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _csv_set(value: str) -> set[str]:
    return {item.strip() for item in value.split(",") if item.strip()}


def _default_package_id() -> str:
    from_env = os.getenv("CANTON_PACKAGE_ID", os.getenv("PACKAGE_ID", "")).strip()
    if from_env:
        return from_env
    path = Path(os.getenv("CANTON_PACKAGE_ID_PATH", "deploy/canton_network/package_id.txt"))
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


@dataclass
class Config:
    provider_url: str = os.getenv("CANTON_PROVIDER_URL", "http://127.0.0.1:3975")
    user_url: str = os.getenv("CANTON_USER_URL", "http://127.0.0.1:2975")

    provider_parties: set[str] = field(
        default_factory=lambda: _csv_set(
            os.getenv("CANTON_PROVIDER_PARTIES", "Seller,SellerAgent,Company,Outsider")
        )
    )
    user_parties: set[str] = field(
        default_factory=lambda: _csv_set(
            os.getenv("CANTON_USER_PARTIES", "Buyer,BuyerAgent")
        )
    )

    provider_token: str = os.getenv("CANTON_PROVIDER_TOKEN", "").strip()
    user_token: str = os.getenv("CANTON_USER_TOKEN", "").strip()
    shared_token: str = os.getenv("CANTON_JWT_TOKEN", "").strip()

    trust_client_auth: bool = _env_bool("CANTON_TRUST_CLIENT_AUTH", False)
    allow_insecure_tokens: bool = _env_bool("CANTON_ALLOW_INSECURE_TOKEN", False)
    insecure_ledger_id: str = os.getenv("CANTON_INSECURE_LEDGER_ID", "sandbox")
    insecure_token_mode: str = os.getenv("CANTON_INSECURE_TOKEN_MODE", "hs256-unsafe").strip().lower()
    insecure_secret: str = os.getenv("CANTON_INSECURE_SECRET", "unsafe")
    insecure_audience: str = os.getenv("CANTON_INSECURE_AUDIENCE", "https://canton.network.global")
    insecure_sub: str = os.getenv("CANTON_INSECURE_SUB", "ledger-api-user")

    package_id: str = _default_package_id()
    party_map_path: Path = Path(
        os.getenv("CANTON_PARTY_MAP_PATH", "deploy/canton_network/party_map.json")
    )

    timeout_seconds: float = float(os.getenv("CANTON_GATEWAY_TIMEOUT_SECONDS", "30"))


CFG = Config()

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
    "controller",
    "controllerParty",
}

PARTY_LIST_FIELDS: set[str] = {
    "actAs",
    "readAs",
    "witnessParties",
    "signatories",
    "observers",
    "discoverableBy",
    "controllers",
    "maintainers",
    "parties",
}


class PartyMap:
    def __init__(self, path: Path):
        self._path = path
        self._mtime: float = -1.0
        self.alias_to_id: dict[str, str] = {}
        self.id_to_alias: dict[str, str] = {}

    def _reload_if_needed(self) -> None:
        try:
            stat = self._path.stat()
        except FileNotFoundError:
            self.alias_to_id = {}
            self.id_to_alias = {}
            self._mtime = -1.0
            return

        if stat.st_mtime <= self._mtime:
            return

        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("party map must be a JSON object")
        except Exception:
            self.alias_to_id = {}
            self.id_to_alias = {}
            self._mtime = stat.st_mtime
            return

        alias_to_id: dict[str, str] = {}
        id_to_alias: dict[str, str] = {}
        for alias, value in payload.items():
            if not isinstance(alias, str) or not isinstance(value, str):
                continue
            alias = alias.strip()
            value = value.strip()
            if not alias or not value:
                continue
            alias_to_id[alias] = value
            id_to_alias[value] = alias

        self.alias_to_id = alias_to_id
        self.id_to_alias = id_to_alias
        self._mtime = stat.st_mtime

    def to_actual(self, maybe_alias: str) -> str:
        self._reload_if_needed()
        return self.alias_to_id.get(maybe_alias, maybe_alias)

    def to_alias(self, maybe_party_id: str) -> str:
        self._reload_if_needed()
        return self.id_to_alias.get(maybe_party_id, maybe_party_id)

    def aliases(self) -> list[str]:
        self._reload_if_needed()
        if self.alias_to_id:
            return sorted(self.alias_to_id.keys())
        defaults = sorted(CFG.provider_parties | CFG.user_parties)
        return defaults


PARTY_MAP = PartyMap(CFG.party_map_path)


def _b64url(data: dict[str, Any]) -> str:
    raw = json.dumps(data, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _b64url_bytes(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _make_insecure_token(party: str | None, admin: bool) -> str:
    if CFG.insecure_token_mode in {"hs256", "hs256-unsafe", "unsafe"}:
        header = {"alg": "HS256", "typ": "JWT"}
        ledger_claim: dict[str, Any] = {
            "ledgerId": CFG.insecure_ledger_id,
            "applicationId": "shadowcap-v1-gateway",
            "userId": CFG.insecure_sub,
            "user-id": CFG.insecure_sub,
            "user_id": CFG.insecure_sub,
            "admin": bool(admin),
            "actAs": [] if party is None else [party],
            "readAs": [] if party is None else [party],
        }
        payload: dict[str, Any] = {
            "sub": CFG.insecure_sub,
            "aud": CFG.insecure_audience,
            "userId": CFG.insecure_sub,
            "user-id": CFG.insecure_sub,
            "user_id": CFG.insecure_sub,
            "https://daml.com/ledger-api": ledger_claim,
        }
        unsigned = f"{_b64url(header)}.{_b64url(payload)}".encode("utf-8")
        signature = hmac.new(
            CFG.insecure_secret.encode("utf-8"),
            unsigned,
            hashlib.sha256,
        ).digest()
        return f"{unsigned.decode('utf-8')}.{_b64url_bytes(signature)}"

    claim: dict[str, Any] = {
        "ledgerId": CFG.insecure_ledger_id,
        "applicationId": "shadowcap-v1-gateway",
        "userId": CFG.insecure_sub,
        "user-id": CFG.insecure_sub,
        "user_id": CFG.insecure_sub,
        "admin": bool(admin),
        "actAs": [] if party is None else [party],
        "readAs": [] if party is None else [party],
    }
    header = {"alg": "none", "typ": "JWT"}
    payload = {"https://daml.com/ledger-api": claim}
    return f"{_b64url(header)}.{_b64url(payload)}."


def _normalize_token(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    if raw.lower().startswith("bearer "):
        return raw
    return f"Bearer {raw}"


def _normalize_template_id(template_id: str) -> str:
    if not template_id:
        return template_id
    if template_id.count(":") >= 2:
        return template_id
    if template_id.count(":") == 1 and CFG.package_id:
        return f"{CFG.package_id}:{template_id}"
    return template_id


def _pick_side(party_header: str) -> str:
    actual = PARTY_MAP.to_actual(party_header)
    alias = PARTY_MAP.to_alias(actual)

    if alias in CFG.user_parties or actual in CFG.user_parties:
        return "user"
    if alias in CFG.provider_parties or actual in CFG.provider_parties:
        return "provider"

    # Default to provider side for unknown aliases.
    return "provider"


def _base_url(side: str) -> str:
    return CFG.user_url if side == "user" else CFG.provider_url


def _side_token(side: str) -> str:
    if side == "user" and CFG.user_token:
        return CFG.user_token
    if side == "provider" and CFG.provider_token:
        return CFG.provider_token
    return CFG.shared_token


def _outbound_auth(
    side: str,
    incoming_auth: str | None,
    party_for_token: str | None,
    *,
    admin: bool,
) -> str | None:
    if CFG.trust_client_auth and incoming_auth:
        return incoming_auth

    configured = _side_token(side)
    if configured:
        return _normalize_token(configured)

    if CFG.allow_insecure_tokens:
        return f"Bearer {_make_insecure_token(party_for_token, admin=admin)}"

    if incoming_auth:
        return incoming_auth

    return None


def _party_value_to_actual(value: Any) -> Any:
    if isinstance(value, str):
        return PARTY_MAP.to_actual(value)
    if isinstance(value, list):
        return [PARTY_MAP.to_actual(v) if isinstance(v, str) else v for v in value]
    return value


def _party_value_to_alias(value: Any) -> Any:
    if isinstance(value, str):
        return PARTY_MAP.to_alias(value)
    if isinstance(value, list):
        return [PARTY_MAP.to_alias(v) if isinstance(v, str) else v for v in value]
    return value


def _normalize_compat_value(value: Any) -> Any:
    if isinstance(value, dict):
        # v1 JSON API compatibility:
        # - Optional None/Some
        # - Enum-like variants encoded as {"tag": "...", "value": {}}
        if set(value.keys()) == {"tag", "value"} and isinstance(value.get("tag"), str):
            tag = str(value.get("tag"))
            inner = value.get("value")
            if tag == "None":
                return None
            if tag == "Some":
                return _normalize_compat_value(inner)
            if inner in ({}, None):
                return tag
            return {"tag": tag, "value": _normalize_compat_value(inner)}
        return {k: _normalize_compat_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize_compat_value(v) for v in value]
    return value


def _map_payload_parties_to_actual(value: Any) -> Any:
    if isinstance(value, dict):
        mapped: dict[str, Any] = {}
        for k, v in value.items():
            if k in PARTY_SCALAR_FIELDS or k in PARTY_LIST_FIELDS:
                mapped[k] = _party_value_to_actual(v)
            else:
                mapped[k] = _normalize_compat_value(v)
        return mapped
    if isinstance(value, list):
        return [_normalize_compat_value(v) for v in value]
    return _normalize_compat_value(value)


def _map_payload_parties_to_alias(value: Any) -> Any:
    if isinstance(value, dict):
        mapped: dict[str, Any] = {}
        for k, v in value.items():
            if k in PARTY_SCALAR_FIELDS or k in PARTY_LIST_FIELDS:
                mapped[k] = _party_value_to_alias(v)
            else:
                mapped[k] = _map_payload_parties_to_alias(v)
        return mapped
    if isinstance(value, list):
        return [_map_payload_parties_to_alias(v) for v in value]
    return value


def _match_query(payload: dict[str, Any], query: dict[str, Any]) -> bool:
    if not query:
        return True
    for key, expected in query.items():
        if key not in payload:
            return False
        if payload[key] != expected:
            return False
    return True


def _extract_active_entries(body: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(body, list):
        return rows

    for item in body:
        if not isinstance(item, dict):
            continue
        contract_entry = item.get("contractEntry")
        if not isinstance(contract_entry, dict):
            continue
        active = contract_entry.get("JsActiveContract")
        if not isinstance(active, dict):
            continue
        created = active.get("createdEvent")
        if not isinstance(created, dict):
            continue
        cid = created.get("contractId")
        if not isinstance(cid, str) or not cid:
            continue
        payload = created.get("createArgument", {})
        if not isinstance(payload, dict):
            payload = {}
        rows.append({"contractId": cid, "payload": payload})
    return rows


def _extract_tree_events(txn_tree: dict[str, Any]) -> tuple[Any, list[dict[str, Any]]]:
    exercise_result: Any = None
    created_events: list[dict[str, Any]] = []

    events_by_id = txn_tree.get("eventsById")
    if not isinstance(events_by_id, dict):
        return exercise_result, created_events

    for event in events_by_id.values():
        if not isinstance(event, dict):
            continue

        created_tree = event.get("CreatedTreeEvent")
        if isinstance(created_tree, dict):
            created_value = created_tree.get("value")
            if isinstance(created_value, dict):
                cid = created_value.get("contractId")
                payload = created_value.get("createArgument", {})
                if isinstance(cid, str) and isinstance(payload, dict):
                    created_events.append({"contractId": cid, "payload": payload})

        exercised_tree = event.get("ExercisedTreeEvent")
        if isinstance(exercised_tree, dict):
            exercised_value = exercised_tree.get("value")
            if isinstance(exercised_value, dict) and "exerciseResult" in exercised_value:
                exercise_result = exercised_value.get("exerciseResult")

    return exercise_result, created_events


def _detail_from_response(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return resp.text


async def _request_canton(
    side: str,
    method: str,
    path: str,
    *,
    incoming_auth: str | None,
    party_for_token: str | None,
    admin: bool = False,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    content: bytes | None = None,
    content_type: str | None = None,
) -> httpx.Response:
    url = f"{_base_url(side).rstrip('/')}/{path.lstrip('/')}"
    headers: dict[str, str] = {}

    auth = _outbound_auth(
        side,
        incoming_auth,
        party_for_token=party_for_token,
        admin=admin,
    )
    if auth:
        headers["Authorization"] = auth

    if content_type:
        headers["Content-Type"] = content_type

    timeout = httpx.Timeout(CFG.timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.request(
            method,
            url,
            json=json_body,
            params=params,
            content=content,
            headers=headers,
        )


async def _ledger_end(
    side: str,
    incoming_auth: str | None,
    party_actual: str,
) -> int:
    resp = await _request_canton(
        side,
        "GET",
        "/v2/state/ledger-end",
        incoming_auth=incoming_auth,
        party_for_token=party_actual,
    )
    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_detail_from_response(resp))

    data = resp.json()
    if not isinstance(data, dict):
        return 0
    offset = data.get("offset", 0)
    try:
        return int(offset)
    except Exception:
        return 0


async def _lookup_template_id(
    side: str,
    incoming_auth: str | None,
    party_actual: str,
    contract_id: str,
) -> str | None:
    body = {
        "contractId": contract_id,
        "eventFormat": {
            "filtersByParty": {party_actual: {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}},
            "verbose": True,
        },
    }
    resp = await _request_canton(
        side,
        "POST",
        "/v2/events/events-by-contract-id",
        incoming_auth=incoming_auth,
        party_for_token=party_actual,
        json_body=body,
    )
    if resp.status_code >= 400:
        return None
    payload = resp.json()
    if not isinstance(payload, dict):
        return None
    created = payload.get("created")
    if not isinstance(created, dict):
        return None
    created_event = created.get("createdEvent")
    if not isinstance(created_event, dict):
        return None
    template_id = created_event.get("templateId")
    if isinstance(template_id, str) and template_id:
        return template_id
    return None


async def _submit_command(
    side: str,
    incoming_auth: str | None,
    party_actual: str,
    command: dict[str, Any],
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "commandId": f"shadowcap-{uuid.uuid4().hex}",
        "actAs": [party_actual],
        "commands": [command],
        "readAs": [party_actual],
        "deduplicationPeriod": {"Empty": {}},
    }

    resp = await _request_canton(
        side,
        "POST",
        "/v2/commands/submit-and-wait-for-transaction-tree",
        incoming_auth=incoming_auth,
        party_for_token=party_actual,
        json_body=body,
    )

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=_detail_from_response(resp))

    data = resp.json()
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Unexpected command response shape")
    return data


app = FastAPI(title="Shadow-Cap Canton v1 Compatibility Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/status")
async def status() -> dict[str, Any]:
    provider_ok = False
    user_ok = False
    details: dict[str, Any] = {}

    for side in ("provider", "user"):
        try:
            resp = await _request_canton(
                side,
                "GET",
                "/v2/version",
                incoming_auth=None,
                party_for_token=None,
                admin=False,
            )
            ok = resp.status_code < 400
            details[side] = {
                "ok": ok,
                "status_code": resp.status_code,
                "base_url": _base_url(side),
            }
            if side == "provider":
                provider_ok = ok
            else:
                user_ok = ok
        except Exception as ex:  # pragma: no cover
            details[side] = {
                "ok": False,
                "error": str(ex),
                "base_url": _base_url(side),
            }

    return {
        "healthy": provider_ok or user_ok,
        "package_id": CFG.package_id or None,
        "party_map_path": str(CFG.party_map_path),
        "party_aliases": PARTY_MAP.aliases(),
        "details": details,
    }


@app.get("/v1/parties")
async def v1_parties() -> dict[str, Any]:
    # Keep this endpoint simple and stable for UI bootstrap.
    aliases = PARTY_MAP.aliases()
    result = [{"identifier": alias, "displayName": alias} for alias in aliases]
    return {"status": 200, "result": result}


@app.post("/v1/query")
async def v1_query(request: Request) -> dict[str, Any]:
    party_header = request.headers.get("X-Ledger-Party")
    if not party_header:
        raise HTTPException(status_code=400, detail="Missing X-Ledger-Party header")

    incoming_auth = request.headers.get("Authorization")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    template_ids = body.get("templateIds")
    if not isinstance(template_ids, list) or not template_ids:
        raise HTTPException(status_code=400, detail="templateIds must be a non-empty list")

    query_filter = body.get("query")
    if query_filter is None:
        query_filter = {}
    if not isinstance(query_filter, dict):
        raise HTTPException(status_code=400, detail="query must be an object")
    query_filter = _normalize_compat_value(query_filter)

    party_actual = PARTY_MAP.to_actual(party_header)
    side = _pick_side(party_header)
    active_at_offset = await _ledger_end(side, incoming_auth, party_actual)

    rows: list[dict[str, Any]] = []
    for raw_tid in template_ids:
        if not isinstance(raw_tid, str):
            continue
        template_id = _normalize_template_id(raw_tid)

        request_body = {
            "activeAtOffset": active_at_offset,
            "verbose": True,
            "filter": {
                "filtersByParty": {
                    party_actual: {
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

        resp = await _request_canton(
            side,
            "POST",
            "/v2/state/active-contracts",
            incoming_auth=incoming_auth,
            party_for_token=party_actual,
            json_body=request_body,
        )
        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail=_detail_from_response(resp))

        parsed = _extract_active_entries(resp.json())
        for item in parsed:
            payload_alias = _map_payload_parties_to_alias(item["payload"])
            if _match_query(payload_alias, query_filter):
                rows.append({"contractId": item["contractId"], "payload": payload_alias})

    return {"status": 200, "result": rows}


@app.post("/v1/create")
async def v1_create(request: Request) -> dict[str, Any]:
    party_header = request.headers.get("X-Ledger-Party")
    if not party_header:
        raise HTTPException(status_code=400, detail="Missing X-Ledger-Party header")

    incoming_auth = request.headers.get("Authorization")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    raw_template_id = body.get("templateId")
    payload = body.get("payload")
    if not isinstance(raw_template_id, str) or not raw_template_id:
        raise HTTPException(status_code=400, detail="templateId is required")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload must be an object")

    template_id = _normalize_template_id(raw_template_id)
    party_actual = PARTY_MAP.to_actual(party_header)
    side = _pick_side(party_header)

    mapped_payload = _map_payload_parties_to_actual(payload)

    command = {
        "CreateCommand": {
            "templateId": template_id,
            "createArguments": mapped_payload,
        }
    }

    cmd_response = await _submit_command(side, incoming_auth, party_actual, command)
    txn_tree = cmd_response.get("transactionTree")
    if not isinstance(txn_tree, dict):
        raise HTTPException(status_code=502, detail="transactionTree missing in command response")

    _, created_events = _extract_tree_events(txn_tree)
    if not created_events:
        raise HTTPException(status_code=502, detail="No created event returned by command")

    created = created_events[0]
    return {
        "status": 200,
        "result": {
            "contractId": created["contractId"],
            "payload": _map_payload_parties_to_alias(created["payload"]),
        },
    }


@app.post("/v1/exercise")
async def v1_exercise(request: Request) -> dict[str, Any]:
    party_header = request.headers.get("X-Ledger-Party")
    if not party_header:
        raise HTTPException(status_code=400, detail="Missing X-Ledger-Party header")

    incoming_auth = request.headers.get("Authorization")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    contract_id = body.get("contractId")
    choice = body.get("choice")
    argument = body.get("argument")
    raw_template_id = body.get("templateId")

    if not isinstance(contract_id, str) or not contract_id:
        raise HTTPException(status_code=400, detail="contractId is required")
    if not isinstance(choice, str) or not choice:
        raise HTTPException(status_code=400, detail="choice is required")
    if not isinstance(argument, dict):
        raise HTTPException(status_code=400, detail="argument must be an object")

    party_actual = PARTY_MAP.to_actual(party_header)
    side = _pick_side(party_header)

    template_id: str | None = None
    if isinstance(raw_template_id, str) and raw_template_id:
        template_id = _normalize_template_id(raw_template_id)
    else:
        template_id = await _lookup_template_id(side, incoming_auth, party_actual, contract_id)

    if not template_id:
        raise HTTPException(
            status_code=400,
            detail="templateId required (or contract lookup failed).",
        )

    mapped_argument = _map_payload_parties_to_actual(argument)

    command = {
        "ExerciseCommand": {
            "templateId": template_id,
            "contractId": contract_id,
            "choice": choice,
            "choiceArgument": mapped_argument,
        }
    }

    cmd_response = await _submit_command(side, incoming_auth, party_actual, command)
    txn_tree = cmd_response.get("transactionTree")
    if not isinstance(txn_tree, dict):
        raise HTTPException(status_code=502, detail="transactionTree missing in command response")

    exercise_result, created_events = _extract_tree_events(txn_tree)
    result_events = [
        {
            "created": {
                "contractId": evt["contractId"],
                "payload": _map_payload_parties_to_alias(evt["payload"]),
            }
        }
        for evt in created_events
    ]

    return {
        "status": 200,
        "result": {
            "exerciseResult": exercise_result,
            "events": result_events,
        },
    }


@app.on_event("startup")
async def _startup_checks() -> None:
    network_mode = os.getenv("CANTON_NETWORK_MODE", "local").strip().lower()
    if network_mode in {"devnet", "testnet", "mainnet", "public"}:
        has_token = bool(CFG.provider_token or CFG.user_token or CFG.shared_token)
        if not has_token:
            import sys
            print(
                f"\nFATAL: Gateway cannot start on {network_mode} without authentication.\n"
                f"Set CANTON_PROVIDER_TOKEN + CANTON_USER_TOKEN or CANTON_JWT_TOKEN.\n"
                f"For local development, set CANTON_NETWORK_MODE=local\n",
                file=sys.stderr,
            )
            raise SystemExit(1)
        if CFG.allow_insecure_tokens:
            import sys
            print(
                f"WARNING: Insecure tokens enabled on {network_mode}. "
                f"Set CANTON_ALLOW_INSECURE_TOKEN=false for production.",
                file=sys.stderr,
            )


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("CANTON_GATEWAY_HOST", "0.0.0.0")
    port = int(os.getenv("CANTON_GATEWAY_PORT", "8081"))
    uvicorn.run("deploy.canton_network.v1_gateway:app", host=host, port=port, reload=False)
