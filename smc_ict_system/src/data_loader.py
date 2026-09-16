"""smc_ict_system/src/data_loader.py — candle acquisition and persistence.

Two sources, one contract. Every frame that leaves this module satisfies
``utils.ensure_frame``: a UTC ``DatetimeIndex`` named ``time``, lower-case
OHLCV columns, numeric dtypes, deduplicated and sorted ascending.

    Yahoo Finance   live/backfill candles for GC=F, the same endpoint the
                    collector layer uses, so the engine and the collectors
                    never disagree about what a 15m bar is.
    Postgres        the shared gold_terminal database. Reads pull stored
                    candles back out; writes land in ``technical_levels``
                    using the exact column set and dedup key that
                    ``collectors/yahoo_collector.py`` writes with.

The 4h timeframe has no native Yahoo interval, so it is aggregated from
60m bars via ``utils.resample_ohlc``. That is the only place a timeframe
is synthesised rather than fetched.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import pandas as pd
import requests
from sqlalchemy import text

from .utils import (
    PACKAGE_ROOT,
    TimeframeSpec,
    atr,
    cfg_get,
    chunked,
    database_url,
    ensure_frame,
    env_int,
    frame_summary,
    json_dumps,
    load_config,
    resample_ohlc,
    setup_logging,
    stable_hash,
    timeframe_specs,
    to_utc,
    utc_now,
)

log = setup_logging("data_loader")

# ------------------------------------------------------------------
# CONSTANTS
# ------------------------------------------------------------------

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

REQUEST_TIMEOUT = 25
MAX_RETRIES = 3
RETRY_BACKOFF_SEC = 1.5

# Yahoo interval -> the label our config uses. 4h is absent on purpose:
# it is aggregated from 60m, never requested directly.
YAHOO_INTERVAL_FOR_LABEL: dict[str, str] = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "60m",
    "1D": "1d",
    "1W": "1wk",
}

# Labels that must be built by resampling a finer interval.
AGGREGATED_LABELS: dict[str, tuple[str, str]] = {
    # label -> (source label, pandas resample rule)
    "4h": ("1h", "4h"),
    "1W": ("1D", "1W"),
}

# Yahoo range -> how many calendar days it reaches back. Used to decide
# whether a cached frame is long enough to skip a network call.
RANGE_DAYS: dict[str, int] = {
    "1d": 1,
    "5d": 5,
    "1mo": 31,
    "3mo": 92,
    "6mo": 183,
    "1y": 366,
    "2y": 731,
    "5y": 1827,
    "10y": 3653,
    "max": 36500,
}


# ------------------------------------------------------------------
# RESULT TYPES
# ------------------------------------------------------------------


@dataclass
class CandleSet:
    """Every timeframe the engine asked for, plus per-frame provenance."""

    frames: dict[str, pd.DataFrame] = field(default_factory=dict)
    sources: dict[str, str] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    fetched_at: datetime = field(default_factory=utc_now)

    def get(self, label: str) -> pd.DataFrame | None:
        return self.frames.get(label)

    def require(self, label: str) -> pd.DataFrame:
        frame = self.frames.get(label)
        if frame is None or frame.empty:
            raise KeyError(f"no candles loaded for timeframe {label!r}")
        return frame

    @property
    def labels(self) -> list[str]:
        return sorted(self.frames, key=lambda label: len(self.frames[label]))

    def summary(self) -> dict[str, Any]:
        """Compact per-timeframe report for logs and dry runs."""
        report: dict[str, Any] = {}
        for label, frame in self.frames.items():
            entry = frame_summary(frame)
            entry["source"] = self.sources.get(label, "unknown")
            report[label] = entry
        for label, message in self.errors.items():
            report[label] = {"bars": 0, "error": message}
        return report

    def describe(self) -> str:
        """One-line-per-timeframe human readable table."""
        lines = []
        for label, entry in self.summary().items():
            if "error" in entry:
                lines.append(f"  {label:<4} FAILED  {entry['error']}")
                continue
            lines.append(
                f"  {label:<4} bars={entry['bars']:<6} "
                f"last={entry['last']}  close={entry['close']:.2f}  "
                f"[{entry['source']}]"
            )
        return "\n".join(lines)


# ------------------------------------------------------------------
# YAHOO FETCH
# ------------------------------------------------------------------


def _yahoo_ticker(config: Mapping[str, Any] | None = None) -> str:
    config = config or load_config()
    return str(cfg_get(config, "instrument.yahoo_ticker", "GC=F"))


def _symbol(config: Mapping[str, Any] | None = None) -> str:
    config = config or load_config()
    return str(cfg_get(config, "instrument.symbol", "XAUUSD"))


def fetch_yahoo_candles(
    interval: str,
    range_: str,
    ticker: str | None = None,
    session: requests.Session | None = None,
) -> pd.DataFrame:
    """Pull OHLCV from the Yahoo chart endpoint and normalise it.

    Retries transient network failures with a linear backoff. A 4xx other
    than 429 is raised immediately — retrying a bad interval just wastes
    the caller's time.
    """
    ticker = ticker or _yahoo_ticker()
    url = YAHOO_CHART_URL.format(ticker=ticker)
    http = session or requests

    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = http.get(
                url,
                params={"interval": interval, "range": range_},
                headers=YAHOO_HEADERS,
                timeout=REQUEST_TIMEOUT,
            )
            if response.status_code == 429 or response.status_code >= 500:
                raise requests.HTTPError(
                    f"retryable HTTP {response.status_code}", response=response
                )
            response.raise_for_status()
            payload = response.json()
            return _parse_yahoo_payload(payload, interval, range_)
        except requests.HTTPError as err:
            status = getattr(err.response, "status_code", None)
            if status is not None and 400 <= status < 500 and status != 429:
                raise
            last_error = err
        except (requests.RequestException, ValueError) as err:
            last_error = err

        if attempt < MAX_RETRIES:
            time.sleep(RETRY_BACKOFF_SEC * attempt)

    raise RuntimeError(
        f"Yahoo fetch failed for {ticker} {interval}/{range_} "
        f"after {MAX_RETRIES} attempts: {last_error}"
    )


def _parse_yahoo_payload(
    payload: Mapping[str, Any], interval: str, range_: str
) -> pd.DataFrame:
    """Turn a Yahoo chart response into a clean OHLCV frame."""
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise ValueError(f"Yahoo error: {chart['error']}")

    results = chart.get("result") or []
    if not results:
        raise ValueError(f"Yahoo returned no result for {interval}/{range_}")

    result = results[0]
    timestamps = result.get("timestamp")
    if not timestamps:
        raise ValueError(f"Yahoo returned no timestamps for {interval}/{range_}")

    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    frame = pd.DataFrame(
        {
            "time": pd.to_datetime(timestamps, unit="s", utc=True),
            "open": quote.get("open"),
            "high": quote.get("high"),
            "low": quote.get("low"),
            "close": quote.get("close"),
            "volume": quote.get("volume"),
        }
    )
    frame = frame.dropna(subset=["open", "high", "low", "close"])
    frame["volume"] = pd.to_numeric(frame["volume"], errors="coerce").fillna(0.0)
    frame = frame.set_index("time")
    return ensure_frame(frame)


# ------------------------------------------------------------------
# AGGREGATION
# ------------------------------------------------------------------


def aggregate_frame(frame: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample a frame to a coarser rule and re-validate the contract."""
    aggregated = resample_ohlc(frame, rule)
    if aggregated.empty:
        raise ValueError(f"aggregation to {rule} produced no bars")
    return ensure_frame(aggregated)


