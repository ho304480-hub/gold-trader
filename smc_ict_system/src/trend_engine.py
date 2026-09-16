"""src/trend_engine.py — multi-timeframe trend scoring and bias gating.

Collapses five independent trend readings into one normalized score per
timeframe, then weights those timeframes into a single directional bias.
The bias is the gate the signal engine consults before it lets a lower
timeframe setup through: a 15m long is only tradeable when the daily and
4h context are not leaning the other way.

Design notes that matter downstream:

* Every component is bounded to -1..+1 so the weighted sum is bounded too.
  A component that can run to infinity (a raw regression slope on gold at
  $2,400 is routinely in the tens) would silently dominate the blend.
* Warm-up is NaN, not zero. A timeframe that has not seen enough bars
  returns ``None`` rather than a neutral 0.0, and ``mtf_bias`` renormalizes
  over the timeframes that actually answered. Scoring a 200-bar EMA stack
  off 40 bars of data and calling the result "neutral" is worse than
  admitting the timeframe has no opinion.
* ``direction`` from :func:`utils.supertrend` is nullable ``Int64``. It is
  ``pd.NA`` through warm-up, so it is coerced through a NaN-safe path
  rather than ``float()``, which raises on ``pd.NA``.

The indicator primitives live in :mod:`src.utils`; this module only
composes them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

import numpy as np
import pandas as pd

from .utils import (
    TimeframeSpec,
    adx,
    donchian_position,
    ema,
    resample_ohlc,
    rolling_slope,
    setup_logging,
    supertrend,
    timeframe_specs,
)

log = setup_logging(__name__)

# ------------------------------------------------------------------
# TUNABLES
# ------------------------------------------------------------------

# Minimum bars before a timeframe is allowed to express an opinion. The
# longest lookback in the component set is the 200-period EMA, so anything
# shorter than this cannot produce a complete EMA stack.
MIN_BARS = 200

# Component weights within a single timeframe. Must sum to 1.0; asserted
# at import so a future edit cannot silently rescale the score.
COMPONENT_WEIGHTS: dict[str, float] = {
    "ema_stack": 0.30,
    "adx_di": 0.20,
    "supertrend": 0.25,
    "linreg": 0.15,
    "donchian": 0.10,
}

# Default timeframe weights. Higher timeframes dominate: the daily sets
# the regime, the 4h confirms it, the 1h times the entry.
DEFAULT_TF_WEIGHTS: dict[str, float] = {"1D": 0.5, "4h": 0.3, "1h": 0.2}

# ADX regime thresholds. Above TREND_ADX the directional reading is taken
# at full strength, below CHOP_ADX it is discarded entirely, and the band
# between the two is a half-strength reading.
TREND_ADX = 25.0
CHOP_ADX = 20.0

# Bias thresholds for the final direction label.
BIAS_BULLISH = 0.5
BIAS_BEARISH = -0.5

# Slope normalization: the regression slope is expressed as a fraction of
# price per bar, then scaled so a move of SLOPE_FULL_SCALE of price per
# bar saturates the component. 0.001 = 0.1% per bar, which is a strong
# sustained trend on any of the timeframes this engine scores.
SLOPE_FULL_SCALE = 0.001

assert abs(sum(COMPONENT_WEIGHTS.values()) - 1.0) < 1e-9, "component weights must sum to 1.0"


# ------------------------------------------------------------------
# RESULT TYPES
# ------------------------------------------------------------------


@dataclass(frozen=True)
class TrendScore:
    """One timeframe's trend reading.

    ``score`` is None when the timeframe could not be scored (too few
    bars, or every component came back NaN). ``components`` is empty in
    that case. A None score is not neutral — it is absent, and
    :meth:`TrendEngine.mtf_bias` excludes it from the blend rather than
    letting it dilute the result.
    """

    timeframe: str
    score: float | None
    components: dict[str, float] = field(default_factory=dict)
    bars: int = 0

    @property
    def is_scored(self) -> bool:
        return self.score is not None

    @property
    def direction(self) -> str:
        """Coarse label for this timeframe alone."""
        if self.score is None:
            return "unknown"
        if self.score > BIAS_BULLISH:
            return "bullish"
        if self.score < BIAS_BEARISH:
            return "bearish"
        return "neutral"


@dataclass(frozen=True)
class MTFBias:
    """Weighted multi-timeframe bias plus the per-timeframe breakdown."""

    bias: float
    direction: str
    per_timeframe: dict[str, float | None]
    components: dict[str, dict[str, float]]
    weights_used: dict[str, float]
    coverage: float

    def as_dict(self) -> dict[str, Any]:
        """JSON-safe payload for the backtester report and the API."""
        return {
            "bias": self.bias,
            "direction": self.direction,
            "per_timeframe": dict(self.per_timeframe),
            "components": {tf: dict(c) for tf, c in self.components.items()},
            "weights_used": dict(self.weights_used),
            "coverage": self.coverage,
        }


# ------------------------------------------------------------------
# HELPERS
# ------------------------------------------------------------------


def _last_finite(series: pd.Series) -> float | None:
    """Last non-NaN value of ``series``, or None when there is none.

    ``.iloc[-1]`` is the wrong tool here: every indicator in this package
    emits NaN through warm-up, and a frame whose final bar is still
    warming up would otherwise poison the whole score.
    """
    if series is None or len(series) == 0:
        return None
    cleaned = series.dropna()
    if cleaned.empty:
        return None
    value = cleaned.iloc[-1]
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if np.isfinite(value) else None


def _rule_for(spec: TimeframeSpec) -> str:
    """Pandas resample rule for a timeframe spec.

    ``resample_ohlc`` takes a rule string, not a label, so the spec's
    ``seconds`` is converted to the coarsest exact pandas offset that
    matches it. Daily and above use calendar offsets so DST and weekend
    gaps do not shift the bucket boundary.
    """
    seconds = int(spec.seconds)
    if seconds % 86400 == 0:
        days = seconds // 86400
        return "1D" if days == 1 else f"{days}D"
    if seconds % 3600 == 0:
        return f"{seconds // 3600}h"
    if seconds % 60 == 0:
        return f"{seconds // 60}min"
    return f"{seconds}s"


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


# ------------------------------------------------------------------
# ENGINE
# ------------------------------------------------------------------


class TrendEngine:
    """Normalized trend score per timeframe, and a weighted MTF bias.

    ``weights`` maps timeframe labels to relative importance. Labels must
    exist in the config's ``timeframes`` block, because the engine needs
    each label's ``seconds`` to resample the base frame. Unknown labels
    are dropped with a warning rather than raising, so a config that
    renames a timeframe degrades to a smaller blend instead of a crash.
    """

    def __init__(
        self,
        weights: Mapping[str, float] | None = None,
        config: Mapping[str, Any] | None = None,
        specs: Mapping[str, TimeframeSpec] | None = None,
    ) -> None:
        self.weights: dict[str, float] = dict(weights or DEFAULT_TF_WEIGHTS)
        self.specs: dict[str, TimeframeSpec] = dict(
            specs if specs is not None else timeframe_specs(config or {})
        )

        unknown = [tf for tf in self.weights if tf not in self.specs]
        if unknown:
            log.warning(
                "TrendEngine: dropping timeframes absent from config: %s", ", ".join(unknown)
            )
            for tf in unknown:
                self.weights.pop(tf, None)

        if not self.weights:
            raise ValueError("TrendEngine has no usable timeframes; check config['timeframes']")

    # ------------------------------------------------------------------
    # Single timeframe
    # ------------------------------------------------------------------

    def score_timeframe(self, frame: pd.DataFrame, tf_name: str) -> TrendScore:
        """Score one timeframe's frame. Returns an unscored result when short."""
        if frame is None or frame.empty:
            return TrendScore(tf_name, None, {}, 0)

        bars = int(len(frame))
        if bars < MIN_BARS:
            log.debug(
                "TrendEngine: %s has %d bars, needs %d — unscored", tf_name, bars, MIN_BARS
            )
            return TrendScore(tf_name, None, {}, bars)

        close = frame["close"]
        components: dict[str, float] = {}

        # 1. EMA stack — full alignment only. A tangled stack is no trend.
        e20 = _last_finite(ema(close, 20))
        e50 = _last_finite(ema(close, 50))
        e200 = _last_finite(ema(close, 200))
        if e20 is None or e50 is None or e200 is None:
            components["ema_stack"] = 0.0
        elif e20 > e50 > e200:
            components["ema_stack"] = 1.0
        elif e20 < e50 < e200:
            components["ema_stack"] = -1.0
        else:
            components["ema_stack"] = 0.0

        # 2. ADX + DI — directional reading scaled by trend strength.
        adx_frame = adx(frame, 14)
        adx_val = _last_finite(adx_frame["adx"])
        plus_di = _last_finite(adx_frame["plus_di"])
        minus_di = _last_finite(adx_frame["minus_di"])
        if adx_val is None or plus_di is None or minus_di is None:
            # Warm-up. Previously this fell through to the half-strength
            # branch and reported a confident +/-0.5 from no data at all.
            components["adx_di"] = 0.0
        else:
            sign = 1.0 if plus_di > minus_di else -1.0
            if adx_val > TREND_ADX:
                components["adx_di"] = sign
            elif adx_val < CHOP_ADX:
                components["adx_di"] = 0.0
            else:
                components["adx_di"] = sign * 0.5

        # 3. Supertrend direction. Nullable Int64 -> NaN-safe coercion.
        st_frame = supertrend(frame, 10, 3.0)
        st_dir = _last_finite(st_frame["direction"].astype("Float64"))
        components["supertrend"] = 0.0 if st_dir is None else _clamp(st_dir)

        # 4. Regression slope, normalized by price.
        #    rolling_slope is not price-normalized, so a raw slope on gold
        #    is in dollars per bar. Dividing by the last close turns it
        #    into a per-bar return, which is comparable across instruments
        #    and across timeframes.
        slope = _last_finite(rolling_slope(close, 50))
        last_close = _last_finite(close)
        if slope is None or last_close is None or last_close == 0.0:
            components["linreg"] = 0.0
        else:
            components["linreg"] = _clamp((slope / last_close) / SLOPE_FULL_SCALE)

        # 5. Donchian position — 0..1 mapped to -1..+1.
        dp = _last_finite(donchian_position(frame, 20))
        components["donchian"] = 0.0 if dp is None else _clamp((dp - 0.5) * 2.0)

        score = float(sum(components[k] * COMPONENT_WEIGHTS[k] for k in COMPONENT_WEIGHTS))
        return TrendScore(tf_name, score, components, bars)

    # ------------------------------------------------------------------
    # Multi-timeframe
    # ------------------------------------------------------------------

    def mtf_bias(self, ltf_df: pd.DataFrame) -> MTFBias:
        """Resample ``ltf_df`` into each configured timeframe and blend.

        Timeframes that could not be scored are excluded from both the
        numerator and the denominator, so a short history on one frame
        does not drag the bias toward zero. ``coverage`` reports what
        fraction of the configured weight actually answered.
        """
        scores: dict[str, TrendScore] = {}
        for tf in self.weights:
            spec = self.specs[tf]
            htf_df = resample_ohlc(ltf_df, _rule_for(spec))
            scores[tf] = self.score_timeframe(htf_df, tf)

        scored = {tf: s for tf, s in scores.items() if s.is_scored}
        weight_sum = sum(self.weights[tf] for tf in scored)
        configured_sum = sum(self.weights.values())

        if weight_sum > 0.0:
            bias = sum(scores[tf].score * self.weights[tf] for tf in scored) / weight_sum
        else:
            bias = 0.0

        coverage = weight_sum / configured_sum if configured_sum else 0.0

        if bias > BIAS_BULLISH:
            direction = "bullish"
        elif bias < BIAS_BEARISH:
            direction = "bearish"
        else:
            direction = "neutral"

        log.info(
            "MTF bias = %.3f (%s) | coverage %.0f%% | %s",
            bias,
            direction,
            coverage * 100.0,
            {tf: (round(s.score, 2) if s.is_scored else None) for tf, s in scores.items()},
        )

        return MTFBias(
            bias=float(bias),
            direction=direction,
            per_timeframe={tf: s.score for tf, s in scores.items()},
            components={tf: dict(s.components) for tf, s in scores.items()},
            weights_used={tf: self.weights[tf] for tf in scored},
            coverage=float(coverage),
        )

    # ------------------------------------------------------------------
    # Gating
    # ------------------------------------------------------------------

    def allows(self, direction: str, bias: MTFBias, min_coverage: float = 0.5) -> bool:
        """Whether the MTF context permits a trade in ``direction``.

        This is the gate, not the signal. A long is blocked when the bias
        is bearish; a neutral bias permits both sides. When coverage is
        below ``min_coverage`` the context is too thin to gate on and the
        trade is allowed through — the caller's own confluence score is
        then the only filter, which is the honest outcome for a frame
        with no higher-timeframe history.
        """
        if bias.coverage < min_coverage:
            log.debug(
                "MTF gate: coverage %.2f below %.2f — not gating", bias.coverage, min_coverage
            )
            return True

        wanted = direction.lower()
        if wanted in ("long", "bullish", "buy"):
            return bias.direction != "bearish"
        if wanted in ("short", "bearish", "sell"):
            return bias.direction != "bullish"
        raise ValueError(f"unknown trade direction: {direction!r}")


def score_timeframe(frame: pd.DataFrame, tf_name: str, **kwargs: Any) -> TrendScore:
    """Module-level convenience wrapper around :meth:`TrendEngine.score_timeframe`."""
    return TrendEngine(**kwargs).score_timeframe(frame, tf_name)


def mtf_bias(ltf_df: pd.DataFrame, **kwargs: Any) -> MTFBias:
    """Module-level convenience wrapper around :meth:`TrendEngine.mtf_bias`."""
    return TrendEngine(**kwargs).mtf_bias(ltf_df)
