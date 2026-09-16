-- ============================================================
-- STEP 1: CENTRAL BANK & MACROECONOMIC NEWS
-- Target: PostgreSQL 15+ / TimescaleDB 2.x
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;
-- ============================================================

CREATE TABLE macro_news (
    id              BIGSERIAL,

    -- Source provenance
    source_name     TEXT        NOT NULL,           -- 'ForexFactory', 'Reuters', 'Fed RSS'
    source_url      TEXT,                           -- canonical link to the release
    external_id     TEXT,                           -- upstream dedup key

    -- Institution identity
    bank_name       TEXT        NOT NULL,           -- 'FED', 'ECB', 'BOJ', 'BOE', 'SNB', 'RBA'
    bank_region     TEXT,                           -- 'US', 'EU', 'JP' (ISO-3166 alpha-2)
    currency        TEXT,                           -- 'USD', 'EUR', 'JPY'

    -- Event taxonomy
    event_title     TEXT        NOT NULL,           -- 'US CPI YoY'
    event_category  TEXT,                           -- 'INFLATION','RATES','EMPLOYMENT','GDP','SPEECH'
    impact_level    SMALLINT    NOT NULL DEFAULT 1, -- 1 = low, 2 = medium, 3 = high

    -- Numeric payload
    value_actual    NUMERIC(18, 4),
    value_forecast  NUMERIC(18, 4),
    value_previous  NUMERIC(18, 4),
    unit            TEXT,                           -- '%', 'K', 'B', 'index'

    surprise        NUMERIC(18, 4) GENERATED ALWAYS AS (
                        CASE
                            WHEN value_actual IS NULL OR value_forecast IS NULL THEN NULL
                            ELSE value_actual - value_forecast
                        END
                    ) STORED,

    -- Time
    published_at    TIMESTAMPTZ NOT NULL,           -- true release time (hypertable partition column)
    scheduled_at    TIMESTAMPTZ,                    -- originally scheduled time (drift tracking)
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Text payload
    headline        TEXT,
    raw_text        TEXT,
    raw_payload     JSONB,                          -- full upstream object for replay

    -- Housekeeping / dedup
    hash_sha256     BYTEA,
    is_revised      BOOLEAN     NOT NULL DEFAULT FALSE,
    revised_from_id BIGINT      REFERENCES macro_news (id) ON DELETE SET NULL,

    PRIMARY KEY (id, published_at)
);

SELECT create_hypertable(
    'macro_news',
    'published_at',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ------------------------------------------------------------
-- INDEXES
-- ------------------------------------------------------------

-- Hot path: "high-impact events near time T"
CREATE INDEX idx_macro_news_impact_time
    ON macro_news (impact_level DESC, published_at DESC);

-- Per-institution timeline
CREATE INDEX idx_macro_news_bank_time
    ON macro_news (bank_name, published_at DESC);

-- Currency-scoped lookups (USD drives XAUUSD)
CREATE INDEX idx_macro_news_currency_time
    ON macro_news (currency, published_at DESC)
    WHERE currency IS NOT NULL;

-- Dedup: same source + same upstream id + same release time
CREATE UNIQUE INDEX uq_macro_news_source_external
    ON macro_news (source_name, external_id, published_at)
    WHERE external_id IS NOT NULL;

-- Dedup: identical content across sources
CREATE UNIQUE INDEX uq_macro_news_hash
    ON macro_news (hash_sha256)
    WHERE hash_sha256 IS NOT NULL;

-- Category-scoped scans (backtests by event type)
CREATE INDEX idx_macro_news_category_time
    ON macro_news (event_category, published_at DESC)
    WHERE event_category IS NOT NULL;

-- Ad-hoc JSONB introspection
CREATE INDEX idx_macro_news_payload_gin
    ON macro_news USING GIN (raw_payload jsonb_path_ops);