# ------------------------------------------------------------------
# CSV / MT5 SOURCES
# ------------------------------------------------------------------
# Both are opt-in alternatives to Yahoo, selected by ``data.source`` in
# config. They return the same ``(frame, source)`` pair as
# ``load_timeframe`` so ``load_candles`` can dispatch to them without
# caring which backend produced the bars.

# MT5 label -> MetaTrader5 TIMEFRAME_* constant name. Resolved lazily
# because the package is Windows-only and must not be imported at module
# scope.
MT5_TIMEFRAME_ATTR: dict[str, str] = {
    "1m": "TIMEFRAME_M1",
    "5m": "TIMEFRAME_M5",
    "15m": "TIMEFRAME_M15",
    "30m": "TIMEFRAME_M30",
    "1h": "TIMEFRAME_H1",
    "4h": "TIMEFRAME_H4",
    "1D": "TIMEFRAME_D1",
    "1W": "TIMEFRAME_W1",
}


def _data_source(config: Mapping[str, Any] | None = None) -> str:
    """Which backend ``data.source`` selects. Defaults to yahoo."""
    config = config or load_config()
    return str(cfg_get(config, "data.source", "yahoo")).strip().lower()


def _csv_path(config: Mapping[str, Any] | None = None) -> Path:
    """Resolve ``data.csv_path`` against the package root.

    A relative path is interpreted from the package root, not the process
    CWD, so the engine behaves the same whether it is launched from the
    repo root or from inside smc_ict_system/.
    """
    config = config or load_config()
    raw = cfg_get(config, "data.csv_path")
    if not raw:
        raise ValueError("data.source is 'csv' but data.csv_path is not set")
    path = Path(str(raw))
    return path if path.is_absolute() else PACKAGE_ROOT / path


