"""src/utils.py — shared helpers for the SMC/ICT signal engine.

Everything that more than one module needs lives here: config loading,
logging, time/session maths, ATR, hashing and small numeric helpers.
No module in this package builds its own logger or reads YAML directly.

Config resolution order:
    1. SMC_CONFIG env var (absolute or relative path to a YAML file)
    2. <package root>/config.yaml
    3. built-in DEFAULTS dict

Secrets are never read from YAML. Database credentials, the Telegram bot
token and SMTP credentials come from the project-root .env, which is the
same file the Node API and the Python collectors read.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd
import yaml
from dotenv import load_dotenv

# ------------------------------------------------------------------
# PATHS
# ------------------------------------------------------------------

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = PACKAGE_ROOT.parent

# The collectors and the Node API both load <project root>/.env. Loading it
# here means one credential file for the whole terminal.
load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_CONFIG_PATH = PACKAGE_ROOT / "config.yaml"

UTC = timezone.utc

# ------------------------------------------------------------------
# DEFAULTS
# ------------------------------------------------------------------
# Kept deliberately small: only the values the engine cannot run without.
# Anything else missing from config.yaml falls back to the module-level
# constant that owns it (e.g. PIVOT_STRENGTH in smc_core).

DEFAULTS: dict[str, Any] = {
    "instrument": {
        "symbol": "XAUUSD",
        "yahoo_ticker": "GC=F",
        "quote_currency": "USD",
        "point_value": 1.0,
        "contract_size": 100,
        "min_lot": 0.01,
        "lot_step": 0.01,
        "max_lot": 100.0,
    },
    "timeframes": {
        "1m": {"yahoo_interval": "1m", "range": "5d", "tf_rank": 1, "seconds": 60},
        "5m": {"yahoo_interval": "5m", "range": "1mo", "tf_rank": 2, "seconds": 300},
        "15m": {"yahoo_interval": "15m", "range": "1mo", "tf_rank": 3, "seconds": 900},
        "1h": {"yahoo_interval": "60m", "range": "1y", "tf_rank": 4, "seconds": 3600},
        "4h": {"yahoo_interval": "60m", "range": "1y", "tf_rank": 5, "seconds": 14400},
        "1D": {"yahoo_interval": "1d", "range": "5y", "tf_rank": 6, "seconds": 86400},
    },
    "active_timeframes": ["5m", "15m", "1h", "4h", "1D"],
    "data": {
        # Which backend load_timeframe() reads from:
        #   yahoo  — the v8 chart endpoint (default, no extra deps)
        #   csv    — a local file at data.csv_path
        #   mt5    — a running MetaTrader 5 terminal (Windows only)
        "source": "yahoo",
        "csv_path": None,
    },
    "detectors": {
        "pivot_strength": 2,
        "equal_level_tol_pct": 0.0006,
        "min_fvg_atr": 0.15,
        "atr_period": 14,
        "displacement_atr": 1.0,
        "ob_lookback": 20,
        "sweep_lookback": 50,
        "min_rr": 2.0,
        "max_zone_age_bars": 300,
    },
    "sessions": {
        "asia": {"start": "00:00", "end": "07:00"},
        "london": {"start": "07:00", "end": "13:00"},
        "ny": {"start": "13:00", "end": "21:00"},
        "overlap": {"start": "13:00", "end": "16:00"},
        "closed": {"start": "21:00", "end": "00:00"},
    },
    "killzones": {
        "asia_range": {"start": "00:00", "end": "03:00"},
        "london_open": {"start": "07:00", "end": "10:00"},
        "ny_am": {"start": "13:00", "end": "16:00"},
        "ny_pm": {"start": "17:00", "end": "20:00"},
    },
    "risk": {
        "account_equity": 10000.0,
        "risk_per_trade_pct": 0.5,
        "max_daily_loss_pct": 2.0,
        "max_open_positions": 3,
        "max_positions_per_direction": 2,
        "max_correlated_exposure_pct": 1.5,
        "min_stop_points": 1.5,
        "stop_buffer_atr": 0.25,
        "target_r_multiples": [1.0, 2.0, 3.0],
        "partial_close_pct": [0.4, 0.3, 0.3],
        "breakeven_at_r": 1.0,
        "trail_after_r": 1.5,
        "trail_atr_multiple": 1.5,
        "kelly_fraction_cap": 0.25,
        "news_blackout_minutes": 30,
    },
    "signal_engine": {
        "min_conviction": 0.55,
        "min_confluence": 2,
        "htf_required": True,
        "weights": {
            "structure": 0.30,
            "zone": 0.25,
            "liquidity": 0.15,
            "session": 0.10,
            "intermarket": 0.12,
            "fundamental": 0.08,
        },
        "veto": {
            "stale_feed": True,
            "wide_spread": True,
            "news_blackout": True,
            "counter_htf": True,
        },
    },
    "backtest": {
        "initial_equity": 10000.0,
        "commission_per_lot": 7.0,
        "slippage_points": 0.20,
        "spread_points": 0.30,
        "max_bars_in_trade": 200,
        "walk_forward_splits": 4,
        "monte_carlo_runs": 1000,
        "monte_carlo_confidence": 0.95,
    },
    "delivery": {
        "enabled": False,
        "channels": ["console"],
        "min_conviction": 0.65,
        "min_rr": 2.0,
        "dedupe_minutes": 30,
        "file": {"path": "signals.jsonl"},
        "telegram": {"parse_mode": "HTML", "disable_notification": False},
        "email": {"subject_prefix": "[XAUUSD]", "recipients": []},
        "webhook": {"url": "", "timeout_seconds": 10},
    },
    "logging": {
        "level": "INFO",
        "format": "%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
        "date_format": "%Y-%m-%d %H:%M:%S",
    },
}


# ------------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------------


def _deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    """Recursively merge override into base, returning a new dict.

    Lists are replaced wholesale rather than concatenated — a config that
    says ``target_r_multiples: [1, 2]`` means exactly that, not "the
    defaults plus two more".
    """
    merged: dict[str, Any] = dict(base)
    for key, value in override.items():
        if key in merged and isinstance(merged[key], Mapping) and isinstance(value, Mapping):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def config_path() -> Path:
    """Resolve which YAML file to read, honouring SMC_CONFIG."""
    override = os.getenv("SMC_CONFIG")
    if override:
        candidate = Path(override)
        if not candidate.is_absolute():
            candidate = PROJECT_ROOT / candidate
        return candidate
    return DEFAULT_CONFIG_PATH


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """Load config.yaml merged over DEFAULTS.

    A missing file is not an error — the engine is expected to run on
    defaults out of the box. A malformed file *is* an error, because
    silently ignoring a typo'd YAML is how a risk limit gets disabled.
    """
    target = Path(path) if path is not None else config_path()

    if not target.exists():
        return json.loads(json.dumps(DEFAULTS))  # deep copy, no shared refs

    with target.open("r", encoding="utf-8") as handle:
        try:
            loaded = yaml.safe_load(handle) or {}
        except yaml.YAMLError as err:
            raise ValueError(f"config.yaml is not valid YAML: {err}") from err

    if not isinstance(loaded, Mapping):
        raise ValueError(
            f"config.yaml must contain a mapping at the top level, got {type(loaded).__name__}"
        )

    return _deep_merge(DEFAULTS, loaded)


def cfg_get(config: Mapping[str, Any], dotted: str, default: Any = None) -> Any:
    """Read a nested config value with a dotted path.

    ``cfg_get(cfg, "risk.risk_per_trade_pct", 0.5)``
    """
    node: Any = config
    for part in dotted.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return default
        node = node[part]
    return node


# ------------------------------------------------------------------
# LOGGING
# ------------------------------------------------------------------


def setup_logging(name: str, config: Mapping[str, Any] | None = None) -> logging.Logger:
    """One consistent log format across the whole package.

    Mirrors collectors/config.py so a combined run reads as a single
    stream. Idempotent: calling it twice for the same name is a no-op.
    """
    log_cfg = (config or {}).get("logging", DEFAULTS["logging"])
    level_name = os.getenv("SMC_LOG_LEVEL", str(log_cfg.get("level", "INFO"))).upper()
    level = getattr(logging, level_name, logging.INFO)

    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter(
                fmt=str(log_cfg.get("format", DEFAULTS["logging"]["format"])),
                datefmt=str(log_cfg.get("date_format", DEFAULTS["logging"]["date_format"])),
            )
        )
        root.addHandler(handler)
    root.setLevel(level)

    logger = logging.getLogger(name)
    logger.setLevel(level)
    return logger


# ------------------------------------------------------------------
# TIME
# ------------------------------------------------------------------


def utc_now() -> datetime:
    """Timezone-aware UTC now. Every timestamp in this package is aware."""
    return datetime.now(tz=UTC)


def to_utc(moment: datetime | pd.Timestamp | str | None) -> datetime | None:
    """Coerce anything timestamp-shaped into an aware UTC datetime."""
    if moment is None:
        return None
    if isinstance(moment, str):
        moment = pd.Timestamp(moment)
    if isinstance(moment, pd.Timestamp):
        moment = moment.to_pydatetime()
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def parse_hhmm(value: str) -> time:
    """Parse 'HH:MM' into a datetime.time. Raises on anything else."""
    parts = str(value).strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"expected HH:MM, got {value!r}")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"time out of range: {value!r}")
    return time(hour=hour, minute=minute)


def _in_window(moment_time: time, start: time, end: time) -> bool:
    """Half-open [start, end) test that survives a midnight wrap."""
    if start <= end:
        return start <= moment_time < end
    return moment_time >= start or moment_time < end


def current_session(moment: datetime, config: Mapping[str, Any] | None = None) -> str:
    """FX session label from UTC clock time.

    Overlap is checked first because it is a strict subset of both London
    and NY — a 14:00 print belongs to OVERLAP, not to whichever of the two
    happens to be listed earlier.
    """
    sessions = (config or {}).get("sessions", DEFAULTS["sessions"])
    moment_utc = to_utc(moment)
    assert moment_utc is not None
    clock = moment_utc.time()

    for label in ("overlap", "london", "ny", "asia", "closed"):
        window = sessions.get(label)
        if not window:
            continue
        if _in_window(clock, parse_hhmm(window["start"]), parse_hhmm(window["end"])):
            return label.upper()

    return "CLOSED"


def current_killzone(moment: datetime, config: Mapping[str, Any] | None = None) -> str | None:
    """ICT killzone label, or None when outside every killzone."""
    killzones = (config or {}).get("killzones", DEFAULTS["killzones"])
    moment_utc = to_utc(moment)
    assert moment_utc is not None
    clock = moment_utc.time()

    for label, window in killzones.items():
        if _in_window(clock, parse_hhmm(window["start"]), parse_hhmm(window["end"])):
            return label.upper()

    return None


def session_bounds(
    moment: datetime, config: Mapping[str, Any] | None = None
) -> tuple[datetime, datetime]:
    """Start and end of the session containing ``moment``, in UTC.

    Used to build session high/low levels and to scope the daily loss
    counter. The end is exclusive.
    """
    sessions = (config or {}).get("sessions", DEFAULTS["sessions"])
    moment_utc = to_utc(moment)
    assert moment_utc is not None

    label = current_session(moment_utc, config).lower()
    window = sessions.get(label, sessions["closed"])
    start_clock = parse_hhmm(window["start"])
    end_clock = parse_hhmm(window["end"])

    start = moment_utc.replace(
        hour=start_clock.hour, minute=start_clock.minute, second=0, microsecond=0
    )
    if start > moment_utc:
        start -= timedelta(days=1)

    end = moment_utc.replace(
        hour=end_clock.hour, minute=end_clock.minute, second=0, microsecond=0
    )
    if end <= start:
        end += timedelta(days=1)

    return start, end


def trading_day(moment: datetime) -> datetime:
    """The 21:00-UTC-to-21:00-UTC trading day that contains ``moment``.

    Gold's day rolls at the 21:00 UTC session close, not at midnight, so
    a daily loss limit keyed on calendar dates would reset mid-session.
    """
    moment_utc = to_utc(moment)
    assert moment_utc is not None
    day_start = moment_utc.replace(hour=21, minute=0, second=0, microsecond=0)
    if moment_utc < day_start:
        day_start -= timedelta(days=1)
    return day_start


# ------------------------------------------------------------------
# NUMERICS
# ------------------------------------------------------------------


def safe_div(numerator: float | None, denominator: float | None, default: float = 0.0) -> float:
    """Division that returns ``default`` instead of raising or returning inf."""
    if numerator is None or denominator is None:
        return default
    if denominator == 0 or not math.isfinite(denominator):
        return default
    result = numerator / denominator
    return result if math.isfinite(result) else default


def clamp(value: float, low: float, high: float) -> float:
    """Constrain ``value`` to [low, high]."""
    return max(low, min(high, value))


def round_to_step(value: float, step: float) -> float:
    """Round ``value`` down to the nearest multiple of ``step``.

    Broker lot sizes are stepped (0.01 by default) and rounding *up* would
    silently exceed the risk budget, so this floors.
    """
    if step <= 0:
        return value
    return math.floor(value / step + 1e-9) * step


def percentile_rank(series: pd.Series, value: float) -> float:
    """Where ``value`` sits inside ``series``, as 0..1.

    Used for ATR percentile, driver percentile and GSR percentile — the
    "is this reading unusual for this instrument" question.
    """
    clean = series.dropna()
    if clean.empty:
        return 0.5
    return float((clean <= value).sum()) / float(len(clean))


def zscore(series: pd.Series, value: float) -> float:
    """Standard score of ``value`` against ``series``. 0.0 when degenerate."""
    clean = series.dropna()
    if len(clean) < 2:
        return 0.0
    std = float(clean.std(ddof=0))
    if std == 0 or not math.isfinite(std):
        return 0.0
    return float((value - float(clean.mean())) / std)


def true_range(frame: pd.DataFrame) -> pd.Series:
    """Wilder's true range: max(H-L, |H-prevC|, |L-prevC|)."""
    high = frame["high"]
    low = frame["low"]
    prev_close = frame["close"].shift(1)
    ranges = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    )
    return ranges.max(axis=1)


