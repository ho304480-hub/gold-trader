"""Throwaway verification for the SessionFilter wiring in backtester.py."""
from __future__ import annotations

import ast
import inspect
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

sys.path.insert(0, ".")

from src import backtester as bt
from src.sessions import SessionFilter
from src.utils import load_config

PASS = 0
FAIL = 0
FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
    else:
        FAIL += 1
        FAILURES.append(f"{label}: {detail}")


def section(name: str) -> None:
    print(f"\n--- {name} ---")


# ---------------------------------------------------------------- AST
section("AST and symbols")
src = open("src/backtester.py", encoding="utf-8").read()
tree = ast.parse(src)
check("ast parses", True)
names = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
for symbol in (
    "replay",
    "walk_forward",
    "BacktestParams",
    "Trade",
    "BacktestResult",
    "_open_trade",
    "killzone_breakdown",
):
    check(f"symbol {symbol}", symbol in names, "missing")
check("SessionFilter imported", "from .sessions import SessionFilter" in src)
check("no current_killzone call", "current_killzone(" not in src)

# ------------------------------------------------------- skip constants
section("Skip reason constants")
for const in (
    "SKIP_KILLZONE",
    "SKIP_DAY_HALTED",
    "SKIP_MAX_TRADES",
    "SKIP_NO_MTF",
    "SKIP_GEOMETRY",
    "SKIP_POSITION_LIMIT",
    "SKIP_SIZING",
    "SKIP_DUPLICATE",
    "SKIP_DAILY_LOSS",
):
    check(f"constant {const}", hasattr(bt, const), "missing")
check("SKIP_KILLZONE value", bt.SKIP_KILLZONE == "outside_killzone")
check("SKIP_DAILY_LOSS value", bt.SKIP_DAILY_LOSS == "daily_loss_limit")
check("SKIP_MAX_TRADES value", bt.SKIP_MAX_TRADES == "max_trades")

# ------------------------------------------------------------- params
section("BacktestParams")
p = bt.BacktestParams()
check("require_killzone default False", p.require_killzone is False)
check("as_dict has require_killzone", "require_killzone" in p.as_dict())
check("as_dict value", p.as_dict()["require_killzone"] is False)

cfg = load_config()
p2 = bt.BacktestParams.from_config(cfg)
check("from_config reads signal_engine.require_killzone", p2.require_killzone is True,
      f"got {p2.require_killzone}")

cfg_off = {k: v for k, v in cfg.items() if k != "signal_engine"}
p3 = bt.BacktestParams.from_config(cfg_off)
check("from_config defaults False when block absent", p3.require_killzone is False)

# The config's own killzones block must be the one the filter reads.
check("config killzones present", "killzones" in cfg)
check("config killzones has london_open", "london_open" in cfg["killzones"])

# --------------------------------------------------------------- Trade
section("Trade dataclass")
t = bt.Trade(
    trade_id=1, symbol="XAUUSD", timeframe="15m", direction=bt.LONG,
    concept="ORDER_BLOCK", sub_concept=None,
    entry_time=datetime(2026, 1, 5, 8, 0, tzinfo=timezone.utc),
    entry_price=2400.0, stop_price=2395.0, target_price=2410.0,
    initial_stop=2395.0, initial_risk=5.0, lots=0.1, atr_at_entry=2.0,
)
check("killzone defaults None", t.killzone is None)
check("to_dict has killzone", "killzone" in t.to_dict())
t.killzone = "london_open"
check("to_dict killzone value", t.to_dict()["killzone"] == "london_open")

# ------------------------------------------------------- signatures
section("Signatures")
replay_sig = inspect.signature(bt.replay)
check("replay has sessions", "sessions" in replay_sig.parameters)
check("replay sessions default None",
      replay_sig.parameters["sessions"].default is None)
