"""
Shared utilities for Agentic Shadow-Cap agents.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from llm_advisor import LLMAdvice

log = logging.getLogger(__name__)

DECISION_LOG_TEMPLATE = "AgenticShadowCap.Market:AgentDecisionLog"


def to_decimal(value: Any) -> Decimal:
    return Decimal(str(value))


def optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, dict) and value.get("tag") == "None":
        return None
    if isinstance(value, dict) and value.get("tag") == "Some":
        return to_decimal(value.get("value"))
    return to_decimal(value)


def parse_side(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        tag = value.get("tag")
        if isinstance(tag, str):
            return tag
    return ""


def make_side(tag: str) -> dict[str, Any]:
    return {"tag": tag, "value": {}}


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
            if event.payload.get(field) == value:
                result[event.contract_id] = event.payload
    return result
