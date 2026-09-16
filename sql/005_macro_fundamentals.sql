-- ============================================================
-- STEP 5: LONG-TERM MACRO FUNDAMENTALS, REAL RATES & INFLATION (XAUUSD)
-- Target: PostgreSQL 15+ / TimescaleDB 2.x
-- Requires: CREATE EXTENSION IF NOT EXISTS timescaledb;
--
-- The slow-moving valuation layer. Steps 1-4 answer "what is price
-- doing and what does the engine think right now"; this table answers
-- "what is gold actually worth against the cost of money". It is the
-- anchor that keeps intraday verdicts honest: when real yields say
-- gold is rich, a bullish SMC setup is a scalp, not a thesis.
--
-- One row per (observation time, indicator, geography, tenor). Wide
-- enough to hold every fundamental series without a column per
-- release, narrow enough that the hot paths stay index-only.
--
-- Series coverage:
--   INFLATION   : CPI (headline/core), PPI, PCE, PCE core, breakevens
--   RATES       : nominal yields, TIPS real yields, term premium
--   POLICY      : Fed funds target/effective, SOFR, policy path
--   LIQUIDITY   : M2, Fed balance sheet, RRP, TGA, bank reserves
--   GROWTH      : GDP, PMI, unemployment, payrolls
--   VALUATION   : gold fair value, real-yield gap, ERP, gold/M2
--   POSITIONING : central bank buying, ETF holdings, sovereign demand
--
-- Integrates with:
--   macro_news            -> macro_event_id (release that produced this print)
--   technical_levels      -> level_id (zone this fundamental contextualises)
--   intermarket_sentiment -> sentiment_id (reading derived from this data)
--   ai_verdicts           -> verdict_id (verdict that consumed this print)
-- ============================================================

