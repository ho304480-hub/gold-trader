-- ============================================================
-- STEP 3: INTERMARKET CORRELATION & MARKET SENTIMENT (XAUUSD)
-- Target: PostgreSQL 15+ / TimescaleDB 2.x
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;
--
-- Cross-asset context layer that explains WHY XAUUSD moves, not
-- just where. One row per observation on a correlation grid of
-- (as_of, driver, horizon). Drives regime detection (risk-on /
-- risk-off / dollar squeeze), real-yield repricing, and the
-- sentiment overlay the signal engine prefixes to every setup.
--
-- Integrates with:
--   macro_news        -> macro_event_id, sentiment_from_macro
--   technical_levels  -> level_id (zone this reading contextualises)
--
-- Driver coverage:
--   RATES    : DXY, US02Y, US10Y, TIPS_10Y, REAL_YIELD_10Y
--   METALS   : XAGUSD, GOLD_SILVER_RATIO, PLATINUM, COPPER
--   RISK     : VIX, SPX, US100, USDJPY, US10Y_JPY (carry)
--   CRYPTO   : BTCUSD (liquidity proxy / debasement bid)
--   SESSION  : ASIA / LONDON / NY volatility, session spreads
--   POSITION : COT net positioning, ETF flows, open interest
--   SENTIMENT: fear/greed, put-call skew, retail long/short
-- ============================================================

