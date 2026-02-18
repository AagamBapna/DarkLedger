#!/usr/bin/env python3
"""Minimal async connection wrapper over v1 JSON API endpoints."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from typing import Any

import httpx


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _normalize_token(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ""
    if value.lower().startswith("bearer "):
        return value
    return f"Bearer {value}"


def _b64url_bytes(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def _b64url_json(value: dict[str, Any]) -> str:
    return _b64url_bytes(json.dumps(value, separators=(",", ":")).encode("utf-8"))


def _make_insecure_token(party: str) -> str:
    mode = os.getenv("DAML_HTTP_JSON_INSECURE_TOKEN_MODE", "hs256-unsafe").strip().lower()
    app_id = os.getenv("DAML_HTTP_JSON_APPLICATION_ID", "shadow-cap-agent")
    if mode in {"hs256", "hs256-unsafe", "unsafe"}:
        secret = os.getenv("DAML_HTTP_JSON_INSECURE_SECRET", "unsafe")
        audience = os.getenv("DAML_HTTP_JSON_INSECURE_AUDIENCE", "https://canton.network.global")
        subject = os.getenv("DAML_HTTP_JSON_INSECURE_SUB", "ledger-api-user")
        header = {"alg": "HS256", "typ": "JWT"}
        payload: dict[str, Any] = {"sub": subject, "aud": audience}
        unsigned = f"{_b64url_json(header)}.{_b64url_json(payload)}".encode("utf-8")
        signature = hmac.new(secret.encode("utf-8"), unsigned, hashlib.sha256).digest()
        return f"{unsigned.decode('utf-8')}.{_b64url_bytes(signature)}"

    header = {"alg": "none", "typ": "JWT"}
    payload = {
        "https://daml.com/ledger-api": {
            "ledgerId": os.getenv("DAML_HTTP_JSON_INSECURE_LEDGER_ID", "sandbox"),
            "applicationId": app_id,
            "actAs": [party],
            "readAs": [party],
        }
    }
    return f"{_b64url_json(header)}.{_b64url_json(payload)}."


@dataclass
class JsonApiCreateEvent:
    contract_id: str
    payload: dict[str, Any]


class JsonApiQueryStream:
    def __init__(self, conn: "HttpJsonConnection", template_id: str):
        self._conn = conn
        self._template_id = template_id
        self._events: list[JsonApiCreateEvent] = []

    async def __aenter__(self) -> "JsonApiQueryStream":
        response = await self._conn._post_json("/v1/query", {"templateIds": [self._template_id]})
        rows = response.get("result")
        self._events = []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                contract_id = row.get("contractId") or row.get("contract_id")
                payload = row.get("payload")
                if isinstance(contract_id, str) and isinstance(payload, dict):
                    self._events.append(JsonApiCreateEvent(contract_id=contract_id, payload=payload))
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return False

    async def creates(self):
        for event in self._events:
            yield event


class HttpJsonConnection:
    def __init__(
        self,
        *,
        base_url: str,
        party: str,
        auth_token: str = "",
        timeout_seconds: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.party = party
        self.auth_token = auth_token.strip()
        self.timeout_seconds = timeout_seconds
        self._client: httpx.AsyncClient | None = None
        self.allow_insecure_token = _env_bool("DAML_HTTP_JSON_ALLOW_INSECURE_TOKEN", False)

    async def __aenter__(self) -> "HttpJsonConnection":
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout_seconds))
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> bool:
        await self.close()
        return False

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def query(self, template_id: str) -> JsonApiQueryStream:
        return JsonApiQueryStream(self, template_id)

    async def create(self, template_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._post_json(
            "/v1/create",
            {
                "templateId": template_id,
                "payload": payload,
            },
        )

    async def exercise(self, cid: str, choice: str, args: dict[str, Any]) -> dict[str, Any]:
        return await self._post_json(
            "/v1/exercise",
            {
                "contractId": cid,
                "choice": choice,
                "argument": args,
            },
        )

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "X-Ledger-Party": self.party,
        }
        token = self.auth_token
        if not token and self.allow_insecure_token:
            token = _make_insecure_token(self.party)
        normalized = _normalize_token(token)
        if normalized:
            headers["Authorization"] = normalized
        return headers

    async def _post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            raise RuntimeError("HttpJsonConnection is not open")
        url = f"{self.base_url}/{path.lstrip('/')}"
        response = await self._client.post(url, headers=self._headers(), json=body)
        if response.status_code >= 400:
            raise RuntimeError(f"{path} failed ({response.status_code}): {response.text}")
        try:
            data = response.json()
        except Exception as ex:
            raise RuntimeError(f"{path} returned non-JSON payload: {response.text}") from ex
        if not isinstance(data, dict):
            raise RuntimeError(f"{path} returned unexpected payload shape")
        return data