wf_sig = inspect.signature(bt.walk_forward)
check("walk_forward has sessions", "sessions" in wf_sig.parameters)
ot_sig = inspect.signature(bt._open_trade)
check("_open_trade has killzone", "killzone" in ot_sig.parameters)
check("_open_trade killzone default None",
      ot_sig.parameters["killzone"].default is None)

# --------------------------------------------------- synthetic frame
section("Synthetic frame replay")


def make_frame(bars: int = 900, start: str = "2026-01-05 00:00", freq: str = "15min"):
    rng = np.random.default_rng(11)
    index = pd.date_range(start, periods=bars, freq=freq, tz="UTC")
    # A gentle trend with noise so pivots, FVGs and order blocks all fire.
    drift = np.linspace(0.0, 12.0, bars)
    noise = rng.normal(0.0, 1.6, bars)
    close = 2400.0 + drift + noise
    open_ = np.concatenate([[close[0]], close[:-1]])
    high = np.maximum(open_, close) + rng.uniform(0.2, 1.4, bars)
    low = np.minimum(open_, close) - rng.uniform(0.2, 1.4, bars)
    return pd.DataFrame(
        {"open": open_, "high": high, "low": low, "close": close,
         "volume": rng.uniform(100, 900, bars)},
        index=index,
    )


frame = make_frame()
check("frame built", len(frame) == 900)

# require_killzone off: trades should be produced and labelled.
params_off = bt.BacktestParams(
    initial_equity=10_000.0, require_killzone=False, max_bars_in_trade=40,
    max_open_positions=3, max_positions_per_direction=2,
)
res_off = bt.replay(frame, timeframe="15m", params=params_off, config=cfg,
                    warmup_bars=300)
check("replay off produced trades", len(res_off.trades) > 0,
      f"got {len(res_off.trades)}")
check("replay off no killzone skips", bt.SKIP_KILLZONE not in res_off.skipped,
      str(res_off.skipped))

labels = {tr.killzone for tr in res_off.trades}
check("labels are config keys or None",
      labels <= {"asia_range", "london_open", "ny_am", "ny_pm", None},
      str(labels))

# Every label must agree with SessionFilter on the entry timestamp.
sf = SessionFilter(cfg)
mismatch = 0
for tr in res_off.trades:
    expected = sf.active_killzone(tr.entry_time)
    if tr.killzone != expected:
        mismatch += 1
check("trade killzone matches SessionFilter", mismatch == 0,
      f"{mismatch} mismatches")

# require_killzone on: every trade must be inside a window.
params_on = bt.BacktestParams(
    initial_equity=10_000.0, require_killzone=True, max_bars_in_trade=40,
    max_open_positions=3, max_positions_per_direction=2,
)
res_on = bt.replay(frame, timeframe="15m", params=params_on, config=cfg,
                   warmup_bars=300)
check("replay on produced trades", len(res_on.trades) > 0,
      f"got {len(res_on.trades)}")
check("replay on recorded killzone skips",
      res_on.skipped.get(bt.SKIP_KILLZONE, 0) > 0, str(res_on.skipped))
outside = [tr for tr in res_on.trades if tr.killzone is None]
check("no trade outside a killzone when gated", not outside,
      f"{len(outside)} outside")
check("gated run has fewer or equal trades",
      len(res_on.trades) <= len(res_off.trades),
      f"{len(res_on.trades)} vs {len(res_off.trades)}")

# The gate must be a strict subset: every gated trade exists in the ungated run.
off_keys = {(tr.entry_time, tr.direction, round(tr.entry_price, 6))
            for tr in res_off.trades}
on_keys = {(tr.entry_time, tr.direction, round(tr.entry_price, 6))
           for tr in res_on.trades}
check("gated trades are a subset of ungated", on_keys <= off_keys,
      f"{len(on_keys - off_keys)} extra")

# The gate must not change the *outcome* of a trade it lets through: the
# same setup, entered at the same bar, must exit identically. A gate that
# perturbs the trade log is a gate that is doing more than filtering.
off_by_key = {(tr.entry_time, tr.direction, round(tr.entry_price, 6)): tr
              for tr in res_off.trades}