def load_csv_candles(
    label: str,
    config: Mapping[str, Any] | None = None,
) -> tuple[pd.DataFrame, str]:
    """Read one timeframe from a local CSV.

    The file is expected to carry a ``time`` column plus OHLC; ``volume``
    is optional and defaults to zero. Column names are matched
    case-insensitively and whitespace-stripped, so a hand-exported
    ``Time,Open,High,Low,Close`` header works unchanged.

    Returns ``(frame, source)`` with source ``csv:<filename>``.
    """
    config = config or load_config()
    path = _csv_path(config)

    if not path.exists():
        raise FileNotFoundError(f"CSV not found: {path}")

    raw = pd.read_csv(path)
    if raw.empty:
        raise ValueError(f"CSV is empty: {path}")

    raw.columns = [str(col).strip().lower() for col in raw.columns]

    # Accept a few common aliases for the timestamp column before handing
    # off to ensure_frame, which only knows about 'time'.
    for alias in ("datetime", "date", "timestamp"):
        if "time" not in raw.columns and alias in raw.columns:
            raw = raw.rename(columns={alias: "time"})
            break

    if "time" not in raw.columns:
        raise ValueError(
            f"CSV {path.name} needs a time column "
            f"(one of: time, datetime, date, timestamp); got {list(raw.columns)}"
        )

    if "volume" not in raw.columns:
        raw["volume"] = 0.0

    frame = ensure_frame(raw)
    log.info("%-4s loaded bars=%d source=csv:%s", label, len(frame), path.name)
    return frame, f"csv:{path.name}"


def load_mt5_candles(
    label: str,
    config: Mapping[str, Any] | None = None,
    bars: int = 5000,
) -> tuple[pd.DataFrame, str]:
    """Pull one timeframe from a running MetaTrader 5 terminal.

    Requires the ``MetaTrader5`` package, which is Windows-only and not a
    hard dependency — it is imported here so the rest of the package runs
    without it. The terminal must be installed, logged in and running.

    Returns ``(frame, source)`` with source ``mt5:<symbol>``.
    """
    config = config or load_config()

    try:
        import MetaTrader5 as mt5  # type: ignore[import-not-found]
    except ImportError as err:
        raise ImportError(
            "data.source is 'mt5' but the MetaTrader5 package is not installed. "
            "Install it with: pip install MetaTrader5"
        ) from err

    symbol = str(cfg_get(config, "instrument.symbol", "XAUUSD"))
    attr = MT5_TIMEFRAME_ATTR.get(label)
    if attr is None:
        raise KeyError(
            f"timeframe {label!r} has no MT5 mapping; "
            f"known labels: {', '.join(sorted(MT5_TIMEFRAME_ATTR))}"
        )

    if not mt5.initialize():
        raise RuntimeError(f"MT5 initialize() failed: {mt5.last_error()}")

    try:
        rates = mt5.copy_rates_from_pos(symbol, getattr(mt5, attr), 0, bars)
    finally:
        # Always release the terminal handle; leaving it open blocks the
        # next call and can wedge the MT5 GUI.
        mt5.shutdown()

    if rates is None or len(rates) == 0:
        raise RuntimeError(
            f"MT5 returned no bars for {symbol} {label} "
            f"(last_error={mt5.last_error()})"
        )

    raw = pd.DataFrame(rates)
    raw["time"] = pd.to_datetime(raw["time"], unit="s", utc=True)
    raw = raw.rename(columns={"tick_volume": "volume"})

    frame = ensure_frame(raw)
    log.info("%-4s loaded bars=%d source=mt5:%s", label, len(frame), symbol)
    return frame, f"mt5:{symbol}"


