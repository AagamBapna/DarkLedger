"""
LLM-powered pricing advisor for Agentic Shadow-Cap agents.

Calls OpenAI (gpt-4o-mini) for pricing recommendations. Falls back
to rule-based logic when the API key is missing or the call fails.
"""

from __future__ import annotations

import json
import os
import logging
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

logger = logging.getLogger("llm_advisor")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")


@dataclass
class LLMAdvice:
    recommended_price: Decimal
    reasoning: str
    confidence: float
    action: str  # hold | reprice | archive | accept | counter


def _rule_based_seller(current_price: Decimal, volatility: Decimal) -> LLMAdvice:
    if volatility >= Decimal("0.45"):
        factor, reason = Decimal("0.90"), "Extreme volatility: lowering floor aggressively to capture liquidity"
    elif volatility >= Decimal("0.30"):
        factor, reason = Decimal("0.95"), "Elevated volatility: slight floor reduction to improve fill probability"
    elif volatility <= Decimal("0.08"):
        factor, reason = Decimal("1.03"), "Low volatility: tightening floor to maximize proceeds in calm market"
    else:
        return LLMAdvice(current_price, "Stable market conditions: holding current price", 0.7, "hold")

    rec = (current_price * factor).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return LLMAdvice(rec, reason, 0.6, "reprice")


def _rule_based_buyer(max_price: Decimal, volatility: Decimal) -> LLMAdvice:
    if volatility >= Decimal("0.45"):
        factor, reason = Decimal("1.05"), "High volatility: raising ceiling to secure scarce supply"
    elif volatility <= Decimal("0.10"):
        factor, reason = Decimal("0.97"), "Low volatility: lowering ceiling to get a better deal in calm market"
    else:
        return LLMAdvice(max_price, "Stable conditions: maintaining current ceiling", 0.7, "hold")

    rec = (max_price * factor).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return LLMAdvice(rec, reason, 0.6, "reprice")


def _rule_based_negotiate_seller(
    proposed_price: Decimal, min_price: Decimal
) -> LLMAdvice:
    if proposed_price >= min_price:
        return LLMAdvice(proposed_price, f"Proposed {proposed_price} meets floor {min_price}", 0.9, "accept")
    return LLMAdvice(
        min_price,
        f"Proposed {proposed_price} below floor {min_price}: countering at floor",
        0.7,
        "counter",
    )


def _rule_based_negotiate_buyer(
    proposed_price: Decimal, max_price: Decimal
) -> LLMAdvice:
    if proposed_price <= max_price:
        return LLMAdvice(proposed_price, f"Proposed {proposed_price} within ceiling {max_price}", 0.9, "accept")
    return LLMAdvice(
        max_price,
        f"Proposed {proposed_price} exceeds ceiling {max_price}: countering at ceiling",
        0.7,
        "counter",
    )


def _call_openai(prompt: str) -> dict[str, Any] | None:
    if not OPENAI_API_KEY:
        return None
    try:
        import httpx

        resp = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a quantitative trading advisor for private secondary markets. "
                            "Respond ONLY with valid JSON: {\"recommended_price\": number, "
                            "\"reasoning\": string, \"confidence\": number 0-1, "
                            "\"action\": \"hold\"|\"reprice\"|\"accept\"|\"counter\"|\"archive\"}"
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.3,
                "max_tokens": 300,
            },
            timeout=8.0,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1].rsplit("```", 1)[0]
        return json.loads(content)
    except Exception as ex:
        logger.warning("OpenAI call failed, using rule-based fallback: %s", ex)
        return None


def _parse_llm_response(data: dict[str, Any], fallback_price: Decimal) -> LLMAdvice:
    try:
        return LLMAdvice(
            recommended_price=Decimal(str(data["recommended_price"])).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP
            ),
            reasoning=str(data.get("reasoning", "LLM decision")),
            confidence=float(data.get("confidence", 0.5)),
            action=str(data.get("action", "hold")),
        )
    except Exception:
        return LLMAdvice(fallback_price, "Failed to parse LLM response", 0.0, "hold")


def get_pricing_advice(
    instrument: str,
    current_price: Decimal,
    market_data: dict[str, Any],
    role: str,
) -> LLMAdvice:
    volatility = Decimal(str(market_data.get("market_volatility", "0.20")))
    news = market_data.get("news_sentiment", "neutral")
    event_type = market_data.get("event_type", "none")

    if role == "seller":
        fallback = _rule_based_seller(current_price, volatility)
    else:
        fallback = _rule_based_buyer(current_price, volatility)

    prompt = (
        f"Instrument: {instrument}\n"
        f"Role: {role}\n"
        f"Current {'min' if role == 'seller' else 'max'} price: {current_price}\n"
        f"Market volatility: {volatility}\n"
        f"News sentiment: {news}\n"
        f"Recent event: {event_type}\n"
        f"Should the {role} agent adjust their price, hold, or archive the intent?"
    )

    result = _call_openai(prompt)
    if result is None:
        return fallback
    return _parse_llm_response(result, current_price)


def get_negotiation_advice(
    instrument: str,
    proposed_price: Decimal,
    own_limit: Decimal,
    market_data: dict[str, Any],
    role: str,
) -> LLMAdvice:
    volatility = Decimal(str(market_data.get("market_volatility", "0.20")))
    news = market_data.get("news_sentiment", "neutral")

    if role == "seller":
        fallback = _rule_based_negotiate_seller(proposed_price, own_limit)
    else:
        fallback = _rule_based_negotiate_buyer(proposed_price, own_limit)

    prompt = (
        f"Instrument: {instrument}\n"
        f"Role: {role}\n"
        f"Proposed price from counterparty: {proposed_price}\n"
        f"My {'minimum acceptable' if role == 'seller' else 'maximum acceptable'}: {own_limit}\n"
        f"Volatility: {volatility}, News: {news}\n"
        f"Should I accept, counter-offer, or reject?"
    )

    result = _call_openai(prompt)
    if result is None:
        return fallback
    return _parse_llm_response(result, own_limit)
