-- ============================================================
-- STEP 4: AI VERDICTS, SIGNAL FUSION LOGS & PERFORMANCE TRACKING (XAUUSD)
-- Target: PostgreSQL 15+ / TimescaleDB 2.x
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;
--
-- The decision + accountability layer. Every row is one immutable
-- verdict emitted by the fusion engine at a point in time, carrying
-- the full evidence chain that produced it, the execution plan it
-- implied, and the realised outcome once the trade resolved.
--
-- Design contract:
--   * APPEND-ONLY. A verdict is never mutated into a different
--     verdict; a re-decision is a new row with a higher revision.
--   * SELF-CONTAINED EVIDENCE. Inputs are snapshotted into JSONB
--     (evidence) so a verdict can be re-audited years later even
--     after upstream rows are compacted or purged.
--   * LINKED. Foreign keys point at the exact source rows in
--     macro_news, technical_levels and intermarket_sentiment.
--   * SCORED. Outcome columns are filled by the resolver job and
--     feed the continuous aggregates below.
--
-- Integrates with:
--   macro_news           -> macro_event_id
--   technical_levels     -> level_id, opposing_level_id
--   intermarket_sentiment-> sentiment_id
--
-- Verdict taxonomy:
--   LONG / SHORT / NO_TRADE / WAIT / SCALE_IN / SCALE_OUT / HEDGE / FLAT
-- ============================================================