def atr(frame: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average true range, Wilder-smoothed (EMA with alpha = 1/period).

    Wilder smoothing rather than a simple mean because that is what every
    charting package plots, and a detector tuned against TradingView's ATR
    must agree with it.
    """
    tr = true_range(frame)
    return tr.ewm(alpha=1.0 / max(period, 1), adjust=False, min_periods=period).mean()


def rsi(frame: pd.DataFrame, period: int = 14) -> pd.Series:
    """Wilder RSI over closes. Returns 0..100.

    The all-gain case (avg_loss == 0) is RSI 100, not 50 — a monotonic
    rally must pin the oscillator at the top, so the zero-loss branch is
    handled explicitly rather than left to a NaN fill.
    """
    delta = frame["close"].diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)

    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()

    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    result = 100.0 - (100.0 / (1.0 + rs))

    # avg_loss == 0 with real gains -> 100; avg_loss == 0 with no gains -> 50.
    no_loss = avg_loss.eq(0.0) & avg_gain.gt(0.0)
    result = result.mask(no_loss, 100.0)
    return result.fillna(50.0)


def rolling_slope(series: pd.Series, window: int) -> pd.Series:
    """Least-squares slope of ``series`` over a trailing window.

    Used for trend classification and for the real-yield drift that feeds
    the fundamental overlay.
    """
    x = np.arange(window, dtype=float)
    x_mean = x.mean()
    x_var = ((x - x_mean) ** 2).sum()

    def _slope(values: np.ndarray) -> float:
        if np.isnan(values).any() or x_var == 0:
            return 0.0
        y_mean = values.mean()
        return float(((x - x_mean) * (values - y_mean)).sum() / x_var)

    return series.rolling(window).apply(_slope, raw=True)


def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential moving average, ``adjust=False``.

    Recursive form rather than ``adjust=True`` because every charting
    package seeds the EMA with the first value and then applies the
    smoothing factor bar by bar. A detector tuned against TradingView has
    to agree with TradingView, and ``adjust=True`` disagrees for the first
    few windows.
    """
    return series.ewm(span=max(period, 1), adjust=False).mean()


def adx(frame: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    """Wilder's directional movement system: ADX, +DI and -DI.

    Returns a frame with ``adx``, ``plus_di`` and ``minus_di`` columns.
    The trend-strength reading is the ADX line; the DI pair carries the
    direction. A high ADX with +DI above -DI is a clean uptrend, and the
    same ADX with the DI pair crossed the other way is a clean downtrend —
    which is why all three are returned together rather than the ADX alone.

    Directional movement is only counted when one side strictly dominates
    the other (``up > down`` and ``up > 0``), so an inside bar contributes
    nothing to either side. That is Wilder's original rule and it is what
    stops a choppy range from manufacturing trend strength.
    """
    high = frame["high"]
    low = frame["low"]

    up_move = high.diff()
    down_move = -low.diff()

    plus_dm = pd.Series(
        np.where((up_move > down_move) & (up_move > 0.0), up_move, 0.0),
        index=frame.index,
    )
    minus_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0.0), down_move, 0.0),
        index=frame.index,
    )

    # Wilder smoothing on both the range and the movement legs, so the
    # ratios below are consistently smoothed.
    alpha = 1.0 / max(period, 1)
    smoothed_tr = true_range(frame).ewm(
        alpha=alpha, adjust=False, min_periods=period
    ).mean()
    smoothed_plus = plus_dm.ewm(alpha=alpha, adjust=False, min_periods=period).mean()
    smoothed_minus = minus_dm.ewm(alpha=alpha, adjust=False, min_periods=period).mean()

    # A zero range means a flat bar; the DI is undefined there, not zero.
    safe_tr = smoothed_tr.replace(0.0, np.nan)
    plus_di = 100.0 * smoothed_plus / safe_tr
    minus_di = 100.0 * smoothed_minus / safe_tr

    di_sum = (plus_di + minus_di).replace(0.0, np.nan)
    dx = 100.0 * (plus_di - minus_di).abs() / di_sum
    adx_ = dx.ewm(alpha=alpha, adjust=False, min_periods=period).mean()

    return pd.DataFrame(
        {"adx": adx_, "plus_di": plus_di, "minus_di": minus_di},
        index=frame.index,
    )


