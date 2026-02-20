#!/usr/bin/env python3
"""
Seller-side legal representative agent for Agentic Shadow-Cap.

Responsibilities:
1) Poll active TradeIntent contracts and reprice via LLM/rule-based logic.
2) Post sell-side DiscoveryInterest "whisper" signals (no price/volume).
3) Auto-negotiate in PrivateNegotiation as seller agent.
4) Log every decision to AgentDecisionLog on-ledger.
5) React to negative news sentiment: increase minPrice by 5% or archive.
"""

from __future__ import annotations

import asyncio
import os
import logging
import time as _time
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from base_agent import BaseAgent, AgentContext
from llm_advisor import get_pricing_advice, get_negotiation_advice
from common import (
    to_decimal,
    decimal_to_text,
    optional_decimal,
    optional_text,
    parse_side,
    make_side,
    parties_match,
    utc_now,
    iso_utc,
    discovery_is_expired,
    commitment_salt,
    commitment_hash,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

ABSOLUTE_FLOOR_RATIO = Decimal("0.60")
REPRICE_COOLDOWN_SECONDS = 15.0


def build_context() -> AgentContext:
    return AgentContext(
        ledger_url=os.getenv("DAML_LEDGER_URL", "http://localhost:5011"),
        agent_party=os.getenv("SELLER_AGENT_PARTY", "SellerAgent"),
        owner_party=os.getenv("SELLER_PARTY", "Seller"),
        feed_path=Path(os.getenv("MARKET_FEED_PATH", "./agent/mock_market_feed.json")),
        control_path=Path(os.getenv("AGENT_CONTROL_PATH", "./agent/agent_controls.json")),
        poll_seconds=float(os.getenv("AGENT_POLL_SECONDS", "5")),
        counterparty_agent_party=os.getenv("SELLER_COUNTERPARTY_AGENT", "BuyerAgent"),
        template_ids={
            "trade_intent": os.getenv("TRADE_INTENT_TEMPLATE", "AgenticShadowCap.Market:TradeIntent"),
            "discovery": os.getenv("DISCOVERY_TEMPLATE", "AgenticShadowCap.Market:DiscoveryInterest"),
            "negotiation": os.getenv("NEGOTIATION_TEMPLATE", "AgenticShadowCap.Market:PrivateNegotiation"),
        },
    )


class SellerAgent(BaseAgent):
    """
    Autonomous seller-side agent.

    Monitors TradeIntent contracts and market data to:
    - Reprice based on volatility and news sentiment
    - Post blind DiscoveryInterest signals
    - Negotiate in PrivateNegotiation channels
    """

    MIN_TICK_CHANGE = Decimal(os.getenv("MIN_TICK_CHANGE", "0.01"))
    COUNTER_OFFER_MARKUP = Decimal(os.getenv("SELLER_COUNTER_MARKUP", "1.00"))
    DISCOVERY_STRATEGY_TAG = os.getenv("SELLER_DISCOVERY_STRATEGY", "SELL_WHISPER")
    DISCOVERY_TTL_SECONDS = int(os.getenv("DISCOVERY_TTL_SECONDS", "300"))

    def __init__(self, context: AgentContext) -> None:
        super().__init__(context)
        self._original_prices: dict[str, Decimal] = {}
        self._last_reprice_time: dict[object, float] = {}
        self._negotiation_processed: set[object] = set()

    def get_loops(self) -> list:
        return [self._repricing_loop, self._negotiation_loop]

    # ── Repricing + Discovery Loop ──────────────────────────────

    async def _repricing_loop(self) -> None:
        while True:
            try:
                market_data = self.market_data()
                controls = self.agent_controls()
                seller_auto_reprice = bool(controls.get("seller_auto_reprice", True))

                tid = self.ctx.template_ids
                intents = await self.query(tid["trade_intent"])
                discoveries = await self.query(tid["discovery"])

                # Track which instruments already have active sell signals
                own_active_sell: set[str] = set()
                now_dt = utc_now()
                for discovery_cid, payload in list(discoveries.items()):
                    instrument = payload.get("instrument", "")
                    posting_agent = payload.get("postingAgent", "")
                    if (
                        parties_match(posting_agent, self.ctx.agent_party)
                        and parse_side(payload.get("side")) == "Sell"
                        and instrument
                    ):
                        if discovery_is_expired(payload, now=now_dt):
                            try:
                                await self.exercise(discovery_cid, "ExpireInterest", {})
                                self.log.info("[agent] expired stale sell DiscoveryInterest %s", discovery_cid)
                            except Exception as ex:
                                self.log.warning("[agent] failed to expire stale DiscoveryInterest %s: %s", discovery_cid, ex)
                            continue
                        own_active_sell.add(instrument)

                for cid, payload in list(intents.items()):
                    instrument = payload["instrument"]
                    current = to_decimal(payload["minPrice"])

                    # Post DiscoveryInterest if not already active for this instrument
                    if instrument not in own_active_sell:
                        discoverable_by = [p for p in [self.ctx.counterparty_agent_party] if p]
                        try:
                            created_at = iso_utc(now_dt)
                            expires_at = iso_utc(now_dt + timedelta(seconds=self.DISCOVERY_TTL_SECONDS))
                            await self.create(tid["discovery"], {
                                "issuer": payload["issuer"],
                                "owner": payload["seller"],
                                "postingAgent": self.ctx.agent_party,
                                "discoverableBy": discoverable_by,
                                "instrument": instrument,
                                "side": make_side("Sell"),
                                "strategyTag": self.DISCOVERY_STRATEGY_TAG,
                                "createdAt": created_at,
                                "expiresAt": expires_at,
                            })
                            own_active_sell.add(instrument)
                            self.log.info("[agent] posted sell DiscoveryInterest for %s", instrument)
                        except Exception as ex:
                            self.log.warning("[agent] DiscoveryInterest failed: %s", ex)

                    if instrument not in self._original_prices:
                        self._original_prices[instrument] = current

                    if not seller_auto_reprice:
                        continue

                    # Cooldown to prevent thrashing
                    now = _time.monotonic()
                    last_t = self._last_reprice_time.get(cid, 0.0)
                    if now - last_t < REPRICE_COOLDOWN_SECONDS:
                        continue

                    advice = get_pricing_advice(instrument, current, market_data, "seller")

                    if advice.action == "hold":
                        continue

                    if advice.action == "archive":
                        self.log.info("[agent] recommends archiving intent for %s: %s", instrument, advice.reasoning[:80])
                        await self.log_agent_decision(instrument, advice, market_data)
                        continue

                    # Clamp to absolute floor (60% of original price)
                    candidate = advice.recommended_price
                    absolute_floor = self._original_prices[instrument] * ABSOLUTE_FLOOR_RATIO
                    if candidate < absolute_floor:
                        self.log.warning(
                            "[agent] clamping %s price %s -> floor %s (60%% of original %s)",
                            instrument, candidate, absolute_floor, self._original_prices[instrument],
                        )
                        candidate = absolute_floor

                    delta = abs(candidate - current)
                    if delta < self.MIN_TICK_CHANGE or candidate <= Decimal("0"):
                        continue

                    self.log.info("[agent] repricing %s: %s -> %s (reason: %s)", instrument, current, candidate, advice.reasoning[:60])
                    try:
                        await self.exercise(cid, "UpdatePrice", {"newMinPrice": str(candidate)})
                        self._last_reprice_time[cid] = _time.monotonic()
                        await self.log_agent_decision(instrument, advice, market_data)
                    except Exception as ex:
                        self.log.error("[agent] repricing failed: %s", ex)
            except Exception as ex:
                self.log.warning("[agent] repricing loop iteration failed: %s", ex)

            await self.sleep()

    # ── Negotiation Loop ────────────────────────────────────────

    async def _negotiation_loop(self) -> None:
        while True:
            try:
                market_data = self.market_data()
                tid = self.ctx.template_ids
                intents = await self.query(tid["trade_intent"])
                negotiations = await self.query_by_field(tid["negotiation"], "sellerAgent", self.ctx.agent_party)

                for cid, payload in list(negotiations.items()):
                    if cid in self._negotiation_processed:
                        continue

                    proposed_qty = optional_decimal(payload.get("proposedQty"))
                    proposed_price = optional_decimal(payload.get("proposedUnitPrice"))
                    seller_accepted = bool(payload.get("sellerAccepted", False))
                    buyer_accepted = bool(payload.get("buyerAccepted", False))
                    seller_terms_revealed = bool(payload.get("sellerTermsRevealed", False))
                    seller_commit_hash = optional_text(payload.get("sellerCommitmentHash"))
                    instrument = payload.get("instrument", "")

                    intent = next((p for p in intents.values() if p.get("instrument") == instrument), None)
                    if intent is None:
                        continue

                    min_price = to_decimal(intent["minPrice"])
                    qty = to_decimal(intent["quantity"])

                    try:
                        if proposed_qty is None:
                            # Submit initial terms
                            self.log.info("[negotiation] submitting initial terms: qty=%s price=%s", qty, min_price)
                            await self.exercise(cid, "SubmitSellerTerms", {"qty": str(qty), "unitPrice": str(min_price)})
                            self._negotiation_processed.add(cid)
                            continue

                        if buyer_accepted and not seller_accepted and proposed_price is not None:
                            advice = get_negotiation_advice(instrument, proposed_price, min_price, market_data, "seller")
                            await self.log_agent_decision(instrument, advice, market_data)

                            if advice.action == "accept":
                                self.log.info("[negotiation] accepting: %s (reason: %s)", proposed_price, advice.reasoning[:60])
                                await self.exercise(cid, "AcceptBySeller", {})
                            else:
                                counter = advice.recommended_price
                                self.log.info("[negotiation] countering at %s (reason: %s)", counter, advice.reasoning[:60])
                                await self.exercise(cid, "SubmitSellerTerms", {"qty": str(qty), "unitPrice": str(counter)})
                            self._negotiation_processed.add(cid)
                            continue

                        if proposed_qty is not None and proposed_price is not None and seller_accepted and not seller_terms_revealed:
                            qty_text = decimal_to_text(proposed_qty)
                            price_text = decimal_to_text(proposed_price)
                            salt = commitment_salt(self.ctx.agent_party, instrument, qty_text, price_text)
                            expected_hash = commitment_hash(qty_text, price_text, salt)

                            if seller_commit_hash != expected_hash:
                                self.log.info("[negotiation] committing seller term hash for %s", instrument)
                                await self.exercise(cid, "CommitTerms", {
                                    "side": make_side("Sell"),
                                    "commitmentHash": expected_hash,
                                })
                            else:
                                self.log.info("[negotiation] revealing seller terms for %s", instrument)
                                await self.exercise(cid, "RevealTerms", {
                                    "side": make_side("Sell"),
                                    "qtyText": qty_text,
                                    "unitPriceText": price_text,
                                    "salt": salt,
                                })
                            self._negotiation_processed.add(cid)
                    except Exception as ex:
                        self.log.error("[negotiation] failed: %s", ex)
            except Exception as ex:
                self.log.warning("[agent] negotiation loop iteration failed: %s", ex)

            await self.sleep()


async def main() -> None:
    from network_config import require_auth_for_public_network, print_network_banner

    print_network_banner("seller-agent")
    require_auth_for_public_network("seller-agent")

    ctx = build_context()
    agent = SellerAgent(ctx)
    await agent.start()


if __name__ == "__main__":
    asyncio.run(main())