CREATE TABLE macro_fundamentals (
    id                  BIGSERIAL,

    -- --------------------------------------------------------
    -- Observation identity + partition key
    -- --------------------------------------------------------
    observed_at         TIMESTAMPTZ NOT NULL,       -- period the data describes (hypertable partition column)
    released_at         TIMESTAMPTZ,                -- when the print hit the tape
    vintage_at          TIMESTAMPTZ,                -- revision vintage (ALFRED-style point-in-time)
    series_code         TEXT        NOT NULL,       -- 'CPIAUCSL','DFII10','T10YIE','PCEPILFE','FEDFUNDS'
    indicator           TEXT        NOT NULL,       -- 'CPI','CORE_CPI','PPI','PCE','CORE_PCE','REAL_YIELD_10Y'
    indicator_family    TEXT        NOT NULL,       -- 'INFLATION','RATES','POLICY','LIQUIDITY','GROWTH','VALUATION','POSITIONING'
    geography           TEXT        NOT NULL DEFAULT 'US',   -- ISO-3166 alpha-2
    currency            TEXT,                       -- 'USD','EUR','JPY'
    tenor               TEXT,                       -- '1M','3M','2Y','5Y','10Y','30Y'
    tenor_months        SMALLINT,                   -- numeric tenor for ordering / curve math
    frequency           TEXT        NOT NULL,       -- 'DAILY','WEEKLY','MONTHLY','QUARTERLY','ANNUAL'
    is_forward_looking  BOOLEAN     NOT NULL DEFAULT FALSE,  -- breakevens, expectations, policy path
    is_seasonally_adj   BOOLEAN,                    -- SA vs NSA matters for CPI comparisons

    -- --------------------------------------------------------
    -- Source provenance
    -- --------------------------------------------------------
    source_name         TEXT        NOT NULL,       -- 'FRED','BLS','BEA','Treasury','Fed','ECB','OECD'
    source_url          TEXT,
    source_series_id    TEXT,                       -- upstream series identifier
    external_id         TEXT,                       -- upstream dedup key
    unit                TEXT,                       -- '%','index','B','M','K','USD_B'
    base_year           TEXT,                       -- '1982-84=100' for index series

    -- --------------------------------------------------------
    -- Value payload
    -- --------------------------------------------------------
    value               NUMERIC(24, 8) NOT NULL,    -- the observation itself
    value_prior         NUMERIC(24, 8),             -- previous period
    value_prior_revised NUMERIC(24, 8),             -- prior period after revision
    value_forecast      NUMERIC(24, 8),             -- consensus, when available
    value_year_ago      NUMERIC(24, 8),             -- same period last year
    change_abs          NUMERIC(24, 8) GENERATED ALWAYS AS (
                            CASE
                                WHEN value_prior IS NULL THEN NULL
                                ELSE value - value_prior
                            END
                        ) STORED,
    change_pct          NUMERIC(14, 6),             -- period-over-period %
    yoy_pct             NUMERIC(14, 6),             -- year-over-year %
    mom_pct             NUMERIC(14, 6),             -- month-over-month %
    qoq_annualized_pct  NUMERIC(14, 6),             -- quarterly annualized
    surprise            NUMERIC(24, 8) GENERATED ALWAYS AS (
                            CASE
                                WHEN value_forecast IS NULL THEN NULL
                                ELSE value - value_forecast
                            END
                        ) STORED,
    surprise_pct        NUMERIC(14, 6),

    -- --------------------------------------------------------
    -- Real interest rate block (the primary gold driver)
    -- --------------------------------------------------------
    nominal_yield       NUMERIC(12, 6),             -- nominal Treasury yield for this tenor
    real_yield          NUMERIC(12, 6),             -- TIPS / inflation-adjusted yield
    breakeven_inflation NUMERIC(12, 6),             -- nominal minus real, same tenor
    term_premium        NUMERIC(12, 6),             -- ACM-style term premium
    forward_rate        NUMERIC(12, 6),             -- implied forward for the tenor
    policy_rate         NUMERIC(12, 6),             -- target / effective policy rate
    policy_rate_upper   NUMERIC(12, 6),             -- target range upper bound
    policy_rate_lower   NUMERIC(12, 6),             -- target range lower bound
    real_policy_rate    NUMERIC(12, 6),             -- policy rate minus core inflation
    yield_curve_slope   NUMERIC(12, 6),             -- 10Y minus 2Y
    yield_curve_inverted BOOLEAN,                   -- slope < 0
    real_yield_change_1m NUMERIC(12, 6),            -- 1-month change in real yield
    real_yield_change_1y NUMERIC(12, 6),            -- 1-year change in real yield
    real_yield_percentile NUMERIC(7, 4),            -- 0..1 rank over full history
    real_yield_regime   TEXT,                       -- 'DEEP_NEGATIVE','NEGATIVE','NEUTRAL','POSITIVE','RESTRICTIVE'

    -- --------------------------------------------------------
    -- Inflation block
    -- --------------------------------------------------------
    inflation_headline  NUMERIC(12, 6),             -- headline CPI/PCE for the period
    inflation_core      NUMERIC(12, 6),             -- core (ex food & energy)
    inflation_supercore NUMERIC(12, 6),             -- services ex housing
    inflation_trimmed   NUMERIC(12, 6),             -- trimmed mean / median
    inflation_3m_ann    NUMERIC(12, 6),             -- 3-month annualized
    inflation_6m_ann    NUMERIC(12, 6),             -- 6-month annualized
    inflation_trend     TEXT,                       -- 'ACCELERATING','STABLE','DECELERATING','DEFLATING'
    inflation_vs_target NUMERIC(12, 6),             -- actual minus central bank target
    inflation_target    NUMERIC(12, 6),             -- central bank target (usually 2.0)
    inflation_expect_1y NUMERIC(12, 6),             -- survey / market 1y expectation
    inflation_expect_5y NUMERIC(12, 6),             -- 5y5y forward expectation
    inflation_expect_10y NUMERIC(12, 6),
    inflation_persistence NUMERIC(12, 6),           -- AR(1) coefficient / stickiness measure
    inflation_percentile NUMERIC(7, 4),             -- 0..1 rank over full history
    stagflation_flag    BOOLEAN     NOT NULL DEFAULT FALSE,  -- high inflation + weak growth

    -- --------------------------------------------------------
    -- Liquidity / money supply block
    -- --------------------------------------------------------
    m2_growth_yoy       NUMERIC(12, 6),
    m2_level            NUMERIC(24, 4),
    fed_balance_sheet   NUMERIC(24, 4),             -- total assets, USD
    balance_sheet_chg   NUMERIC(24, 4),             -- QE/QT pace
    reverse_repo        NUMERIC(24, 4),             -- RRP balance
    treasury_gen_acct   NUMERIC(24, 4),             -- TGA balance
    bank_reserves       NUMERIC(24, 4),
    net_liquidity       NUMERIC(24, 4),             -- Fed BS minus RRP minus TGA
    net_liquidity_chg   NUMERIC(24, 4),
    liquidity_regime    TEXT,                       -- 'EXPANDING','FLAT','CONTRACTING'

    -- --------------------------------------------------------
    -- Growth / labour block (for stagflation + policy path reads)
    -- --------------------------------------------------------
    gdp_growth_qoq      NUMERIC(12, 6),
    gdp_growth_yoy      NUMERIC(12, 6),
    pmi_manufacturing   NUMERIC(12, 6),
    pmi_services        NUMERIC(12, 6),
    unemployment_rate   NUMERIC(12, 6),
    payrolls_change     NUMERIC(18, 4),             -- NFP change in thousands
    wage_growth_yoy     NUMERIC(12, 6),             -- AHE / ECI
    growth_regime       TEXT,                       -- 'EXPANSION','SLOWDOWN','CONTRACTION','RECOVERY'

    -- --------------------------------------------------------
    -- Gold valuation block
    -- --------------------------------------------------------
    gold_price          NUMERIC(18, 4),             -- spot at observation time
    gold_fair_value     NUMERIC(18, 4),             -- model-implied from real yields
    gold_real_yield_gap NUMERIC(18, 4),             -- actual minus fair value
    gold_valuation_pct  NUMERIC(12, 6),             -- premium/discount to fair value, %
    gold_valuation_state TEXT,                      -- 'CHEAP','FAIR','RICH','EXTREME'
    gold_m2_ratio       NUMERIC(18, 8),             -- gold price / M2 level
    gold_m2_percentile  NUMERIC(7, 4),
    gold_spx_ratio      NUMERIC(18, 8),             -- gold / S&P 500 relative value
    gold_oil_ratio      NUMERIC(18, 8),             -- gold / WTI
    gold_avg_real_cost  NUMERIC(18, 4),             -- all-in sustaining cost proxy
    gold_cost_support   NUMERIC(18, 4),             -- cost-curve floor
    gold_above_cost_pct NUMERIC(12, 6),             -- margin above AISC

    -- --------------------------------------------------------
    -- Structural demand block
    -- --------------------------------------------------------
    cb_net_purchases_t  NUMERIC(18, 4),             -- central bank net buying, tonnes
    cb_purchases_12m_t  NUMERIC(18, 4),             -- trailing 12-month total
    etf_holdings_t      NUMERIC(18, 4),             -- global ETF tonnage
    etf_flow_1m_t       NUMERIC(18, 4),
    etf_flow_ytd_t      NUMERIC(18, 4),
    jewellery_demand_t  NUMERIC(18, 4),
    industrial_demand_t NUMERIC(18, 4),
    mine_supply_t       NUMERIC(18, 4),
    recycling_supply_t  NUMERIC(18, 4),
    total_supply_t      NUMERIC(18, 4),
    total_demand_t      NUMERIC(18, 4),
    supply_demand_bal_t NUMERIC(18, 4) GENERATED ALWAYS AS (
                            CASE
                                WHEN total_supply_t IS NULL OR total_demand_t IS NULL THEN NULL
                                ELSE total_demand_t - total_supply_t
                            END
                        ) STORED,
    demand_regime       TEXT,                       -- 'STRUCTURAL_BID','BALANCED','SUPPLY_GLUT'

    -- --------------------------------------------------------
    -- Composite fundamental bias
    -- --------------------------------------------------------
    fundamental_bias    TEXT,                       -- 'STRONGLY_BULLISH','BULLISH','NEUTRAL','BEARISH','STRONGLY_BEARISH'
    bias_score          NUMERIC(10, 4),             -- -100..100 long-horizon score
    bias_confidence     NUMERIC(7, 4),              -- 0..1
    horizon             TEXT,                       -- 'INTRADAY','SWING','POSITION','STRUCTURAL'
    regime_label        TEXT,                       -- 'GOLDILOCKS','REFLATION','STAGFLATION','DEFLATION','CRISIS'
    is_stale            BOOLEAN     NOT NULL DEFAULT FALSE,
    quality_flags       TEXT[],                     -- {'REVISED','PRELIMINARY','PARTIAL_SERIES','STALE_PRINT'}

    -- --------------------------------------------------------
    -- Provenance + limitless extensibility
    -- --------------------------------------------------------
    collector           TEXT,                       -- 'fred_collector_v3'
    collector_version   TEXT,
    collector_params    JSONB,                      -- exact series/params at capture
    meta                JSONB       NOT NULL DEFAULT '{}'::JSONB,
    raw_payload         JSONB,                      -- verbatim upstream object for replay
    tags                TEXT[],                     -- {'fomc_week','cpi_week','qe_taper'}

    -- --------------------------------------------------------
    -- Linkage to existing tables
    -- --------------------------------------------------------
    macro_event_id      BIGINT,                     -- -> macro_news (id)
    level_id            BIGINT,                     -- -> technical_levels (id)
    sentiment_id        BIGINT,                     -- -> intermarket_sentiment (id)
    verdict_id          BIGINT,                     -- -> ai_verdicts (id)
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- --------------------------------------------------------
    -- Strict integrity constraints
    -- --------------------------------------------------------
    CONSTRAINT chk_mf_family        CHECK (indicator_family IN ('INFLATION','RATES','POLICY','LIQUIDITY','GROWTH','VALUATION','POSITIONING')),
    CONSTRAINT chk_mf_frequency     CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
    CONSTRAINT chk_mf_geography     CHECK (geography ~ '^[A-Z]{2}$'),
    CONSTRAINT chk_mf_tenor_months  CHECK (tenor_months IS NULL OR tenor_months BETWEEN 0 AND 600),
    CONSTRAINT chk_mf_real_regime   CHECK (real_yield_regime IS NULL OR real_yield_regime IN ('DEEP_NEGATIVE','NEGATIVE','NEUTRAL','POSITIVE','RESTRICTIVE')),
    CONSTRAINT chk_mf_infl_trend    CHECK (inflation_trend IS NULL OR inflation_trend IN ('ACCELERATING','STABLE','DECELERATING','DEFLATING')),
    CONSTRAINT chk_mf_liq_regime    CHECK (liquidity_regime IS NULL OR liquidity_regime IN ('EXPANDING','FLAT','CONTRACTING')),
    CONSTRAINT chk_mf_growth_regime CHECK (growth_regime IS NULL OR growth_regime IN ('EXPANSION','SLOWDOWN','CONTRACTION','RECOVERY')),
    CONSTRAINT chk_mf_val_state     CHECK (gold_valuation_state IS NULL OR gold_valuation_state IN ('CHEAP','FAIR','RICH','EXTREME')),
    CONSTRAINT chk_mf_demand_regime CHECK (demand_regime IS NULL OR demand_regime IN ('STRUCTURAL_BID','BALANCED','SUPPLY_GLUT')),
    CONSTRAINT chk_mf_bias          CHECK (fundamental_bias IS NULL OR fundamental_bias IN ('STRONGLY_BULLISH','BULLISH','NEUTRAL','BEARISH','STRONGLY_BEARISH')),
    CONSTRAINT chk_mf_horizon       CHECK (horizon IS NULL OR horizon IN ('INTRADAY','SWING','POSITION','STRUCTURAL')),
    CONSTRAINT chk_mf_regime_label  CHECK (regime_label IS NULL OR regime_label IN ('GOLDILOCKS','REFLATION','STAGFLATION','DEFLATION','CRISIS')),

    -- Bounded analytics
    CONSTRAINT chk_mf_real_pct      CHECK (real_yield_percentile IS NULL OR real_yield_percentile BETWEEN 0 AND 1),
    CONSTRAINT chk_mf_infl_pct      CHECK (inflation_percentile  IS NULL OR inflation_percentile  BETWEEN 0 AND 1),
    CONSTRAINT chk_mf_m2_pct        CHECK (gold_m2_percentile     IS NULL OR gold_m2_percentile     BETWEEN 0 AND 1),
    CONSTRAINT chk_mf_bias_score    CHECK (bias_score IS NULL OR bias_score BETWEEN -100 AND 100),
    CONSTRAINT chk_mf_bias_conf     CHECK (bias_confidence IS NULL OR bias_confidence BETWEEN 0 AND 1),
    CONSTRAINT chk_mf_persistence   CHECK (inflation_persistence IS NULL OR inflation_persistence BETWEEN -1 AND 1),

    -- Non-negative physical quantities
    CONSTRAINT chk_mf_m2_level      CHECK (m2_level IS NULL OR m2_level >= 0),
    CONSTRAINT chk_mf_fed_bs        CHECK (fed_balance_sheet IS NULL OR fed_balance_sheet >= 0),
    CONSTRAINT chk_mf_rrp           CHECK (reverse_repo IS NULL OR reverse_repo >= 0),
    CONSTRAINT chk_mf_tga           CHECK (treasury_gen_acct IS NULL OR treasury_gen_acct >= 0),
    CONSTRAINT chk_mf_reserves      CHECK (bank_reserves IS NULL OR bank_reserves >= 0),
    CONSTRAINT chk_mf_gold_price    CHECK (gold_price IS NULL OR gold_price > 0),
    CONSTRAINT chk_mf_fair_value    CHECK (gold_fair_value IS NULL OR gold_fair_value > 0),
    CONSTRAINT chk_mf_cost_support  CHECK (gold_cost_support IS NULL OR gold_cost_support > 0),
    CONSTRAINT chk_mf_etf_holdings  CHECK (etf_holdings_t IS NULL OR etf_holdings_t >= 0),
    CONSTRAINT chk_mf_supply        CHECK (total_supply_t IS NULL OR total_supply_t >= 0),
    CONSTRAINT chk_mf_demand        CHECK (total_demand_t IS NULL OR total_demand_t >= 0),
    CONSTRAINT chk_mf_mine_supply   CHECK (mine_supply_t IS NULL OR mine_supply_t >= 0),

    -- Rates must be internally coherent
    CONSTRAINT chk_mf_policy_range  CHECK (
        policy_rate_upper IS NULL OR policy_rate_lower IS NULL
        OR policy_rate_upper >= policy_rate_lower
    ),
    CONSTRAINT chk_mf_policy_inside CHECK (
        policy_rate IS NULL OR policy_rate_upper IS NULL OR policy_rate_lower IS NULL
        OR (policy_rate <= policy_rate_upper AND policy_rate >= policy_rate_lower)
    ),

    -- Breakeven must equal nominal minus real when all three are present
    CONSTRAINT chk_mf_breakeven_math CHECK (
        nominal_yield IS NULL OR real_yield IS NULL OR breakeven_inflation IS NULL
        OR abs(breakeven_inflation - (nominal_yield - real_yield)) <= 0.05
    ),

    -- Curve inversion flag must agree with the slope sign
    CONSTRAINT chk_mf_curve_flag CHECK (
        yield_curve_slope IS NULL OR yield_curve_inverted IS NULL
        OR yield_curve_inverted = (yield_curve_slope < 0)
    ),

    -- Inflation trend must agree with the 3m-vs-6m annualized spread
    CONSTRAINT chk_mf_infl_trend_agree CHECK (
        inflation_trend IS NULL OR inflation_3m_ann IS NULL OR inflation_6m_ann IS NULL
        OR (inflation_trend = 'ACCELERATING' AND inflation_3m_ann > inflation_6m_ann)
        OR (inflation_trend = 'DECELERATING' AND inflation_3m_ann < inflation_6m_ann)
        OR (inflation_trend IN ('STABLE','DEFLATING'))
    ),

    -- Core cannot exceed headline by an implausible margin
    CONSTRAINT chk_mf_core_vs_headline CHECK (
        inflation_headline IS NULL OR inflation_core IS NULL
        OR inflation_core <= inflation_headline + 5
    ),

    -- Valuation state must agree with the premium/discount sign
    CONSTRAINT chk_mf_valuation_agree CHECK (
        gold_valuation_state IS NULL OR gold_valuation_pct IS NULL
        OR (gold_valuation_state = 'CHEAP'   AND gold_valuation_pct < 0)
        OR (gold_valuation_state = 'RICH'    AND gold_valuation_pct > 0)
        OR (gold_valuation_state = 'EXTREME' AND abs(gold_valuation_pct) > 25)
        OR (gold_valuation_state = 'FAIR')
    ),

    -- Bias direction must agree with the composite score sign
    CONSTRAINT chk_mf_bias_agree CHECK (
        fundamental_bias IS NULL OR bias_score IS NULL
        OR (fundamental_bias IN ('STRONGLY_BULLISH','BULLISH') AND bias_score > 0)
        OR (fundamental_bias IN ('STRONGLY_BEARISH','BEARISH') AND bias_score < 0)
        OR (fundamental_bias = 'NEUTRAL')
    ),

    -- Stagflation requires both legs of the definition
    CONSTRAINT chk_mf_stagflation CHECK (
        stagflation_flag = FALSE
        OR (inflation_core IS NOT NULL AND inflation_target IS NOT NULL
            AND inflation_core > inflation_target
            AND growth_regime IN ('SLOWDOWN','CONTRACTION'))
    ),

    -- A revision vintage cannot predate the observation it describes
    CONSTRAINT chk_mf_vintage_order CHECK (
        vintage_at IS NULL OR vintage_at >= observed_at
    ),

    -- Release cannot precede the period it reports
    CONSTRAINT chk_mf_release_order CHECK (
        released_at IS NULL OR released_at >= observed_at
    ),

    -- TimescaleDB requires the partition column inside the primary key
    PRIMARY KEY (id, observed_at)
);

