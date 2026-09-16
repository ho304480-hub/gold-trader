"""src/signal_engine.py — SMC primitives + MTF bias + stop planning -> signals.

The engine is a pipeline with four gates, and every gate is a refusal
rather than a score adjustment. A setup either clears all four or it is
not emitted at all:

    1. MTF bias      the higher timeframes must not lean against the idea
    2. killzone      the setup must form inside a configured ICT window
    3. sweep         a liquidity grab must precede the change of character
    4. R:R           the reconciled stop must clear ``detectors.min_rr``

Design notes that matter downstream:

* **Direction vocabulary is split, deliberately.** :mod:`src.smc_core` and
  :mod:`src.stop_manager` speak ``BULLISH``/``BEARISH``; :class:`Signal`
  speaks ``long``/``short`` because that is what a trade log and the
  delivery layer want to print. The translation happens once, in
  :func:`_trade_side`, so no caller has to guess which dialect it holds.

* **Zones are not events.** The detectors return :class:`src.smc_core.Zone`
  objects, which carry ``formed_at`` and ``meta["index"]`` rather than a
  bare bar index. Every recency test goes through :func:`_zone_index`, which
  prefers the recorded index and falls back to a timestamp lookup, so a
  detector that stops populating ``meta`` degrades to a slower path instead
  of silently treating every zone as brand new.

* **The stop is planned before the size is computed.** Sizing needs a stop
  distance and nothing else, so a setup whose stop cannot be reconciled is
  rejected before the sizer is ever consulted. That ordering is what keeps
  ``lots`` from being a number attached to a trade that has no stop.

* **A rejected size is not a trade.** :class:`src.position_sizer.PositionSize`
  reports zero lots with a ``reason`` when the geometry cannot be sized. The
  signal is dropped rather than emitted with ``lots=0.0``, because a zero-lot
  signal is a row that will be counted as a setup and sized as nothing.

* **Killzones come from :mod:`src.utils`.** There is no ``sessions`` module
  in this package; ``utils.current_killzone`` reads the ``killzones`` block
  from the same config object the rest of the engine uses, so the live scan
  and the backtester cannot disagree about what time it is.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from .position_sizer import PositionSizer
from .smc_core import (
    BEARISH,
    BULLISH,
    CHOCH,
    MSS,
    ORDER_BLOCK,
    STOP_HUNT,
    SWING_HIGH,
    SWING_LOW,
    DetectorParams,
    Zone,
    detect_zones,
    prepare,
)
from .stop_manager import StopManager
from .trend_engine import MTFBias, TrendEngine
from .utils import cfg_get, current_killzone, setup_logging

log = setup_logging(__name__)

# ------------------------------------------------------------------
# TUNABLES
# ------------------------------------------------------------------

# Bars of history the engine needs before it will scan at all. The MTF
# blend resamples into a daily frame and scores a 200-period EMA stack on
# it, so a frame shorter than this cannot produce a bias worth gating on.
MIN_BARS = 300

# Trade-side vocabulary, as opposed to the BULLISH/BEARISH the detectors
# and the stop manager use.
LONG = "long"
SHORT = "short"

# Confluence weights. Must sum to 100 so ``score`` is a percentage; the
# assertion below is what keeps a future edit from silently rescaling it.
WEIGHT_BIAS = 25
WEIGHT_SWEEP = 20
WEIGHT_OB = 15
WEIGHT_FVG = 10
WEIGHT_RR_STRONG = 20
WEIGHT_RR_OK = 10
WEIGHT_STRUCTURAL = 10

# R:R thresholds that earn the strong / acceptable confluence bonus.
RR_STRONG = 3.0
RR_OK = 2.0

# Maximum distance, in ATR, that a swept level may sit from the entry and
# still be treated as the structural anchor for the stop. ``find_stop_hunts``
# scans back ``sweep_lookback`` bars, so on a frame where price has travelled
# the most recent sweep can be many ATR away — a level from an earlier leg
# rather than the invalidation of this trade. Anchoring to it produces a stop
# wider than the trade's own target, and every setup then dies on R:R.
DEFAULT_MAX_SWEEP_ATR = 4.0

# Structure concepts that count as a change of character. MSS is included
# because it is a CHoCH that also took the opposite extreme — strictly
# stronger evidence, not a different family.
CHOCH_CONCEPTS = (CHOCH, MSS)

# Liquidity pool concept name, as emitted by smc_core.find_liquidity_pools.
LIQUIDITY_POOL = "LIQUIDITY_POOL"

assert (
    WEIGHT_BIAS
    + WEIGHT_SWEEP
    + WEIGHT_OB
    + WEIGHT_FVG
    + WEIGHT_RR_STRONG
    + WEIGHT_STRUCTURAL
    == 100
), "confluence weights must sum to 100"


# ------------------------------------------------------------------
# RESULT TYPE
# ------------------------------------------------------------------


@dataclass(frozen=True)
class Signal:
    """One tradeable setup, fully resolved.

    ``lots`` is a real broker-steppable size, never zero: a setup whose
    stop cannot be sized is dropped by the engine rather than emitted with
    a zero lot count. ``reasons`` is the human-readable confluence trail,
    and ``score`` is its weighted sum.
    """

    time: pd.Timestamp
    symbol: str
    direction: str
    entry: float
    stop: float
    target: float
    rr: float
    lots: float
    score: int
    reasons: tuple[str, ...] = ()
    stop_method: str = ""
    risk_amount: float = 0.0
    risk_budget: float = 0.0
    bias: float = 0.0
    killzone: str | None = None

    @property
    def is_long(self) -> bool:
        return self.direction == LONG

    @property
    def stop_distance(self) -> float:
        """Risk in price units."""
        return abs(self.entry - self.stop)

    @property
    def risk_pct_of_budget(self) -> float:
        """Fraction of the risk budget this position actually consumes."""
        if self.risk_budget <= 0:
            return 0.0
        return self.risk_amount / self.risk_budget

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe payload for the backtester report and the API."""
        return {
            "time": self.time.isoformat(),
            "symbol": self.symbol,
            "direction": self.direction,
            "entry": self.entry,
            "stop": self.stop,
            "target": self.target,
            "rr": self.rr,
            "lots": self.lots,
            "score": self.score,
            "reasons": list(self.reasons),
            "stop_method": self.stop_method,
            "risk_amount": self.risk_amount,
            "risk_budget": self.risk_budget,
            "bias": self.bias,
            "killzone": self.killzone,
        }


