"""HTTP gateway for the public web demo.

It exposes a single public API surface and proxies requests to:
- Daml JSON API (`/ledger/*`)
- Market API (`/market/*`)
"""

from __future__ import annotations

import json
import os

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

LEDGER_API_URL = os.getenv("LEDGER_API_URL", "http://127.0.0.1:7575")
MARKET_API_URL = os.getenv("MARKET_API_URL", "http://127.0.0.1:8090")
CORS_ALLOW_ORIGINS = os.getenv("CORS_ALLOW_ORIGINS", "*")
PACKAGE_ID = os.getenv("PACKAGE_ID", "").strip()

ALL_METHODS: list[str] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}

app = FastAPI(title="Shadow-Cap Public Demo Gateway")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in CORS_ALLOW_ORIGINS.split(",") if origin.strip()] or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _normalize_template_id(template_id: str) -> str:
    if not PACKAGE_ID:
        return template_id
    if template_id.count(":") >= 2:
        return template_id
    if template_id.count(":") == 1 and template_id.startswith("AgenticShadowCap."):
        return f"{PACKAGE_ID}:{template_id}"
    return template_id


def _normalize_ledger_body(body: bytes, content_type: str | None) -> bytes:
    if not PACKAGE_ID or not body:
        return body
    if not content_type or "application/json" not in content_type.lower():
        return body

    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return body

    if not isinstance(payload, dict):
        return body

    changed = False
    template_id = payload.get("templateId")
    if isinstance(template_id, str):
        normalized = _normalize_template_id(template_id)
        if normalized != template_id:
            payload["templateId"] = normalized
            changed = True

    template_ids = payload.get("templateIds")
    if isinstance(template_ids, list):
        normalized_ids = [
            _normalize_template_id(item) if isinstance(item, str) else item
            for item in template_ids
        ]
        if normalized_ids != template_ids:
            payload["templateIds"] = normalized_ids
            changed = True

    if not changed:
        return body
    return json.dumps(payload).encode("utf-8")


async def _proxy_request(request: Request, upstream_base: str, upstream_path: str) -> Response:
    target = f"{upstream_base.rstrip('/')}/{upstream_path.lstrip('/')}"
    body = await request.body()
    if upstream_base == LEDGER_API_URL:
        body = _normalize_ledger_body(body, request.headers.get("content-type"))
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }

    timeout = httpx.Timeout(connect=10.0, read=30.0, write=30.0, pool=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        upstream_response = await client.request(
            request.method,
            target,
            params=request.query_params,
            headers=headers,
            content=body,
        )

    response_headers = {
        key: value
        for key, value in upstream_response.headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }
    return Response(
        content=upstream_response.content,
        status_code=upstream_response.status_code,
        headers=response_headers,
    )


@app.api_route("/ledger", methods=ALL_METHODS)
async def ledger_root(request: Request) -> Response:
    return await _proxy_request(request, LEDGER_API_URL, "")


@app.api_route("/ledger/{path:path}", methods=ALL_METHODS)
async def ledger_proxy(path: str, request: Request) -> Response:
    return await _proxy_request(request, LEDGER_API_URL, path)


@app.api_route("/market", methods=ALL_METHODS)
async def market_root(request: Request) -> Response:
    return await _proxy_request(request, MARKET_API_URL, "")


@app.api_route("/market/{path:path}", methods=ALL_METHODS)
async def market_proxy(path: str, request: Request) -> Response:
    return await _proxy_request(request, MARKET_API_URL, path)


@app.get("/status")
async def gateway_status() -> dict[str, object]:
    checks: dict[str, dict[str, object]] = {}
    admin_token = (
        "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0."
        "eyJodHRwczovL2RhbWwuY29tL2xlZGdlci1hcGkiOnsibGVkZ2VySWQiOiJzYW5kYm94IiwiYXBwbGljYXRpb25JZCI6InN0YXR1cy1jaGVjayIsImFkbWluIjp0cnVlLCJhY3RBcyI6W10sInJlYWRBcyI6W119fQ."
    )
    async with httpx.AsyncClient(timeout=5.0) as client:
        for name, url in (
            ("ledger", f"{LEDGER_API_URL.rstrip('/')}/v1/parties"),
            ("market", f"{MARKET_API_URL.rstrip('/')}/status"),
        ):
            try:
                if name == "ledger":
                    response = await client.get(
                        url,
                        headers={
                            "Authorization": f"Bearer {admin_token}",
                        },
                    )
                else:
                    response = await client.get(url)
                checks[name] = {"ok": response.status_code < 400, "status_code": response.status_code}
            except Exception as ex:  # pragma: no cover
                checks[name] = {"ok": False, "error": str(ex)}

    healthy = all(bool(check.get("ok")) for check in checks.values())
    return {
        "healthy": healthy,
        "ledger_api_url": LEDGER_API_URL,
        "market_api_url": MARKET_API_URL,
        "package_id": PACKAGE_ID or None,
        "checks": checks,
    }
