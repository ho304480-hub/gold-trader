-- ============================================================
-- STEP 2: SMART MONEY CONCEPTS / ICT TECHNICAL LEVELS (XAUUSD)
-- Target: PostgreSQL 15+ / TimescaleDB 2.x
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;
--
-- Institutional-grade structural-zone store. One row per
-- detected zone, versioned on (valid_from, ...) so a zone can
-- be invalidated, mitigated, re-anchored or re-scored without
-- losing its history. Every concept family shares one physical
-- table (single scan path, single set of continuous aggregates)
-- and carries a typed JSONB "meta" bag for anything the schema
-- does not yet model explicitly.
--
-- Concept families covered:
--   ORDER BLOCK : OB, BREAKER, MITIGATION_BLOCK, REJECTION_BLOCK
--   LIQUIDITY   : LIQUIDITY_POOL, STOP_HUNT, EQUAL_HIGHS/LOWS, INDUCEMENT
--   IMBALANCE   : FVG, IMBALANCE, BISI, SIBI, PREMIUM, DISCOUNT
--   STRUCTURE   : BOS, CHoCH, MSS, SWING_HIGH, SWING_LOW
--   EXTREME     : DEALING_RANGE, ASIA_HIGH/LOW, SESSION_HIGH/LOW, PDH/PDL
--   MICRO       : OPTIMAL_TRADE_ENTRY, CONSEQUENT_ENCROACHMENT
-- ============================================================

