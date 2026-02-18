#!/usr/bin/env python3
"""
Base agent class for Agentic Shadow-Cap.

Provides a reusable framework for connecting to a Canton Participant node
via dazl and running event-driven loops. Concrete agents (seller, buyer)
extend this class and implement their specific decision logic.
"""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import dazl

from common import (
    load_market_data,
    load_agent_controls,
    log_decision,
    query_active,
    query_filtered,
    retry_create,
    retry_exercise,
)
from llm_advisor import LLMAdvice


@dataclass
class AgentContext:
    """Shared configuration for all agents."""

    ledger_url: str
    agent_party: str
    owner_party: str
    feed_path: Path
    control_path: Path
    poll_seconds: float
    counterparty_agent_party: str
    template_ids: dict[str, str] = field(default_factory=dict)

    @staticmethod
    def _env(key: str, default: str) -> str:
        return os.getenv(key, default)


class BaseAgent(ABC):
    """
    Abstract base class for Canton dark-pool agents.

    Connects to a Canton Participant node via dazl, runs one or more
    concurrent async loops, and provides shared utilities for ledger
    interactions (query, create, exercise, decision logging).
    """

    def __init__(self, context: AgentContext) -> None:
        self.ctx = context
        self.log = logging.getLogger(self.__class__.__name__)
        self._conn: Any = None

    # ── Lifecycle ───────────────────────────────────────────────

    async def start(self) -> None:
        """Connect to the ledger and launch all agent loops."""
        self.log.info(
            "[boot] agent=%s ledger=%s owner=%s",
            self.ctx.agent_party,
            self.ctx.ledger_url,
            self.ctx.owner_party,
        )
        async with dazl.connect(
            url=self.ctx.ledger_url,
            act_as=[self.ctx.agent_party],
            read_as=[self.ctx.agent_party],
        ) as conn:
            self._conn = conn
            self.log.info("[boot] connected, starting loops")
            loops = self.get_loops()
            await asyncio.gather(*[loop() for loop in loops])

    @abstractmethod
    def get_loops(self) -> list:
        """Return a list of async callables (coroutine functions) to run concurrently."""
        ...

    # ── Market data helpers ─────────────────────────────────────

    def market_data(self) -> dict[str, Any]:
        """Load current market feed from disk."""
        return load_market_data(self.ctx.feed_path)

    def agent_controls(self) -> dict[str, Any]:
        """Load current agent control flags."""
        return load_agent_controls(self.ctx.control_path)

    # ── Ledger interaction wrappers ─────────────────────────────

    async def query(self, template_id: str) -> dict[Any, dict[str, Any]]:
        """Query all active contracts of a template visible to this agent."""
        return await query_active(self._conn, template_id)

    async def query_by_field(
        self, template_id: str, field: str, value: str
    ) -> dict[Any, dict[str, Any]]:
        """Query active contracts filtered by a specific field value."""
        return await query_filtered(self._conn, template_id, field, value)

    async def create(self, template_id: str, payload: dict) -> Any:
        """Create a contract on the ledger with retry."""
        return await retry_create(self._conn, template_id, payload)

    async def exercise(self, cid: Any, choice: str, args: dict) -> Any:
        """Exercise a choice on a contract with retry."""
        return await retry_exercise(self._conn, cid, choice, args)

    async def log_agent_decision(
        self,
        instrument: str,
        advice: LLMAdvice,
        market_data: dict,
    ) -> None:
        """Write an AgentDecisionLog entry to the ledger."""
        await log_decision(
            self._conn,
            self.ctx.agent_party,
            self.ctx.owner_party,
            instrument,
            advice,
            market_data,
        )

    # ── Sleep helper ────────────────────────────────────────────

    async def sleep(self) -> None:
        """Sleep for the configured poll interval."""
        await asyncio.sleep(self.ctx.poll_seconds)