def supertrend(
    frame: pd.DataFrame, period: int = 10, multiplier: float = 3.0
) -> pd.DataFrame:
    """Supertrend line plus its direction flag (``1`` long, ``-1`` short).

    The band is ratcheted, not recomputed: once price closes above the
    line the lower band becomes the floor and can only rise, and once it
    closes below, the upper band becomes the ceiling and can only fall.
    That ratchet is the whole indicator — without it the line would just
    be an ATR channel and would flip on every wiggle.

    The ratchet is seeded at the first bar with a finite ATR, which is bar
    ``period - 1``. Bars before that have no ATR, so both the line and the
    direction are left null rather than guessed at; callers should treat
    the first ``period`` bars as warm-up.
    """
    if frame.empty:
        return pd.DataFrame(
            {
                "supertrend": pd.Series(dtype=float),
                "direction": pd.Series(dtype="Int64"),
            },
            index=frame.index,
        )

    hl2 = (frame["high"] + frame["low"]) / 2.0
    atr_ = atr(frame, period)
    upper = hl2 + multiplier * atr_
    lower = hl2 - multiplier * atr_

    close = frame["close"]
    line = pd.Series(index=frame.index, dtype=float)
    # Nullable Int64 rather than int: the warm-up bars have no direction,
    # and a plain int column would be silently upcast to float64 by pandas
    # the moment a NaN lands in it, turning every live value into 1.0/-1.0.
    direction = pd.Series(index=frame.index, dtype="Int64")

    # ATR is NaN for the first ``period`` bars, so the bands are NaN too.
    # Seed the ratchet at the first bar with a real ATR and leave the
    # warm-up bars NaN — a comparison against NaN is always False, which
    # would otherwise flip the direction to short on the first live bar of
    # a clean uptrend.
    finite = np.isfinite(lower.to_numpy(dtype=float))
    if not finite.any():
        return pd.DataFrame(
            {"supertrend": line, "direction": direction}, index=frame.index
        )

    start = int(np.argmax(finite))
    line.iloc[start] = lower.iloc[start]
    direction.iloc[start] = 1

    for i in range(start + 1, len(frame)):
        prev_line = line.iloc[i - 1]
        prev_dir = direction.iloc[i - 1]

        if close.iloc[i] > prev_line:
            direction.iloc[i] = 1
            line.iloc[i] = max(lower.iloc[i], prev_line)
        else:
            direction.iloc[i] = -1
            line.iloc[i] = min(upper.iloc[i], prev_line)

        # Defensive: a non-finite band would poison the ratchet for every
        # later bar, so hold the previous state instead of propagating it.
        if not np.isfinite(line.iloc[i]):
            line.iloc[i] = prev_line
            direction.iloc[i] = prev_dir

    return pd.DataFrame({"supertrend": line, "direction": direction}, index=frame.index)


