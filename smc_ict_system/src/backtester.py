"""smc_ict_system/src/backtester.py — replay, walk-forward, Monte Carlo.

The backtester is deliberately the *only* module that owns a clock. Every
other module is a pure function of candles plus config, which is what lets
this file replay history bar by bar and get the same zones a live scan
would have produced at that moment.

The replay loop is event-driven and strictly causal:

    for each bar t:
        zones visible at t  = detect_zones(frame[:t])   # no lookahead
        open trades         = advance one bar, check stop / target
        new entries         = zones that formed on bar t-1 and are still live

Two rules keep the results honest:

1.  **No lookahead.** A zone is only tradeable from the bar *after* the
    bar that formed it. ``formed_at`` is the timestamp of the origin
    candle, so the earliest possible entry is ``formed_at + 1 bar``.
2.  **Pessimistic fills.** When a bar's range covers both the stop and the
    target, the stop is assumed to have been hit first. Optimistic
    tie-breaking is the single most common way a backtest lies.

Costs are charged on every fill: spread on entry, slippage on both sides,
commission per lot round-turn.

The replay loop is the *only* place a clock is read, and it reads it once
per bar. Everything time-dependent — the killzone gate, the trading-day
roll, the daily loss counter — is derived from that single ``moment``, so
a replay cannot disagree with itself about what time it is.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

from . import smc_core as core
from .sessions import SessionFilter
from .smc_core import (
    BEARISH,
    BULLISH,
    FVG,
    LIQUIDITY_POOL,
    ORDER_BLOCK,
    STOP_HUNT,
    Zone,
)
from .utils import (
    cfg_get,
    clamp,
    ensure_frame,
    json_safe,
    load_config,
    round_to_step,
    safe_div,
    setup_logging,
    to_utc,
    trading_day,
)

log = setup_logging("backtester")

# ------------------------------------------------------------------
# CONSTANTS
# ------------------------------------------------------------------

LONG = "LONG"
SHORT = "SHORT"

# Exit reasons, in the order they are checked within a bar.
EXIT_STOP = "STOP"
EXIT_TARGET = "TARGET"
EXIT_TRAIL = "TRAIL"
EXIT_TIME = "TIME"
EXIT_EOD = "EOD"
EXIT_OPEN = "OPEN"

# Concepts that can actually be traded. Pivots and liquidity pools are
# context, not entries — you do not buy a swing high.
TRADEABLE_CONCEPTS: tuple[str, ...] = (
    ORDER_BLOCK,
    FVG,
    STOP_HUNT,
    LIQUIDITY_POOL,
)

# Why a setup was refused, reported on the result so a run can be read as
# a funnel rather than a bare trade count.
SKIP_KILLZONE = "outside_killzone"
SKIP_DAY_HALTED = "day_halted"
SKIP_MAX_TRADES = "max_trades"
SKIP_NO_MTF = "no_mtf_confirmation"
SKIP_GEOMETRY = "invalid_geometry"
SKIP_POSITION_LIMIT = "position_limit"
SKIP_SIZING = "sizing_rejected"
SKIP_DUPLICATE = "duplicate_setup"
SKIP_DAILY_LOSS = "daily_loss_limit"


@dataclass(frozen=True)
class BacktestParams:
    """Resolved backtest tuning, read once per run from config."""

    initial_equity: float = 10_000.0
    commission_per_lot: float = 7.0
    slippage_points: float = 0.20
    spread_points: float = 0.30
    max_bars_in_trade: int = 200
    walk_forward_splits: int = 4
    monte_carlo_runs: int = 1000
    monte_carlo_confidence: float = 0.95

    # Risk knobs are read here too so a replay never has to reach into
    # risk_manager (which owns live sizing) just to size a historical trade.
    risk_per_trade_pct: float = 0.5
    max_daily_loss_pct: float = 2.0
    min_stop_points: float = 1.5
    stop_buffer_atr: float = 0.25
    target_r_multiples: tuple[float, ...] = (1.0, 2.0, 3.0)
    partial_close_pct: tuple[float, ...] = (0.4, 0.3, 0.3)
    breakeven_at_r: float = 1.0
    trail_after_r: float = 1.5
    trail_atr_multiple: float = 1.5
    min_rr: float = 2.0
    max_open_positions: int = 3
    max_positions_per_direction: int = 2

    # Killzone gate. ``require_killzone`` mirrors the live engine's
    # ``signal_engine.require_killzone``: when it is on, a setup that forms
    # outside every configured window is refused rather than traded. The
    # default is False so a replay of a frame with no session context still
    # produces trades, and the CLI turns it on explicitly.
    require_killzone: bool = False

    # Instrument contract, needed to convert points into money.
    contract_size: float = 100.0
    point_value: float = 1.0
    min_lot: float = 0.01
    lot_step: float = 0.01
    max_lot: float = 100.0

    @classmethod
    def from_config(cls, config: Mapping[str, Any] | None = None) -> "BacktestParams":
        config = config or load_config()
        targets = cfg_get(config, "risk.target_r_multiples", [1.0, 2.0, 3.0])
        partials = cfg_get(config, "risk.partial_close_pct", [0.4, 0.3, 0.3])
        return cls(
            initial_equity=float(cfg_get(config, "backtest.initial_equity", 10_000.0)),
            commission_per_lot=float(
                cfg_get(config, "backtest.commission_per_lot", 7.0)
            ),
            slippage_points=float(cfg_get(config, "backtest.slippage_points", 0.20)),
            spread_points=float(cfg_get(config, "backtest.spread_points", 0.30)),
            max_bars_in_trade=int(cfg_get(config, "backtest.max_bars_in_trade", 200)),
            walk_forward_splits=int(cfg_get(config, "backtest.walk_forward_splits", 4)),
            monte_carlo_runs=int(cfg_get(config, "backtest.monte_carlo_runs", 1000)),
            monte_carlo_confidence=float(
                cfg_get(config, "backtest.monte_carlo_confidence", 0.95)
            ),
            risk_per_trade_pct=float(cfg_get(config, "risk.risk_per_trade_pct", 0.5)),
            max_daily_loss_pct=float(cfg_get(config, "risk.max_daily_loss_pct", 2.0)),
            min_stop_points=float(cfg_get(config, "risk.min_stop_points", 1.5)),
            stop_buffer_atr=float(cfg_get(config, "risk.stop_buffer_atr", 0.25)),
            target_r_multiples=tuple(float(value) for value in targets),
            partial_close_pct=tuple(float(value) for value in partials),
            breakeven_at_r=float(cfg_get(config, "risk.breakeven_at_r", 1.0)),
            trail_after_r=float(cfg_get(config, "risk.trail_after_r", 1.5)),
            trail_atr_multiple=float(cfg_get(config, "risk.trail_atr_multiple", 1.5)),
            min_rr=float(cfg_get(config, "detectors.min_rr", 2.0)),
            max_open_positions=int(cfg_get(config, "risk.max_open_positions", 3)),
            max_positions_per_direction=int(
                cfg_get(config, "risk.max_positions_per_direction", 2)
            ),
            require_killzone=bool(
                cfg_get(config, "signal_engine.require_killzone", False)
            ),
            contract_size=float(cfg_get(config, "instrument.contract_size", 100.0)),
            point_value=float(cfg_get(config, "instrument.point_value", 1.0)),
            min_lot=float(cfg_get(config, "instrument.min_lot", 0.01)),
            lot_step=float(cfg_get(config, "instrument.lot_step", 0.01)),
            max_lot=float(cfg_get(config, "instrument.max_lot", 100.0)),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "initial_equity": self.initial_equity,
            "commission_per_lot": self.commission_per_lot,
            "slippage_points": self.slippage_points,
            "spread_points": self.spread_points,
            "max_bars_in_trade": self.max_bars_in_trade,
            "risk_per_trade_pct": self.risk_per_trade_pct,
            "min_stop_points": self.min_stop_points,
            "stop_buffer_atr": self.stop_buffer_atr,
            "target_r_multiples": list(self.target_r_multiples),
            "min_rr": self.min_rr,
            "require_killzone": self.require_killzone,
        }


# ------------------------------------------------------------------
# TRADE MODEL
# ------------------------------------------------------------------


@dataclass
class Trade:
    """One simulated position, from entry to flat.

    ``r_multiple`` is the only performance number that matters: it is
    normalised by the risk actually taken, so a 0.01-lot scalp and a
    1-lot swing are comparable.
    """

    trade_id: int
    symbol: str
    timeframe: str
    direction: str
    concept: str
    sub_concept: str | None
    entry_time: datetime
    entry_price: float
    stop_price: float
    target_price: float
    initial_stop: float
    initial_risk: float
    lots: float
    atr_at_entry: float
    confluence: tuple[str, ...] = ()
    mtf_confirmed: bool = False
    conviction: float = 0.0

    # Killzone label the entry landed in, from ``SessionFilter``. ``None``
    # when the entry was outside every configured window — which is only
    # reachable when ``require_killzone`` is off, since the gate refuses
    # those setups otherwise. Carried on the trade so the report can group
    # performance by window without re-deriving the clock from entry_time.
    killzone: str | None = None

    exit_time: datetime | None = None
    exit_price: float | None = None
    exit_reason: str | None = None
    bars_held: int = 0
    mfe: float = 0.0
    mae: float = 0.0
    gross_pnl: float = 0.0
    costs: float = 0.0
    net_pnl: float = 0.0
    r_multiple: float = 0.0
    partials_taken: int = 0
    remaining_fraction: float = 1.0
    breakeven_moved: bool = False
    trailing_active: bool = False
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def is_open(self) -> bool:
        return self.exit_time is None

    @property
    def is_long(self) -> bool:
        return self.direction == LONG

    def to_dict(self) -> dict[str, Any]:
        return {
            "trade_id": self.trade_id,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "direction": self.direction,
            "concept": self.concept,
            "sub_concept": self.sub_concept,
            "entry_time": self.entry_time.isoformat(),
            "entry_price": round(self.entry_price, 3),
            "stop_price": round(self.stop_price, 3),
            "target_price": round(self.target_price, 3),
            "exit_time": self.exit_time.isoformat() if self.exit_time else None,
            "exit_price": round(self.exit_price, 3) if self.exit_price else None,
            "exit_reason": self.exit_reason,
            "lots": self.lots,
            "bars_held": self.bars_held,
            "mfe": round(self.mfe, 3),
            "mae": round(self.mae, 3),
            "gross_pnl": round(self.gross_pnl, 2),
            "costs": round(self.costs, 2),
            "net_pnl": round(self.net_pnl, 2),
            "r_multiple": round(self.r_multiple, 4),
            "confluence": list(self.confluence),
            "mtf_confirmed": self.mtf_confirmed,
            "conviction": round(self.conviction, 4),
            "killzone": self.killzone,
        }


@dataclass
class Setup:
    """A tradeable idea derived from a zone, before sizing."""

    zone: Zone
    timeframe: str
    direction: str
    entry_price: float
    stop_price: float
    target_price: float
    risk: float
    reward: float
    risk_reward: float
    atr_at_entry: float
    conviction: float = 0.0

    @property
    def is_valid(self) -> bool:
        return self.risk > 0 and self.reward > 0 and self.risk_reward > 0


def build_setup(
    zone: Zone,
    timeframe: str,
    params: BacktestParams,
    atr_value: float | None = None,
    conviction: float = 0.0,
) -> Setup | None:
    """Turn a zone into an entry / stop / target triple.

    Entry is the proximal edge — the price you would actually get filled
    at when price returns to the zone. The stop sits ``stop_buffer_atr``
    beyond the distal edge, which is the level that invalidates the idea.
    The target is the furthest configured R multiple, so ``risk_reward``
    is the best case the trade is being asked to deliver.

    Returns None when the geometry cannot produce a sane trade: a
    zero-height zone, a stop inside the spread, or a target that does not
    clear ``min_rr``.
    """
    if zone.concept not in TRADEABLE_CONCEPTS:
        return None
    if not zone.is_zone:
        return None

    atr_value = atr_value or zone.atr_at_formation or 0.0
    buffer = atr_value * params.stop_buffer_atr if atr_value else 0.0

    if zone.is_bullish:
        direction = LONG
        entry = zone.price_high
        stop = zone.price_low - buffer
    elif zone.is_bearish:
        direction = SHORT
        entry = zone.price_low
        stop = zone.price_high + buffer
    else:
        return None

    risk = abs(entry - stop)
    if risk < params.min_stop_points:
        return None

    furthest = max(params.target_r_multiples) if params.target_r_multiples else 2.0
    reward = risk * furthest
    target = entry + reward if direction == LONG else entry - reward

    risk_reward = safe_div(reward, risk, 0.0)
    if risk_reward < params.min_rr:
        return None

    return Setup(
        zone=zone,
        timeframe=timeframe,
        direction=direction,
        entry_price=entry,
        stop_price=stop,
        target_price=target,
        risk=risk,
        reward=reward,
        risk_reward=risk_reward,
        atr_at_entry=atr_value,
        conviction=conviction,
    )


def size_position(
    setup: Setup,
    equity: float,
    params: BacktestParams,
) -> float:
    """Lots such that a stop-out costs exactly ``risk_per_trade_pct``.

    Floors to the broker's lot step rather than rounding, because rounding
    up would quietly exceed the risk budget on every single trade.
    """
    risk_money = equity * (params.risk_per_trade_pct / 100.0)
    if risk_money <= 0 or setup.risk <= 0:
        return 0.0

    # Money lost per lot if the stop is hit.
    loss_per_lot = setup.risk * params.contract_size * params.point_value
    if loss_per_lot <= 0:
        return 0.0

    raw_lots = risk_money / loss_per_lot
    lots = round_to_step(raw_lots, params.lot_step)
    lots = clamp(lots, 0.0, params.max_lot)
    if lots < params.min_lot:
        return 0.0
    return round(lots, 4)


# ------------------------------------------------------------------
# FILLS AND COSTS
# ------------------------------------------------------------------


def entry_fill(price: float, direction: str, params: BacktestParams) -> float:
    """Entry price after spread and slippage, always against the trader."""
    adverse = params.spread_points + params.slippage_points
    return price + adverse if direction == LONG else price - adverse


def exit_fill(price: float, direction: str, params: BacktestParams) -> float:
    """Exit price after slippage, always against the trader."""
    if direction == LONG:
        return price - params.slippage_points
    return price + params.slippage_points


def trade_costs(lots: float, params: BacktestParams) -> float:
    """Round-turn commission for a position of ``lots``."""
    return lots * params.commission_per_lot


def money_for_points(points: float, lots: float, params: BacktestParams) -> float:
    """Convert a price move into account currency."""
    return points * lots * params.contract_size * params.point_value


def _close_fraction(
    trade: Trade,
    fraction: float,
    price: float,
    moment: datetime,
    reason: str,
    params: BacktestParams,
) -> None:
    """Book ``fraction`` of the position at ``price`` and update the books."""
    fraction = clamp(fraction, 0.0, trade.remaining_fraction)
    if fraction <= 0:
        return

    lots = trade.lots * fraction
    points = (price - trade.entry_price) if trade.is_long else (trade.entry_price - price)
    gross = money_for_points(points, lots, params)
    cost = trade_costs(lots, params)

    trade.gross_pnl += gross
    trade.costs += cost
    trade.remaining_fraction = round(trade.remaining_fraction - fraction, 6)

    if trade.remaining_fraction <= 1e-6:
        trade.remaining_fraction = 0.0
        trade.exit_time = moment
        trade.exit_price = price
        trade.exit_reason = reason


def _finalise(trade: Trade, params: BacktestParams) -> Trade:
    """Compute net PnL and the R multiple once the position is flat."""
    trade.net_pnl = trade.gross_pnl - trade.costs
    risk_money = money_for_points(trade.initial_risk, trade.lots, params)
    trade.r_multiple = safe_div(trade.net_pnl, risk_money, 0.0)
    return trade


def advance_trade(
    trade: Trade,
    bar: pd.Series,
    moment: datetime,
    params: BacktestParams,
) -> Trade:
    """Walk one bar forward for an open trade.

    Order of checks inside the bar matters and is deliberately pessimistic:

    1.  Stop first. If the bar's range covers both the stop and the next
        target, the stop is assumed to have been hit — the intrabar path is
        unknowable, and assuming the good outcome is how backtests flatter
        themselves.
    2.  Partial targets, in ascending R order, each booked once.
    3.  Breakeven move once ``breakeven_at_r`` is reached.
    4.  ATR trail once ``trail_after_r`` is reached.
    5.  Time stop at ``max_bars_in_trade``.
    """
    if not trade.is_open:
        return trade

    high = float(bar["high"])
    low = float(bar["low"])
    close = float(bar["close"])
    trade.bars_held += 1

    # Excursions, measured in price points from entry.
    if trade.is_long:
        trade.mfe = max(trade.mfe, high - trade.entry_price)
        trade.mae = min(trade.mae, low - trade.entry_price)
    else:
        trade.mfe = max(trade.mfe, trade.entry_price - low)
        trade.mae = min(trade.mae, trade.entry_price - high)

    # ---- 1. stop ---------------------------------------------------
    stop_hit = low <= trade.stop_price if trade.is_long else high >= trade.stop_price
    if stop_hit:
        _close_fraction(
            trade,
            trade.remaining_fraction,
            exit_fill(trade.stop_price, trade.direction, params),
            moment,
            EXIT_STOP,
            params,
        )
        return _finalise(trade, params)

    # ---- 2. partial targets ----------------------------------------
    for index, multiple in enumerate(params.target_r_multiples):
        if index >= len(params.partial_close_pct):
            break
        if trade.partials_taken > index:
            continue

        level = (
            trade.entry_price + trade.initial_risk * multiple
            if trade.is_long
            else trade.entry_price - trade.initial_risk * multiple
        )
        reached = high >= level if trade.is_long else low <= level
        if not reached:
            continue

        is_last = index == len(params.target_r_multiples) - 1
        fraction = (
            trade.remaining_fraction if is_last else params.partial_close_pct[index]
        )

        _close_fraction(
            trade,
            fraction,
            exit_fill(level, trade.direction, params),
            moment,
            EXIT_TARGET,
            params,
        )
        trade.partials_taken = index + 1
        if not trade.is_open:
            return _finalise(trade, params)

    # ---- 3. breakeven ----------------------------------------------
    if not trade.breakeven_moved and params.breakeven_at_r > 0:
        trigger = (
            trade.entry_price + trade.initial_risk * params.breakeven_at_r
            if trade.is_long
            else trade.entry_price - trade.initial_risk * params.breakeven_at_r
        )
        if (high >= trigger) if trade.is_long else (low <= trigger):
            trade.stop_price = trade.entry_price
            trade.breakeven_moved = True

    # ---- 4. ATR trail ----------------------------------------------
    if params.trail_after_r > 0 and trade.atr_at_entry > 0:
        trigger = (
            trade.entry_price + trade.initial_risk * params.trail_after_r
            if trade.is_long
            else trade.entry_price - trade.initial_risk * params.trail_after_r
        )
        if (high >= trigger) if trade.is_long else (low <= trigger):
            trade.trailing_active = True

        if trade.trailing_active:
            distance = trade.atr_at_entry * params.trail_atr_multiple
            candidate = close - distance if trade.is_long else close + distance
            # The trail ratchets the stop toward the entry but never through
            # it: a long's stop stays at or below the fill and a short's at or
            # above, so the position can never be flipped by its own trailing
            # logic. Breakeven is the tightest the trail may go.
            if trade.is_long:
                candidate = min(candidate, trade.entry_price)
                trade.stop_price = max(trade.stop_price, candidate)
            else:
                candidate = max(candidate, trade.entry_price)
                trade.stop_price = min(trade.stop_price, candidate)

    # ---- 5. time stop ----------------------------------------------
    if params.max_bars_in_trade > 0 and trade.bars_held >= params.max_bars_in_trade:
        _close_fraction(
            trade,
            trade.remaining_fraction,
            exit_fill(close, trade.direction, params),
            moment,
            EXIT_TIME,
            params,
        )
        return _finalise(trade, params)

    return trade


# ------------------------------------------------------------------
# RESULT
# ------------------------------------------------------------------


@dataclass
class BacktestResult:
    """Everything one replay produced, plus the derived statistics."""

    symbol: str
    timeframe: str
    start: datetime | None
    end: datetime | None
    bars: int
    initial_equity: float
    final_equity: float
    trades: list[Trade] = field(default_factory=list)
    equity_curve: pd.Series | None = None
    skipped: dict[str, int] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)

    # ---- derived ----------------------------------------------------

    @property
    def closed(self) -> list[Trade]:
        return [trade for trade in self.trades if not trade.is_open]

    @property
    def open_trades(self) -> list[Trade]:
        return [trade for trade in self.trades if trade.is_open]

    @property
    def wins(self) -> list[Trade]:
        return [trade for trade in self.closed if trade.net_pnl > 0]

    @property
    def losses(self) -> list[Trade]:
        return [trade for trade in self.closed if trade.net_pnl < 0]

    @property
    def net_pnl(self) -> float:
        return self.final_equity - self.initial_equity

    @property
    def return_pct(self) -> float:
        return safe_div(self.net_pnl, self.initial_equity, 0.0) * 100.0

    @property
    def win_rate(self) -> float:
        closed = self.closed
        if not closed:
            return 0.0
        return len(self.wins) / len(closed)

    @property
    def profit_factor(self) -> float:
        gross_win = sum(trade.net_pnl for trade in self.wins)
        gross_loss = abs(sum(trade.net_pnl for trade in self.losses))
        if gross_loss == 0:
            return float("inf") if gross_win > 0 else 0.0
        return gross_win / gross_loss

    @property
    def expectancy_r(self) -> float:
        closed = self.closed
        if not closed:
            return 0.0
        return sum(trade.r_multiple for trade in closed) / len(closed)

    @property
    def average_win(self) -> float:
        return safe_div(sum(t.net_pnl for t in self.wins), len(self.wins), 0.0)

    @property
    def average_loss(self) -> float:
        return safe_div(sum(t.net_pnl for t in self.losses), len(self.losses), 0.0)

    @property
    def max_drawdown(self) -> float:
        """Peak-to-trough on the equity curve, in account currency."""
        curve = self.equity_curve
        if curve is None or curve.empty:
            return 0.0
        peak = curve.cummax()
        return float((peak - curve).max())

    @property
    def max_drawdown_pct(self) -> float:
        return safe_div(self.max_drawdown, self.initial_equity, 0.0) * 100.0

    @property
    def sharpe(self) -> float:
        """Per-trade Sharpe, annualisation left to the caller.

        Computed on R multiples rather than currency so the number does not
        move when position sizing changes.
        """
        closed = self.closed
        if len(closed) < 2:
            return 0.0
        values = np.array([trade.r_multiple for trade in closed], dtype=float)
        std = float(values.std(ddof=1))
        if std == 0 or not math.isfinite(std):
            return 0.0
        return float(values.mean() / std) * math.sqrt(len(values))

    @property
    def sortino(self) -> float:
        """Downside-deviation Sharpe. Punishes losers, ignores upside vol."""
        closed = self.closed
        if len(closed) < 2:
            return 0.0
        values = np.array([trade.r_multiple for trade in closed], dtype=float)
        downside = values[values < 0]
        if downside.size == 0:
            return float("inf") if values.mean() > 0 else 0.0
        deviation = float(np.sqrt((downside**2).mean()))
        if deviation == 0:
            return 0.0
        return float(values.mean() / deviation) * math.sqrt(len(values))

    @property
    def average_bars_held(self) -> float:
        closed = self.closed
        if not closed:
            return 0.0
        return sum(trade.bars_held for trade in closed) / len(closed)

    def exit_breakdown(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for trade in self.closed:
            key = trade.exit_reason or "UNKNOWN"
            counts[key] = counts.get(key, 0) + 1
        return counts

    def concept_breakdown(self) -> dict[str, dict[str, float]]:
        """Per-concept win rate and expectancy — which detector pays."""
        grouped: dict[str, list[Trade]] = {}
        for trade in self.closed:
            grouped.setdefault(trade.concept, []).append(trade)

        report: dict[str, dict[str, float]] = {}
        for concept, trades in grouped.items():
            wins = [t for t in trades if t.net_pnl > 0]
            report[concept] = {
                "trades": len(trades),
                "win_rate": round(len(wins) / len(trades), 4),
                "expectancy_r": round(
                    sum(t.r_multiple for t in trades) / len(trades), 4
                ),
                "net_pnl": round(sum(t.net_pnl for t in trades), 2),
            }
        return report

    def killzone_breakdown(self) -> dict[str, dict[str, float]]:
        """Per-killzone win rate and expectancy — which window pays.

        Trades entered outside every window are grouped under ``"outside"``
        rather than dropped, because a run with ``require_killzone`` off
        would otherwise report a breakdown that does not sum to the trade
        count. The label is the config key (``"london_open"``), not the
        uppercased display form.
        """
        grouped: dict[str, list[Trade]] = {}
        for trade in self.closed:
            grouped.setdefault(trade.killzone or "outside", []).append(trade)

        report: dict[str, dict[str, float]] = {}
        for label, trades in grouped.items():
            wins = [t for t in trades if t.net_pnl > 0]
            report[label] = {
                "trades": len(trades),
                "win_rate": round(len(wins) / len(trades), 4),
                "expectancy_r": round(
                    sum(t.r_multiple for t in trades) / len(trades), 4
                ),
                "net_pnl": round(sum(t.net_pnl for t in trades), 2),
            }
        return report

    def summary(self) -> dict[str, Any]:
        """Flat dict for logs, JSON and the CLI report."""
        return {
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "start": self.start.isoformat() if self.start else None,
            "end": self.end.isoformat() if self.end else None,
            "bars": self.bars,
            "initial_equity": round(self.initial_equity, 2),
            "final_equity": round(self.final_equity, 2),
            "net_pnl": round(self.net_pnl, 2),
            "return_pct": round(self.return_pct, 3),
            "trades": len(self.trades),
            "closed": len(self.closed),
            "open": len(self.open_trades),
            "wins": len(self.wins),
            "losses": len(self.losses),
            "win_rate": round(self.win_rate, 4),
            "profit_factor": (
                round(self.profit_factor, 4)
                if math.isfinite(self.profit_factor)
                else None
            ),
            "expectancy_r": round(self.expectancy_r, 4),
            "average_win": round(self.average_win, 2),
            "average_loss": round(self.average_loss, 2),
            "max_drawdown": round(self.max_drawdown, 2),
            "max_drawdown_pct": round(self.max_drawdown_pct, 3),
            "sharpe": round(self.sharpe, 4),
            "sortino": (
                round(self.sortino, 4) if math.isfinite(self.sortino) else None
            ),
            "average_bars_held": round(self.average_bars_held, 2),
            "exits": self.exit_breakdown(),
            "by_concept": self.concept_breakdown(),
            "by_killzone": self.killzone_breakdown(),
            "skipped": dict(sorted(self.skipped.items())),
        }

    def describe(self) -> str:
        """Human-readable report for the console."""
        stats = self.summary()
        profit_factor = stats["profit_factor"]
        sortino = stats["sortino"]
        lines = [
            f"{stats['symbol']} {stats['timeframe']}  "
            f"{stats['start']} -> {stats['end']}  ({stats['bars']} bars)",
            "-" * 62,
            f"  equity        {stats['initial_equity']:>12,.2f} -> "
            f"{stats['final_equity']:>12,.2f}",
            f"  net pnl       {stats['net_pnl']:>12,.2f}  "
            f"({stats['return_pct']:+.2f}%)",
            f"  trades        {stats['closed']:>12d}  "
            f"({stats['open']} still open)",
            f"  win rate      {stats['win_rate'] * 100:>11.2f}%  "
            f"({stats['wins']}W / {stats['losses']}L)",
            f"  profit factor {profit_factor if profit_factor is not None else 'inf':>12}",
            f"  expectancy    {stats['expectancy_r']:>12.4f} R",
            f"  avg win/loss  {stats['average_win']:>12,.2f} / "
            f"{stats['average_loss']:,.2f}",
            f"  max drawdown  {stats['max_drawdown']:>12,.2f}  "
            f"({stats['max_drawdown_pct']:.2f}%)",
            f"  sharpe        {stats['sharpe']:>12.4f}",
            f"  sortino       {sortino if sortino is not None else 'inf':>12}",
            f"  avg bars held {stats['average_bars_held']:>12.2f}",
        ]

        if stats["exits"]:
            lines.append(
                "  exits         "
                + ", ".join(
                    f"{key}={value}" for key, value in sorted(stats["exits"].items())
                )
            )
        if stats["by_concept"]:
            lines.append("  by concept:")
            for concept, row in sorted(stats["by_concept"].items()):
                lines.append(
                    f"    {concept:<16} {row['trades']:>4} trades  "
                    f"win {row['win_rate'] * 100:>5.1f}%  "
                    f"exp {row['expectancy_r']:>7.4f} R  "
                    f"pnl {row['net_pnl']:>10,.2f}"
                )
        if stats["by_killzone"]:
            lines.append("  by killzone:")
            for label, row in sorted(stats["by_killzone"].items()):
                lines.append(
                    f"    {label:<16} {row['trades']:>4} trades  "
                    f"win {row['win_rate'] * 100:>5.1f}%  "
                    f"exp {row['expectancy_r']:>7.4f} R  "
                    f"pnl {row['net_pnl']:>10,.2f}"
                )
        if stats["skipped"]:
            lines.append(
                "  skipped       "
                + ", ".join(
                    f"{key}={value}" for key, value in sorted(stats["skipped"].items())
                )
            )
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        """Full serialisable payload: stats plus every trade."""
        return {
            "summary": self.summary(),
            "params": json_safe(self.params),
            "trades": [trade.to_dict() for trade in self.trades],
        }


# ------------------------------------------------------------------
# REPLAY
# ------------------------------------------------------------------


def _zone_key(zone: Zone) -> tuple:
    """Identity for dedupe: same concept, same level, same formation bar."""
    return (
        zone.concept,
        zone.sub_concept,
        round(zone.price_high, 3),
        round(zone.price_low, 3),
        zone.formed_at,
    )


def _visible_index(zone: Zone, index: pd.DatetimeIndex, pivot_strength: int) -> int:
    """First bar position at which ``zone`` could have been known.

    Most detectors stamp ``formed_at`` on the bar that completes the
    pattern, so the zone is knowable at that bar. Fractal pivots are the
    exception: a swing high at bar ``i`` is only confirmed once
    ``pivot_strength`` bars have closed to its right, so it becomes
    knowable at ``i + pivot_strength``.

    Returning the position rather than the timestamp lets the replay loop
    do an integer comparison per bar instead of a search.
    """
    formed = pd.Timestamp(zone.formed_at)
    position = int(index.searchsorted(formed, side="left"))
    if zone.concept in (core.SWING_HIGH, core.SWING_LOW):
        position += max(1, pivot_strength)
    return position


def _detect_once(
    prepared: pd.DataFrame,
    detector_params: core.DetectorParams,
    config: Mapping[str, Any],
) -> list[tuple[int, Zone]]:
    """Run every detector once over the whole frame.

    Detection is a pure function of the candles, and every detector is
    causal — a zone's ``formed_at`` never points at a bar that had not
    closed yet. That means the set of zones visible at bar ``t`` is just
    the full detection set filtered to ``visible_index <= t``, which is
    identical to re-running detection on ``frame[:t+1]`` but costs one
    pass instead of one pass per bar.

    The staleness filter is deliberately *not* applied here. ``is_stale``
    measures a zone's age against the frame it is handed, so filtering
    against the full frame would expire every zone that formed more than
    ``max_zone_age_bars`` before the end of the series — including zones
    that were perfectly fresh at the bar being replayed. The replay loop
    applies it per bar instead, against the window ending at that bar.

    Returns ``(visible_index, zone)`` pairs sorted by visibility, so the
    replay loop can walk them with a cursor instead of rescanning.
    """
    zones = core.detect_zones(prepared, detector_params, config)
    # The dealing range is rebuilt per bar (see ``_rolling_zones``), so it
    # is dropped from the precomputed set to avoid double-counting.
    zones = [zone for zone in zones if zone.concept != core.DEALING_RANGE]
    zones = core.score_confluence(zones)

    indexed = [
        (_visible_index(zone, prepared.index, detector_params.pivot_strength), zone)
        for zone in zones
    ]
    indexed.sort(key=lambda pair: pair[0])
    return indexed


def _rolling_zones(
    prepared: pd.DataFrame,
    position: int,
    detector_params: core.DetectorParams,
) -> list[Zone]:
    """Zones that must be recomputed against the window ending at ``position``.

    The dealing range is the only detector that is not a fixed function of
    the candles: it takes the high and low of *everything it is shown* and
    stamps the result on the last bar. On a window ending at bar ``t`` that
    is the range of bars 0..t; on the full frame it is the range of the
    whole series. Those are different zones, so it cannot be precomputed
    once and filtered — it has to be rebuilt per bar.

    It is cheap: two reductions and no loops, unlike the pivot, structure,
    FVG, order-block and sweep detectors that dominate the runtime.
    """
    window = prepared.iloc[: position + 1]
    zones = core.find_dealing_range(window, detector_params)
    return core.score_confluence(zones)


def _entry_triggered(setup: Setup, bar: pd.Series) -> bool:
    """True when the bar traded into the setup's entry level.

    A limit order at the proximal edge fills when price touches it. The
    spread is charged on top, so the fill is always worse than the level.
    """
    high = float(bar["high"])
    low = float(bar["low"])
    if setup.direction == LONG:
        return low <= setup.entry_price
    return high >= setup.entry_price


def _open_trade(
    setup: Setup,
    moment: datetime,
    trade_id: int,
    symbol: str,
    equity: float,
    params: BacktestParams,
    killzone: str | None = None,
) -> Trade | None:
    """Size and open a position from a triggered setup."""
    lots = size_position(setup, equity, params)
    if lots <= 0:
        return None

    fill = entry_fill(setup.entry_price, setup.direction, params)
    # Re-derive risk from the actual fill, not the theoretical level: the
    # spread is real money and the R multiple must include it.
    risk = abs(fill - setup.stop_price)
    if risk <= 0:
        return None

    return Trade(
        trade_id=trade_id,
        symbol=symbol,
        timeframe=setup.timeframe,
        direction=setup.direction,
        concept=setup.zone.concept,
        sub_concept=setup.zone.sub_concept,
        entry_time=moment,
        entry_price=fill,
        stop_price=setup.stop_price,
        target_price=setup.target_price,
        initial_stop=setup.stop_price,
        initial_risk=risk,
        lots=lots,
        atr_at_entry=setup.atr_at_entry,
        confluence=setup.zone.confluence,
        mtf_confirmed=setup.zone.mtf_confirmed,
        conviction=setup.conviction,
        killzone=killzone,
        costs=trade_costs(lots, params),
        meta={"zone_formed_at": setup.zone.formed_at.isoformat()},
    )


def _can_open(
    direction: str,
    open_trades: Sequence[Trade],
    params: BacktestParams,
) -> bool:
    """Position-count and per-direction caps."""
    if len(open_trades) >= params.max_open_positions:
        return False
    same_side = sum(1 for trade in open_trades if trade.direction == direction)
    return same_side < params.max_positions_per_direction


def replay(
    frame: pd.DataFrame,
    timeframe: str = "15m",
    params: BacktestParams | None = None,
    detector_params: core.DetectorParams | None = None,
    config: Mapping[str, Any] | None = None,
    symbol: str | None = None,
    warmup_bars: int = 100,
    detect_every: int = 1,
    require_mtf: bool = False,
    htf_frame: pd.DataFrame | None = None,
    htf_label: str | None = None,
    max_trades: int | None = None,
    sessions: SessionFilter | None = None,
) -> BacktestResult:
    """Replay a frame bar by bar and return the trade log.

    ``warmup_bars`` bars are consumed before any detection happens: ATR
    needs 14 bars, pivots need ``pivot_strength`` either side, and order
    blocks look back 20. Trading the first 100 bars of a series would be
    trading a detector that has not warmed up.

    ``detect_every`` throttles how often the entry scan runs. Detection
    itself is a pure function of the candles and is computed once for the
    whole frame; this knob only controls how often the loop looks at the
    zone set for new entries. On a 15m frame, scanning every bar versus
    every fourth bar changes the trade count by a few percent while
    cutting the entry-scan cost by three quarters. Set it to 1 for a
    strict replay.

    ``require_mtf`` turns on the higher-timeframe filter: a setup is only
    taken when the HTF frame has an agreeing zone at the same price. Pass
    ``htf_frame`` and ``htf_label`` to enable it.

    ``sessions`` is the killzone filter. It is built once here from the
    config when not supplied, because the alternative — calling
    ``utils.current_killzone`` per bar — re-reads the ``killzones`` block
    and re-parses ``"07:00"`` on every iteration of a loop that runs tens
    of thousands of times. One filter, one parse, then a clock comparison
    per bar. The gate only refuses setups when ``params.require_killzone``
    is on; when it is off the label is still recorded on each trade so the
    report can group by window.
    """
    config = config or load_config()
    params = params or BacktestParams.from_config(config)
    detector_params = detector_params or core.DetectorParams.from_config(config)
    symbol = symbol or str(cfg_get(config, "instrument.symbol", "XAUUSD"))
    sessions = sessions or SessionFilter(config)

    frame = ensure_frame(frame)
    if len(frame) <= warmup_bars + 2:
        raise ValueError(
            f"need more than {warmup_bars + 2} bars to replay, got {len(frame)}"
        )

    if require_mtf and (htf_frame is None or htf_label is None):
        raise ValueError("require_mtf needs both htf_frame and htf_label")

    prepared = core.prepare(frame, detector_params)
    htf_prepared = (
        core.prepare(htf_frame, detector_params) if htf_frame is not None else None
    )

    # Detection is pure and causal, so it runs once here rather than once
    # per bar. ``visible`` is sorted by the bar position at which each zone
    # becomes knowable, which lets the loop advance a cursor instead of
    # rescanning the whole history every bar.
    visible = _detect_once(prepared, detector_params, config)
    visible_cursor = 0
    live: list[Zone] = []

    htf_visible: list[tuple[int, Zone]] = []
    htf_cursor = 0
    htf_live: list[Zone] = []
    if require_mtf and htf_prepared is not None:
        htf_visible = _detect_once(htf_prepared, detector_params, config)

    equity = params.initial_equity
    trades: list[Trade] = []
    open_trades: list[Trade] = []
    skipped: dict[str, int] = {}
    seen: set[tuple] = set()
    equity_points: list[tuple[datetime, float]] = []
    trade_id = 0

    # Daily loss guard, keyed on the 21:00-UTC trading day.
    day_start = trading_day(prepared.index[warmup_bars].to_pydatetime())
    day_pnl = 0.0
    day_halted = False

    def note(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    for position in range(warmup_bars, len(prepared)):
        moment = prepared.index[position].to_pydatetime()
        bar = prepared.iloc[position]

        # ---- trading day roll --------------------------------------
        current_day = trading_day(moment)
        if current_day != day_start:
            day_start = current_day
            day_pnl = 0.0
            day_halted = False

        # ---- advance open positions --------------------------------
        still_open: list[Trade] = []
        for trade in open_trades:
            advance_trade(trade, bar, moment, params)
            if trade.is_open:
                still_open.append(trade)
            else:
                equity += trade.net_pnl
                day_pnl += trade.net_pnl
        open_trades = still_open

        # ---- daily loss limit --------------------------------------
        if not day_halted and params.max_daily_loss_pct > 0:
            limit = -abs(equity * (params.max_daily_loss_pct / 100.0))
            if day_pnl <= limit:
                day_halted = True
                note(SKIP_DAILY_LOSS)

        # ---- detection ---------------------------------------------
        # Zones become visible as the cursor passes their formation bar.
        # ``detect_every`` still throttles how often the entry scan runs,
        # but the zone set itself is always up to date.
        while visible_cursor < len(visible) and visible[visible_cursor][0] <= position:
            live.append(visible[visible_cursor])
            visible_cursor += 1

        if (position - warmup_bars) % max(detect_every, 1) != 0:
            equity_points.append((moment, equity))
            continue

        # Staleness is measured against the bar being replayed, not the end
        # of the series: a zone formed 40 bars ago is fresh at bar t even
        # when the frame runs another 2,000 bars past it.
        max_age = detector_params.max_zone_age_bars
        if max_age > 0:
            zones = [zone for born, zone in live if position - born <= max_age]
        else:
            zones = [zone for _, zone in live]

        # The dealing range is a rolling construct and is rebuilt here.
        zones = zones + _rolling_zones(prepared, position, detector_params)

        if require_mtf and htf_prepared is not None and htf_label is not None:
            htf_position = int(htf_prepared.index.searchsorted(moment, side="right"))
            while (
                htf_cursor < len(htf_visible)
                and htf_visible[htf_cursor][0] < htf_position
            ):
                htf_live.append(htf_visible[htf_cursor][1])
                htf_cursor += 1
            if not htf_live:
                equity_points.append((moment, equity))
                continue
            zones = core.apply_mtf_confirmation(zones, htf_live, htf_label)

        # ---- killzone ----------------------------------------------
        # One clock read per bar, resolved once and reused for every zone
        # considered on this bar. ``active_killzone`` returns the config
        # key verbatim (``"london_open"``), not the uppercased display form
        # ``utils.current_killzone`` produces — the config key is canonical
        # and the uppercase is a presentation convention.
        killzone = sessions.active_killzone(moment)
        if params.require_killzone and killzone is None:
            note(SKIP_KILLZONE)
            equity_points.append((moment, equity))
            continue

        # ---- entries -----------------------------------------------
        for zone in zones:
            if day_halted:
                note(SKIP_DAY_HALTED)
                break
            if max_trades is not None and len(trades) >= max_trades:
                note(SKIP_MAX_TRADES)
                break

            key = _zone_key(zone)
            if key in seen:
                continue

            # A zone is only tradeable from the bar after it formed.
            if zone.formed_at >= moment:
                continue

            if require_mtf and not zone.mtf_confirmed:
                note(SKIP_NO_MTF)
                continue

            atr_value = float(bar["atr"])
            setup = build_setup(
                zone,
                timeframe,
                params,
                atr_value=None if math.isnan(atr_value) else atr_value,
            )
            if setup is None:
                note(SKIP_GEOMETRY)
                continue

            if not _can_open(setup.direction, open_trades, params):
                note(SKIP_POSITION_LIMIT)
                continue

            if not _entry_triggered(setup, bar):
                # Not at the level yet. Leave it unseen so a later bar can
                # still trigger it.
                continue

            trade_id += 1
            trade = _open_trade(
                setup, moment, trade_id, symbol, equity, params, killzone=killzone
            )
            if trade is None:
                note(SKIP_SIZING)
                continue

            seen.add(key)
            trades.append(trade)
            open_trades.append(trade)

        equity_points.append((moment, equity))

    # ---- close anything still open at the last bar ------------------
    if open_trades:
        last_moment = prepared.index[-1].to_pydatetime()
        last_bar = prepared.iloc[-1]
        for trade in open_trades:
            _close_fraction(
                trade,
                trade.remaining_fraction,
                exit_fill(float(last_bar["close"]), trade.direction, params),
                last_moment,
                EXIT_OPEN,
                params,
            )
            _finalise(trade, params)
            equity += trade.net_pnl
        open_trades = []

    curve = pd.Series(
        [value for _, value in equity_points],
        index=pd.DatetimeIndex([moment for moment, _ in equity_points]),
        name="equity",
    )

    return BacktestResult(
        symbol=symbol,
        timeframe=timeframe,
        start=prepared.index[warmup_bars].to_pydatetime(),
        end=prepared.index[-1].to_pydatetime(),
        bars=len(prepared) - warmup_bars,
        initial_equity=params.initial_equity,
        final_equity=equity,
        trades=trades,
        equity_curve=curve,
        skipped=skipped,
        params=params.as_dict(),
    )


# ------------------------------------------------------------------
# WALK-FORWARD
# ------------------------------------------------------------------


@dataclass
class WalkForwardWindow:
    """One in-sample / out-of-sample pair."""

    index: int
    train_start: datetime
    train_end: datetime
    test_start: datetime
    test_end: datetime
    train: BacktestResult | None = None
    test: BacktestResult | None = None

    @property
    def degradation(self) -> float:
        """Expectancy decay from train to test, in R.

        A strategy that makes 0.4 R in sample and 0.05 R out of sample is
        not a strategy, it is a curve fit. This number is the honest one.
        """
        if self.train is None or self.test is None:
            return 0.0
        return self.test.expectancy_r - self.train.expectancy_r

    def summary(self) -> dict[str, Any]:
        return {
            "window": self.index,
            "train": f"{self.train_start.isoformat()} -> {self.train_end.isoformat()}",
            "test": f"{self.test_start.isoformat()} -> {self.test_end.isoformat()}",
            "train_trades": len(self.train.closed) if self.train else 0,
            "train_expectancy_r": (
                round(self.train.expectancy_r, 4) if self.train else None
            ),
            "test_trades": len(self.test.closed) if self.test else 0,
            "test_expectancy_r": (
                round(self.test.expectancy_r, 4) if self.test else None
            ),
            "test_win_rate": round(self.test.win_rate, 4) if self.test else None,
            "test_net_pnl": round(self.test.net_pnl, 2) if self.test else None,
            "degradation_r": round(self.degradation, 4),
        }


def walk_forward(
    frame: pd.DataFrame,
    timeframe: str = "15m",
    splits: int | None = None,
    params: BacktestParams | None = None,
    detector_params: core.DetectorParams | None = None,
    config: Mapping[str, Any] | None = None,
    warmup_bars: int = 100,
    detect_every: int = 1,
    require_mtf: bool = False,
    htf_frame: pd.DataFrame | None = None,
    htf_label: str | None = None,
    sessions: SessionFilter | None = None,
) -> list[WalkForwardWindow]:
    """Split the series into consecutive train/test windows and replay each.

    The split is anchored, not rolling: window *n* trains on everything up
    to its test start and tests on the next slice. That mirrors how the
    engine would actually be re-tuned over time — you never get to see the
    future while fitting.

    Each window's test slice is replayed with a fresh account, so equity
    does not leak between windows.

    ``sessions`` is built once here and handed to every window, so the
    killzone parse happens once for the whole walk-forward rather than
    once per replay.
    """
    config = config or load_config()
    params = params or BacktestParams.from_config(config)
    detector_params = detector_params or core.DetectorParams.from_config(config)
    splits = splits or params.walk_forward_splits
    sessions = sessions or SessionFilter(config)

    frame = ensure_frame(frame)
    if splits < 1:
        raise ValueError("splits must be at least 1")

    usable = len(frame) - warmup_bars
    if usable < splits * 2:
        raise ValueError(
            f"need at least {splits * 2 + warmup_bars} bars for {splits} splits, "
            f"got {len(frame)}"
        )

    # Each split owns an equal slice of the post-warmup bars. The first
    # slice is pure training; every later slice is tested on the bars that
    # follow its own training set.
    slice_size = usable // (splits + 1)
    windows: list[WalkForwardWindow] = []

    for index in range(splits):
        train_end_position = warmup_bars + slice_size * (index + 1)
        test_end_position = min(train_end_position + slice_size, len(frame))
        if test_end_position <= train_end_position:
            break

        train_frame = frame.iloc[:train_end_position]
        test_frame = frame.iloc[
            max(train_end_position - warmup_bars, 0) : test_end_position
        ]
        if len(test_frame) <= warmup_bars + 2:
            continue

        window = WalkForwardWindow(
            index=index,
            train_start=frame.index[0].to_pydatetime(),
            train_end=frame.index[train_end_position - 1].to_pydatetime(),
            test_start=test_frame.index[0].to_pydatetime(),
            test_end=test_frame.index[-1].to_pydatetime(),
        )

        window.train = replay(
            train_frame,
            timeframe=timeframe,
            params=params,
            detector_params=detector_params,
            config=config,
            warmup_bars=warmup_bars,
            detect_every=detect_every,
            require_mtf=require_mtf,
            htf_frame=htf_frame,
            htf_label=htf_label,
            sessions=sessions,
        )
        window.test = replay(
            test_frame,
            timeframe=timeframe,
            params=params,
            detector_params=detector_params,
            config=config,
            warmup_bars=warmup_bars,
            detect_every=detect_every,
            require_mtf=require_mtf,
            htf_frame=htf_frame,
            htf_label=htf_label,
            sessions=sessions,
        )
        windows.append(window)

    return windows


def walk_forward_summary(windows: Sequence[WalkForwardWindow]) -> dict[str, Any]:
    """Aggregate a walk-forward run into one verdict."""
    tested = [window for window in windows if window.test is not None]
    if not tested:
        return {"windows": 0}

    test_expectancies = [window.test.expectancy_r for window in tested]
    train_expectancies = [
        window.train.expectancy_r for window in tested if window.train is not None
    ]
    positive = sum(1 for value in test_expectancies if value > 0)

    return {
        "windows": len(tested),
        "train_expectancy_r": (
            round(sum(train_expectancies) / len(train_expectancies), 4)
            if train_expectancies
            else None
        ),
        "test_expectancy_r": round(
            sum(test_expectancies) / len(test_expectancies), 4
        ),
        "test_expectancy_std": (
            round(float(np.std(test_expectancies, ddof=1)), 4)
            if len(test_expectancies) > 1
            else 0.0
        ),
        "profitable_windows": positive,
        "consistency": round(positive / len(tested), 4),
        "average_degradation_r": round(
            sum(window.degradation for window in tested) / len(tested), 4
        ),
        "total_test_trades": sum(len(window.test.closed) for window in tested),
        "total_test_pnl": round(sum(window.test.net_pnl for window in tested), 2),
        "windows_detail": [window.summary() for window in tested],
    }


# ------------------------------------------------------------------
# MONTE CARLO
# ------------------------------------------------------------------


@dataclass
class MonteCarloResult:
    """Bootstrap distribution of outcomes from one trade log."""

    runs: int
    confidence: float
    trades_per_run: int
    final_equity: np.ndarray
    max_drawdown: np.ndarray
    expectancy_r: np.ndarray

    def percentile(self, values: np.ndarray, quantile: float) -> float:
        if values.size == 0:
            return 0.0
        return float(np.percentile(values, quantile * 100.0))

    def summary(self) -> dict[str, Any]:
        lower = (1.0 - self.confidence) / 2.0
        upper = 1.0 - lower
        return {
            "runs": self.runs,
            "confidence": self.confidence,
            "trades_per_run": self.trades_per_run,
            "final_equity": {
                "p05": round(self.percentile(self.final_equity, lower), 2),
                "median": round(self.percentile(self.final_equity, 0.5), 2),
                "p95": round(self.percentile(self.final_equity, upper), 2),
                "mean": round(float(self.final_equity.mean()), 2),
                "std": round(float(self.final_equity.std(ddof=1)), 2)
                if self.final_equity.size > 1
                else 0.0,
            },
            "max_drawdown": {
                "p05": round(self.percentile(self.max_drawdown, lower), 2),
                "median": round(self.percentile(self.max_drawdown, 0.5), 2),
                "p95": round(self.percentile(self.max_drawdown, upper), 2),
                "worst": round(float(self.max_drawdown.max()), 2),
            },
            "expectancy_r": {
                "p05": round(self.percentile(self.expectancy_r, lower), 4),
                "median": round(self.percentile(self.expectancy_r, 0.5), 4),
                "p95": round(self.percentile(self.expectancy_r, upper), 4),
            },
            "probability_of_profit": round(
                float((self.final_equity > 0).mean()), 4
            ),
            "risk_of_ruin": round(
                float((self.final_equity <= 0).mean()), 4
            ),
        }

    def describe(self) -> str:
        stats = self.summary()
        equity = stats["final_equity"]
        drawdown = stats["max_drawdown"]
        expectancy = stats["expectancy_r"]
        return "\n".join(
            [
                f"Monte Carlo — {stats['runs']} runs, "
                f"{stats['trades_per_run']} trades each, "
                f"{stats['confidence'] * 100:.0f}% band",
                "-" * 62,
                f"  final equity  p05 {equity['p05']:>10,.2f}   "
                f"median {equity['median']:>10,.2f}   p95 {equity['p95']:>10,.2f}",
                f"  max drawdown  p05 {drawdown['p05']:>10,.2f}   "
                f"median {drawdown['median']:>10,.2f}   "
                f"p95 {drawdown['p95']:>10,.2f}   worst {drawdown['worst']:,.2f}",
                f"  expectancy R  p05 {expectancy['p05']:>10.4f}   "
                f"median {expectancy['median']:>10.4f}   "
                f"p95 {expectancy['p95']:>10.4f}",
                f"  P(profit)     {stats['probability_of_profit'] * 100:>10.2f}%",
                f"  P(ruin)       {stats['risk_of_ruin'] * 100:>10.2f}%",
            ]
        )


def monte_carlo(
    result: BacktestResult,
    runs: int | None = None,
    confidence: float | None = None,
    params: BacktestParams | None = None,
    seed: int | None = 7,
    ruin_threshold: float = 0.0,
) -> MonteCarloResult:
    """Bootstrap the trade log to see how much of the result was luck.

    Trades are resampled *with replacement* in R space, then replayed
    through the same compounding equity path. Resampling R rather than
    currency keeps the distribution independent of position sizing, which
    is the point: the question is whether the edge is real, not whether
    the lot size was lucky.

    ``seed`` is fixed by default so two runs of the same backtest produce
    the same confidence band. Pass ``seed=None`` for a fresh draw.
    """
    params = params or BacktestParams()
    runs = runs or params.monte_carlo_runs
    confidence = confidence if confidence is not None else params.monte_carlo_confidence

    closed = result.closed
    if not closed:
        empty = np.zeros(0, dtype=float)
        return MonteCarloResult(
            runs=0,
            confidence=confidence,
            trades_per_run=0,
            final_equity=empty,
            max_drawdown=empty,
            expectancy_r=empty,
        )

    r_values = np.array([trade.r_multiple for trade in closed], dtype=float)
    risk_fraction = params.risk_per_trade_pct / 100.0
    count = len(r_values)

    rng = random.Random(seed)
    final_equity = np.zeros(runs, dtype=float)
    max_drawdown = np.zeros(runs, dtype=float)
    expectancy = np.zeros(runs, dtype=float)

    for run in range(runs):
        equity = result.initial_equity
        peak = equity
        worst = 0.0
        total_r = 0.0

        for _ in range(count):
            r_multiple = r_values[rng.randrange(count)]
            total_r += r_multiple
            # Risk is a fixed fraction of *current* equity, so the path
            # compounds exactly the way the live account would.
            equity += equity * risk_fraction * r_multiple
            peak = max(peak, equity)
            worst = max(worst, peak - equity)
            if equity <= ruin_threshold:
                equity = ruin_threshold
                break

        final_equity[run] = equity
        max_drawdown[run] = worst
        expectancy[run] = total_r / count

    return MonteCarloResult(
        runs=runs,
        confidence=confidence,
        trades_per_run=count,
        final_equity=final_equity,
        max_drawdown=max_drawdown,
        expectancy_r=expectancy,
    )


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------


def _load_frame_for_cli(
    timeframe: str,
    config: Mapping[str, Any],
    prefer_db: bool,
    limit: int | None,
) -> pd.DataFrame:
    """Fetch candles for the CLI, preferring the database when asked."""
    from . import data_loader

    if prefer_db:
        frame = data_loader.read_candles(timeframe, limit=limit)
        if frame is not None and not frame.empty:
            return frame
        log.warning("no candles in Postgres for %s, falling back to Yahoo", timeframe)

    candles = data_loader.load_candles([timeframe], config)
    return candles.require(timeframe)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Replay the SMC/ICT engine over historical XAUUSD candles"
    )
    parser.add_argument("--timeframe", default="15m", help="timeframe label")
    parser.add_argument("--htf", default=None, help="higher timeframe for the MTF filter")
    parser.add_argument("--bars", type=int, default=None, help="cap the bar count")
    parser.add_argument("--warmup", type=int, default=100, help="bars before trading")
    parser.add_argument(
        "--detect-every", type=int, default=1, help="re-detect every N bars"
    )
    parser.add_argument("--equity", type=float, default=None, help="starting equity")
    parser.add_argument("--risk", type=float, default=None, help="risk per trade, %%")
    parser.add_argument("--splits", type=int, default=None, help="walk-forward splits")
    parser.add_argument("--mc-runs", type=int, default=None, help="Monte Carlo runs")
    parser.add_argument("--mtf", action="store_true", help="require HTF confirmation")
    parser.add_argument(
        "--killzones",
        action="store_true",
        help="only take setups inside a configured killzone",
    )
    parser.add_argument("--db", action="store_true", help="read candles from Postgres")
    parser.add_argument("--json", default=None, help="write the full report to a file")
    parser.add_argument("--quiet", action="store_true", help="summary only")
    args = parser.parse_args(argv)

    config = load_config()
    params = BacktestParams.from_config(config)
    if args.equity is not None or args.risk is not None:
        params = BacktestParams(
            **{
                **params.__dict__,
                "initial_equity": args.equity or params.initial_equity,
                "risk_per_trade_pct": args.risk or params.risk_per_trade_pct,
            }
        )
    if args.killzones:
        # The flag is the CLI's own switch, so it overrides whatever the
        # config's signal_engine block says. The filter itself is built
        # once below and shared by the replay and every walk-forward window.
        params = BacktestParams(**{**params.__dict__, "require_killzone": True})

    sessions = SessionFilter(config)
    log.info("killzones: %s", ", ".join(sessions.names) or "none configured")

    frame = _load_frame_for_cli(args.timeframe, config, args.db, args.bars)
    if args.bars:
        frame = frame.iloc[-args.bars :]

    htf_frame = None
    if args.mtf:
        if not args.htf:
            parser.error("--mtf requires --htf")
        htf_frame = _load_frame_for_cli(args.htf, config, args.db, None)

    log.info(
        "replaying %s bars of %s from %s",
        len(frame),
        args.timeframe,
        frame.index[0],
    )

    result = replay(
        frame,
        timeframe=args.timeframe,
        params=params,
        config=config,
        warmup_bars=args.warmup,
        detect_every=args.detect_every,
        require_mtf=args.mtf,
        htf_frame=htf_frame,
        htf_label=args.htf,
        sessions=sessions,
    )
    print(result.describe())

    payload: dict[str, Any] = {"backtest": result.to_dict()}

    if args.splits:
        windows = walk_forward(
            frame,
            timeframe=args.timeframe,
            splits=args.splits,
            params=params,
            config=config,
            warmup_bars=args.warmup,
            detect_every=args.detect_every,
            require_mtf=args.mtf,
            htf_frame=htf_frame,
            htf_label=args.htf,
            sessions=sessions,
        )
        summary = walk_forward_summary(windows)
        payload["walk_forward"] = summary
        if not args.quiet:
            print()
            print(
                f"Walk-forward — {summary['windows']} windows, "
                f"test expectancy {summary['test_expectancy_r']:+.4f} R, "
                f"consistency {summary['consistency'] * 100:.1f}%, "
                f"degradation {summary['average_degradation_r']:+.4f} R"
            )
            for row in summary["windows_detail"]:
                print(
                    f"  #{row['window']}  train {row['train_expectancy_r']} R "
                    f"({row['train_trades']} trades)  ->  "
                    f"test {row['test_expectancy_r']} R "
                    f"({row['test_trades']} trades)  "
                    f"degradation {row['degradation_r']:+.4f}"
                )

    if args.mc_runs:
        mc = monte_carlo(result, runs=args.mc_runs, params=params)
        payload["monte_carlo"] = mc.summary()
        if not args.quiet:
            print()
            print(mc.describe())

    if args.json:
        from pathlib import Path

        Path(args.json).write_text(json_dumps(payload), encoding="utf-8")
        log.info("report written to %s", args.json)

    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