# ------------------------------------------------------------------
# HELPERS
# ------------------------------------------------------------------


def _trade_side(direction: str) -> str:
    """Map a detector direction onto the trade-side vocabulary.

    Raises rather than guessing, because a silent fallback here would label
    every unrecognised direction as a short.
    """
    if direction == BULLISH:
        return LONG
    if direction == BEARISH:
        return SHORT
    raise ValueError(f"unknown detector direction: {direction!r}")


def _zone_index(zone: Zone, frame: pd.DataFrame) -> int | None:
    """Bar position of ``zone`` in ``frame``, or None when it is not in it.

    ``meta["index"]`` is the detector's own record and is preferred because
    it survives a frame whose index has been re-sliced. The timestamp
    lookup is the fallback for a zone built by a detector that does not
    populate ``meta``.
    """
    recorded = zone.meta.get("index") if isinstance(zone.meta, Mapping) else None
    if isinstance(recorded, (int, np.integer)) and 0 <= int(recorded) < len(frame):
        return int(recorded)

    try:
        position = frame.index.get_indexer([pd.Timestamp(zone.formed_at)])[0]
    except (TypeError, ValueError):
        return None
    return int(position) if position >= 0 else None


def _last_finite(series: pd.Series | None) -> float | None:
    """Last finite value of ``series``, or None.

    ``.iloc[-1]`` is the wrong tool: every indicator in this package emits
    NaN through warm-up, and a frame whose final bar is still warming up
    would otherwise poison the entry price.
    """
    if series is None or len(series) == 0:
        return None
    cleaned = pd.to_numeric(series, errors="coerce").dropna()
    if cleaned.empty:
        return None
    value = float(cleaned.iloc[-1])
    return value if np.isfinite(value) else None