def donchian_position(frame: pd.DataFrame, window: int = 20) -> pd.Series:
    """Where the close sits inside its trailing Donchian channel, 0..1.

    ``0.0`` is the channel low, ``1.0`` the channel high. Expressed as a
    position rather than as the raw bands because that is what the
    confluence layer consumes: a breakout is a reading near 1.0, a sweep
    is a reading that pokes above 1.0 and closes back under it.

    A zero-width channel (flat market, or a window of identical bars)
    yields NaN rather than a division blow-up.
    """
    high = frame["high"].rolling(window).max()
    low = frame["low"].rolling(window).min()
    width = (high - low).replace(0.0, np.nan)
    return (frame["close"] - low) / width


# ------------------------------------------------------------------
# HASHING / SERIALISATION
# ------------------------------------------------------------------


def stable_hash(*parts: object) -> bytes:
    """SHA-256 over a pipe-joined key, matching the collectors' convention.

    The collectors write ``hash_sha256`` as BYTEA from exactly this
    construction, so a zone detected here and a zone detected there hash
    identically and dedup correctly.
    """
    payload = "|".join("" if part is None else str(part) for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).digest()


def hash_hex(*parts: object) -> str:
    """Hex form of :func:`stable_hash`, for logs and JSON payloads."""
    return stable_hash(*parts).hex()