CREATE TABLE intermarket_sentiment (
    id                  BIGSERIAL,

    -- --------------------------------------------------------
    -- Observation identity + partition key
    -- --------------------------------------------------------
    as_of               TIMESTAMPTZ NOT NULL,       -- observation time (hypertable partition column)
    base_symbol         TEXT        NOT NULL DEFAULT 'XAUUSD',
    timeframe           TEXT        NOT NULL,       -- timeframe of the measurement window
    timeframe_seconds   INTEGER     NOT NULL,
    session             TEXT,                       -- 'ASIA','LONDON','NY','OVERLAP','CLOSED'
    session_phase       TEXT,                       -- 'OPEN_DRIVE','LUNCH','PM_FIX','CLOSE'

    -- --------------------------------------------------------
    -- Driver identity (the correlated instrument / metric)
    -- --------------------------------------------------------
    driver_symbol       TEXT        NOT NULL,       -- 'DXY','XAGUSD','VIX','US10Y','GOLD_SILVER_RATIO'
    driver_class        TEXT        NOT NULL,       -- 'RATES','METALS','RISK','CRYPTO','SESSION','POSITION','SENTIMENT'
    driver_source       TEXT,                       -- 'YahooFinance','FRED','CFTC','ICE','gold-api','broker'
    driver_external_id  TEXT,                       -- upstream id for replay

    -- --------------------------------------------------------
    -- Driver price state
    -- --------------------------------------------------------
    driver_price        NUMERIC(24, 8),
    driver_open         NUMERIC(24, 8),
    driver_high         NUMERIC(24, 8),
    driver_low          NUMERIC(24, 8),
    driver_change_pct   NUMERIC(12, 6),             -- window return in percent
    driver_change_abs   NUMERIC(24, 8),
    driver_zscore       NUMERIC(12, 6),             -- standardized vs rolling window
    driver_percentile   NUMERIC(7, 4),              -- 0..1 rank within lookback history

    -- --------------------------------------------------------
    -- XAUUSD state at the same instant (for alignment)
    -- --------------------------------------------------------
    gold_price          NUMERIC(18, 4),
    gold_change_pct     NUMERIC(12, 6),
    gold_range_pct      NUMERIC(12, 6),             -- (high-low)/open for the window
    gold_trend          TEXT,                       -- 'UP','DOWN','RANGE'
    gold_rsi_14         NUMERIC(7, 4),

    -- --------------------------------------------------------
    -- Correlation block (rolling window)
    -- --------------------------------------------------------
    lookback_periods    INTEGER,                    -- bars in the rolling window
    correl_pearson      NUMERIC(8, 6),              -- -1..1 linear
    correl_spearman     NUMERIC(8, 6),              -- -1..1 rank-based (outlier robust)
    correl_rolling_mean NUMERIC(8, 6),              -- mean r over the longer window
    correl_zscore       NUMERIC(10, 6),             -- how unusual the current r is
    beta_gold_vs_driver NUMERIC(14, 6),             -- OLS slope, gold regressed on driver
    r_squared           NUMERIC(8, 6),              -- 0..1 explanatory power
    correl_regime       TEXT,                       -- 'INVERSE_STRONG','INVERSE','DECOUPLED','DIRECT','DIRECT_STRONG'
    lead_lag_periods    SMALLINT,                   -- -N driver leads, 0 contemporaneous, +N gold leads
    is_correl_broken    BOOLEAN     NOT NULL DEFAULT FALSE,  -- correlation breakdown flag
    broken_since        TIMESTAMPTZ,

    -- --------------------------------------------------------
    -- Ratio / spread analytics (gold-specific)
    -- --------------------------------------------------------
    gold_silver_ratio   NUMERIC(14, 6),             -- XAUUSD / XAGUSD
    gsr_change_pct      NUMERIC(12, 6),
    gsr_percentile      NUMERIC(7, 4),
    gsr_signal          TEXT,                       -- 'RISK_ON_TILT','RISK_OFF_TILT','NEUTRAL'
    gold_dxy_spread     NUMERIC(18, 6),             -- gold log-return minus DXY log-return
    real_yield_10y      NUMERIC(12, 6),             -- nominal 10y minus breakeven
    gold_real_yield_gap NUMERIC(18, 6),             -- actual gold vs real-yield implied fair value

    -- --------------------------------------------------------
    -- Session volatility regime
    -- --------------------------------------------------------
    atr_session         NUMERIC(18, 6),
    atr_percentile      NUMERIC(7, 4),
    realized_vol        NUMERIC(12, 6),             -- annualized realized volatility
    implied_vol         NUMERIC(12, 6),             -- options-implied, when available
    vol_of_vol          NUMERIC(12, 6),
    vol_regime          TEXT,                       -- 'COMPRESSED','NORMAL','EXPANDED','PANIC'
    session_range_pts   NUMERIC(18, 6),             -- raw session high-low in points
    session_range_atr   NUMERIC(12, 6),
    spread_avg_pts      NUMERIC(12, 6),             -- mean broker spread for the session
    spread_max_pts      NUMERIC(12, 6),
    liquidity_score     NUMERIC(7, 4),              -- 0..1 depth / slippage composite,
    tick_rate_per_min   NUMERIC(12, 4),

    -- --------------------------------------------------------
    -- Market sentiment hooks
    -- --------------------------------------------------------
    fear_greed_index    NUMERIC(7, 4),              -- 0..100
    fear_greed_label    TEXT,                       -- 'EXTREME_FEAR'..'EXTREME_GREED'
    risk_sentiment      TEXT,                       -- 'RISK_ON','RISK_OFF','MIXED'
    positioning_bias    TEXT,                       -- 'LONG_HEAVY','SHORT_HEAVY','BALANCED'
    cot_net_long        NUMERIC(18, 2),             -- CFTC managed-money net
    cot_net_change      NUMERIC(18, 2),
    cot_percentile      NUMERIC(7, 4),
    etf_flow_usd        NUMERIC(24, 2),             -- GLD/IAU net creation/redemption
    retail_long_pct     NUMERIC(7, 4),              -- 0..100 retail positioning
    put_call_ratio      NUMERIC(12, 6),
    news_sentiment      NUMERIC(8, 6),              -- -1..1 NLP score
    news_volume         INTEGER,                    -- headline count in window
    sentiment_composite NUMERIC(8, 6),              -- -1..1 fused model output
    contrarian_flag     BOOLEAN     NOT NULL DEFAULT FALSE,  -- sentiment at exhaustion extreme

    -- --------------------------------------------------------
    -- Composite signal contribution
    -- --------------------------------------------------------
    bias_contribution   NUMERIC(8, 4),              -- score pushed into the fusion engine
    confidence          NUMERIC(7, 4),              -- 0..1 confidence weight
    is_stale            BOOLEAN     NOT NULL DEFAULT FALSE,
    quality_flags       TEXT[],                     -- {'THIN_LIQUIDITY','WIDE_SPREAD','PARTIAL_FEED'}

    -- --------------------------------------------------------
    -- Provenance + limitless extensibility
    -- --------------------------------------------------------
    collector           TEXT,                       -- 'intermarket_collector_v2'
    collector_version   TEXT,
    collector_params    JSONB,                      -- exact window/params at capture
    meta                JSONB       NOT NULL DEFAULT '{}'::JSONB,
    raw_payload         JSONB,                      -- verbatim upstream object for replay
    tags                TEXT[],

    -- --------------------------------------------------------
    -- Linkage to existing tables
    -- --------------------------------------------------------
    macro_event_id      BIGINT,                     -- -> macro_news (id)
    level_id            BIGINT,                     -- -> technical_levels (id)
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Enforce sane ranges at the storage layer
    CONSTRAINT chk_is_driver_class   CHECK (driver_class IN ('RATES','METALS','RISK','CRYPTO','SESSION','POSITION','SENTIMENT')),
    CONSTRAINT chk_is_correl_range   CHECK (correl_pearson  IS NULL OR correl_pearson  BETWEEN -1 AND 1),
    CONSTRAINT chk_is_spearman_range CHECK (correl_spearman IS NULL OR correl_spearman BETWEEN -1 AND 1),
    CONSTRAINT chk_is_r2_range       CHECK (r_squared       IS NULL OR r_squared       BETWEEN 0 AND 1),
    CONSTRAINT chk_is_pct_range      CHECK (driver_percentile IS NULL OR driver_percentile BETWEEN 0 AND 1),
    CONSTRAINT chk_is_gsr_pct_range  CHECK (gsr_percentile  IS NULL OR gsr_percentile  BETWEEN 0 AND 1),
    CONSTRAINT chk_is_atr_pct_range  CHECK (atr_percentile  IS NULL OR atr_percentile  BETWEEN 0 AND 1),
    CONSTRAINT chk_is_cot_pct_range  CHECK (cot_percentile  IS NULL OR cot_percentile  BETWEEN 0 AND 1),
    CONSTRAINT chk_is_liquidity      CHECK (liquidity_score IS NULL OR liquidity_score BETWEEN 0 AND 1),
    CONSTRAINT chk_is_confidence     CHECK (confidence      IS NULL OR confidence      BETWEEN 0 AND 1),
    CONSTRAINT chk_is_fear_greed     CHECK (fear_greed_index IS NULL OR fear_greed_index BETWEEN 0 AND 100),
    CONSTRAINT chk_is_retail_pct     CHECK (retail_long_pct IS NULL OR retail_long_pct BETWEEN 0 AND 100),
    CONSTRAINT chk_is_news_sentiment CHECK (news_sentiment  IS NULL OR news_sentiment  BETWEEN -1 AND 1),
    CONSTRAINT chk_is_composite      CHECK (sentiment_composite IS NULL OR sentiment_composite BETWEEN -1 AND 1),
    CONSTRAINT chk_is_tf_seconds     CHECK (timeframe_seconds > 0),
    CONSTRAINT chk_is_driver_highlow CHECK (driver_high IS NULL OR driver_low IS NULL OR driver_high >= driver_low),

    -- TimescaleDB requires the partition column inside the primary key
    PRIMARY KEY (id, as_of)
);

