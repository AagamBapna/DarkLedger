"""
Shared utilities for Agentic Shadow-Cap agents.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from llm_advisor import LLMAdvice

log = logging.getLogger(__name__)

DECISION_LOG_TEMPLATE = "AgenticShadowCap.Market:AgentDecisionLog"
DEFAULT_AGENT_CONTROLS = {
    "seller_auto_reprice": True,
    "buyer_auto_reprice": True,
}


def to_decimal(value: Any) -> Decimal:
    return Decimal(str(value))


def decimal_to_text(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    if "." not in text:
        return f"{text}.0"
    return text


def optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, dict) and value.get("tag") == "None":
        return None
    if isinstance(value, dict) and value.get("tag") == "Some":
        return to_decimal(value.get("value"))
    return to_decimal(value)


def optional_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        tag = value.get("tag")
        if tag == "None":
            return None
        if tag == "Some":
            inner = value.get("value")
            return inner if isinstance(inner, str) else None
    return None


def parse_side(value: Any) -> str:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "buy":
            return "Buy"
        if lowered == "sell":
            return "Sell"
        return value
    if isinstance(value, dict):
        tag = value.get("tag")
        if isinstance(tag, str):
            return parse_side(tag)
        if len(value) == 1:
            key = next(iter(value.keys()))
            if isinstance(key, str):
                return parse_side(key)
    return ""


def make_side(tag: str) -> dict[str, Any]:
    return {"tag": tag, "value": {}}


def parse_party_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    parties: list[str] = []
    for item in value:
        if isinstance(item, str):
            parties.append(item)
    return parties


def normalize_party(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.split("::", 1)[0].strip()


def parties_match(left: Any, right: Any) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    if left == right:
        return True
    left_norm = normalize_party(left)
    right_norm = normalize_party(right)
    return bool(left_norm and right_norm and left_norm == right_norm)


def load_market_data(feed_path: Path) -> dict[str, Any]:
    if not feed_path.exists():
        return {"market_volatility": "0.20", "news_sentiment": "neutral"}
    try:
        payload = json.loads(feed_path.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            payload = payload[-1] if payload else {}
        return payload
    except Exception:
        return {"market_volatility": "0.20", "news_sentiment": "neutral"}


def load_agent_controls(control_path: Path) -> dict[str, Any]:
    if not control_path.exists():
        return dict(DEFAULT_AGENT_CONTROLS)
    try:
        payload = json.loads(control_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return dict(DEFAULT_AGENT_CONTROLS)
        return {
            "seller_auto_reprice": bool(payload.get("seller_auto_reprice", True)),
            "buyer_auto_reprice": bool(payload.get("buyer_auto_reprice", True)),
        }
    except Exception:
        return dict(DEFAULT_AGENT_CONTROLS)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_ledger_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def commitment_hash(qty_text: str, unit_price_text: str, salt: str) -> str:
    raw = f"{qty_text}|{unit_price_text}|{salt}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def commitment_salt(
    agent_party: str,
    instrument: str,
    qty_text: str,
    unit_price_text: str,
) -> str:
    raw = f"{agent_party}|{instrument}|{qty_text}|{unit_price_text}|shadowcap-commit-v1"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def discovery_is_expired(payload: dict[str, Any], *, now: datetime | None = None) -> bool:
    expiry = parse_ledger_time(payload.get("expiresAt"))
    if expiry is None:
        return False
    at = now or utc_now()
    return expiry <= at


async def retry_exercise(conn: Any, cid: Any, choice: str, args: dict, retries: int = 3) -> Any:
    for attempt in range(retries):
        try:
            return await conn.exercise(cid, choice, args)
        except Exception as ex:
            if attempt == retries - 1:
                raise
            wait = 2 ** attempt
            log.warning("[retry] attempt %d failed for %s: %s, retrying in %ds", attempt + 1, choice, ex, wait)
            await asyncio.sleep(wait)


async def retry_create(conn: Any, template_id: str, payload: dict, retries: int = 3) -> Any:
    for attempt in range(retries):
        try:
            return await conn.create(template_id, payload)
        except Exception as ex:
            if attempt == retries - 1:
                raise
            wait = 2 ** attempt
            log.warning("[retry] create attempt %d failed: %s, retrying in %ds", attempt + 1, ex, wait)
            await asyncio.sleep(wait)


async def log_decision(
    conn: Any,
    agent_party: str,
    owner_party: str,
    instrument: str,
    advice: LLMAdvice,
    market_data: dict,
) -> None:
    try:
        await conn.create(DECISION_LOG_TEMPLATE, {
            "agent": agent_party,
            "owner": owner_party,
            "instrument": instrument,
            "decision": advice.action,
            "reasoning": advice.reasoning,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "marketContext": json.dumps({
                "volatility": str(market_data.get("market_volatility", "")),
                "sentiment": market_data.get("news_sentiment", ""),
                "confidence": advice.confidence,
                "recommended_price": str(advice.recommended_price),
            }),
        })
    except Exception as ex:
        log.warning("[decision-log] failed to log decision: %s", ex)


async def query_active(conn: Any, template_id: str) -> dict[Any, dict[str, Any]]:
    result: dict[Any, dict[str, Any]] = {}
    async with conn.query(template_id) as stream:
        async for event in stream.creates():
            result[event.contract_id] = event.payload
    return result


async def query_filtered(conn: Any, template_id: str, field: str, value: str) -> dict[Any, dict[str, Any]]:
    result: dict[Any, dict[str, Any]] = {}
    async with conn.query(template_id) as stream:
        async for event in stream.creates():
            actual = event.payload.get(field)
            if actual == value or parties_match(actual, value):
                result[event.contract_id] = event.payload
    return result