drift = 0
for tr in res_on.trades:
    other = off_by_key.get((tr.entry_time, tr.direction, round(tr.entry_price, 6)))
    if other is None:
        continue
    if (other.exit_reason != tr.exit_reason
            or abs(other.net_pnl - tr.net_pnl) > 1e-9
            or abs(other.r_multiple - tr.r_multiple) > 1e-9):
        drift += 1
check("gated trades exit identically to ungated", drift == 0,
      f"{drift} drifted")

# --------------------------------------------------- breakdown report
section("killzone_breakdown")
kb = res_off.killzone_breakdown()
check("breakdown non-empty", bool(kb), "empty")
check("breakdown sums to closed trades",
      sum(row["trades"] for row in kb.values()) == len(res_off.closed),
      f"{sum(r['trades'] for r in kb.values())} vs {len(res_off.closed)}")
check("breakdown keys are labels",
      set(kb) <= {"asia_range", "london_open", "ny_am", "ny_pm", "outside"},
      str(set(kb)))
for label, row in kb.items():
    check(f"breakdown {label} has win_rate", "win_rate" in row)
    check(f"breakdown {label} has expectancy_r", "expectancy_r" in row)
    check(f"breakdown {label} has net_pnl", "net_pnl" in row)

summary = res_off.summary()
check("summary has by_killzone", "by_killzone" in summary)
check("summary by_killzone matches", summary["by_killzone"] == kb)
check("summary is JSON-safe", isinstance(bt.json_safe(summary), dict))

desc = res_off.describe()
check("describe mentions by killzone", "by killzone" in desc or not kb)
check("describe is a string", isinstance(desc, str))

# ------------------------------------------------------- walk_forward
section("walk_forward threading")
windows = bt.walk_forward(frame, timeframe="15m", splits=2, params=params_on,
                          config=cfg, warmup_bars=300)
check("walk_forward returned windows", len(windows) > 0, f"got {len(windows)}")
for w in windows:
    if w.test is not None:
        bad = [tr for tr in w.test.trades if tr.killzone is None]
        check(f"window {w.index} test trades gated", not bad, f"{len(bad)} outside")

# --------------------------------------------------- explicit filter
section("Explicit SessionFilter injection")
custom = SessionFilter({"killzones": {"only_ny": {"start": "13:00", "end": "16:00"}}})
res_custom = bt.replay(frame, timeframe="15m", params=params_on, config=cfg,
                       warmup_bars=300, sessions=custom)
check("custom filter used", all(tr.killzone == "only_ny" for tr in res_custom.trades),
      str({tr.killzone for tr in res_custom.trades}))
check("custom filter produced trades", len(res_custom.trades) > 0,
      f"got {len(res_custom.trades)}")

# ------------------------------------------------------ edge cases
section("Edge cases")
try:
    bt.replay(frame.iloc[:10], timeframe="15m", params=params_off, config=cfg,
              warmup_bars=300)
    check("short frame raises", False, "no raise")
except ValueError as err:
    check("short frame raises ValueError", "need more than" in str(err), str(err))

try:
    bt.replay(frame, timeframe="15m", params=params_off, config=cfg,
              warmup_bars=300, require_mtf=True)
    check("mtf without frame raises", False, "no raise")
except ValueError as err:
    check("mtf without frame raises ValueError", "htf_frame" in str(err), str(err))

# Empty killzones block: gate on means nothing trades.
empty_filter = SessionFilter({"killzones": {}})
res_empty = bt.replay(frame, timeframe="15m", params=params_on, config=cfg,
                      warmup_bars=300, sessions=empty_filter)
check("empty killzones blocks everything", len(res_empty.trades) == 0,
      f"got {len(res_empty.trades)}")
check("empty killzones records skips",
      res_empty.skipped.get(bt.SKIP_KILLZONE, 0) > 0, str(res_empty.skipped))