def load_timeframe(
    label: str,
    specs: Mapping[str, TimeframeSpec],
    config: Mapping[str, Any] | None = None,
    session: requests.Session | None = None,
) -> tuple[pd.DataFrame, str]:
    """Load one timeframe, aggregating when Yahoo has no native interval.

    Returns ``(frame, source)`` where source is ``yahoo`` or
    ``yahoo:<parent>`` for an aggregated frame, or ``csv:<file>`` /
    ``mt5:<symbol>`` when ``data.source`` selects a local backend.
    """
    spec = specs.get(label)
    if spec is None:
        raise KeyError(f"timeframe {label!r} is not defined in config")

    source = _data_source(config)
    if source == "csv":
        return load_csv_candles(label, config)
    if source == "mt5":
        return load_mt5_candles(label, config)
    if source not in ("yahoo", "yfinance"):
        raise ValueError(
            f"unknown data.source {source!r}; expected csv, yahoo, yfinance or mt5"
        )

    if label in AGGREGATED_LABELS:
        parent_label, rule = AGGREGATED_LABELS[label]
        parent_spec = specs.get(parent_label)
        if parent_spec is None:
            raise KeyError(
                f"timeframe {label!r} aggregates from {parent_label!r}, "
                "which is not defined in config"
            )
        parent = fetch_yahoo_candles(
            parent_spec.yahoo_interval, parent_spec.range, session=session
        )
        return aggregate_frame(parent, rule), f"yahoo:{parent_label}"

    interval = YAHOO_INTERVAL_FOR_LABEL.get(label, spec.yahoo_interval)
    frame = fetch_yahoo_candles(interval, spec.range, session=session)
    return frame, "yahoo"


def load_candles(
    labels: Sequence[str] | None = None,
    config: Mapping[str, Any] | None = None,
    session: requests.Session | None = None,
    strict: bool = False,
) -> CandleSet:
    """Fetch every requested timeframe.

    One timeframe failing does not abort the run — the failure is recorded
    in ``CandleSet.errors`` and the engine decides whether it can still
    produce a verdict. Pass ``strict=True`` to raise instead.
    """
    config = config or load_config()
    specs = timeframe_specs(config)
    wanted = list(labels or config.get("active_timeframes") or specs.keys())

    result = CandleSet()
    http = session or requests.Session()

    for label in wanted:
        try:
            frame, source = load_timeframe(label, specs, config, session=http)
            result.frames[label] = frame
            result.sources[label] = source
            log.debug("%-4s loaded bars=%d source=%s", label, len(frame), source)
        except Exception as err:  # noqa: BLE001 — one TF must not kill the run
            result.errors[label] = str(err)
            log.warning("%-4s load failed: %s", label, err)
            if strict:
                raise

    if not result.frames:
        raise RuntimeError(
            "no timeframe could be loaded: "
            + "; ".join(f"{k}={v}" for k, v in result.errors.items())
        )

    return result


# ------------------------------------------------------------------
# POSTGRES — CANDLE READ
# ------------------------------------------------------------------

# The collectors own the candle tables; the engine only reads them. The
# query is written against the same column names the collector layer
# writes, and degrades to an empty frame when the table is absent.
CANDLE_READ_SQL = text(
    """
    SELECT time, open, high, low, close, volume
      FROM candles
     WHERE symbol = :symbol
       AND timeframe = :timeframe
       AND time >= :since
     ORDER BY time ASC
    """
)