# ------------------------------------------------------------------
# ENGINE
# ------------------------------------------------------------------


class SignalEngine:
    """Scans a prepared frame and returns the setups that cleared every gate.

    Constructed once per run from the resolved config. The engine holds no
    per-scan state, so the same instance can be reused across timeframes
    and across a replay without carrying a position between calls.
    """

    def __init__(
        self,
        cfg: Mapping[str, Any] | None = None,
        params: DetectorParams | None = None,
    ) -> None:
        self.cfg: Mapping[str, Any] = cfg or {}
        self.params = params or DetectorParams.from_config(self.cfg)

        self.symbol = str(cfg_get(self.cfg, "instrument.symbol", "XAUUSD"))

        # Gate thresholds. ``require_*`` flags default to True so a config
        # that omits them gets the strict behaviour rather than the loose one.
        self.require_htf_bias = bool(
            cfg_get(self.cfg, "signal_engine.require_htf_bias", True)
        )
        self.require_killzone = bool(
            cfg_get(self.cfg, "signal_engine.require_killzone", True)
        )
        self.require_sweep = bool(cfg_get(self.cfg, "signal_engine.require_sweep", True))
        self.min_rr = float(cfg_get(self.cfg, "detectors.min_rr", 2.0))
        self.min_score = int(cfg_get(self.cfg, "signal_engine.min_score", 50))
        self.choch_lookback = int(cfg_get(self.cfg, "signal_engine.choch_lookback", 20))
        self.sweep_lookback = int(cfg_get(self.cfg, "signal_engine.sweep_lookback", 50))
        self.min_coverage = float(
            cfg_get(self.cfg, "signal_engine.min_bias_coverage", 0.5)
        )
        self.max_sweep_atr = float(
            cfg_get(self.cfg, "signal_engine.max_sweep_atr", DEFAULT_MAX_SWEEP_ATR)
        )

        self.trend = TrendEngine(config=self.cfg)
        self.stops = StopManager(self.cfg)
        self.sizer = PositionSizer(config=self.cfg)

    # ---- scan -----------------------------------------------------

    def scan(self, df: pd.DataFrame) -> list[Signal]:
        """Every setup in the final bar of ``df`` that cleared all four gates.

        ``df`` is validated and enriched here rather than by the caller, so
        a raw OHLCV frame is accepted and a frame that is already prepared
        is not prepared twice.
        """
        signals: list[Signal] = []

        if df is None or len(df) < MIN_BARS:
            log.warning(
                "not enough bars to scan (%d < %d)",
                0 if df is None else len(df),
                MIN_BARS,
            )
            return signals

        frame = prepare(df, self.params)

        # ---- gate 1: MTF bias -------------------------------------
        bias = self.trend.mtf_bias(frame)
        if self.require_htf_bias:
            long_ok = self.trend.allows(BULLISH, bias, self.min_coverage)
            short_ok = self.trend.allows(BEARISH, bias, self.min_coverage)
            if not long_ok and not short_ok:
                log.info(
                    "MTF bias blocks both sides (%.3f) — no trades this scan", bias.bias
                )
                return signals

        # ---- detection pass ---------------------------------------
        zones = detect_zones(frame, self.params, self.cfg)
        if not zones:
            log.info("no zones detected — no trades this scan")
            return signals

        last_idx = len(frame) - 1
        entry = _last_finite(frame["close"])
        if entry is None:
            log.warning("final close is not finite — no trades this scan")
            return signals

        choch_zones = self._recent_choch(zones, frame, last_idx)
        sweeps = self._recent_sweeps(zones, frame, last_idx)

        # Two CHoCHs on the same leg resolve to the same sweep, the same order
        # block and therefore the same entry, stop and target. That is one
        # setup, not two, so the geometry is tracked and a repeat is skipped
        # rather than emitted as a second identical row.
        seen: set[tuple[str, float, float, float]] = set()

        for choch in choch_zones:
            direction = choch.direction
            if direction not in (BULLISH, BEARISH):
                continue

            # Bias must agree with the CHoCH direction.
            if not self.trend.allows(direction, bias, self.min_coverage):
                continue

            # ---- gate 2: killzone ---------------------------------
            killzone = current_killzone(frame.index[last_idx], self.cfg)
            if self.require_killzone and killzone is None:
                continue

            # ---- gate 3: sweep ------------------------------------
            sweep = self._matching_sweep(sweeps, direction, choch, frame)
            if self.require_sweep and sweep is None:
                continue

            ob = self._matching_zone(zones, ORDER_BLOCK, direction, choch, frame)
            fvg = self._matching_fvg(zones, direction, choch, frame)

            sweep_price = self._sweep_price(sweep, frame, last_idx, direction)

            # ---- gate 4: R:R --------------------------------------
            target = self._next_target(zones, direction, entry, frame)
            if target is None:
                continue

            plan = self.stops.plan(
                frame,
                direction,
                entry,
                sweep_price=sweep_price,
                zone=ob,
                target=target,
            )
            if plan is None or not plan.is_valid:
                continue
            if plan.rr < self.min_rr:
                continue

            # ---- sizing -------------------------------------------
            size = self.sizer.size_for_plan(plan)
            if not size.is_valid:
                log.debug(
                    "setup dropped: %s at %.2f (stop %.2f)",
                    size.reason,
                    entry,
                    plan.stop,
                )
                continue

            score, reasons = self._score(direction, bias, sweep, ob, fvg, plan)
            if score < self.min_score:
                continue

            key = (direction, round(float(entry), 6), round(float(plan.stop), 6),
                   round(float(plan.target), 6))
            if key in seen:
                log.debug("setup already emitted for this leg; skipping duplicate")
                continue
            seen.add(key)

            signals.append(
                Signal(
                    time=frame.index[last_idx],
                    symbol=self.symbol,
                    direction=_trade_side(direction),
                    entry=float(entry),
                    stop=float(plan.stop),
                    target=float(plan.target),
                    rr=float(plan.rr),
                    lots=float(size.lots),
                    score=int(score),
                    reasons=tuple(reasons),
                    stop_method=plan.method,
                    risk_amount=float(size.risk_amount),
                    risk_budget=float(size.risk_budget),
                    bias=float(bias.bias),
                    killzone=killzone,
                )
            )

        log.info("scan produced %d signal(s) from %d zone(s)", len(signals), len(zones))
        return signals

    # ---- recency --------------------------------------------------

    def _recent_choch(
        self, zones: Sequence[Zone], frame: pd.DataFrame, last_idx: int
    ) -> list[Zone]:
        """Change-of-character zones formed within ``choch_lookback`` bars."""
        floor = last_idx - self.choch_lookback
        found: list[Zone] = []
        for zone in zones:
            if zone.concept not in CHOCH_CONCEPTS:
                continue
            index = _zone_index(zone, frame)
            if index is not None and index >= floor:
                found.append(zone)
        return found

    def _recent_sweeps(
        self, zones: Sequence[Zone], frame: pd.DataFrame, last_idx: int
    ) -> list[Zone]:
        """Stop-hunt zones formed within ``sweep_lookback`` bars."""
        floor = last_idx - self.sweep_lookback
        found: list[Zone] = []
        for zone in zones:
            if zone.concept != STOP_HUNT:
                continue
            index = _zone_index(zone, frame)
            if index is not None and index >= floor:
                found.append(zone)
        return found

    # ---- matching -------------------------------------------------

    def _matching_sweep(
        self,
        sweeps: Sequence[Zone],
        direction: str,
        choch: Zone,
        frame: pd.DataFrame,
    ) -> Zone | None:
        """The most recent sweep of the right side that preceded ``choch``.

        A bullish CHoCH needs a swept low (sell-side liquidity taken), a
        bearish one a swept high. The sweep must come *before* the break —
        a sweep that happens after the change of character is the market
        reacting to the break, not the cause of it.
        """
        choch_index = _zone_index(choch, frame)
        if choch_index is None:
            return None

        candidates: list[tuple[int, Zone]] = []
        for sweep in sweeps:
            if sweep.direction != direction:
                continue
            swept = sweep.meta.get("swept_level") if isinstance(sweep.meta, Mapping) else None
            if swept is None:
                continue
            index = _zone_index(sweep, frame)
            if index is None or index >= choch_index:
                continue
            candidates.append((index, sweep))

        if not candidates:
            return None
        return max(candidates, key=lambda pair: pair[0])[1]

    def _matching_zone(
        self,
        zones: Sequence[Zone],
        concept: str,
        direction: str,
        choch: Zone,
        frame: pd.DataFrame,
    ) -> Zone | None:
        """Most recent zone of ``concept`` on ``direction`` before ``choch``."""
        choch_index = _zone_index(choch, frame)
        if choch_index is None:
            return None

        candidates: list[tuple[int, Zone]] = []
        for zone in zones:
            if zone.concept != concept or zone.direction != direction:
                continue
            index = _zone_index(zone, frame)
            if index is None or index >= choch_index:
                continue
            candidates.append((index, zone))

        if not candidates:
            return None
        return max(candidates, key=lambda pair: pair[0])[1]

    def _matching_fvg(
        self, zones: Sequence[Zone], direction: str, choch: Zone, frame: pd.DataFrame
    ) -> Zone | None:
        """Most recent fair value gap on ``direction`` before ``choch``."""
        return self._matching_zone(zones, "FVG", direction, choch, frame)

    # ---- levels ---------------------------------------------------

    def _sweep_price(
        self,
        sweep: Zone | None,
        frame: pd.DataFrame,
        last_idx: int,
        direction: str,
    ) -> float:
        """Price the structural stop is built from.

        The swept level when a sweep was found *and it is close enough to
        the entry to be the wick this trade is sitting on*, otherwise the
        current bar's own extreme.

        The proximity test matters more than it looks. ``find_stop_hunts``
        scans back ``sweep_lookback`` bars, so on a frame where price has
        travelled, the most recent sweep can sit many ATR below the entry.
        Anchoring the structural stop to it produces a stop that is wider
        than the trade's own target, and every setup is then rejected on
        R:R for a reason that has nothing to do with the setup. A sweep
        further than ``max_sweep_atr`` ATR away is a level from an earlier
        leg, not the invalidation of this one.
        """
        atr_now = self.stops.atr_value(frame)
        max_distance = None
        if atr_now is not None and atr_now > 0:
            max_distance = self.max_sweep_atr * atr_now

        if sweep is not None:
            level = self._sweep_level(sweep)
            if level is not None:
                if max_distance is None or abs(level - self._entry_price(frame, last_idx)) <= max_distance:
                    return level

        column = "low" if direction == BULLISH else "high"
        fallback = _last_finite(frame[column])
        if fallback is None:
            return float(frame[column].iloc[last_idx])
        return fallback

    @staticmethod
    def _sweep_level(sweep: Zone) -> float | None:
        """The swept price recorded on a stop-hunt zone, or None."""
        swept = sweep.meta.get("swept_level") if isinstance(sweep.meta, Mapping) else None
        if isinstance(swept, (int, float, np.floating)) and np.isfinite(float(swept)):
            return float(swept)
        if sweep.ref_price is not None and np.isfinite(float(sweep.ref_price)):
            return float(sweep.ref_price)
        return None

    @staticmethod
    def _entry_price(frame: pd.DataFrame, last_idx: int) -> float:
        """The entry the scan is sizing against: the final close."""
        value = _last_finite(frame["close"])
        if value is None:
            return float(frame["close"].iloc[last_idx])
        return value

    def _next_target(
        self,
        zones: Sequence[Zone],
        direction: str,
        entry: float,
        frame: pd.DataFrame | None = None,
    ) -> float | None:
        """Nearest opposing liquidity pool far enough beyond ``entry`` to pay.

        Buyside pools sit above price and are the target for a long;
        sell-side pools sit below and are the target for a short. The pool's
        ``ref_price`` is the level itself, which is what price is drawn to —
        the band edges are the tolerance, not the magnet.

        A pool that sits *on* the entry is not a target. ``find_liquidity_pools``
        emits a pool on every bar whose high matches its neighbour, so on a
        quiet stretch the most recent pool is routinely the current price.
        Returning it would hand the stop manager a reward of zero and every
        setup would be rejected on R:R for a reason that has nothing to do
        with the setup.

        The margin is derived from the stop families rather than fixed,
        because ``StopManager.plan`` reconciles by taking the *wider* of
        structural and ATR. The ATR family guarantees ``atr_mult`` ATR of
        risk; the structural family can be wider, and when it wins the reward
        has to clear ``min_rr`` against that larger risk instead. A margin
        sized only for the ATR stop under-sizes it whenever the structural
        stop wins, which is the common case once price has travelled away
        from the sweep. ``stop_buffer_atr`` is added because the structural
        stop sits that far beyond the zone edge.
        """
        atr_now = self.stops.atr_value(frame) if frame is not None else None
        margin = 0.0
        if atr_now is not None and atr_now > 0:
            atr_risk = self.stops.atr_mult * atr_now
            structural_floor = (self.stops.atr_mult + self.stops.stop_buffer_atr) * atr_now
            margin = max(atr_risk, structural_floor) * self.min_rr

        levels: list[float] = []
        for zone in zones:
            if zone.concept != LIQUIDITY_POOL:
                continue
            level = zone.ref_price
            if level is None or not np.isfinite(float(level)):
                continue
            levels.append(float(level))

        if direction == BULLISH:
            above = [level for level in levels if level > entry + margin]
            return min(above) if above else None

        below = [level for level in levels if level < entry - margin]
        return max(below) if below else None

    # ---- scoring --------------------------------------------------

    def _score(
        self,
        direction: str,
        bias: MTFBias,
        sweep: Zone | None,
        ob: Zone | None,
        fvg: Zone | None,
        plan: Any,
    ) -> tuple[int, list[str]]:
        """Weighted confluence score, capped at 100, with its reasons."""
        score = 0
        reasons: list[str] = []

        if bias.direction == _trade_side(direction):
            score += WEIGHT_BIAS
            reasons.append(f"MTF bias aligned ({bias.bias:.2f})")

        if sweep is not None:
            score += WEIGHT_SWEEP
            reasons.append(f"Liquidity sweep ({sweep.sub_concept or sweep.concept})")

        if ob is not None:
            score += WEIGHT_OB
            reasons.append("Order block present")

        if fvg is not None:
            score += WEIGHT_FVG
            reasons.append("FVG present")

        if plan.rr >= RR_STRONG:
            score += WEIGHT_RR_STRONG
            reasons.append(f"R:R {plan.rr:.2f}")
        elif plan.rr >= RR_OK:
            score += WEIGHT_RR_OK
            reasons.append(f"R:R {plan.rr:.2f}")

        if plan.method == "structural":
            score += WEIGHT_STRUCTURAL
            reasons.append("Structural stop")

        return min(score, 100), reasons

    # ---- introspection --------------------------------------------

    def as_dict(self) -> dict[str, Any]:
        """Resolved settings, for a run header or a trade log."""
        return {
            "symbol": self.symbol,
            "require_htf_bias": self.require_htf_bias,
            "require_killzone": self.require_killzone,
            "require_sweep": self.require_sweep,
            "min_rr": self.min_rr,
            "min_score": self.min_score,
            "choch_lookback": self.choch_lookback,
            "sweep_lookback": self.sweep_lookback,
            "min_bias_coverage": self.min_coverage,
            "max_sweep_atr": self.max_sweep_atr,
            "detectors": self.params.as_dict(),
            "stops": self.stops.as_dict(),
            "sizer": self.sizer.as_dict(),
        }


# ------------------------------------------------------------------
# MODULE-LEVEL WRAPPER
# ------------------------------------------------------------------


def scan(df: pd.DataFrame, cfg: Mapping[str, Any] | None = None) -> list[Signal]:
    """One-shot scan without holding an engine."""
    return SignalEngine(cfg).scan(df)