def json_dumps(value: object) -> str:
    """JSON with datetimes and numpy scalars coerced to plain types."""
    return json.dumps(value, default=_json_default)


def _json_default(value: object) -> object:
    if isinstance(value, (datetime, pd.Timestamp)):
        moment = to_utc(value)
        return moment.isoformat() if moment else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return str(value)


def json_safe(value: Any) -> Any:
    """Recursively convert a structure into JSON-serialisable primitives."""
    return json.loads(json_dumps(value))


# ------------------------------------------------------------------
# ENV / SECRETS
# ------------------------------------------------------------------


def env(name: str, default: str | None = None) -> str | None:
    """Read an environment variable, treating blank as absent."""
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw


def env_int(name: str, default: int) -> int:
    raw = env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    raw = env(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def env_bool(name: str, default: bool = False) -> bool:
    raw = env(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def database_url() -> str:
    """Same resolution order as collectors/config.py and db.js.

    DATABASE_URL wins; otherwise the discrete DB_* vars are assembled.
    Kept identical on purpose so the engine and the collectors can never
    end up pointed at different databases.
    """
    explicit = env("DATABASE_URL")
    if explicit:
        return explicit

    host = env("DB_HOST", "localhost")
    port = env_int("DB_PORT", 5432)
    name = env("DB_NAME", "gold_terminal")
    user = env("DB_USER", "postgres")
    password = env("DB_PASSWORD", "")
    return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{name}"


# ------------------------------------------------------------------
# FRAME HELPERS
# ------------------------------------------------------------------


def ensure_frame(
    frame: pd.DataFrame, required: Sequence[str] = ("open", "high", "low", "close")
) -> pd.DataFrame:
    """Validate and normalise an OHLCV frame.

    Guarantees: a DatetimeIndex named ``time`` in UTC, lower-case column
    names, numeric dtypes, no duplicate timestamps, sorted ascending.
    Every detector assumes this contract, so it is enforced once here
    rather than defensively in twenty places.
    """
    if frame is None or frame.empty:
        raise ValueError("candle frame is empty")

    out = frame.copy()
    out.columns = [str(col).lower() for col in out.columns]

    missing = [col for col in required if col not in out.columns]
    if missing:
        raise ValueError(f"candle frame is missing columns: {', '.join(missing)}")

    if not isinstance(out.index, pd.DatetimeIndex):
        if "time" in out.columns:
            out = out.set_index("time")
        else:
            raise ValueError("candle frame needs a DatetimeIndex or a 'time' column")

    index = pd.DatetimeIndex(out.index)
    if index.tz is None:
        index = index.tz_localize("UTC")
    else:
        index = index.tz_convert("UTC")
    out.index = index
    out.index.name = "time"

    for col in required:
        out[col] = pd.to_numeric(out[col], errors="coerce")

    if "volume" in out.columns:
        out["volume"] = pd.to_numeric(out["volume"], errors="coerce").fillna(0.0)

    out = out[~out.index.duplicated(keep="last")]
    out = out.sort_index()
    out = out.dropna(subset=list(required))

    if out.empty:
        raise ValueError("candle frame has no usable rows after cleaning")

    return out


def resample_ohlc(frame: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Aggregate candles to a coarser rule (e.g. '4h' from 60m bars).

    Yahoo has no native 4h interval, so the loader builds it here. Volume
    sums; OHLC takes first/max/min/last in the correct order.
    """
    aggregation: dict[str, str] = {
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
    }
    if "volume" in frame.columns:
        aggregation["volume"] = "sum"

    aggregated = frame.resample(rule, label="left", closed="left").agg(aggregation)
    return aggregated.dropna(subset=["open", "high", "low", "close"])


def frame_summary(frame: pd.DataFrame) -> dict[str, Any]:
    """Compact description of a frame, for logs and dry-run reports."""
    if frame is None or frame.empty:
        return {"bars": 0}
    first = to_utc(frame.index[0])
    last = to_utc(frame.index[-1])
    return {
        "bars": int(len(frame)),
        "first": first.isoformat() if first else None,
        "last": last.isoformat() if last else None,
        "high": float(frame["high"].max()),
        "low": float(frame["low"].min()),
        "close": float(frame["close"].iloc[-1]),
    }


def chunked(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    """Yield ``items`` in fixed-size slices. Used for batched DB writes."""
    if size <= 0:
        raise ValueError("chunk size must be positive")
    for start in range(0, len(items), size):
        yield items[start : start + size]


@dataclass(frozen=True)
class TimeframeSpec:
    """Resolved timeframe metadata: label, Yahoo interval, rank, seconds."""

    label: str
    yahoo_interval: str
    range: str
    tf_rank: int
    seconds: int

    @property
    def is_htf(self) -> bool:
        """Rank 4 and above (1h+) counts as higher-timeframe context."""
        return self.tf_rank >= 4


def timeframe_specs(config: Mapping[str, Any]) -> dict[str, TimeframeSpec]:
    """Build the label -> TimeframeSpec map from config."""
    raw = config.get("timeframes", DEFAULTS["timeframes"])
    specs: dict[str, TimeframeSpec] = {}
    for label, entry in raw.items():
        specs[str(label)] = TimeframeSpec(
            label=str(label),
            yahoo_interval=str(entry.get("yahoo_interval", label)),
            range=str(entry.get("range", "1y")),
            tf_rank=int(entry.get("tf_rank", 1)),
            seconds=int(entry.get("seconds", 60)),
        )
    return specs


def next_higher_timeframe(
    label: str, specs: Mapping[str, TimeframeSpec]
) -> TimeframeSpec | None:
    """The next timeframe up the rank ladder, or None if already top.

    This is the HTF filter: a 15m long is only tradeable when the 1h
    structure agrees with it.
    """
    current = specs.get(label)
    if current is None:
        return None
    higher = [spec for spec in specs.values() if spec.tf_rank > current.tf_rank]
    if not higher:
        return None
    return min(higher, key=lambda spec: spec.tf_rank)


def lower_timeframes(label: str, specs: Mapping[str, TimeframeSpec]) -> list[TimeframeSpec]:
    """Every timeframe below ``label``, strongest first. Entry refinement."""
    current = specs.get(label)
    if current is None:
        return []
    lower = [spec for spec in specs.values() if spec.tf_rank < current.tf_rank]
    return sorted(lower, key=lambda spec: spec.tf_rank, reverse=True)