def read_candles(
    label: str,
    since: datetime | str | None = None,
    limit: int | None = None,
    symbol: str | None = None,
    config: Mapping[str, Any] | None = None,
) -> pd.DataFrame:
    """Read stored candles for one timeframe.

    Returns an empty frame (not an exception) when the table is missing or
    holds nothing for the window — the caller falls back to Yahoo.
    """
    from sqlalchemy import create_engine

    config = config or load_config()
    symbol = symbol or _symbol(config)
    since = to_utc(since) or (utc_now() - timedelta(days=30))

    engine = create_engine(database_url(), pool_pre_ping=True, future=True)
    try:
        with engine.connect() as conn:
            frame = pd.read_sql_query(
                CANDLE_READ_SQL,
                conn,
                params={"symbol": symbol, "timeframe": label, "since": since},
            )
    except Exception as err:  # noqa: BLE001 — missing table is not fatal
        log.debug("candle read for %s unavailable: %s", label, err)
        return pd.DataFrame()
    finally:
        engine.dispose()

    if frame.empty:
        return pd.DataFrame()

    frame = frame.set_index("time")
    frame = ensure_frame(frame)
    if limit:
        frame = frame.tail(int(limit))
    return frame


def load_candles_preferring_db(
    labels: Sequence[str] | None = None,
    config: Mapping[str, Any] | None = None,
    min_bars: int = 200,
) -> CandleSet:
    """Load from Postgres when it has enough history, else fall back to Yahoo.

    The engine runs identically whether or not the database is reachable,
    which keeps a live scan working on a laptop with no Postgres running.
    """
    config = config or load_config()
    specs = timeframe_specs(config)
    wanted = list(labels or config.get("active_timeframes") or specs.keys())

    result = CandleSet()
    missing: list[str] = []

    for label in wanted:
        frame = read_candles(label, config=config)
        if len(frame) >= min_bars:
            result.frames[label] = frame
            result.sources[label] = "postgres"
        else:
            missing.append(label)

    if missing:
        log.info("postgres short on %s — fetching from Yahoo", ", ".join(missing))
        fetched = load_candles(missing, config=config)
        result.frames.update(fetched.frames)
        result.sources.update(fetched.sources)
        result.errors.update(fetched.errors)

    if not result.frames:
        raise RuntimeError("no candles available from Postgres or Yahoo")

    return result


# ------------------------------------------------------------------
# POSTGRES — ZONE WRITE
# ------------------------------------------------------------------

# Mirrors collectors/yahoo_collector.py INSERT_SQL column-for-column so
# both writers dedup against the same uq_tl_zone_identity index. The
# engine adds the columns the collector leaves NULL: detector provenance,
# algo_params, confluence, and the execution linkage.
ZONE_INSERT_SQL = text(
    """
    INSERT INTO technical_levels (
        symbol, timeframe, timeframe_seconds, tf_rank,
        concept, sub_concept, direction, is_htf, polarity,
        price_high, price_low, price_open, price_close,
        atr_at_formation, premium_discount,
        ref_price, displacement_atr,
        strength, confluence_count, confluence,
        formed_at, valid_from, valid_until, state_version,
        status, mitigation_state, is_valid,
        mtf_confirmed, mtf_aligned_tfs, ltf_trigger_tf,
        entry_price, stop_price, target_price, risk_reward,
        detector, detector_version, algo_params,
        tags, meta, raw_payload, hash_sha256
    ) VALUES (
        :symbol, :timeframe, :timeframe_seconds, :tf_rank,
        :concept, :sub_concept, :direction, :is_htf, :polarity,
        :price_high, :price_low, :price_open, :price_close,
        :atr_at_formation, :premium_discount,
        :ref_price, :displacement_atr,
        :strength, :confluence_count, CAST(:confluence AS text[]),
        :formed_at, :valid_from, :valid_until, 1,
        :status, :mitigation_state, TRUE,
        :mtf_confirmed, CAST(:mtf_aligned_tfs AS text[]), :ltf_trigger_tf,
        :entry_price, :stop_price, :target_price, :risk_reward,
        :detector, :detector_version, CAST(:algo_params AS jsonb),
        CAST(:tags AS text[]), CAST(:meta AS jsonb),
        CAST(:raw_payload AS jsonb), :hash_sha256
    )
    ON CONFLICT (symbol, timeframe, concept, formed_at, price_high, price_low)
        WHERE state_version = 1
    DO NOTHING
    """
)

DETECTOR_NAME = "smc_ict_system"
DETECTOR_VERSION = "0.1.0"