CREATE TABLE technical_levels (
    id                  BIGSERIAL,

    -- --------------------------------------------------------
    -- Instrument + timeframe identity
    -- --------------------------------------------------------
    symbol              TEXT        NOT NULL DEFAULT 'XAUUSD',
    timeframe           TEXT        NOT NULL,       -- '1m','5m','15m','1h','4h','1D','1W'
    timeframe_seconds   INTEGER     NOT NULL,       -- materialised for fast bucket math
    tf_rank             SMALLINT    NOT NULL,       -- 1=intraday .. 7=HTF, hierarchical filters

    -- --------------------------------------------------------
    -- Concept taxonomy
    -- --------------------------------------------------------
    concept             TEXT        NOT NULL,       -- 'ORDER_BLOCK','FVG','LIQUIDITY_POOL',...
    sub_concept         TEXT,                       -- 'BREAKER','STOP_HUNT','EQUAL_HIGHS',...
    direction           TEXT        NOT NULL,       -- 'BULLISH','BEARISH','NEUTRAL'
    is_htf              BOOLEAN     NOT NULL DEFAULT FALSE,
    polarity            SMALLINT,                   -- 1 = supply/above, -1 = demand/below, 0 = mid

    -- --------------------------------------------------------
    -- Zone geometry (price space)
    -- --------------------------------------------------------
    price_high          NUMERIC(18, 4) NOT NULL,    -- distal / far edge
    price_low           NUMERIC(18, 4) NOT NULL,    -- proximal / near edge
    price_mid           NUMERIC(18, 4) GENERATED ALWAYS AS (
                            (price_high + price_low) / 2.0
                        ) STORED,
    price_open          NUMERIC(18, 4),             -- origin candle open (OB / iFVG)
    price_close         NUMERIC(18, 4),             -- origin candle close (OB / iFVG)
    zone_height         NUMERIC(18, 4) GENERATED ALWAYS AS (
                            price_high - price_low
                        ) STORED,
    atr_at_formation    NUMERIC(18, 4),             -- ATR(14) on the formation TF
    zone_height_atr     NUMERIC(18, 4) GENERATED ALWAYS AS (
                            CASE
                                WHEN atr_at_formation IS NULL OR atr_at_formation = 0 THEN NULL
                                ELSE (price_high - price_low) / atr_at_formation
                            END
                        ) STORED,
    premium_discount    NUMERIC(7, 4),              -- 0.0 = range low, 1.0 = range high

    -- --------------------------------------------------------
    -- Reference swing / liquidity anchor
    -- --------------------------------------------------------
    ref_price           NUMERIC(18, 4),             -- swept high/low, EQH/EQL level
    anchor_level_id     BIGINT      REFERENCES technical_levels (id) ON DELETE SET NULL,

    -- --------------------------------------------------------
    -- Detection quality
    -- --------------------------------------------------------
    displacement_atr    NUMERIC(10, 4),             -- departure-leg size in ATR units
    volume_delta        NUMERIC(24, 8),             -- signed aggressor delta on departure
    tick_volume         NUMERIC(24, 8),
    time_in_zone_secs   INTEGER,                    -- dwell before mitigation
    touches             SMALLINT    NOT NULL DEFAULT 0,
    approach_count      SMALLINT    NOT NULL DEFAULT 0,
    liquidity_est_usd   NUMERIC(24, 2),             -- modelled stop-pool notional
    strength            NUMERIC(5, 2),              -- 0.00 .. 100.00 composite model score
    confluence_count    SMALLINT    NOT NULL DEFAULT 0,
    confluence          TEXT[],                     -- {'HTF_FVG','OB_OVERLAP','SESSION_HIGH'}

    -- --------------------------------------------------------
    -- Lifecycle: FRESH -> TOUCHED -> MITIGATED / VIOLATED / EXPIRED
    -- --------------------------------------------------------
    status              TEXT        NOT NULL DEFAULT 'FRESH',
    mitigation_state    TEXT        NOT NULL DEFAULT 'UNMITIGATED',
    mitigation_mode     TEXT,                       -- 'CLOSE_THROUGH','WICK','50_PCT_RULE'
    state_version       INTEGER     NOT NULL DEFAULT 1,
    is_valid            BOOLEAN     NOT NULL DEFAULT TRUE,

    -- --------------------------------------------------------
    -- Multi-timeframe validity
    -- --------------------------------------------------------
    mtf_confirmed       BOOLEAN     NOT NULL DEFAULT FALSE,
    mtf_aligned_tfs     TEXT[],                     -- TFs confirming the same zone
    ltf_trigger_tf      TEXT,                       -- lower TF that produced entry
    invalidated_by_tf   TEXT,

    -- --------------------------------------------------------
    -- Formation / validity window (partition key is valid_from)
    -- --------------------------------------------------------
    formed_at           TIMESTAMPTZ NOT NULL,       -- candle close that created the zone
    candle_open_time    TIMESTAMPTZ,                -- origin candle open
    valid_from          TIMESTAMPTZ NOT NULL,       -- when the zone became tradeable
    valid_until         TIMESTAMPTZ,                -- theoretical / session expiry
    first_touch_at      TIMESTAMPTZ,
    mitigated_at        TIMESTAMPTZ,
    invalidated_at      TIMESTAMPTZ,

    -- --------------------------------------------------------
    -- Execution linkage
    -- --------------------------------------------------------
    entry_price         NUMERIC(18, 4),
    stop_price          NUMERIC(18, 4),
    target_price        NUMERIC(18, 4),
    risk_reward         NUMERIC(10, 4),
    risk_points         NUMERIC(18, 4) GENERATED ALWAYS AS (
                            CASE
                                WHEN entry_price IS NULL OR stop_price IS NULL THEN NULL
                                ELSE abs(entry_price - stop_price)
                            END
                        ) STORED,

    -- --------------------------------------------------------
    -- Provenance + limitless extensibility
    -- --------------------------------------------------------
    detector            TEXT,                       -- 'smc_engine_v3', 'manual', 'vision_llm'
    detector_version    TEXT,
    algo_params         JSONB,                      -- exact params used at detection time
    meta                JSONB       NOT NULL DEFAULT '{}'::JSONB,
    raw_payload         JSONB,                      -- verbatim detector output for replay
    tags                TEXT[],                     -- {'asia','news_shield','killzone'}

    -- --------------------------------------------------------
    -- Housekeeping / dedup
    -- --------------------------------------------------------
    hash_sha256         BYTEA,
    ingest_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Enforce sane geometry at the storage layer
    CONSTRAINT chk_tl_zone_geometry CHECK (price_high >= price_low),
    CONSTRAINT chk_tl_direction     CHECK (direction IN ('BULLISH','BEARISH','NEUTRAL')),
    CONSTRAINT chk_tl_status        CHECK (status IN ('FRESH','TOUCHED','RESPECTED','MITIGATED','VIOLATED','EXPIRED','ARCHIVED')),
    CONSTRAINT chk_tl_tf_seconds    CHECK (timeframe_seconds > 0),
    CONSTRAINT chk_tl_tf_rank       CHECK (tf_rank BETWEEN 1 AND 7),
    CONSTRAINT chk_tl_premium_disc  CHECK (premium_discount IS NULL OR premium_discount BETWEEN 0 AND 1),
    CONSTRAINT chk_tl_strength      CHECK (strength IS NULL OR strength BETWEEN 0 AND 100),

    -- TimescaleDB requires the partition column inside the primary key
    PRIMARY KEY (id, valid_from)
);