CREATE TABLE ai_verdicts (
    id                  BIGSERIAL,

    -- --------------------------------------------------------
    -- Decision identity + partition key
    -- --------------------------------------------------------
    decided_at          TIMESTAMPTZ NOT NULL,       -- verdict timestamp (hypertable partition column)
    symbol              TEXT        NOT NULL DEFAULT 'XAUUSD',
    timeframe           TEXT        NOT NULL,       -- decision timeframe
    timeframe_seconds   INTEGER     NOT NULL,
    session             TEXT,                       -- 'ASIA','LONDON','NY','OVERLAP','CLOSED'
    killzone            TEXT,                       -- 'LONDON_OPEN','NY_AM','NY_PM','ASIA_RANGE'

    -- --------------------------------------------------------
    -- Verdict
    -- --------------------------------------------------------
    verdict             TEXT        NOT NULL,       -- 'LONG','SHORT','NO_TRADE','WAIT','SCALE_IN','SCALE_OUT','HEDGE','FLAT'
    direction           TEXT        NOT NULL,       -- 'BULLISH','BEARISH','NEUTRAL'
    conviction          NUMERIC(7, 4),              -- 0..1 model conviction
    confidence          NUMERIC(7, 4),              -- 0..1 calibrated confidence
    fused_score         NUMERIC(10, 4),             -- -100..100 blended directional score
    raw_score           NUMERIC(10, 4),             -- pre-calibration score
    edge_bps            NUMERIC(12, 4),             -- expected edge in basis points
    expected_value      NUMERIC(14, 4),            -- EV in account currency
    kelly_fraction      NUMERIC(8, 6),              -- 0..1 suggested sizing fraction
    position_size_lots  NUMERIC(14, 4),
    risk_pct            NUMERIC(8, 4),              -- % of equity risked
    revision            INTEGER     NOT NULL DEFAULT 1,
    supersedes_id       BIGINT,                     -- -> ai_verdicts (id), prior revision
    is_final            BOOLEAN     NOT NULL DEFAULT TRUE,  -- FALSE once superseded

    -- --------------------------------------------------------
    -- Evidence chain (FKs into Steps 1-3)
    -- --------------------------------------------------------
    macro_event_id      BIGINT,                     -- -> macro_news (id)
    level_id            BIGINT,                     -- -> technical_levels (id)  primary zone
    opposing_level_id   BIGINT,                     -- -> technical_levels (id)  target / invalidation zone
    sentiment_id        BIGINT,                     -- -> intermarket_sentiment (id)
    evidence_count      SMALLINT    NOT NULL DEFAULT 0,
    evidence            JSONB       NOT NULL DEFAULT '{}'::JSONB,  -- frozen input snapshot
    evidence_hash       BYTEA,                      -- hash of evidence for tamper detection

    -- --------------------------------------------------------
    -- Fusion engine internals
    -- --------------------------------------------------------
    engine              TEXT,                       -- 'fusion_engine_v4'
    engine_version      TEXT,
    model_name          TEXT,                       -- 'gpt-xau-v3', 'ensemble_lgbm'
    model_version       TEXT,
    prompt_hash         BYTEA,                      -- reproducibility for LLM verdicts
    weights             JSONB,                      -- per-factor weights used
    factor_scores       JSONB,                      -- per-factor raw + weighted contributions
    top_factors         TEXT[],                     -- ordered drivers of the decision
    veto_flags          TEXT[],                     -- {'NEWS_BLACKOUT','SPREAD_WIDE','STALE_FEED'}
    regime_context      TEXT,                       -- 'TRENDING','RANGING','VOLATILE','NEWS_DRIVEN'
    latency_ms          INTEGER,
    token_usage         INTEGER,                    -- LLM cost accounting
    cost_usd            NUMERIC(12, 6),

    -- --------------------------------------------------------
    -- Execution plan implied by the verdict
    -- --------------------------------------------------------
    entry_price         NUMERIC(18, 4),
    stop_price          NUMERIC(18, 4),
    target_price        NUMERIC(18, 4),
    target_price_2      NUMERIC(18, 4),
    risk_reward         NUMERIC(10, 4),
    risk_points         NUMERIC(18, 4) GENERATED ALWAYS AS (
                            CASE
                                WHEN entry_price IS NULL OR stop_price IS NULL THEN NULL
                                ELSE abs(entry_price - stop_price)
                            END
                        ) STORED,
    reward_points       NUMERIC(18, 4) GENERATED ALWAYS AS (
                            CASE
                                WHEN entry_price IS NULL OR target_price IS NULL THEN NULL
                                ELSE abs(target_price - entry_price)
                            END
                        ) STORED,
    order_type          TEXT,                       -- 'MARKET','LIMIT','STOP','MITIGATION'
    valid_until         TIMESTAMPTZ,                -- verdict expiry
    invalidation_price  NUMERIC(18, 4),             -- thesis-death level
    invalidation_reason TEXT,

    -- --------------------------------------------------------
    -- Execution reality (filled by the broker bridge)
    -- --------------------------------------------------------
    execution_status    TEXT        NOT NULL DEFAULT 'PENDING',
    executed_at         TIMESTAMPTZ,
    filled_price        NUMERIC(18, 4),
    slippage_points     NUMERIC(18, 4) GENERATED ALWAYS AS (
                            CASE
                                WHEN filled_price IS NULL OR entry_price IS NULL THEN NULL
                                ELSE filled_price - entry_price
                            END
                        ) STORED,
    spread_at_entry     NUMERIC(12, 4),
    broker_ticket       TEXT,
    broker_name         TEXT,
    rejection_reason    TEXT,

    -- --------------------------------------------------------
    -- Outcome / performance tracking (filled by the resolver)
    -- --------------------------------------------------------
    outcome             TEXT        NOT NULL DEFAULT 'OPEN',
    closed_at           TIMESTAMPTZ,
    exit_price          NUMERIC(18, 4),
    exit_reason         TEXT,                       -- 'TP','SL','TRAIL','TIME_STOP','MANUAL','INVALIDATED'
    gross_pnl           NUMERIC(18, 4),
    net_pnl             NUMERIC(18, 4),
    pnl_pct             NUMERIC(12, 6),
    r_multiple          NUMERIC(12, 6),             -- realised R
    mae_points          NUMERIC(18, 4),             -- max adverse excursion
    mfe_points          NUMERIC(18, 4),             -- max favourable excursion
    mae_r               NUMERIC(12, 6),
    mfe_r               NUMERIC(12, 6),
    bars_held           INTEGER,
    hold_seconds        INTEGER,
    hit_target_1        BOOLEAN,
    hit_target_2        BOOLEAN,
    was_stopped         BOOLEAN,
    was_reversed        BOOLEAN,                    -- price reversed through invalidation
    max_drawdown_r      NUMERIC(12, 6),

    -- --------------------------------------------------------
    -- Attribution (why it won or lost)
    -- --------------------------------------------------------
    attribution         JSONB,                      -- per-factor P&L attribution
    primary_driver      TEXT,                       -- factor that most explained the outcome
    error_class         TEXT,                       -- 'GOOD_LOSS','BAD_WIN','MODEL_ERROR','EXECUTION_ERROR','REGIME_SHIFT'
    lesson              TEXT,                       -- free-text post-mortem
    tags                TEXT[],                     -- {'news_shield','asia_sweep','counter_trend'}

    -- --------------------------------------------------------
    -- Provenance + limitless extensibility
    -- --------------------------------------------------------
    meta                JSONB       NOT NULL DEFAULT '{}'::JSONB,
    raw_payload         JSONB,                      -- verbatim engine output for replay
    hash_sha256         BYTEA,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    -- Strict integrity constraints
    -- --------------------------------------------------------
    CONSTRAINT chk_av_verdict        CHECK (verdict IN ('LONG','SHORT','NO_TRADE','WAIT','SCALE_IN','SCALE_OUT','HEDGE','FLAT')),
    CONSTRAINT chk_av_direction      CHECK (direction IN ('BULLISH','BEARISH','NEUTRAL')),
    CONSTRAINT chk_av_outcome        CHECK (outcome IN ('OPEN','WIN','LOSS','BREAKEVEN','CANCELLED','EXPIRED','VOID')),
    CONSTRAINT chk_av_exec_status    CHECK (execution_status IN ('PENDING','SUBMITTED','FILLED','PARTIAL','REJECTED','CANCELLED','EXPIRED')),
    CONSTRAINT chk_av_conviction     CHECK (conviction IS NULL OR conviction BETWEEN 0 AND 1),
    CONSTRAINT chk_av_confidence     CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    CONSTRAINT chk_av_kelly          CHECK (kelly_fraction IS NULL OR kelly_fraction BETWEEN 0 AND 1),
    CONSTRAINT chk_av_fused_score    CHECK (fused_score IS NULL OR fused_score BETWEEN -100 AND 100),
    CONSTRAINT chk_av_raw_score      CHECK (raw_score IS NULL OR raw_score BETWEEN -100 AND 100),
    CONSTRAINT chk_av_risk_pct       CHECK (risk_pct IS NULL OR risk_pct BETWEEN 0 AND 100),
    CONSTRAINT chk_av_revision       CHECK (revision >= 1),
    CONSTRAINT chk_av_tf_seconds     CHECK (timeframe_seconds > 0),
    CONSTRAINT chk_av_evidence_count CHECK (evidence_count >= 0),
    CONSTRAINT chk_av_latency        CHECK (latency_ms IS NULL OR latency_ms >= 0),
    CONSTRAINT chk_av_tokens         CHECK (token_usage IS NULL OR token_usage >= 0),
    CONSTRAINT chk_av_cost           CHECK (cost_usd IS NULL OR cost_usd >= 0),
    CONSTRAINT chk_av_position_size  CHECK (position_size_lots IS NULL OR position_size_lots >= 0),
    CONSTRAINT chk_av_bars_held      CHECK (bars_held IS NULL OR bars_held >= 0),
    CONSTRAINT chk_av_hold_seconds   CHECK (hold_seconds IS NULL OR hold_seconds >= 0),

    -- Directional verdicts must carry a tradeable plan
    CONSTRAINT chk_av_tradeable_plan CHECK (
        verdict NOT IN ('LONG','SHORT','SCALE_IN','SCALE_OUT')
        OR (entry_price IS NOT NULL AND stop_price IS NOT NULL AND target_price IS NOT NULL)
    ),

    -- Stops must sit on the correct side of entry for every
    -- directional verdict, including scale-ins and scale-outs.
    CONSTRAINT chk_av_stop_side CHECK (
        (verdict IN ('LONG','SCALE_IN','SCALE_OUT') AND direction = 'BULLISH'
            AND entry_price IS NOT NULL AND stop_price IS NOT NULL AND stop_price < entry_price)
        OR (verdict IN ('LONG','SCALE_IN','SCALE_OUT') AND direction = 'BEARISH'
            AND entry_price IS NOT NULL AND stop_price IS NOT NULL AND stop_price > entry_price)
        OR (verdict = 'SHORT' AND entry_price IS NOT NULL AND stop_price IS NOT NULL AND stop_price > entry_price)
        OR (verdict NOT IN ('LONG','SHORT','SCALE_IN','SCALE_OUT'))
    ),

    -- Targets must sit on the profitable side of entry
    CONSTRAINT chk_av_target_side CHECK (
        (verdict IN ('LONG','SCALE_IN') AND entry_price IS NOT NULL AND target_price IS NOT NULL
            AND target_price > entry_price)
        OR (verdict IN ('SHORT','SCALE_OUT') AND entry_price IS NOT NULL AND target_price IS NOT NULL
            AND target_price < entry_price)
        OR (verdict NOT IN ('LONG','SHORT','SCALE_IN','SCALE_OUT'))
    ),

    -- A directional verdict must agree with its own direction field
    CONSTRAINT chk_av_direction_agreement CHECK (
        (verdict = 'LONG'  AND direction = 'BULLISH')
        OR (verdict = 'SHORT' AND direction = 'BEARISH')
        OR (verdict NOT IN ('LONG','SHORT'))
    ),

    -- A superseded verdict cannot still be flagged final
    CONSTRAINT chk_av_final_consistency CHECK (
        supersedes_id IS NULL OR is_final = FALSE
    ),

    -- A closed trade must have an exit price and a close time
    CONSTRAINT chk_av_closed_fields CHECK (
        outcome IN ('OPEN','CANCELLED','EXPIRED','VOID')
        OR (closed_at IS NOT NULL AND exit_price IS NOT NULL)
    ),

    -- A filled order must record when and at what price
    CONSTRAINT chk_av_filled_fields CHECK (
        execution_status NOT IN ('FILLED','PARTIAL')
        OR (executed_at IS NOT NULL AND filled_price IS NOT NULL)
    ),

    -- A rejected order must say why
    CONSTRAINT chk_av_rejected_reason CHECK (
        execution_status <> 'REJECTED' OR rejection_reason IS NOT NULL
    ),

    -- Superseding chain must be forward-only
    CONSTRAINT chk_av_supersedes CHECK (supersedes_id IS NULL OR supersedes_id <> id),

    -- TimescaleDB requires the partition column inside the primary key
    PRIMARY KEY (id, decided_at)
);

