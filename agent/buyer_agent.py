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
from decimal import Decimal
from pathlib import Path

from base_agent import BaseAgent, AgentContext
from llm_advisor import get_pricing_advice, get_negotiation_advice
from common import (
    optional_decimal,
    parse_side,
    parse_party_list,
    make_side,
    parties_match,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

ABSOLUTE_CEILING_RATIO = Decimal("1.40")


def build_context() -> AgentContext:
    return AgentContext(
        ledger_url=os.getenv("DAML_LEDGER_URL", "http://localhost:5021"),
        agent_party=os.getenv("BUYER_AGENT_PARTY", "BuyerAgent"),
        owner_party=os.getenv("BUYER_PARTY", "Buyer"),
        feed_path=Path(os.getenv("MARKET_FEED_PATH", "./agent/mock_market_feed.json")),
        control_path=Path(os.getenv("AGENT_CONTROL_PATH", "./agent/agent_controls.json")),
        poll_seconds=float(os.getenv("AGENT_POLL_SECONDS", "5")),
        counterparty_agent_party=os.getenv("BUYER_COUNTERPARTY_AGENT", "SellerAgent"),
        template_ids={
            "discovery": os.getenv("DISCOVERY_TEMPLATE", "AgenticShadowCap.Market:DiscoveryInterest"),
            "negotiation": os.getenv("NEGOTIATION_TEMPLATE", "AgenticShadowCap.Market:PrivateNegotiation"),
        },
    )


class BuyerAgent(BaseAgent):
    """
    Autonomous buyer-side agent.

    Monitors the ledger for sell-side DiscoveryInterest signals,
    posts matching buy signals, and negotiates prices within a
    configurable maxPrice ceiling.
    """

    TARGET_INSTRUMENT = os.getenv("TARGET_INSTRUMENT", "COMPANY-SERIES-A")
    MAX_PRICE = Decimal(os.getenv("BUYER_MAX_PRICE", "110.00"))
    DEFAULT_QTY = Decimal(os.getenv("BUYER_DEFAULT_QTY", "1000.00"))
    DISCOVERY_STRATEGY_TAG = os.getenv("BUYER_DISCOVERY_STRATEGY", "BUY_WHISPER")

    def __init__(self, context: AgentContext) -> None:
        super().__init__(context)
        self._negotiation_processed: set[object] = set()
        self._original_max = self.MAX_PRICE

    def get_loops(self) -> list:
        return [self._discovery_loop, self._negotiation_loop]

    # ── Discovery Loop ──────────────────────────────────────────

    async def _discovery_loop(self) -> None:
        while True:
            try:
                tid = self.ctx.template_ids
                discoveries = await self.query(tid["discovery"])

                has_sell_signal = False
                own_buy_cids: list[str] = []
                matched_sell_signal: dict | None = None

                for cid, payload in discoveries.items():
                    side = parse_side(payload.get("side"))
                    instrument = payload.get("instrument", "")
                    posting_agent = payload.get("postingAgent", "")
                    discoverable_by = parse_party_list(payload.get("discoverableBy"))

                    if (
                        side == "Buy"
                        and instrument == self.TARGET_INSTRUMENT
                        and parties_match(posting_agent, self.ctx.agent_party)
                    ):
                        own_buy_cids.append(str(cid))

                    if (
                        side == "Sell"
                        and instrument == self.TARGET_INSTRUMENT
                        and not parties_match(posting_agent, self.ctx.agent_party)
                        and (
                            not discoverable_by
                            or any(parties_match(self.ctx.agent_party, p) for p in discoverable_by)
                        )
                    ):
                        has_sell_signal = True
                        matched_sell_signal = payload

                # Keep at most one active buy-side whisper per instrument.
                if len(own_buy_cids) > 1:
                    for stale_cid in sorted(own_buy_cids)[1:]:
                        try:
                            await self.exercise(stale_cid, "CancelInterest", {})
                            self.log.info("[agent] canceled duplicate buy DiscoveryInterest %s", stale_cid)
                        except Exception as ex:
                            self.log.warning("[agent] failed to cancel duplicate DiscoveryInterest %s: %s", stale_cid, ex)
                    own_buy_cids = sorted(own_buy_cids)[:1]

                if has_sell_signal and not own_buy_cids:
                    issuer = (matched_sell_signal or {}).get("issuer", "")
                    counterparty_agent = (matched_sell_signal or {}).get("postingAgent", "") or self.ctx.counterparty_agent_party
                    discoverable_by = [p for p in [counterparty_agent] if p]
                    if issuer:
                        try:
                            await self.create(tid["discovery"], {
                                "issuer": issuer,
                                "owner": self.ctx.owner_party,
                                "postingAgent": self.ctx.agent_party,
                                "discoverableBy": discoverable_by,
                                "instrument": self.TARGET_INSTRUMENT,
                                "side": make_side("Buy"),
                                "strategyTag": self.DISCOVERY_STRATEGY_TAG,
                            })
                            self.log.info("[agent] posted buy DiscoveryInterest for %s", self.TARGET_INSTRUMENT)
                        except Exception as ex:
                            self.log.warning("[agent] DiscoveryInterest failed: %s", ex)
            except Exception as ex:
                self.log.warning("[agent] discovery loop iteration failed: %s", ex)

            await self.sleep()

    # ── Negotiation Loop ────────────────────────────────────────

    async def _negotiation_loop(self) -> None:
        while True:
            try:
                market_data = self.market_data()
                controls = self.agent_controls()
                buyer_auto_reprice = bool(controls.get("buyer_auto_reprice", True))
                tid = self.ctx.template_ids
                negotiations = await self.query_by_field(tid["negotiation"], "buyerAgent", self.ctx.agent_party)

                # Dynamically adjust max price based on market conditions
                if buyer_auto_reprice:
                    advice = get_pricing_advice(self.TARGET_INSTRUMENT, self.MAX_PRICE, market_data, "buyer")
                    adjusted_max = advice.recommended_price
                else:
                    adjusted_max = self.MAX_PRICE

                absolute_ceiling = self._original_max * ABSOLUTE_CEILING_RATIO
                if adjusted_max > absolute_ceiling:
                    self.log.warning(
                        "[agent] clamping adjusted max %s -> ceiling %s (140%% of original %s)",
                        adjusted_max, absolute_ceiling, self._original_max,
                    )
                    adjusted_max = absolute_ceiling

                for cid, payload in list(negotiations.items()):
                    if cid in self._negotiation_processed:
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
                        await self.log_agent_decision(instrument, neg_advice, market_data)

                        if neg_advice.action == "accept":
                            self.log.info("[negotiation] accepting at %s (reason: %s)", proposed_price, neg_advice.reasoning[:60])
                            await self.exercise(cid, "AcceptByBuyer", {})
                        else:
                            self.log.info("[negotiation] countering at %s (reason: %s)", adjusted_max, neg_advice.reasoning[:60])
                            await self.exercise(cid, "SubmitBuyerTerms", {
                                "qty": str(proposed_qty),
                                "unitPrice": str(adjusted_max),
                            })
                        self._negotiation_processed.add(cid)
                    except Exception as ex:
                        self.log.error("[negotiation] failed: %s", ex)
            except Exception as ex:
                self.log.warning("[agent] negotiation loop iteration failed: %s", ex)

            await self.sleep()


async def main() -> None:
    from network_config import require_auth_for_public_network, print_network_banner

    print_network_banner("buyer-agent")
    require_auth_for_public_network("buyer-agent")

    ctx = build_context()
    agent = BuyerAgent(ctx)
    await agent.start()


if __name__ == "__main__":
    asyncio.run(main())