def zone_hash(
    symbol: str,
    timeframe: str,
    concept: str,
    formed_at: datetime,
    price_high: float,
    price_low: float,
) -> bytes:
    """SHA-256 over the same six fields the collector hashes.

    Identical zones detected by either system collapse onto one row via
    ``uq_tl_hash``, so the engine never double-counts a level the
    collector already stored.
    """
    return stable_hash(
        symbol,
        timeframe,
        concept,
        formed_at.isoformat(),
        price_high,
        price_low,
    )


def build_zone_row(
    zone: Any,
    label: str,
    spec: TimeframeSpec,
    symbol: str,
    range_high: float,
    range_low: float,
    config: Mapping[str, Any] | None = None,
    algo_params: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Map one detected zone onto the technical_levels column set.

    ``zone`` is duck-typed: anything exposing the attribute names used by
    ``smc_core.Zone`` works, which keeps this module free of a circular
    import back into the detector.
    """
    config = config or load_config()
    span = float(range_high) - float(range_low)

    premium_discount = None
    if span > 0:
        mid = (float(zone.price_high) + float(zone.price_low)) / 2.0
        premium_discount = round((mid - float(range_low)) / span, 4)

    formed_at = to_utc(zone.formed_at) or utc_now()
    valid_until = None
    max_age = cfg_get(config, "detectors.max_zone_age_bars", 300)
    if max_age:
        valid_until = formed_at + timedelta(seconds=spec.seconds * int(max_age))

    strength = getattr(zone, "strength", None)
    if strength is not None:
        # The column is NUMERIC(5,2) constrained to 0..100. Detectors emit
        # ATR-relative ratios, so anything at or below 1.0 is a ratio and
        # gets scaled; larger values are already on the 0..100 scale.
        strength = float(strength)
        if strength <= 1.0:
            strength = round(strength * 100.0, 2)
        strength = max(0.0, min(100.0, strength))

    tags = list(getattr(zone, "tags", ()) or ())
    confluence = list(getattr(zone, "confluence", ()) or ())
    meta = dict(getattr(zone, "meta", None) or {})

    return {
        "symbol": symbol,
        "timeframe": label,
        "timeframe_seconds": spec.seconds,
        "tf_rank": spec.tf_rank,
        "concept": zone.concept,
        "sub_concept": getattr(zone, "sub_concept", None),
        "direction": zone.direction,
        "is_htf": spec.is_htf,
        "polarity": int(getattr(zone, "polarity", 0) or 0),
        "price_high": float(zone.price_high),
        "price_low": float(zone.price_low),
        "price_open": getattr(zone, "price_open", None),
        "price_close": getattr(zone, "price_close", None),
        "atr_at_formation": getattr(zone, "atr_at_formation", None),
        "premium_discount": premium_discount,
        "ref_price": getattr(zone, "ref_price", None),
        "displacement_atr": getattr(zone, "displacement_atr", None),
        "strength": strength,
        "confluence_count": len(confluence),
        "confluence": confluence,
        "formed_at": formed_at,
        "valid_from": formed_at,
        "valid_until": valid_until,
        "status": getattr(zone, "status", "FRESH"),
        "mitigation_state": getattr(zone, "mitigation_state", "UNMITIGATED"),
        "mtf_confirmed": bool(getattr(zone, "mtf_confirmed", False)),
        "mtf_aligned_tfs": list(getattr(zone, "mtf_aligned_tfs", ()) or ()),
        "ltf_trigger_tf": getattr(zone, "ltf_trigger_tf", None),
        "entry_price": getattr(zone, "entry_price", None),
        "stop_price": getattr(zone, "stop_price", None),
        "target_price": getattr(zone, "target_price", None),
        "risk_reward": getattr(zone, "risk_reward", None),
        "detector": DETECTOR_NAME,
        "detector_version": DETECTOR_VERSION,
        "algo_params": json_dumps(dict(algo_params or {})),
        "tags": tags,
        "meta": json_dumps(meta),
        "raw_payload": json_dumps(
            {
                "detector": DETECTOR_NAME,
                "timeframe": label,
                "concept": zone.concept,
                "sub_concept": getattr(zone, "sub_concept", None),
                "direction": zone.direction,
                "price_high": float(zone.price_high),
                "price_low": float(zone.price_low),
                "formed_at": formed_at.isoformat(),
            }
        ),
        "hash_sha256": zone_hash(
            symbol,
            label,
            zone.concept,
            formed_at,
            float(zone.price_high),
            float(zone.price_low),
        ),
    }


def write_zones(
    rows: Iterable[Mapping[str, Any]],
    batch_size: int | None = None,
) -> int:
    """Insert zone rows in batched transactions. Returns rows inserted.

    ``ON CONFLICT DO NOTHING`` means a re-run over unchanged candles
    inserts nothing, so the scan is idempotent and safe to schedule.
    """
    from sqlalchemy import create_engine

    rows = list(rows)
    if not rows:
        return 0

    batch_size = batch_size or env_int("SMC_WRITE_BATCH", 500)
    engine = create_engine(database_url(), pool_pre_ping=True, future=True)
    inserted = 0

    try:
        for batch in chunked(rows, batch_size):
            with engine.begin() as conn:
                for row in batch:
                    result = conn.execute(ZONE_INSERT_SQL, dict(row))
                    inserted += result.rowcount or 0
    finally:
        engine.dispose()

    return inserted


def read_zones(
    label: str | None = None,
    concepts: Sequence[str] | None = None,
    symbol: str | None = None,
    valid_only: bool = True,
    limit: int = 5000,
    config: Mapping[str, Any] | None = None,
) -> pd.DataFrame:
    """Read stored zones back, newest first. Empty frame when unavailable."""
    from sqlalchemy import create_engine

    config = config or load_config()
    symbol = symbol or _symbol(config)

    clauses = ["symbol = :symbol"]
    params: dict[str, Any] = {"symbol": symbol, "limit": int(limit)}

    if label:
        clauses.append("timeframe = :timeframe")
        params["timeframe"] = label
    if concepts:
        clauses.append("concept = ANY(:concepts)")
        params["concepts"] = list(concepts)
    if valid_only:
        clauses.append("is_valid")

    sql = text(
        f"""
        SELECT id, timeframe, tf_rank, concept, sub_concept, direction,
               is_htf, polarity, price_high, price_low, price_mid,
               atr_at_formation, zone_height_atr, premium_discount,
               strength, confluence_count, confluence,
               status, mitigation_state, mtf_confirmed,
               formed_at, valid_from, valid_until,
               entry_price, stop_price, target_price, risk_reward,
               tags, meta
          FROM technical_levels
         WHERE {' AND '.join(clauses)}
         ORDER BY formed_at DESC
         LIMIT :limit
        """
    )

    engine = create_engine(database_url(), pool_pre_ping=True, future=True)
    try:
        with engine.connect() as conn:
            return pd.read_sql_query(sql, conn, params=params)
    except Exception as err:  # noqa: BLE001 — read is best-effort
        log.debug("zone read unavailable: %s", err)
        return pd.DataFrame()
    finally:
        engine.dispose()


# ------------------------------------------------------------------
# CONVENIENCE
# ------------------------------------------------------------------


def latest_price(label: str = "15m", config: Mapping[str, Any] | None = None) -> float:
    """Most recent close on ``label``. Raises when nothing is loadable."""
    config = config or load_config()
    specs = timeframe_specs(config)
    frame, _ = load_timeframe(label, specs, config)
    return float(frame["close"].iloc[-1])


def with_atr(frame: pd.DataFrame, period: int | None = None) -> pd.DataFrame:
    """Attach an ``atr`` column using the configured period."""
    config = load_config()
    period = period or int(cfg_get(config, "detectors.atr_period", 14))
    out = frame.copy()
    out["atr"] = atr(out, period)
    return out


def staleness_seconds(frame: pd.DataFrame, spec: TimeframeSpec) -> float:
    """How long ago the last bar closed, in seconds.

    The signal engine vetoes on a stale feed, so this is the number that
    decides whether the newest candle is fresh enough to trade.
    """
    if frame is None or frame.empty:
        return float("inf")
    last = to_utc(frame.index[-1])
    if last is None:
        return float("inf")
    return (utc_now() - last).total_seconds()
