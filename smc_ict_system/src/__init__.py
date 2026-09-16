"""smc_ict_system.src — SMC/ICT signal engine.

Instrument-agnostic: the symbol, contract size and tick value all come
from config.yaml, so the same engine runs XAUUSD (the default profile)
or EURUSD (config.eurusd.yaml) without code changes.

Package layout:
    utils         config, logging, time/session maths, ATR, hashing
    data_loader   Yahoo fetch, 4h aggregation, Postgres read/write
    smc_core      pivots, BOS/CHoCH/MSS, order blocks, FVGs, sweeps
    sessions      session/killzone levels and ranges
    signal_engine confluence scoring and conviction
    risk_manager  position sizing, stops, targets, daily limits
    backtester    walk-forward and Monte Carlo evaluation
    delivery      console/file/Telegram/email/webhook output

Shares the gold-trader Postgres schema and .env credentials with the
Node API and the Python collectors.
"""

from __future__ import annotations

__all__ = [
    "utils",
    "data_loader",
    "smc_core",
    "sessions",
    "signal_engine",
    "risk_manager",
    "backtester",
    "delivery",
]

__version__ = "1.0.0"
