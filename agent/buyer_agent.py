#!/usr/bin/env python3
"""
Buyer-side legal representative agent for Agentic Shadow-Cap.

Responsibilities:
1) Watch sell-side DiscoveryInterest signals; post matching buy signals.
2) Auto-negotiate in PrivateNegotiation as buyer agent.
3) Log every decision to AgentDecisionLog on-ledger via LLM advisor.
"""

from __future__ import annotations

import asyncio
import os
import logging
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
    retry_exercise,
    retry_create,
    log_decision,
    query_active,
    query_filtered,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("buyer_agent")

ABSOLUTE_CEILING_RATIO = Decimal("1.40")


@dataclass
class AgentConfig:
    ledger_url: str
    agent_party: str
    buyer_party: str
    target_instrument: str
    discovery_template_id: str
    negotiation_template_id: str
    feed_path: Path
    poll_seconds: float
    max_price: Decimal
    default_qty: Decimal
    discovery_strategy_tag: str

    @staticmethod
    def from_env() -> "AgentConfig":
        return AgentConfig(
            ledger_url=os.getenv("DAML_LEDGER_URL", "http://localhost:5021"),
            agent_party=os.getenv("BUYER_AGENT_PARTY", "BuyerAgent"),
            buyer_party=os.getenv("BUYER_PARTY", "Buyer"),
            target_instrument=os.getenv("TARGET_INSTRUMENT", "COMPANY-SERIES-A"),
            discovery_template_id=os.getenv("DISCOVERY_TEMPLATE", "AgenticShadowCap.Market:DiscoveryInterest"),
            negotiation_template_id=os.getenv("NEGOTIATION_TEMPLATE", "AgenticShadowCap.Market:PrivateNegotiation"),
            feed_path=Path(os.getenv("MARKET_FEED_PATH", "./agent/mock_market_feed.json")),
            poll_seconds=float(os.getenv("AGENT_POLL_SECONDS", "5")),
            max_price=Decimal(os.getenv("BUYER_MAX_PRICE", "110.00")),
            default_qty=Decimal(os.getenv("BUYER_DEFAULT_QTY", "1000.00")),
            discovery_strategy_tag=os.getenv("BUYER_DISCOVERY_STRATEGY", "BUY_WHISPER"),
        )


async def discovery_loop(conn: Any, config: AgentConfig) -> None:
    posted_buy: set[str] = set()

    while True:
        discoveries = await query_active(conn, config.discovery_template_id)

        has_sell_signal = False
        for payload in discoveries.values():
            side = parse_side(payload.get("side"))
            instrument = payload.get("instrument", "")
            posting_agent = payload.get("postingAgent", "")
            if side == "Sell" and instrument == config.target_instrument and posting_agent != config.agent_party:
                has_sell_signal = True
                break

        if has_sell_signal and config.target_instrument not in posted_buy:
            issuer = next(
                (p.get("issuer") for p in discoveries.values() if p.get("instrument") == config.target_instrument),
                "",
            )
            if issuer:
                try:
                    await retry_create(conn, config.discovery_template_id, {
                        "issuer": issuer,
                        "owner": config.buyer_party,
                        "postingAgent": config.agent_party,
                        "instrument": config.target_instrument,
                        "side": make_side("Buy"),
                        "strategyTag": config.discovery_strategy_tag,
                    })
                    posted_buy.add(config.target_instrument)
                    log.info("[agent] posted buy DiscoveryInterest for %s", config.target_instrument)
                except Exception as ex:
                    log.warning("[agent] DiscoveryInterest failed: %s", ex)

        await asyncio.sleep(config.poll_seconds)


async def negotiation_loop(conn: Any, config: AgentConfig) -> None:
    processed: set[Any] = set()
    original_max = config.max_price

    while True:
        market_data = load_market_data(config.feed_path)
        negotiations = await query_filtered(conn, config.negotiation_template_id, "buyerAgent", config.agent_party)

        advice = get_pricing_advice(config.target_instrument, config.max_price, market_data, "buyer")
        adjusted_max = advice.recommended_price

        absolute_ceiling = original_max * ABSOLUTE_CEILING_RATIO
        if adjusted_max > absolute_ceiling:
            log.warning(
                "[agent] clamping adjusted max %s -> ceiling %s (140%% of original %s)",
                adjusted_max, absolute_ceiling, original_max,
            )
            adjusted_max = absolute_ceiling

        for cid, payload in list(negotiations.items()):
            if cid in processed:
                continue

            proposed_qty = optional_decimal(payload.get("proposedQty"))
            proposed_price = optional_decimal(payload.get("proposedUnitPrice"))
            seller_accepted = bool(payload.get("sellerAccepted", False))
            buyer_accepted = bool(payload.get("buyerAccepted", False))
            instrument = payload.get("instrument", "")

            if not seller_accepted or buyer_accepted:
                continue
            if proposed_qty is None or proposed_price is None:
                continue

            try:
                neg_advice = get_negotiation_advice(instrument, proposed_price, adjusted_max, market_data, "buyer")
                await log_decision(conn, config.agent_party, config.buyer_party, instrument, neg_advice, market_data)

                if neg_advice.action == "accept":
                    log.info("[negotiation] accepting at %s (reason: %s)", proposed_price, neg_advice.reasoning[:60])
                    await retry_exercise(conn, cid, "AcceptByBuyer", {})
                else:
                    log.info("[negotiation] countering at %s (reason: %s)", adjusted_max, neg_advice.reasoning[:60])
                    await retry_exercise(conn, cid, "SubmitBuyerTerms", {
                        "qty": str(proposed_qty),
                        "unitPrice": str(adjusted_max),
                    })
                processed.add(cid)
            except Exception as ex:
                log.error("[negotiation] failed: %s", ex)

        await asyncio.sleep(config.poll_seconds)


async def main() -> None:
    config = AgentConfig.from_env()
    log.info("[boot] buyer agent=%s ledger=%s target=%s", config.agent_party, config.ledger_url, config.target_instrument)

    async with dazl.connect(url=config.ledger_url, act_as=[config.agent_party], read_as=[config.agent_party]) as conn:
        log.info("[boot] connected, starting loops")
        await asyncio.gather(
            discovery_loop(conn, config),
            negotiation_loop(conn, config),
        )


if __name__ == "__main__":
    asyncio.run(main())
