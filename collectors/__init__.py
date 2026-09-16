"""collectors/__init__.py — Python ingestion layer for Gold Terminal.

Each module here owns one upstream source and writes into exactly one
TimescaleDB hypertable:

    fred_collector.py    -> macro_fundamentals   (FRED series, point-in-time)
    yahoo_collector.py   -> technical_levels     (GC=F candles -> SMC zones)
    goldapi_collector.py -> intermarket_sentiment (XAU spot ticks + context)

Run any collector directly (`python -m collectors.fred_collector`) or all
of them through `python -m collectors.run_all`.
"""

__all__ = ["config"]
