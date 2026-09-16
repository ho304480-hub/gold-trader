"""src/stop_manager.py — stop-loss placement: structural, ATR, chandelier, time.

Three stop families are computed independently and then reconciled into one
plan, because each answers a different question:

* **Structural** — where is the idea actually wrong? A long that swept a low
  and left an order block behind is invalidated when price closes back
  through that wick, not when an arbitrary number of points have elapsed.
* **ATR** — how much noise does this instrument need to breathe? Gold at
  $2,400 routinely wicks 8 points on a 15m bar without changing anything.
* **Chandelier** — how far has the position run, and how much of that run
  should it be allowed to give back?

The plan takes the *wider* of structural and ATR. A stop that sits inside
the noise band is a stop that gets hit by the market's breathing rather than
by the thesis failing, and the cost of the extra distance is paid back in
the win rate. Because the ATR family alone guarantees a risk of at least
``atr_mult`` ATR, the reconciled risk can never fall inside that band.

Design notes that matter downstream:

* ``Zone`` is the real structural type from :mod:`src.smc_core`. It carries
  ``price_high`` as the distal edge and ``price_low`` as the proximal edge
  for *both* directions, so the stop side is selected by direction rather
  than by assuming high/low map to resistance/support.
* ``atr`` returns a Series whose warm-up is NaN. ``float(series.iloc[-1])``
  on a short frame yields ``nan``, and every comparison against ``nan`` is
  ``False`` — which silently produces a stop at the entry price. The ATR
  read goes through :func:`_last_finite` and a missing value is reported as
  ``None`` rather than guessed at.
* ``spread_buffer`` is expressed in *price*, not points. The config's
  ``risk.min_stop_points`` is in points, so the two are never mixed.
* The time stop is a *rule*, not a price: it answers "has this trade earned
  the right to keep occupying a slot?" and is evaluated by the caller, which
  is the only place that knows how many bars have actually closed.

The indicator primitives live in :mod:`src.utils`; this module only composes
them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np
import pandas as pd

from .smc_core import BEARISH, BULLISH, Zone
from .utils import atr, cfg_get, safe_div, setup_logging

log = setup_logging(__name__)

# ------------------------------------------------------------------
# TUNABLES
# ------------------------------------------------------------------

# Defaults mirror the ``risk`` block in config.yaml. They are duplicated
# here only so the class is usable without a config object; the config
# always wins when one is supplied.
DEFAULT_ATR_PERIOD = 14
DEFAULT_ATR_MULT = 1.5
DEFAULT_CHANDELIER_PERIOD = 22
DEFAULT_CHANDELIER_MULT = 3.0
DEFAULT_SPREAD_BUFFER = 0.0002
DEFAULT_MIN_RR = 2.0

# Stop methods, reported on the plan so a trade log can be grouped by them.
METHOD_STRUCTURAL = "structural"
METHOD_ATR = "atr"
METHOD_CHANDELIER = "chandelier"


# ------------------------------------------------------------------
# HELPERS
# ------------------------------------------------------------------


def _last_finite(series: pd.Series | None) -> float | None:
    """Last finite value of ``series``, or None.

    ``atr`` and the rolling windows in this module are NaN through warm-up
    and may be nullable dtypes. ``float(pd.NA)`` raises ``TypeError`` and
    ``float(nan)`` propagates a value that compares ``False`` against every
    threshold, so both are funnelled through here and reported as None.
    """
    if series is None or len(series) == 0:
        return None
    try:
        value = pd.to_numeric(series, errors="coerce").astype("Float64").iloc[-1]
    except (TypeError, ValueError):
        return None
    if value is None or pd.isna(value):
        return None
    value = float(value)
    return value if np.isfinite(value) else None


# ------------------------------------------------------------------
# PLAN
# ------------------------------------------------------------------


@dataclass(frozen=True)
class StopPlan:
    """One resolved stop / target pair plus the geometry behind it.

    ``distance`` is the risk in price units and ``rr`` the reward-to-risk
    ratio. ``method`` names which family won the reconciliation, and
    ``components`` carries every candidate that was considered so a trade
    log can show why the chosen stop sits where it does.
    """

    entry: float
    stop: float
    target: float
    rr: float
    method: str
    distance: float
    direction: str = ""
    components: Mapping[str, float] | None = None

    @property
    def is_long(self) -> bool:
        return self.direction == BULLISH

    @property
    def is_valid(self) -> bool:
        """True when the geometry can produce a sane trade."""
        return self.distance > 0.0 and self.rr > 0.0

    @property
    def risk_reward(self) -> float:
        return self.rr

    def r_multiple(self, price: float) -> float:
        """Where ``price`` sits in R terms relative to the entry."""
        if self.distance <= 0:
            return 0.0
        move = price - self.entry if self.is_long else self.entry - price
        return safe_div(move, self.distance, 0.0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "entry": round(self.entry, 3),
            "stop": round(self.stop, 3),
            "target": round(self.target, 3),
            "rr": round(self.rr, 4),
            "method": self.method,
            "distance": round(self.distance, 3),
            "direction": self.direction,
            "components": (
                {key: round(value, 3) for key, value in self.components.items()}
                if self.components
                else {}
            ),
        }


# ------------------------------------------------------------------
# MANAGER
# ------------------------------------------------------------------


class StopManager:
    """Structural + ATR + chandelier stop placement.

    Constructed once per run from the resolved config. Every method is a
    pure function of the frame it is handed, so the same instance can be
    reused across timeframes and across a replay without carrying state.
    """

    def __init__(self, cfg: Mapping[str, Any] | None = None):
        cfg = cfg or {}
        self.cfg = cfg
        self.atr_period = int(cfg_get(cfg, "risk.atr_period", DEFAULT_ATR_PERIOD))
        self.atr_mult = float(cfg_get(cfg, "risk.atr_mult", DEFAULT_ATR_MULT))
        self.chandelier_period = int(
            cfg_get(cfg, "risk.chandelier_period", DEFAULT_CHANDELIER_PERIOD)
        )
        self.chandelier_mult = float(
            cfg_get(cfg, "risk.chandelier_mult", DEFAULT_CHANDELIER_MULT)
        )
        self.spread_buffer = float(
            cfg_get(cfg, "risk.spread_buffer", DEFAULT_SPREAD_BUFFER)
        )
        self.min_rr = float(cfg_get(cfg, "detectors.min_rr", DEFAULT_MIN_RR))
        self.min_stop_points = float(cfg_get(cfg, "risk.min_stop_points", 0.0))
        self.stop_buffer_atr = float(cfg_get(cfg, "risk.stop_buffer_atr", 0.25))

    # ---- ATR read -------------------------------------------------

    def atr_value(self, df: pd.DataFrame) -> float | None:
        """Latest ATR, or None when the frame is too short to warm up."""
        if df is None or len(df) < self.atr_period + 1:
            return None
        return _last_finite(atr(df, self.atr_period))

    # ---- structural -----------------------------------------------

    def structural_stop(
        self,
        direction: str,
        sweep_price: float | None,
        zone: Zone | None = None,
    ) -> float | None:
        """Stop beyond the sweep wick and the zone's distal edge.

        ``Zone.price_high`` is the distal edge for both directions, so a
        bullish stop sits below ``price_low`` and a bearish stop above
        ``price_high``. The sweep wick is folded in because a sweep that
        has not been reclaimed is the level the idea is built on.
        """
        if direction not in (BULLISH, BEARISH):
            return None
        if sweep_price is None or not np.isfinite(sweep_price):
            return None

        if direction == BULLISH:
            base = float(sweep_price)
            if zone is not None:
                base = min(base, float(zone.price_low))
            return base - self.spread_buffer

        base = float(sweep_price)
        if zone is not None:
            base = max(base, float(zone.price_high))
        return base + self.spread_buffer

    # ---- ATR ------------------------------------------------------

    def atr_stop(
        self, df: pd.DataFrame, direction: str, entry: float
    ) -> float | None:
        """Entry offset by ``atr_mult`` ATR, or None when ATR is unavailable."""
        if direction not in (BULLISH, BEARISH):
            return None
        value = self.atr_value(df)
        if value is None or value <= 0:
            return None
        distance = self.atr_mult * value
        return entry - distance if direction == BULLISH else entry + distance

    # ---- chandelier -----------------------------------------------

    def chandelier_stop(self, df: pd.DataFrame, direction: str) -> float | None:
        """Trailing stop hung off the highest high / lowest low.

        Called once per bar to ratchet. Returns None when the frame is
        shorter than the chandelier window or ATR has not warmed up.
        """
        if direction not in (BULLISH, BEARISH):
            return None
        if df is None or len(df) < self.chandelier_period:
            return None
        value = self.atr_value(df)
        if value is None or value <= 0:
            return None

        if direction == BULLISH:
            anchor = _last_finite(df["high"].rolling(self.chandelier_period).max())
            if anchor is None:
                return None
            return anchor - self.chandelier_mult * value

        anchor = _last_finite(df["low"].rolling(self.chandelier_period).min())
        if anchor is None:
            return None
        return anchor + self.chandelier_mult * value

    # ---- reconciliation -------------------------------------------

    def plan(
        self,
        df: pd.DataFrame,
        direction: str,
        entry: float,
        sweep_price: float | None = None,
        zone: Zone | None = None,
        target: float | None = None,
        target_r: float | None = None,
    ) -> StopPlan | None:
        """Reconcile the stop families into one plan.

        The wider of structural and ATR wins. When only one family can be
        computed the plan uses it and says so; when neither can, the plan
        is None rather than a stop parked at the entry.

        ``target`` may be supplied directly, or derived from ``target_r``
        multiples of the resolved risk. Returns None when the geometry is
        unusable: no ATR to size against, a non-positive risk, or a reward
        that does not clear ``min_rr``.
        """
        if direction not in (BULLISH, BEARISH):
            return None
        if entry is None or not np.isfinite(entry):
            return None

        candidates: dict[str, float] = {}

        structural = (
            self.structural_stop(direction, sweep_price, zone)
            if sweep_price is not None
            else None
        )
        if structural is not None:
            candidates[METHOD_STRUCTURAL] = structural

        atr_candidate = self.atr_stop(df, direction, entry)
        if atr_candidate is not None:
            candidates[METHOD_ATR] = atr_candidate

        if not candidates:
            log.debug("no stop family could be computed; plan rejected")
            return None

        # A plan without an ATR read has no volatility context: the risk
        # cannot be sanity-checked against the instrument's noise, and a
        # structural stop alone on a thin frame is a guess dressed as
        # geometry. Refuse rather than emit a confident-looking number.
        atr_now = self.atr_value(df)
        if atr_now is None or atr_now <= 0:
            log.debug("no ATR available; plan rejected")
            return None

        if METHOD_STRUCTURAL in candidates and METHOD_ATR in candidates:
            if direction == BULLISH:
                stop = min(candidates[METHOD_STRUCTURAL], candidates[METHOD_ATR])
                method = (
                    METHOD_STRUCTURAL
                    if candidates[METHOD_STRUCTURAL] <= candidates[METHOD_ATR]
                    else METHOD_ATR
                )
            else:
                stop = max(candidates[METHOD_STRUCTURAL], candidates[METHOD_ATR])
                method = (
                    METHOD_STRUCTURAL
                    if candidates[METHOD_STRUCTURAL] >= candidates[METHOD_ATR]
                    else METHOD_ATR
                )
        elif METHOD_STRUCTURAL in candidates:
            stop = candidates[METHOD_STRUCTURAL]
            method = METHOD_STRUCTURAL
        else:
            stop = candidates[METHOD_ATR]
            method = METHOD_ATR

        risk = abs(entry - stop)
        if risk <= 0:
            return None

        if target is None:
            multiple = target_r if target_r is not None else self.min_rr
            reward = risk * multiple
            target = entry + reward if direction == BULLISH else entry - reward

        reward = abs(target - entry)
        rr = safe_div(reward, risk, 0.0)
        if rr < self.min_rr:
            log.debug("plan rejected: rr %.2f below min_rr %.2f", rr, self.min_rr)
            return None

        return StopPlan(
            entry=float(entry),
            stop=float(stop),
            target=float(target),
            rr=rr,
            method=method,
            distance=risk,
            direction=direction,
            components=candidates,
        )

    # ---- trailing -------------------------------------------------

    def ratchet(
        self,
        current_stop: float,
        candidate: float,
        direction: str,
        entry: float,
    ) -> float:
        """Move ``current_stop`` toward ``candidate`` but never through entry.

        A long's stop only rises and never above the fill; a short's only
        falls and never below it. This is the same ratchet the backtester
        applies, exposed here so live and replay agree.
        """
        if direction == BULLISH:
            return max(current_stop, min(candidate, entry))
        if direction == BEARISH:
            return min(current_stop, max(candidate, entry))
        return current_stop

    # ---- time stop ------------------------------------------------

    def time_stop_hit(
        self,
        bars_open: int,
        max_bars: int,
        current_r: float,
        min_r: float = 1.0,
    ) -> bool:
        """True when a trade has used its slot without earning its keep.

        A trade that has run out of bars *and* has not reached ``min_r``
        is dead weight: the thesis had its window and did not deliver.
        """
        if max_bars <= 0:
            return False
        return bars_open >= max_bars and current_r < min_r

    def as_dict(self) -> dict[str, Any]:
        return {
            "atr_period": self.atr_period,
            "atr_mult": self.atr_mult,
            "chandelier_period": self.chandelier_period,
            "chandelier_mult": self.chandelier_mult,
            "spread_buffer": self.spread_buffer,
            "min_rr": self.min_rr,
            "min_stop_points": self.min_stop_points,
            "stop_buffer_atr": self.stop_buffer_atr,
        }


# ------------------------------------------------------------------
# MODULE-LEVEL WRAPPERS
# ------------------------------------------------------------------


def structural_stop(
    direction: str,
    sweep_price: float | None,
    zone: Zone | None = None,
    cfg: Mapping[str, Any] | None = None,
) -> float | None:
    """One-shot structural stop without constructing a manager."""
    return StopManager(cfg).structural_stop(direction, sweep_price, zone)


def atr_stop(
    df: pd.DataFrame,
    direction: str,
    entry: float,
    cfg: Mapping[str, Any] | None = None,
) -> float | None:
    """One-shot ATR stop without constructing a manager."""
    return StopManager(cfg).atr_stop(df, direction, entry)


def chandelier_stop(
    df: pd.DataFrame,
    direction: str,
    cfg: Mapping[str, Any] | None = None,
) -> float | None:
    """One-shot chandelier stop without constructing a manager."""
    return StopManager(cfg).chandelier_stop(df, direction)


def plan_stop(
    df: pd.DataFrame,
    direction: str,
    entry: float,
    sweep_price: float | None = None,
    zone: Zone | None = None,
    target: float | None = None,
    target_r: float | None = None,
    cfg: Mapping[str, Any] | None = None,
) -> StopPlan | None:
    """One-shot reconciled stop plan without constructing a manager."""
    return StopManager(cfg).plan(
        df,
        direction,
        entry,
        sweep_price=sweep_price,
        zone=zone,
        target=target,
        target_r=target_r,
    )