SELECT create_hypertable(
    'intermarket_sentiment',
    'as_of',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ------------------------------------------------------------
-- HOT-PATH INDEXES
-- ------------------------------------------------------------

-- Primary query: "latest reading for this driver on this TF"
CREATE INDEX idx_is_driver_time
    ON intermarket_sentiment (base_symbol, driver_symbol, timeframe, as_of DESC);

-- Driver-class dashboard (all RATES / all RISK inputs at a glance)
CREATE INDEX idx_is_class_time
    ON intermarket_sentiment (driver_class, as_of DESC)
    WHERE driver_class IS NOT NULL;

-- Session-scoped volatility + spread analytics
CREATE INDEX idx_is_session_time
    ON intermarket_sentiment (session, timeframe, as_of DESC)
    WHERE session IS NOT NULL;

-- Regime detection: every driver currently in a given correlation regime
CREATE INDEX idx_is_correl_regime
    ON intermarket_sentiment (correl_regime, as_of DESC)
    WHERE correl_regime IS NOT NULL;

-- Correlation-break alerts (partial, small, hot)
CREATE INDEX idx_is_correl_broken
    ON intermarket_sentiment (base_symbol, driver_symbol, broken_since DESC)
    WHERE is_correl_broken;

-- Volatility-regime filter for position sizing
CREATE INDEX idx_is_vol_regime
    ON intermarket_sentiment (vol_regime, timeframe, as_of DESC)
    WHERE vol_regime IS NOT NULL;

-- Sentiment extremes / contrarian scans
CREATE INDEX idx_is_contrarian
    ON intermarket_sentiment (base_symbol, as_of DESC)
    WHERE contrarian_flag;

-- Freshness guard for the live signal engine
CREATE INDEX idx_is_fresh_readings
    ON intermarket_sentiment (base_symbol, driver_symbol, as_of DESC)
    WHERE NOT is_stale;

-- ------------------------------------------------------------
-- LINKAGE INDEXES (joins back to Steps 1 and 2)
-- ------------------------------------------------------------

-- "Which macro release was this reading taken around?"
CREATE INDEX idx_is_macro_event
    ON intermarket_sentiment (macro_event_id, as_of DESC)
    WHERE macro_event_id IS NOT NULL;

-- "What intermarket context existed when this zone formed?"
CREATE INDEX idx_is_level
    ON intermarket_sentiment (level_id, as_of DESC)
    WHERE level_id IS NOT NULL;

-- ------------------------------------------------------------
-- ARRAY + JSONB EXTENSIBILITY
-- ------------------------------------------------------------

CREATE INDEX idx_is_tags_gin
    ON intermarket_sentiment USING GIN (tags);

CREATE INDEX idx_is_quality_flags_gin
    ON intermarket_sentiment USING GIN (quality_flags);

-- Typed JSONB bag: containment queries, e.g.
--   WHERE meta @> '{"regime":{"label":"DOLLAR_SQUEEZE"}}'::jsonb
--   WHERE meta @> '{"cot":{"report_date":"2026-09-08"}}'::jsonb
CREATE INDEX idx_is_meta_gin
    ON intermarket_sentiment USING GIN (meta jsonb_path_ops);

-- Exact collector-config replay (window lengths, sources, weights)
CREATE INDEX idx_is_collector_params_gin
    ON intermarket_sentiment USING GIN (collector_params jsonb_path_ops)
    WHERE collector_params IS NOT NULL;

-- Full upstream payload (heavier, backtest forensics only)
CREATE INDEX idx_is_raw_payload_gin
    ON intermarket_sentiment USING GIN (raw_payload jsonb_path_ops)
    WHERE raw_payload IS NOT NULL;

-- ------------------------------------------------------------
-- RANGE + PHYSICAL-ORDER SCANS
-- ------------------------------------------------------------

-- "What readings fall inside this price band?" — pairs with the
-- GiST envelope index on technical_levels for confluence scoring.
CREATE INDEX idx_is_gold_price_envelope
    ON intermarket_sentiment
    USING GIST (numrange(gold_price, gold_price, '[]'));

-- Cheap append-only scans on the hypertable's physical ordering
CREATE INDEX idx_is_as_of_brin
    ON intermarket_sentiment USING BRIN (as_of);

-- ------------------------------------------------------------
-- DEDUP
-- ------------------------------------------------------------

-- One reading per (time, driver, timeframe, session) — re-collection
-- must UPSERT, never append a duplicate observation. NULLS NOT DISTINCT
-- (PG15+) makes a NULL session unique too, so live sessions and
-- sessionless reads dedup on the same key.
CREATE UNIQUE INDEX uq_is_observation
    ON intermarket_sentiment (as_of, base_symbol, driver_symbol, timeframe, session)
    NULLS NOT DISTINCT;

-- Same upstream record replayed twice
CREATE UNIQUE INDEX uq_is_driver_external
    ON intermarket_sentiment (driver_source, driver_external_id, as_of)
    WHERE driver_external_id IS NOT NULL;