-- ============================================================
-- STEP 6: TRACKED SOURCES — DYNAMIC LINK REGISTRY
-- Target: PostgreSQL 15+ / TimescaleDB 2.x
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;
--
-- A small, mutable registry of the places the terminal reads from:
-- news feeds, central-bank pages, data portals, analyst blogs, X
-- accounts, anything with a URL worth polling. Unlike the Steps 1-5
-- tables this one is NOT a hypertable — it is configuration, not
-- time-series. It is read on every collection pass and written to
-- interactively, so it stays a plain heap table with a tiny index
-- footprint.
--
-- Design intent:
--   * url is the natural key. The same link must never be registered
--     twice, so UNIQUE(url) is the dedup contract and the ON CONFLICT
--     target for the Python helper.
--   * is_active is the soft-delete switch. Retiring a source keeps
--     its history and its id stable for anything already referencing
--     it, instead of cascading deletes through downstream tables.
--   * category is free-form text on purpose. The taxonomy will drift
--     as new source types appear; a CHECK constraint or enum here
--     would force a migration every time a new label is wanted.
--
-- Integrates with:
--   macro_news            -> source_url / source_name (provenance match)
--   macro_fundamentals    -> source_url / source_name (provenance match)
--   intermarket_sentiment -> driver_source (provenance match)
-- ============================================================

CREATE TABLE tracked_sources (
    id          SERIAL PRIMARY KEY,
    title       VARCHAR(255) NOT NULL,
    url         TEXT         UNIQUE NOT NULL,
    category    VARCHAR(100),
    is_active   BOOLEAN      DEFAULT TRUE,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ------------------------------------------------------------
-- HOUSEKEEPING
-- ------------------------------------------------------------

-- The collector's hot path is "give me everything still switched on",
-- so the partial index only carries the rows that query ever wants.
CREATE INDEX idx_tracked_sources_active
    ON tracked_sources (is_active)
    WHERE is_active;

-- Filtering the registry by category in the UI / CLI.
CREATE INDEX idx_tracked_sources_category
    ON tracked_sources (category)
    WHERE category IS NOT NULL;

-- Newest-first listing without a sort.
CREATE INDEX idx_tracked_sources_created_at
    ON tracked_sources (created_at DESC);

-- Case-insensitive title search for the terminal's source picker.
CREATE INDEX idx_tracked_sources_title_lower
    ON tracked_sources (lower(title));

-- ------------------------------------------------------------
-- SEED: the sources the terminal already reads from
-- ------------------------------------------------------------
-- ON CONFLICT DO NOTHING keeps this migration safe to re-run and
-- safe to apply on a database where someone already added these
-- links by hand.

INSERT INTO tracked_sources (title, url, category) VALUES
    ('FRED — Federal Reserve Economic Data',
     'https://fred.stlouisfed.org/', 'MACRO_DATA'),
    ('US Bureau of Labor Statistics',
     'https://www.bls.gov/', 'MACRO_DATA'),
    ('US Bureau of Economic Analysis',
     'https://www.bea.gov/', 'MACRO_DATA'),
    ('Federal Reserve — Press Releases',
     'https://www.federalreserve.gov/newsevents/pressreleases.htm', 'CENTRAL_BANK'),
    ('European Central Bank — Press',
     'https://www.ecb.europa.eu/press/html/index.en.html', 'CENTRAL_BANK'),
    ('Bank of Japan — Releases',
     'https://www.boj.or.jp/en/statistics/index.htm', 'CENTRAL_BANK'),
    ('Bank of England — News',
     'https://www.bankofengland.co.uk/news', 'CENTRAL_BANK'),
    ('US Treasury — Daily Yield Curve',
     'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve', 'RATES'),
    ('CME FedWatch Tool',
     'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html', 'RATES'),
    ('World Gold Council — Research',
     'https://www.gold.org/goldhub/research', 'GOLD_FLOW'),
    ('SPDR Gold Shares (GLD) — Holdings',
     'https://www.spdrgoldshares.com/', 'GOLD_FLOW'),
    ('Reuters — Commodities',
     'https://www.reuters.com/markets/commodities/', 'NEWS'),
    ('Kitco — Gold News',
     'https://www.kitco.com/news/', 'NEWS'),
    ('ForexFactory — Economic Calendar',
     'https://www.forexfactory.com/calendar', 'CALENDAR'),
    ('Investing.com — Economic Calendar',
     'https://www.investing.com/economic-calendar/', 'CALENDAR'),
    ('Yahoo Finance — Gold Futures (GC=F)',
     'https://finance.yahoo.com/quote/GC=F/', 'MARKET_DATA'),
    ('gold-api.com — XAU Spot',
     'https://api.gold-api.com/price/XAU', 'MARKET_DATA')
ON CONFLICT (url) DO NOTHING;
