"""
Tiny FastAPI sidecar for injecting market events and checking agent health.

Run alongside each agent:
    uvicorn agent.market_api:app --host 0.0.0.0 --port 8090
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

FEED_PATH = Path(os.getenv("MARKET_FEED_PATH", "./agent/mock_market_feed.json"))
CONTROL_PATH = Path(os.getenv("AGENT_CONTROL_PATH", "./agent/agent_controls.json"))

app = FastAPI(title="Shadow-Cap Market Event API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

EVENT_VOLATILITY_MAP = {
    "positive_earnings": {"market_volatility": 0.12, "news_sentiment": "positive"},
    "sec_investigation": {"market_volatility": 0.55, "news_sentiment": "negative"},
    "market_crash": {"market_volatility": 0.72, "news_sentiment": "very_negative"},
    "acquisition_rumor": {"market_volatility": 0.38, "news_sentiment": "speculative"},
    "stable_market": {"market_volatility": 0.15, "news_sentiment": "neutral"},
}

last_decision: dict = {}
DEFAULT_AGENT_CONFIG = {
    "seller_auto_reprice": True,
    "buyer_auto_reprice": True,
}


class MarketEvent(BaseModel):
    event_type: str
    severity: float = 1.0


class StatusResponse(BaseModel):
    healthy: bool
    feed_path: str
    control_path: str
    agent_config: dict
    last_decision: dict
    current_feed: dict


class AgentConfigUpdate(BaseModel):
    role: Literal["seller", "buyer"]
    auto_reprice: bool


def read_agent_config() -> dict:
    if not CONTROL_PATH.exists():
        return dict(DEFAULT_AGENT_CONFIG)
    try:
        payload = json.loads(CONTROL_PATH.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return dict(DEFAULT_AGENT_CONFIG)
        return {
            "seller_auto_reprice": bool(payload.get("seller_auto_reprice", True)),
            "buyer_auto_reprice": bool(payload.get("buyer_auto_reprice", True)),
        }
    except Exception:
        return dict(DEFAULT_AGENT_CONFIG)


def write_agent_config(config: dict) -> None:
    CONTROL_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONTROL_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")


@app.post("/market-event")
def inject_market_event(event: MarketEvent):
    base = EVENT_VOLATILITY_MAP.get(event.event_type, {"market_volatility": 0.25, "news_sentiment": "unknown"})
    vol = round(base["market_volatility"] * event.severity, 4)
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "market_volatility": vol,
        "news_sentiment": base["news_sentiment"],
        "event_type": event.event_type,
        "source": "injected-event",
    }
    FEED_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {"status": "ok", "applied": payload}


@app.get("/status", response_model=StatusResponse)
def get_status():
    current = {}
    config = read_agent_config()
    if FEED_PATH.exists():
        try:
            current = json.loads(FEED_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return StatusResponse(
        healthy=True,
        feed_path=str(FEED_PATH),
        control_path=str(CONTROL_PATH),
        agent_config=config,
        last_decision=last_decision,
        current_feed=current,
    )


@app.get("/events")
def list_events():
    return {"events": list(EVENT_VOLATILITY_MAP.keys())}


@app.get("/agent-config")
def get_agent_config():
    return read_agent_config()


@app.post("/agent-config")
def set_agent_config(update: AgentConfigUpdate):
    current = read_agent_config()
    current[f"{update.role}_auto_reprice"] = update.auto_reprice
    write_agent_config(current)
    return {"status": "ok", "config": current}


def update_last_decision(data: dict):
    last_decision.clear()
    last_decision.update(data)