SELECT create_hypertable(
    'ai_verdicts',
    'decided_at',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ------------------------------------------------------------
-- HOT-PATH INDEXES
-- ------------------------------------------------------------

-- Primary query: "latest verdict for this symbol/TF"
CREATE INDEX idx_av_latest_verdict
    ON ai_verdicts (symbol, timeframe, decided_at DESC);

-- Live actionable verdicts only (partial, small, hot)
CREATE INDEX idx_av_actionable
    ON ai_verdicts (symbol, verdict, conviction DESC NULLS LAST, decided_at DESC)
    WHERE is_final AND outcome = 'OPEN' AND verdict <> 'NO_TRADE';

-- Open positions awaiting resolution (resolver job scan)
CREATE INDEX idx_av_open_positions
    ON ai_verdicts (symbol, decided_at)
    WHERE outcome = 'OPEN' AND execution_status IN ('FILLED','PARTIAL');

-- Pending orders awaiting broker acknowledgement
CREATE INDEX idx_av_pending_execution
    ON ai_verdicts (symbol, decided_at)
    WHERE execution_status IN ('PENDING','SUBMITTED');

-- Verdict history for a single logical decision (revision chain)
CREATE INDEX idx_av_revision_chain
    ON ai_verdicts (symbol, timeframe, decided_at DESC)
    WHERE NOT is_final;

-- Supersession lookups
CREATE INDEX idx_av_supersedes
    ON ai_verdicts (supersedes_id)
    WHERE supersedes_id IS NOT NULL;

-- Session / killzone performance slicing
CREATE INDEX idx_av_session_perf
    ON ai_verdicts (session, killzone, decided_at DESC)
    WHERE session IS NOT NULL;

-- ------------------------------------------------------------
-- PERFORMANCE-TRACKING INDEXES
-- ------------------------------------------------------------

-- Closed-trade ledger, newest first
CREATE INDEX idx_av_closed_ledger
    ON ai_verdicts (symbol, closed_at DESC)
    WHERE outcome IN ('WIN','LOSS','BREAKEVEN');

-- Win/loss analytics by verdict type
CREATE INDEX idx_av_outcome_by_verdict
    ON ai_verdicts (verdict, outcome, decided_at DESC)
    WHERE outcome <> 'OPEN';

-- R-multiple distribution / expectancy studies
CREATE INDEX idx_av_r_multiple
    ON ai_verdicts (symbol, r_multiple DESC NULLS LAST, decided_at DESC)
    WHERE r_multiple IS NOT NULL;

-- Error taxonomy review (post-mortem dashboards)
CREATE INDEX idx_av_error_class
    ON ai_verdicts (error_class, decided_at DESC)
    WHERE error_class IS NOT NULL;

-- Model / engine version comparison (A-B evaluation)
CREATE INDEX idx_av_model_version
    ON ai_verdicts (model_name, model_version, decided_at DESC)
    WHERE model_name IS NOT NULL;

-- Execution-quality audit (slippage, rejections)
CREATE INDEX idx_av_execution_quality
    ON ai_verdicts (broker_name, execution_status, decided_at DESC)
    WHERE execution_status <> 'PENDING';

-- ------------------------------------------------------------
-- LINKAGE INDEXES (joins back to Steps 1-3)
-- ------------------------------------------------------------

-- "Which verdicts were driven by this macro release?"
CREATE INDEX idx_av_macro_event
    ON ai_verdicts (macro_event_id, decided_at DESC)
    WHERE macro_event_id IS NOT NULL;

-- "Which verdicts were taken at this zone?"
CREATE INDEX idx_av_level
    ON ai_verdicts (level_id, decided_at DESC)
    WHERE level_id IS NOT NULL;

-- "Which verdicts targeted this opposing zone?"
CREATE INDEX idx_av_opposing_level
    ON ai_verdicts (opposing_level_id, decided_at DESC)
    WHERE opposing_level_id IS NOT NULL;

-- "Which verdicts consumed this sentiment reading?"
CREATE INDEX idx_av_sentiment
    ON ai_verdicts (sentiment_id, decided_at DESC)
    WHERE sentiment_id IS NOT NULL;

-- ------------------------------------------------------------
-- ARRAY + JSONB EXTENSIBILITY
-- ------------------------------------------------------------

CREATE INDEX idx_av_tags_gin
    ON ai_verdicts USING GIN (tags);

CREATE INDEX idx_av_top_factors_gin
    ON ai_verdicts USING GIN (top_factors);

CREATE INDEX idx_av_veto_flags_gin
    ON ai_verdicts USING GIN (veto_flags);

-- Typed JSONB bag: containment queries, e.g.
--   WHERE meta @> '{"news_blackout":true}'::jsonb
--   WHERE meta @> '{"account":{"id":"live-01"}}'::jsonb
CREATE INDEX idx_av_meta_gin
    ON ai_verdicts USING GIN (meta jsonb_path_ops);

-- Frozen evidence snapshot (audit: "find every verdict that saw X")
CREATE INDEX idx_av_evidence_gin
    ON ai_verdicts USING GIN (evidence jsonb_path_ops);

-- Per-factor weight configs used at decision time
CREATE INDEX idx_av_weights_gin
    ON ai_verdicts USING GIN (weights jsonb_path_ops)
    WHERE weights IS NOT NULL;

-- Per-factor score breakdown
CREATE INDEX idx_av_factor_scores_gin
    ON ai_verdicts USING GIN (factor_scores jsonb_path_ops)
    WHERE factor_scores IS NOT NULL;

-- P&L attribution breakdown
CREATE INDEX idx_av_attribution_gin
    ON ai_verdicts USING GIN (attribution jsonb_path_ops)
    WHERE attribution IS NOT NULL;

-- Verbatim engine output (heavier, forensics only)
CREATE INDEX idx_av_raw_payload_gin
    ON ai_verdicts USING GIN (raw_payload jsonb_path_ops)
    WHERE raw_payload IS NOT NULL;

-- ------------------------------------------------------------
-- PHYSICAL-ORDER + TAMPER DETECTION
-- ------------------------------------------------------------

-- Cheap append-only scans on the hypertable's physical ordering
CREATE INDEX idx_av_decided_at_brin
    ON ai_verdicts USING BRIN (decided_at);

-- Evidence tamper detection / exact replay dedup
CREATE INDEX idx_av_evidence_hash
    ON ai_verdicts (evidence_hash)
    WHERE evidence_hash IS NOT NULL;

CREATE INDEX idx_av_prompt_hash
    ON ai_verdicts (prompt_hash)
    WHERE prompt_hash IS NOT NULL;

-- ------------------------------------------------------------
-- DEDUP
-- ------------------------------------------------------------

-- One verdict per (decision time, symbol, TF, engine, revision).
-- Re-decisions must bump revision and set supersedes_id.
CREATE UNIQUE INDEX uq_av_verdict_identity
    ON ai_verdicts (decided_at, symbol, timeframe, engine, revision)
    WHERE engine IS NOT NULL;

-- Same engine output replayed twice
CREATE UNIQUE INDEX uq_av_hash
    ON ai_verdicts (hash_sha256)
    WHERE hash_sha256 IS NOT NULL;