SELECT create_hypertable(
    'macro_fundamentals',
    'observed_at',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- ------------------------------------------------------------
-- HOT-PATH INDEXES
-- ------------------------------------------------------------

-- Primary query: "latest value of this series"
CREATE INDEX idx_mf_series_latest
    ON macro_fundamentals (series_code, observed_at DESC);

-- Primary query: "latest value of this indicator for this geography/tenor"
CREATE INDEX idx_mf_indicator_latest
    ON macro_fundamentals (indicator, geography, tenor, observed_at DESC);

-- Family-level scans (all inflation series, all rate series)
CREATE INDEX idx_mf_family_time
    ON macro_fundamentals (indicator_family, geography, observed_at DESC);

-- Curve construction: every tenor of one family at one time
CREATE INDEX idx_mf_curve
    ON macro_fundamentals (indicator_family, geography, observed_at DESC, tenor_months)
    WHERE tenor_months IS NOT NULL;

-- ------------------------------------------------------------
-- REAL-RATE / INFLATION ANALYTICS INDEXES
-- ------------------------------------------------------------

-- The core gold model: real yield history for regression
CREATE INDEX idx_mf_real_yield
    ON macro_fundamentals (geography, tenor, observed_at DESC)
    WHERE real_yield IS NOT NULL;

-- Breakeven inflation series (market-implied expectations)
CREATE INDEX idx_mf_breakeven
    ON macro_fundamentals (geography, tenor, observed_at DESC)
    WHERE breakeven_inflation IS NOT NULL;

-- Regime slicing for real yields
CREATE INDEX idx_mf_real_regime
    ON macro_fundamentals (real_yield_regime, observed_at DESC)
    WHERE real_yield_regime IS NOT NULL;

-- Inflation trend / stagflation screens
CREATE INDEX idx_mf_infl_trend
    ON macro_fundamentals (inflation_trend, geography, observed_at DESC)
    WHERE inflation_trend IS NOT NULL;

CREATE INDEX idx_mf_stagflation
    ON macro_fundamentals (geography, observed_at DESC)
    WHERE stagflation_flag;

-- Policy path reconstruction
CREATE INDEX idx_mf_policy
    ON macro_fundamentals (geography, observed_at DESC)
    WHERE policy_rate IS NOT NULL;

-- Liquidity regime (QE/QT backdrop)
CREATE INDEX idx_mf_liquidity
    ON macro_fundamentals (liquidity_regime, observed_at DESC)
    WHERE liquidity_regime IS NOT NULL;

-- ------------------------------------------------------------
-- VALUATION INDEXES
-- ------------------------------------------------------------

-- Fair-value gap screens ("gold is 18% rich to real yields")
CREATE INDEX idx_mf_valuation
    ON macro_fundamentals (gold_valuation_state, observed_at DESC)
    WHERE gold_valuation_state IS NOT NULL;

CREATE INDEX idx_mf_valuation_gap
    ON macro_fundamentals (observed_at DESC, gold_valuation_pct)
    WHERE gold_valuation_pct IS NOT NULL;

-- Composite fundamental bias, newest first
CREATE INDEX idx_mf_bias
    ON macro_fundamentals (fundamental_bias, horizon, observed_at DESC)
    WHERE fundamental_bias IS NOT NULL;

CREATE INDEX idx_mf_regime_label
    ON macro_fundamentals (regime_label, observed_at DESC)
    WHERE regime_label IS NOT NULL;

-- ------------------------------------------------------------
-- LINKAGE INDEXES (joins back to Steps 1-4)
-- ------------------------------------------------------------

-- "Which fundamentals were captured around this macro release?"
CREATE INDEX idx_mf_macro_event
    ON macro_fundamentals (macro_event_id, observed_at DESC)
    WHERE macro_event_id IS NOT NULL;

-- "Which fundamentals contextualise this zone?"
CREATE INDEX idx_mf_level
    ON macro_fundamentals (level_id, observed_at DESC)
    WHERE level_id IS NOT NULL;

-- "Which fundamentals fed this sentiment reading?"
CREATE INDEX idx_mf_sentiment
    ON macro_fundamentals (sentiment_id, observed_at DESC)
    WHERE sentiment_id IS NOT NULL;

-- "Which fundamentals did this verdict consume?"
CREATE INDEX idx_mf_verdict
    ON macro_fundamentals (verdict_id, observed_at DESC)
    WHERE verdict_id IS NOT NULL;

-- ------------------------------------------------------------
-- ARRAY + JSONB EXTENSIBILITY
-- ------------------------------------------------------------

CREATE INDEX idx_mf_tags_gin
    ON macro_fundamentals USING GIN (tags);

CREATE INDEX idx_mf_quality_flags_gin
    ON macro_fundamentals USING GIN (quality_flags);

-- Typed JSONB bag: containment queries, e.g.
--   WHERE meta @> '{"vintage":"2026-08"}'::jsonb
--   WHERE meta @> '{"survey":"michigan"}'::jsonb
CREATE INDEX idx_mf_meta_gin
    ON macro_fundamentals USING GIN (meta jsonb_path_ops);

-- Exact collector configuration used at capture
CREATE INDEX idx_mf_collector_params_gin
    ON macro_fundamentals USING GIN (collector_params jsonb_path_ops)
    WHERE collector_params IS NOT NULL;

-- Verbatim upstream object (heavier, forensics only)
CREATE INDEX idx_mf_raw_payload_gin
    ON macro_fundamentals USING GIN (raw_payload jsonb_path_ops)
    WHERE raw_payload IS NOT NULL;

-- ------------------------------------------------------------
-- PHYSICAL-ORDER + STALENESS
-- ------------------------------------------------------------

-- Cheap append-only scans on the hypertable's physical ordering
CREATE INDEX idx_mf_observed_at_brin
    ON macro_fundamentals USING BRIN (observed_at);

-- Freshness monitoring for the collector
CREATE INDEX idx_mf_stale
    ON macro_fundamentals (series_code, observed_at DESC)
    WHERE is_stale;

-- ------------------------------------------------------------
-- DEDUP
-- ------------------------------------------------------------

-- One observation per (period, series, vintage). A revised print
-- is a new vintage row, never an overwrite of the original.
CREATE UNIQUE INDEX uq_mf_observation
    ON macro_fundamentals (observed_at, series_code, geography, vintage_at)
    NULLS NOT DISTINCT;

-- Same upstream record ingested twice
CREATE UNIQUE INDEX uq_mf_external
    ON macro_fundamentals (source_name, external_id)
    WHERE external_id IS NOT NULL;