# NaT in the index must not raise and must land outside every window.
nat_frame = frame.copy()
nat_index = nat_frame.index.to_list()
nat_index[500] = pd.NaT
nat_frame.index = pd.DatetimeIndex(nat_index)
try:
    res_nat = bt.replay(nat_frame, timeframe="15m", params=params_off, config=cfg,
                        warmup_bars=300)
    check("NaT index replays", True)
    check("NaT bar not labelled", all(tr.killzone is not None for tr in res_nat.trades))
except Exception as err:  # noqa: BLE001
    check("NaT index replays", False, f"{type(err).__name__}: {err}")

# The scalar path must survive NaT too, not just the vectorised one.
check("scalar NaT returns None", sf.active_killzone(pd.NaT) is None)
check("scalar NaT Timestamp returns None",
      sf.active_killzone(pd.Timestamp("NaT")) is None)
check("scalar nan returns None", sf.active_killzone(float("nan")) is None)
check("scalar None returns None", sf.active_killzone(None) is None)
check("scalar in_killzone NaT is False", sf.in_killzone(pd.NaT) is False)
check("scalar in_named NaT is False",
      sf.in_named(pd.NaT, "london_open") is False)

# --------------------------------------------------- config untouched
section("Config immutability")
before = repr(sorted(cfg.keys()))
bt.replay(frame, timeframe="15m", params=params_on, config=cfg, warmup_bars=300)
check("config keys unchanged", repr(sorted(cfg.keys())) == before)
check("killzones block unchanged",
      cfg["killzones"] == load_config()["killzones"])

# --------------------------------------------------------- eurusd cfg
section("EURUSD profile")
eur = load_config("config.eurusd.yaml")
eur_filter = SessionFilter(eur)
# The EURUSD profile overrides london_open and ny_am and inherits the
# asia_range / ny_pm defaults through the deep merge, so all four are live.
check("eurusd windows",
      set(eur_filter.names) == {"asia_range", "london_open", "ny_am", "ny_pm"},
      str(eur_filter.names))
check("eurusd london_open 07:00-10:00",
      eur_filter.window("london_open").start.hour == 7
      and eur_filter.window("london_open").end.hour == 10)
check("eurusd ny_am 12:00-15:00",
      eur_filter.window("ny_am").start.hour == 12
      and eur_filter.window("ny_am").end.hour == 15)
check("eurusd asia_range inherited 00:00-03:00",
      eur_filter.window("asia_range").start.hour == 0
      and eur_filter.window("asia_range").end.hour == 3)
check("eurusd ny_pm inherited 17:00-20:00",
      eur_filter.window("ny_pm").start.hour == 17
      and eur_filter.window("ny_pm").end.hour == 20)
p_eur = bt.BacktestParams.from_config(eur)
check("eurusd require_killzone from config",
      p_eur.require_killzone is True, f"got {p_eur.require_killzone}")
check("eurusd contract size", p_eur.contract_size == 100000.0)

# The EURUSD frame is FX, so the same replay must run on it unchanged.
eur_frame = make_frame(bars=900)
eur_frame = eur_frame / 2400.0 * 1.0850
res_eur = bt.replay(eur_frame, timeframe="15m", params=p_eur, config=eur,
                    warmup_bars=300)
check("eurusd replay runs", isinstance(res_eur, bt.BacktestResult))
check("eurusd labels are eurusd windows",
      {tr.killzone for tr in res_eur.trades}
      <= {"asia_range", "london_open", "ny_am", "ny_pm", None},
      str({tr.killzone for tr in res_eur.trades}))

# ------------------------------------------------------------- report
print(f"\n{'=' * 62}")
print(f"PASS {PASS}   FAIL {FAIL}")
if FAILURES:
    print("\nFAILURES:")
    for line in FAILURES:
        print(f"  - {line}")
print("=" * 62)
sys.exit(1 if FAIL else 0)
