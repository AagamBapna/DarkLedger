#!/usr/bin/env python3
"""
Seller-side legal representative agent for Agentic Shadow-Cap.

Responsibilities:
1) Poll active TradeIntent contracts and reprice via LLM/rule-based logic.
2) Post sell-side DiscoveryInterest "whisper" signals (no price/volume).
3) Auto-negotiate in PrivateNegotiation as seller agent.
4) Log every decision to AgentDecisionLog on-ledger.
"""

from __future__ import annotations

import asyncio
import os
import logging
import time as _time
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import dazl

from llm_advisor import get_pricing_advice, get_negotiation_advice
from common import (
    to_decimal,
    optional_decimal,
    parse_side,
    make_side,
    load_market_data,
    load_agent_controls,
    retry_exercise,
    retry_create,
    log_decision,
    query_active,
    query_filtered,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("seller_agent")

ABSOLUTE_FLOOR_RATIO = Decimal("0.60")
REPRICE_COOLDOWN_SECONDS = 15.0


@dataclass
class AgentConfig:
    ledger_url: str
    agent_party: str
    owner_party: str
    template_id: str
    discovery_template_id: str
    negotiation_template_id: str
    feed_path: Path
    poll_seconds: float
    min_tick_change: Decimal
    discovery_strategy_tag: str
    counter_offer_markup: Decimal
    counterparty_agent_party: str
    control_path: Path

    @staticmethod
    def from_env() -> "AgentConfig":
        return AgentConfig(
            ledger_url=os.getenv("DAML_LEDGER_URL", "http://localhost:5011"),
            agent_party=os.getenv("SELLER_AGENT_PARTY", "SellerAgent"),
            owner_party=os.getenv("SELLER_PARTY", "Seller"),
            template_id=os.getenv("TRADE_INTENT_TEMPLATE", "AgenticShadowCap.Market:TradeIntent"),
            discovery_template_id=os.getenv("DISCOVERY_TEMPLATE", "AgenticShadowCap.Market:DiscoveryInterest"),
            negotiation_template_id=os.getenv("NEGOTIATION_TEMPLATE", "AgenticShadowCap.Market:PrivateNegotiation"),
            feed_path=Path(os.getenv("MARKET_FEED_PATH", "./agent/mock_market_feed.json")),
            poll_seconds=float(os.getenv("AGENT_POLL_SECONDS", "5")),
            min_tick_change=Decimal(os.getenv("MIN_TICK_CHANGE", "0.01")),
            discovery_strategy_tag=os.getenv("SELLER_DISCOVERY_STRATEGY", "SELL_WHISPER"),
            counter_offer_markup=Decimal(os.getenv("SELLER_COUNTER_MARKUP", "1.00")),
            counterparty_agent_party=os.getenv("SELLER_COUNTERPARTY_AGENT", "BuyerAgent"),
            control_path=Path(os.getenv("AGENT_CONTROL_PATH", "./agent/agent_controls.json")),
        )


async def repricing_loop(conn: Any, config: AgentConfig) -> None:
    original_prices: dict[str, Decimal] = {}
    last_reprice_time: dict[Any, float] = {}

    while True:
        market_data = load_market_data(config.feed_path)
        controls = load_agent_controls(config.control_path)
        seller_auto_reprice = bool(controls.get("seller_auto_reprice", True))
        intents = await query_active(conn, config.template_id)
        discoveries = await query_active(conn, config.discovery_template_id)

        own_active_sell: set[str] = set()
        for payload in discoveries.values():
            instrument = payload.get("instrument", "")
            if (
                payload.get("postingAgent") == config.agent_party
                and parse_side(payload.get("side")) == "Sell"
                and instrument
            ):
                own_active_sell.add(instrument)

        for cid, payload in list(intents.items()):
            instrument = payload["instrument"]
            current = to_decimal(payload["minPrice"])

            if instrument not in own_active_sell:
                discoverable_by = [p for p in [config.counterparty_agent_party] if p]
                try:
                    await retry_create(conn, config.discovery_template_id, {
                        "issuer": payload["issuer"],
                        "owner": payload["seller"],
                        "postingAgent": config.agent_party,
                        "discoverableBy": discoverable_by,
                        "instrument": instrument,
                        "side": make_side("Sell"),
                        "strategyTag": config.discovery_strategy_tag,
                    })
                    own_active_sell.add(instrument)
                    log.info("[agent] posted sell DiscoveryInterest for %s", instrument)
                except Exception as ex:
                    log.warning("[agent] DiscoveryInterest failed: %s", ex)

            if instrument not in original_prices:
                original_prices[instrument] = current

            if not seller_auto_reprice:
                continue

            now = _time.monotonic()
            last_t = last_reprice_time.get(cid, 0.0)
            if now - last_t < REPRICE_COOLDOWN_SECONDS:
                continue

            advice = get_pricing_advice(instrument, current, market_data, "seller")

            if advice.action == "hold":
                continue

            if advice.action == "archive":
                log.info("[agent] LLM recommends archiving intent for %s", instrument)
                await log_decision(conn, config.agent_party, config.owner_party, instrument, advice, market_data)
                continue

            candidate = advice.recommended_price
            absolute_floor = original_prices[instrument] * ABSOLUTE_FLOOR_RATIO
            if candidate < absolute_floor:
                log.warning(
                    "[agent] clamping %s price %s -> floor %s (60%% of original %s)",
                    instrument, candidate, absolute_floor, original_prices[instrument],
                )
                candidate = absolute_floor

            delta = abs(candidate - current)
            if delta < config.min_tick_change or candidate <= Decimal("0"):
                continue

            log.info("[agent] repricing %s: %s -> %s (reason: %s)", instrument, current, candidate, advice.reasoning[:60])
            try:
                await retry_exercise(conn, cid, "UpdatePrice", {"newMinPrice": str(candidate)})
                last_reprice_time[cid] = _time.monotonic()
                await log_decision(conn, config.agent_party, config.owner_party, instrument, advice, market_data)
            except Exception as ex:
                log.error("[agent] repricing failed: %s", ex)

        await asyncio.sleep(config.poll_seconds)


async def negotiation_loop(conn: Any, config: AgentConfig) -> None:
    processed: set[Any] = set()

    while True:
        market_data = load_market_data(config.feed_path)
        intents = await query_active(conn, config.template_id)
        negotiations = await query_filtered(conn, config.negotiation_template_id, "sellerAgent", config.agent_party)

        for cid, payload in list(negotiations.items()):
            if cid in processed:
                continue

            proposed_qty = optional_decimal(payload.get("proposedQty"))
            proposed_price = optional_decimal(payload.get("proposedUnitPrice"))
            seller_accepted = bool(payload.get("sellerAccepted", False))
            buyer_accepted = bool(payload.get("buyerAccepted", False))
            instrument = payload.get("instrument", "")

            intent = next((p for p in intents.values() if p.get("instrument") == instrument), None)
            if intent is None:
                continue

            min_price = to_decimal(intent["minPrice"])
            qty = to_decimal(intent["quantity"])

            try:
                if proposed_qty is None:
                    log.info("[negotiation] submitting initial terms: qty=%s price=%s", qty, min_price)
                    await retry_exercise(conn, cid, "SubmitSellerTerms", {"qty": str(qty), "unitPrice": str(min_price)})
                    processed.add(cid)
                    continue

                if buyer_accepted and not seller_accepted and proposed_price is not None:
                    advice = get_negotiation_advice(instrument, proposed_price, min_price, market_data, "seller")
                    await log_decision(conn, config.agent_party, config.owner_party, instrument, advice, market_data)

                    if advice.action == "accept":
                        log.info("[negotiation] accepting: %s (reason: %s)", proposed_price, advice.reasoning[:60])
                        await retry_exercise(conn, cid, "AcceptBySeller", {})
                    else:
                        counter = advice.recommended_price
                        log.info("[negotiation] countering at %s (reason: %s)", counter, advice.reasoning[:60])
                        await retry_exercise(conn, cid, "SubmitSellerTerms", {"qty": str(qty), "unitPrice": str(counter)})
                    processed.add(cid)
            except Exception as ex:
                log.error("[negotiation] failed: %s", ex)

        await asyncio.sleep(config.poll_seconds)


async def main() -> None:
    config = AgentConfig.from_env()
    log.info("[boot] seller agent=%s ledger=%s", config.agent_party, config.ledger_url)

    async with dazl.connect(url=config.ledger_url, act_as=[config.agent_party], read_as=[config.agent_party]) as conn:
        log.info("[boot] connected, starting loops")
        await asyncio.gather(
            repricing_loop(conn, config),
            negotiation_loop(conn, config),
        )


if __name__ == "__main__":
    asyncio.run(main())