SELECT create_hypertable(
    'technical_levels',
    'valid_from',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ------------------------------------------------------------
-- HOT-PATH INDEXES
-- ------------------------------------------------------------

-- Primary query: "live, valid zones for this TF, strongest first"
CREATE INDEX idx_tl_live_zone
    ON technical_levels (symbol, timeframe, concept, direction, valid_from DESC)
    WHERE is_valid;

-- Active (untouched / valid) zone map per instrument
CREATE INDEX idx_tl_active_untouched
    ON technical_levels (symbol, price_high, price_low)
    WHERE is_valid AND status IN ('FRESH','TOUCHED');

-- Structural timeline (BOS / CHoCH / MSS sequence reconstruction)
CREATE INDEX idx_tl_structure_timeline
    ON technical_levels (symbol, formed_at DESC)
    WHERE concept IN ('BOS','CHOCH','MSS','SWING_HIGH','SWING_LOW');

-- HTF bias alignment
CREATE INDEX idx_tl_htf_direction
    ON technical_levels (symbol, direction, valid_from DESC)
    WHERE is_htf AND is_valid;

-- ------------------------------------------------------------
-- CONCEPT-SCOPED PARTIAL INDEXES
-- ------------------------------------------------------------

-- Order blocks awaiting mitigation (entry-engine hot path)
CREATE INDEX idx_tl_order_blocks_pending
    ON technical_levels (symbol, timeframe, direction, price_high DESC)
    WHERE concept = 'ORDER_BLOCK'
      AND is_valid
      AND status IN ('FRESH','TOUCHED')
      AND mitigation_state = 'UNMITIGATED';

-- Liquidity resting above/below — sweep engine + stop-hunt detector
CREATE INDEX idx_tl_liquidity_live
    ON technical_levels (symbol, ref_price DESC)
    WHERE concept IN ('LIQUIDITY_POOL','EQUAL_HIGHS','EQUAL_LOWS','STOP_HUNT')
      AND is_valid;

-- Unfilled imbalances by TF (price is likely to rebalance toward these)
CREATE INDEX idx_tl_fvg_unfilled
    ON technical_levels (symbol, timeframe, direction, price_high DESC)
    WHERE concept IN ('FVG','IMBALANCE','BISI','SIBI')
      AND is_valid
      AND mitigation_state = 'UNMITIGATED';

-- Trade-quality filter (HTF-confirmed, strongest first)
CREATE INDEX idx_tl_quality_rank
    ON technical_levels (symbol, timeframe, strength DESC NULLS LAST, confluence_count DESC)
    WHERE is_valid AND mtf_confirmed;

-- ------------------------------------------------------------
-- GEO / RANGE SCANS
-- ------------------------------------------------------------

-- "What levels overlap this price band?" — confluence scoring,
-- SL/TP placement, pre-trade risk checks.
CREATE INDEX idx_tl_price_envelope
    ON technical_levels
    USING GIST (numrange(price_low, price_high, '[]'));

-- Cheap append-only scans on the hypertable's physical ordering
CREATE INDEX idx_tl_valid_from_brin
    ON technical_levels USING BRIN (valid_from);

-- ------------------------------------------------------------
-- ARRAY + JSONB EXTENSIBILITY
-- ------------------------------------------------------------

CREATE INDEX idx_tl_confluence_gin
    ON technical_levels USING GIN (confluence);

CREATE INDEX idx_tl_tags_gin
    ON technical_levels USING GIN (tags);

-- Typed JSONB bag: containment queries, e.g.
--   WHERE meta @> '{"killzone":"LONDON"}'::jsonb
--   WHERE meta @> '{"sweep":{"class":"STOP_RUN"}}'::jsonb
CREATE INDEX idx_tl_meta_gin
    ON technical_levels USING GIN (meta jsonb_path_ops);

-- Exact detector-config replay (algo_params / detector_version)
CREATE INDEX idx_tl_algo_params_gin
    ON technical_levels USING GIN (algo_params jsonb_path_ops)
    WHERE algo_params IS NOT NULL;

-- Full detector payload (heavier, backtest forensics only)
CREATE INDEX idx_tl_raw_payload_gin
    ON technical_levels USING GIN (raw_payload jsonb_path_ops)
    WHERE raw_payload IS NOT NULL;

-- ------------------------------------------------------------
-- DEDUP
-- ------------------------------------------------------------

-- Same zone, same TF, same formation time = one logical level at birth.
-- Scoped to state_version = 1 so lifecycle updates (state_version 2..N)
-- can append without colliding; re-detections must bump state_version
-- or provide hash_sha256, never insert a duplicate genesis row.
CREATE UNIQUE INDEX uq_tl_zone_identity
    ON technical_levels (symbol, timeframe, concept, formed_at, price_high, price_low)
    WHERE state_version = 1;

-- Hard content dedup across the whole table, any lifecycle version
CREATE UNIQUE INDEX uq_tl_hash
    ON technical_levels (hash_sha256)
    WHERE hash_sha256 IS NOT NULL;