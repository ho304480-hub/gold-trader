// ============================================================
// HAMZA SIGNAL ENGINE
// Multi-timeframe structure tracker (1m / 15m / 4h / 1D) with a
// live-price evaluator that scores incoming ticks against the
// technical zones each timeframe has produced.
//
// Exposes global `HamzaSignalEngine` (plain script, no ES modules).
// Also exports for Node so the engine can be unit-tested headless.
// ============================================================

(function (global) {
  "use strict";

  // ---- Timeframe table -------------------------------------
  //  Keyed exactly as the rest of the terminal keys them ("1D" is
  //  capitalised in hamza.html, so it stays capitalised here).
  const TF_MS = {
    "1m": 60 * 1000,
    "15m": 15 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1D": 24 * 60 * 60 * 1000,
  };

  // Ordered slowest -> fastest. Used for confluence weighting: a zone
  // confirmed on 1D outranks the same zone on 1m.
  const TF_ORDER = ["1D", "4h", "15m", "1m"];

  const TF_WEIGHT = { "1D": 4, "4h": 3, "15m": 2, "1m": 1 };

  // ---- Tunables --------------------------------------------
  const DEFAULTS = {
    swingLookback: 3,      // bars either side required to confirm a pivot
    maxZonesPerTf: 12,     // cap retained zones per timeframe
    zoneMergePct: 0.0015,  // zones closer than 0.15% of price get merged
    atrPeriod: 14,
    proximityAtr: 0.5,     // "price is at the zone" band, in ATR units
    minScore: 40,          // below this, no signal is emitted
    maxCandlesPerTf: 2000, // ring-buffer ceiling per timeframe
    obDisplacementAtr: 1.2, // body size (in ATR) that qualifies as displacement
    maxOrderBlocks: 6,     // retained order blocks per timeframe
    minActionScore: 55,    // score required before BUY/SELL replaces HOLD
    stopBufferAtr: 0.35,   // stop-loss padding beyond the zone edge, in ATR
    targetRr: 2.0,         // reward:risk used to derive the take-profit

    // ---- Smart-money tunables ------------------------------
    //  These govern the two institutional zone families. They are
    //  deliberately separate from the pivot tunables above so the
    //  swing-structure layer and the order-flow layer can be tuned
    //  independently without one dragging the other.
    obRangeAtr: 1.0,        // full high-low range (in ATR) that qualifies as displacement
    obVolumeFactor: 1.15,   // displacement volume vs. trailing mean to confirm an OB
    obMitigationAtr: 0.25,  // penetration (in ATR) that counts as OB mitigation
    maxBreakers: 4,         // retained breaker blocks per timeframe
    fvgMinAtr: 0.15,        // minimum gap height (in ATR) to register an FVG
    maxFvgs: 8,             // retained fair value gaps per timeframe
    fvgFillThreshold: 0.5,  // fraction filled before an FVG is considered spent
    smcConfluenceBonus: 12, // score added per independent SMC family agreeing
    smcStackCap: 30,        // ceiling on the combined SMC contribution

    // ---- Session / AMD tunables ----------------------------
    //  The Power of Three (accumulation, manipulation, distribution)
    //  plays out inside each trading session. These govern how the
    //  engine reads the clock and how much the phase is worth.
    asiaStartUtc: 0,        // 00:00 UTC — Tokyo opens
    asiaEndUtc: 7,          // 07:00 UTC — Tokyo winds down
    londonStartUtc: 7,      // 07:00 UTC — London opens
    londonEndUtc: 12,       // 12:00 UTC — London/NY overlap begins
    nyStartUtc: 12,         // 12:00 UTC — New York opens
    nyEndUtc: 21,           // 21:00 UTC — NY closes
    killzoneMinutes: 90,    // opening window treated as the manipulation window
    sessionBonus: 8,        // score for trading inside an active session
    killzoneBonus: 10,      // extra score for trading inside a killzone
    deadZonePenalty: 14,    // score docked outside every session
    amdDistributionBonus: 12, // score for a distribution-phase entry
    amdAccumulationPenalty: 8, // score docked for entering during accumulation

    // ---- Liquidity tunables --------------------------------
    //  ERL (external range liquidity) sits beyond the range extremes;
    //  IRL (internal range liquidity) sits inside it. Price alternates
    //  between the two, and the sweep of one is what fuels the run to
    //  the other.
    equalLevelToleranceAtr: 0.15, // how close two highs must be to count as equal
    minPoolTouches: 2,      // swing points required to form a liquidity pool
    maxPools: 8,            // retained liquidity pools per timeframe
    sweepMinAtr: 0.1,       // minimum wick penetration (in ATR) to count as a sweep
    sweepReclaimBars: 3,    // bars allowed for price to reclaim after a sweep
    sweepBonus: 14,         // score for a confirmed sweep in the trade direction
    sweepAgainstPenalty: 12,// score docked when a sweep points the other way
    erlTargetBonus: 8,      // score when the trade targets external liquidity
    irlTargetBonus: 5,      // score when the trade targets internal liquidity

    // ---- Market Maker Model tunables -----------------------
    mmbmRangeMinBars: 6,    // bars required to define an accumulation range
    mmbmRangeMaxAtr: 3.0,   // range height ceiling (in ATR) for accumulation
    mmbmDisplacementAtr: 1.5, // displacement leg required to confirm distribution
    mmbmBonus: 20,          // score for a fully confirmed MMBM
    mmbmAgainstPenalty: 15, // score docked when the model points the other way
    mmbmLookbackBars: 60,   // bars scanned when hunting for the model
  };

  // ---- Central banks ---------------------------------------
  //  Macro backdrop for gold. Each entry carries the properties that
  //  actually move XAU: the policy rate, the direction the bank is
  //  leaning, how much of the world's reserve currency it controls,
  //  and the sign of its net effect on gold.
  //
  //  `goldBias` is the structural read, not a live one:
  //    "bullish"  — policy stance tends to support gold
  //    "bearish"  — policy stance tends to weigh on gold
  //    "neutral"  — effect is conditional on the prevailing regime
  //
  //  `impact` is the relative weight the bank carries in the macro
  //  score (0-1). The Fed dominates because XAU is priced in USD.
  const centralBanks = {
    Fed: {
      name: "Federal Reserve",
      country: "United States",
      currency: "USD",
      policyRate: 4.25,          // upper bound of the target range, %
      stance: "easing",          // easing | tightening | holding
      goldBias: "bullish",
      impact: 1.0,
      reserveShare: 0.58,        // share of global FX reserves, fraction
      mandate: "dual",           // price stability + maximum employment
      meetingCadence: 8,         // scheduled policy meetings per year
      notes: "USD denomination makes the Fed the dominant driver of XAU.",
    },
    ECB: {
      name: "European Central Bank",
      country: "Euro Area",
      currency: "EUR",
      policyRate: 2.15,          // deposit facility rate, %
      stance: "easing",
      goldBias: "bullish",
      impact: 0.7,
      reserveShare: 0.20,
      mandate: "price stability",
      meetingCadence: 8,
      notes: "Euro strength against USD transmits into gold via the cross.",
    },
    BoE: {
      name: "Bank of England",
      country: "United Kingdom",
      currency: "GBP",
      policyRate: 4.0,
      stance: "holding",
      goldBias: "neutral",
      impact: 0.45,
      reserveShare: 0.05,
      mandate: "price stability",
      meetingCadence: 8,
      notes: "London is the primary gold vaulting and clearing hub.",
    },
    BoJ: {
      name: "Bank of Japan",
      country: "Japan",
      currency: "JPY",
      policyRate: 0.5,
      stance: "tightening",
      goldBias: "bearish",
      impact: 0.5,
      reserveShare: 0.06,
      mandate: "price stability",
      meetingCadence: 8,
      notes: "Yen carry unwind forces deleveraging across commodity books.",
    },
    PBoC: {
      name: "People's Bank of China",
      country: "China",
      currency: "CNY",
      policyRate: 3.0,           // 1-year loan prime rate, %
      stance: "easing",
      goldBias: "bullish",
      impact: 0.65,
      reserveShare: 0.03,
      mandate: "price stability",
      meetingCadence: 12,
      notes: "State gold buying is a persistent physical-demand bid.",
    },
  };

  // Ordered heaviest -> lightest so a macro read lists the Fed first.
  const CB_ORDER = ["Fed", "ECB", "PBoC", "BoJ", "BoE"];

  // ---- Small numeric helpers -------------------------------
  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  // Normalise any timestamp to milliseconds. Feeds hand us seconds or
  // milliseconds interchangeably; mixing them is what produces phantom
  // gaps, so every entry point funnels through here.
  function toMs(ts) {
    const n = Number(ts);
    if (!isNum(n) || n <= 0) return NaN;
    return n < 1e11 ? n * 1000 : n;
  }

  function bucketMs(ts, intervalMs) {
    const ms = toMs(ts);
    if (!isNum(ms)) return NaN;
    return Math.floor(ms / intervalMs) * intervalMs;
  }

  // ---- Candle validation -----------------------------------
  // Mirrors the sanitisation contract used by the chart layer so the
  // engine can never be fed a candle the renderer would have rejected.
  function isValidCandle(c) {
    if (!c) return false;
    const fields = [c.time, c.open, c.high, c.low, c.close];
    for (let i = 0; i < fields.length; i++) {
      if (!isNum(fields[i])) return false;
    }
    if (c.time <= 0) return false;
    if (c.high < c.low) return false;
    if (c.high < c.open || c.high < c.close) return false;
    if (c.low > c.open || c.low > c.close) return false;
    return true;
  }

  function normalizeCandle(c) {
    if (!c) return null;
    const time = Math.floor(toMs(c.time) / 1000);
    if (!isNum(time) || time <= 0) return null;
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (!isNum(open) || !isNum(high) || !isNum(low) || !isNum(close)) return null;

    // Reject structurally impossible bars outright. Repairing them here
    // would let corrupt feed data masquerade as a valid candle, which is
    // exactly the failure mode the chart layer's sanitiser guards against.
    if (high < low) return null;
    if (high < open || high < close) return null;
    if (low > open || low > close) return null;

    return {
      time: time,
      open: open,
      high: high,
      low: low,
      close: close,
      volume: Number(c.volume) || 0,
    };
  }


  // ---- Indicators ------------------------------------------
  function atr(candles, period) {
    if (!candles || candles.length < 2) return 0;
    const p = Math.max(1, period || DEFAULTS.atrPeriod);
    const start = Math.max(1, candles.length - p);
    let sum = 0;
    let n = 0;
    for (let i = start; i < candles.length; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      if (isNum(tr)) {
        sum += tr;
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(0);
    if (!values.length) return out;
    const mult = 2 / (period + 1);
    out[0] = values[0];
    for (let i = 1; i < values.length; i++) {
      out[i] = (values[i] - out[i - 1]) * mult + out[i - 1];
    }
    return out;
  }

  // ---- Pivot detection -------------------------------------
  // A swing high needs `lookback` bars on each side that fail to exceed
  // it. Ties are rejected so a flat shelf does not register as a pivot.
  function findPivots(candles, lookback) {
    const highs = [];
    const lows = [];
    const lb = Math.max(1, lookback || DEFAULTS.swingLookback);
    for (let i = lb; i < candles.length - lb; i++) {
      const c = candles[i];
      let isHigh = true;
      let isLow = true;
      for (let j = i - lb; j <= i + lb; j++) {
        if (j === i) continue;
        if (candles[j].high >= c.high) isHigh = false;
        if (candles[j].low <= c.low) isLow = false;
      }
      if (isHigh) highs.push({ index: i, price: c.high, time: c.time });
      if (isLow) lows.push({ index: i, price: c.low, time: c.time });
    }
    return { highs: highs, lows: lows };
  }

  // ---- Zone construction -----------------------------------
  // A zone is a price band, not a line: MT5 traders read supply and
  // demand as regions, and a band survives spread and slippage far
  // better than a single tick value.
  function makeZone(kind, price, time, tf, strength) {
    const pad = Math.max(price * 0.0004, 0.05);
    return {
      kind: kind,               // "supply" | "demand"
      zoneType: "supportResistance",
      tf: tf,
      top: round2(price + pad),
      bottom: round2(price - pad),
      mid: round2(price),
      formedAt: time,
      touches: 1,
      strength: strength || 1,
      broken: false,
    };
  }

  function zoneOverlaps(a, b, mergePct) {
    const ref = Math.max(Math.abs(a.mid), 1);
    const tolerance = ref * mergePct;
    return !(a.bottom - tolerance > b.top || b.bottom - tolerance > a.top);
  }

  function mergeZones(zones, mergePct) {
    const out = [];
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      let merged = false;
      for (let j = 0; j < out.length; j++) {
        if (out[j].kind !== z.kind) continue;
        // Never fold an order block into a pivot band (or vice versa) —
        // they carry different strength and different trade logic.
        if (out[j].zoneType !== z.zoneType) continue;
        if (zoneOverlaps(out[j], z, mergePct)) {
          const o = out[j];
          o.top = round2(Math.max(o.top, z.top));
          o.bottom = round2(Math.min(o.bottom, z.bottom));
          o.mid = round2((o.top + o.bottom) / 2);
          o.touches += z.touches;
          o.strength += z.strength;
          o.formedAt = Math.min(o.formedAt, z.formedAt);
          merged = true;
          break;
        }
      }
      if (!merged) out.push(z);
    }
    return out;
  }

  // ---- Order Block detection -------------------------------
  // An order block is the last opposing candle before an impulsive
  // displacement move — the bar where institutional orders are assumed
  // to have been filled. It is NOT the same thing as a swing pivot, so
  // it gets its own detector and its own zoneType tag.
  //
  //   bullish OB: last down candle before a strong up displacement
  //   bearish OB: last up candle before a strong down displacement
  //
  // "Strong" is measured against ATR so the threshold scales with the
  // instrument's current volatility rather than a fixed price distance.
  //
  // Three independent confirmations are scored per block:
  //   1. BODY  — the displacement candle's body clears obDisplacementAtr
  //   2. RANGE — the displacement candle's full high-low clears obRangeAtr
  //   3. VOLUME— the displacement candle trades above its trailing mean
  // A block that clears all three is a "confirmed" institutional print;
  // one that clears only the body is a weak candidate and is scored down.
  function findOrderBlocks(candles, tf, atrValue, opts) {
    const out = [];
    if (!candles || candles.length < 5) return out;

    const ref = isNum(atrValue) && atrValue > 0 ? atrValue : 0;
    if (ref <= 0) return out;

    const o = opts || {};
    const displacement = isNum(o.displacementAtr) ? o.displacementAtr : 1.2;
    const rangeAtr = isNum(o.rangeAtr) ? o.rangeAtr : 1.0;
    const volumeFactor = isNum(o.volumeFactor) ? o.volumeFactor : 1.15;
    const maxBlocks = o.maxBlocks || 6;
    const weight = TF_WEIGHT[tf] || 1;
    const bodyThreshold = ref * displacement;
    const rangeThreshold = ref * rangeAtr;

    // Trailing volume mean, computed once. Feeds that omit volume leave
    // every bar at 0, in which case the volume test is skipped rather
    // than failing every block.
    const volMean = trailingVolumeMean(candles, 20);
    const volumeUsable = volMean > 0;

    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];

      const body = Math.abs(cur.close - cur.open);
      const range = cur.high - cur.low;
      if (body < bodyThreshold) continue;

      const bullishMove = cur.close > cur.open;
      const bearishMove = cur.close < cur.open;
      if (!bullishMove && !bearishMove) continue;

      // The block is the opposing candle immediately preceding the move.
      const isOpposing = bullishMove
        ? prev.close < prev.open
        : prev.close > prev.open;
      if (!isOpposing) continue;

      // Confirmation tally. Body already passed by the guard above.
      let confirmations = 1;
      if (range >= rangeThreshold) confirmations++;
      const volOk = volumeUsable
        ? (Number(cur.volume) || 0) >= volMean * volumeFactor
        : false;
      if (volOk) confirmations++;

      const kind = bullishMove ? "demand" : "supply";

      // The block spans the opposing candle's full wick range, not just
      // its body. Institutional fills sit in the wicks as often as the
      // body, and a body-only band is too thin to survive spread.
      const top = prev.high;
      const bottom = prev.low;

      out.push({
        kind: kind,
        zoneType: "orderBlock",
        tf: tf,
        top: round2(top),
        bottom: round2(bottom),
        mid: round2((top + bottom) / 2),
        formedAt: prev.time,
        touches: 1,
        // An OB outranks a plain pivot band, and a fully confirmed one
        // outranks a body-only candidate.
        strength: weight * 2 + confirmations * weight,
        broken: false,
        displacement: round2(body / ref),
        rangeAtr: round2(range / ref),
        confirmations: confirmations,
        volumeConfirmed: volOk,
        mitigated: false,
        mitigation: 0,
        origin: "displacement",
      });
    }

    // Keep the most recent blocks — older ones have usually been
    // mitigated already and carry less weight in live evaluation.
    if (out.length > maxBlocks) return out.slice(out.length - maxBlocks);
    return out;
  }

  // ---- Fair Value Gap detection ----------------------------
  // A fair value gap is a three-candle imbalance: the middle candle
  // moves so fast that the wicks of candle 1 and candle 3 never overlap,
  // leaving a price band that traded in one direction only. Price tends
  // to return and "rebalance" that band, which makes it a high-probability
  // reaction zone.
  //
  //   bullish FVG: candle1.high < candle3.low   -> gap between them
  //   bearish FVG: candle1.low  > candle3.high  -> gap between them
  //
  // The gap is tracked for how much of it price has since filled. A gap
  // that is more than `fillThreshold` consumed is spent and is scored
  // down rather than deleted, so a late retest still reads correctly.
  function findFairValueGaps(candles, tf, atrValue, opts) {
    const out = [];
    if (!candles || candles.length < 3) return out;

    const ref = isNum(atrValue) && atrValue > 0 ? atrValue : 0;
    if (ref <= 0) return out;

    const o = opts || {};
    const minAtr = isNum(o.minAtr) ? o.minAtr : 0.15;
    const maxFvgs = o.maxFvgs || 8;
    const fillThreshold = isNum(o.fillThreshold) ? o.fillThreshold : 0.5;
    const weight = TF_WEIGHT[tf] || 1;
    const minHeight = ref * minAtr;

    for (let i = 2; i < candles.length; i++) {
      const c1 = candles[i - 2];
      const c2 = candles[i - 1];
      const c3 = candles[i];

      let kind = null;
      let top = 0;
      let bottom = 0;

      if (c1.high < c3.low) {
        // Bullish imbalance: the gap sits above candle 1's high.
        kind = "demand";
        bottom = c1.high;
        top = c3.low;
      } else if (c1.low > c3.high) {
        // Bearish imbalance: the gap sits below candle 1's low.
        kind = "supply";
        bottom = c3.high;
        top = c1.low;
      } else {
        continue;
      }

      const height = top - bottom;
      if (height < minHeight) continue;

      // How much of the gap has price since traded back through?
      let deepest = kind === "demand" ? top : bottom;
      for (let j = i + 1; j < candles.length; j++) {
        const c = candles[j];
        if (kind === "demand") {
          // A bullish gap fills from the top down.
          if (c.low < deepest) deepest = c.low;
        } else {
          // A bearish gap fills from the bottom up.
          if (c.high > deepest) deepest = c.high;
        }
      }

      let filled;
      if (kind === "demand") {
        filled = Math.max(0, Math.min(1, (top - deepest) / height));
      } else {
        filled = Math.max(0, Math.min(1, (deepest - bottom) / height));
      }

      out.push({
        kind: kind,
        zoneType: "fairValueGap",
        tf: tf,
        top: round2(top),
        bottom: round2(bottom),
        mid: round2((top + bottom) / 2),
        formedAt: c2.time,
        touches: 1,
        // A gap is a thinner structure than an order block, so it starts
        // below one on strength — but an unfilled gap is still a live
        // institutional reference and outranks a plain pivot band.
        strength: weight * 1.5,
        broken: false,
        gapAtr: round2(height / ref),
        filled: round2(filled),
        spent: filled >= fillThreshold,
        origin: "imbalance",
      });
    }

    if (out.length > maxFvgs) return out.slice(out.length - maxFvgs);
    return out;
  }

  // ---- Breaker block detection -----------------------------
  // A breaker is an order block that price closed straight through. The
  // failed block flips role: a broken demand block becomes resistance,
  // a broken supply block becomes support. Breakers are the highest
  // conviction of the three families because they mark a level where
  // the institutional side was proven wrong and had to reposition.
  function findBreakerBlocks(blocks, candles, tf, atrValue, opts) {
    const out = [];
    if (!blocks || !blocks.length || !candles || !candles.length) return out;

    const ref = isNum(atrValue) && atrValue > 0 ? atrValue : 0;
    if (ref <= 0) return out;

    const o = opts || {};
    const maxBreakers = o.maxBreakers || 4;
    const weight = TF_WEIGHT[tf] || 1;
    const last = candles[candles.length - 1];

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      // A block is only a breaker once price has closed beyond its far
      // edge — a wick through is a raid, not a break.
      const brokeDemand = b.kind === "demand" && last.close < b.bottom;
      const brokeSupply = b.kind === "supply" && last.close > b.top;
      if (!brokeDemand && !brokeSupply) continue;

      out.push({
        kind: brokeDemand ? "supply" : "demand", // role flipped
        zoneType: "breakerBlock",
        tf: tf,
        top: b.top,
        bottom: b.bottom,
        mid: b.mid,
        formedAt: b.formedAt,
        touches: b.touches,
        strength: weight * 3,
        broken: true,
        displacement: b.displacement,
        confirmations: b.confirmations,
        origin: "failedOrderBlock",
        flippedFrom: b.kind,
      });
    }

    if (out.length > maxBreakers) return out.slice(out.length - maxBreakers);
    return out;
  }

  // ---- Trailing volume mean --------------------------------
  // Mean volume over the trailing window, used to decide whether a
  // displacement candle carried real participation. Returns 0 when the
  // feed carries no volume at all, which callers read as "test skipped".
  function trailingVolumeMean(candles, window) {
    if (!candles || !candles.length) return 0;
    const w = Math.max(1, window || 20);
    const start = Math.max(0, candles.length - w);
    let sum = 0;
    let n = 0;
    for (let i = start; i < candles.length; i++) {
      const v = Number(candles[i].volume);
      if (isNum(v) && v > 0) {
        sum += v;
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  }

  // ---- SMC family ranking ----------------------------------
  // Orders the institutional families by conviction. Used as the final
  // tie-break when two zones sit the same distance from price, so the
  // engine prefers the strongest structure rather than whichever
  // happened to be pushed into the array first.
  function smcRank(zone) {
    if (!zone) return 0;
    if (zone.zoneType === "breakerBlock") return 4;
    if (zone.zoneType === "orderBlock") return 3;
    if (zone.zoneType === "fairValueGap") return 2;
    return 1; // supportResistance
  }

  // A zeroed SMC block, used by the early-return paths so every result
  // object has the same shape regardless of which branch produced it.
  function emptySmc() {
    return {
      families: 0,
      stacked: false,
      net: 0,
      weight: 0,
      orderBlocks: 0,
      fairValueGaps: 0,
      breakers: 0,
      pivots: 0,
    };
  }

  // ============================================================
  //  SESSION CLOCK & POWER OF THREE (AMD)
  // ============================================================
  //  Gold trades three overlapping sessions. Each one runs the same
  //  three-act structure — accumulation, manipulation, distribution —
  //  and the act price is in decides what a signal is actually worth.
  //
  //  Entering during accumulation means sitting in a range while the
  //  market builds the fuel it is about to burn. Entering during
  //  manipulation means getting swept. Entering during distribution
  //  means riding the leg the market makers just paid for.
  //
  //  All windows are UTC so the engine does not care what timezone the
  //  browser is in.

  const SESSION_DEFS = [
    {
      name: "Asia",
      label: "Tokyo",
      startUtc: 0,
      endUtc: 7,
      character: "range",
      notes: "Thin liquidity, tight ranges. Where the accumulation range is built.",
    },
    {
      name: "London",
      label: "London",
      startUtc: 7,
      endUtc: 12,
      character: "expansion",
      notes: "Primary gold vaulting and clearing hub. Where the Asian range gets swept.",
    },
    {
      name: "NewYork",
      label: "New York",
      startUtc: 12,
      endUtc: 21,
      character: "expansion",
      notes: "COMEX floor hours. Highest volume, largest displacement legs.",
    },
  ];

  // Resolve the UTC hour of a timestamp, tolerating seconds or ms.
  function utcHourOf(ts) {
    const ms = toMs(ts);
    if (!isNum(ms)) return null;
    const d = new Date(ms);
    return d.getUTCHours() + d.getUTCMinutes() / 60;
  }

  // Which session is live at this timestamp. Returns the definition
  // plus how far into the session we are, or null outside all sessions.
  function sessionAt(ts, cfg) {
    const hour = utcHourOf(ts);
    if (hour === null) return null;

    const c = cfg || DEFAULTS;
    const windows = [
      { name: "Asia", label: "Tokyo", start: c.asiaStartUtc, end: c.asiaEndUtc, character: "range" },
      { name: "London", label: "London", start: c.londonStartUtc, end: c.londonEndUtc, character: "expansion" },
      { name: "NewYork", label: "New York", start: c.nyStartUtc, end: c.nyEndUtc, character: "expansion" },
    ];

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (hour >= w.start && hour < w.end) {
        const minutesIn = Math.round((hour - w.start) * 60);
        const minutesTotal = Math.round((w.end - w.start) * 60);
        return {
          name: w.name,
          label: w.label,
          character: w.character,
          startUtc: w.start,
          endUtc: w.end,
          minutesIn: minutesIn,
          minutesTotal: minutesTotal,
          progress: minutesTotal > 0 ? minutesIn / minutesTotal : 0,
          killzone: minutesIn < c.killzoneMinutes,
        };
      }
    }
    return null;
  }

  // The Power of Three. Each session splits into three acts:
  //
  //   accumulation — the opening window where the range is built and
  //                  stops are stacked on both sides
  //   manipulation — the sweep that takes one side of that range out
  //   distribution — the displacement leg that pays the position
  //
  // The split is proportional to the session length so a 7-hour Tokyo
  // session and a 9-hour New York session both get a sensible shape.
  function amdPhaseAt(ts, cfg) {
    const c = cfg || DEFAULTS;
    const s = sessionAt(ts, c);

    if (!s) {
      return {
        session: null,
        sessionLabel: null,
        character: null,
        phase: "off",
        label: "off-session",
        progress: 0,
        minutesIn: 0,
        minutesTotal: 0,
        killzone: false,
        notes: "Outside every session window — liquidity is thin and levels are unreliable.",
      };
    }

    const p = s.progress;
    let phase;
    let notes;

    if (p < 0.3) {
      phase = "accumulation";
      notes = s.label + " is building its range — stops are stacking on both sides.";
    } else if (p < 0.55) {
      phase = "manipulation";
      notes = s.label + " is sweeping the range — expect a false break before the real move.";
    } else {
      phase = "distribution";
      notes = s.label + " is distributing — the displacement leg is underway.";
    }

    return {
      session: s.name,
      sessionLabel: s.label,
      character: s.character,
      phase: phase,
      label: phase,
      progress: p,
      minutesIn: s.minutesIn,
      minutesTotal: s.minutesTotal,
      killzone: s.killzone,
      notes: notes,
    };
  }

  // ============================================================
  //  LIQUIDITY MAPPING — ERL / IRL
  // ============================================================
  //  Liquidity is not a line, it is a cluster of resting orders. Two
  //  things matter:
  //
  //    ERL — external range liquidity. The highs and lows that sit
  //          BEYOND the current range. These are the draw on liquidity,
  //          the targets the market is reaching for.
  //
  //    IRL — internal range liquidity. The highs and lows INSIDE the
  //          range. These are the fuel stops on the way to the target.
  //
  //  Price alternates: sweep IRL, run to ERL, sweep ERL, run back to
  //  IRL. A trade that targets ERL has more room than one that targets
  //  IRL, and the engine scores them differently.

  // Cluster swing highs and lows into pools of resting orders. Two
  // swings within `equalLevelToleranceAtr` of each other are the same
  // pool — that is where the stops are stacked.
  function findLiquidityPools(candles, tf, atrValue, opts) {
    const c = opts || DEFAULTS;
    const out = [];
    if (!candles || candles.length < 5) return out;

    const a = isNum(atrValue) && atrValue > 0 ? atrValue : 1;
    const tol = a * c.equalLevelToleranceAtr;

    // Collect raw swing points using the same fractal rule as the
    // pivot layer, so liquidity and structure agree on what a swing is.
    const highs = [];
    const lows = [];
    const lb = 2;

    for (let i = lb; i < candles.length - lb; i++) {
      const bar = candles[i];
      let isHigh = true;
      let isLow = true;

      for (let j = i - lb; j <= i + lb; j++) {
        if (j === i) continue;
        if (candles[j].high >= bar.high) isHigh = false;
        if (candles[j].low <= bar.low) isLow = false;
      }

      if (isHigh) highs.push({ price: bar.high, time: bar.time, index: i });
      if (isLow) lows.push({ price: bar.low, time: bar.time, index: i });
    }

    // Greedy clustering: walk the swings in price order and merge any
    // that sit within tolerance of the running cluster mean.
    function cluster(points, side) {
      if (!points.length) return [];
      const sorted = points.slice().sort(function (x, y) { return x.price - y.price; });
      const groups = [];
      let cur = [sorted[0]];

      for (let i = 1; i < sorted.length; i++) {
        const mean = cur.reduce(function (s, q) { return s + q.price; }, 0) / cur.length;
        if (Math.abs(sorted[i].price - mean) <= tol) {
          cur.push(sorted[i]);
        } else {
          groups.push(cur);
          cur = [sorted[i]];
        }
      }
      groups.push(cur);

      const pools = [];
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (g.length < c.minPoolTouches) continue;

        const mean = g.reduce(function (s, q) { return s + q.price; }, 0) / g.length;
        let last = g[0];
        for (let k = 1; k < g.length; k++) if (g[k].index > last.index) last = g[k];

        let hi = -Infinity;
        let lo = Infinity;
        for (let k = 0; k < g.length; k++) {
          if (g[k].price > hi) hi = g[k].price;
          if (g[k].price < lo) lo = g[k].price;
        }

        pools.push({
          side: side,
          price: round2(mean),
          touches: g.length,
          firstTime: g[0].time,
          lastTime: last.time,
          lastIndex: last.index,
          spread: round2(hi - lo),
        });
      }
      return pools;
    }

    const h = cluster(highs, "buySide");
    const l = cluster(lows, "sellSide");

    for (let i = 0; i < h.length; i++) out.push(h[i]);
    for (let i = 0; i < l.length; i++) out.push(l[i]);

    // Strongest pools first — more touches means more resting orders.
    out.sort(function (x, y) { return y.touches - x.touches; });

    for (let i = 0; i < out.length; i++) out[i].tf = tf;
    return out.slice(0, c.maxPools);
  }

  // Split pools into external and internal relative to the dealing
  // range. The range is the highest high and lowest low of the recent
  // window; anything at or beyond those extremes is ERL, anything
  // inside is IRL.
  function classifyLiquidity(pools, candles, tf, atrValue, opts) {
    const c = opts || DEFAULTS;
    const a = isNum(atrValue) && atrValue > 0 ? atrValue : 1;
    const out = { erl: [], irl: [], range: null };

    if (!candles || !candles.length) return out;

    // Dealing range: the extremes of the retained window.
    let hi = -Infinity;
    let lo = Infinity;
    let hiTime = null;
    let loTime = null;

    for (let i = 0; i < candles.length; i++) {
      if (candles[i].high > hi) { hi = candles[i].high; hiTime = candles[i].time; }
      if (candles[i].low < lo) { lo = candles[i].low; loTime = candles[i].time; }
    }

    const height = hi - lo;
    const lastClose = candles[candles.length - 1].close;

    out.range = {
      tf: tf,
      high: round2(hi),
      low: round2(lo),
      height: round2(height),
      heightAtr: a > 0 ? round2(height / a) : 0,
      highTime: hiTime,
      lowTime: loTime,
      equilibrium: round2(lo + height / 2),
      position: height > 0 ? round2((lastClose - lo) / height) : 0.5,
    };

    // A pool is external when it sits within a tolerance of the range
    // extreme, internal when it sits meaningfully inside it.
    const edge = a * c.equalLevelToleranceAtr * 2;

    for (let i = 0; i < pools.length; i++) {
      const p = pools[i];
      const nearHigh = Math.abs(p.price - hi) <= edge;
      const nearLow = Math.abs(p.price - lo) <= edge;
      const isErl = nearHigh || nearLow;

      const entry = {
        side: p.side,
        price: p.price,
        touches: p.touches,
        tf: tf,
        kind: isErl ? "ERL" : "IRL",
        lastTime: p.lastTime,
        lastIndex: p.lastIndex,
        spread: p.spread,
        distanceAtr: a > 0 ? round2(Math.abs(p.price - lastClose) / a) : 0,
      };

      if (isErl) out.erl.push(entry);
      else out.irl.push(entry);
    }

    // Nearest-first ordering so a caller can read the next draw on
    // liquidity without sorting.
    out.erl.sort(function (x, y) {
      return Math.abs(x.price - lastClose) - Math.abs(y.price - lastClose);
    });
    out.irl.sort(function (x, y) {
      return Math.abs(x.price - lastClose) - Math.abs(y.price - lastClose);
    });

    return out;
  }

  // Sweep detection. A sweep is a wick that trades through a pool and
  // then closes back on the origin side — the market took the stops
  // without accepting the price. That is the manipulation leg, and it
  // is the single most reliable tell in the model.
  function findLiquiditySweeps(candles, pools, tf, atrValue, opts) {
    const c = opts || DEFAULTS;
    const out = [];
    if (!candles || candles.length < 3 || !pools || !pools.length) return out;

    const a = isNum(atrValue) && atrValue > 0 ? atrValue : 1;
    const minPen = a * c.sweepMinAtr;
    const reclaim = c.sweepReclaimBars;

    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      const isBuySide = pool.side === "buySide";

      // Only look at bars after the pool was last touched.
      const from = isNum(pool.lastIndex) ? pool.lastIndex + 1 : 0;

      for (let j = from; j < candles.length; j++) {
        const bar = candles[j];
        let penetrated = false;
        let penetration = 0;

        if (isBuySide) {
          penetrated = bar.high > pool.price;
          penetration = bar.high - pool.price;
        } else {
          penetrated = bar.low < pool.price;
          penetration = pool.price - bar.low;
        }

        if (!penetrated || penetration < minPen) continue;

        // Did price close back on the origin side within the reclaim
        // window? A close beyond the pool is acceptance, not a sweep.
        let reclaimed = false;
        let reclaimIndex = -1;

        for (let k = j; k < Math.min(candles.length, j + reclaim + 1); k++) {
          const b = candles[k];
          if (isBuySide && b.close < pool.price) { reclaimed = true; reclaimIndex = k; break; }
          if (!isBuySide && b.close > pool.price) { reclaimed = true; reclaimIndex = k; break; }
        }

        if (!reclaimed) continue;

        // A sweep of buy-side liquidity is bearish — the market took
        // the stops above and reversed. Sell-side is the mirror.
        out.push({
          tf: tf,
          side: pool.side,
          poolPrice: pool.price,
          poolTouches: pool.touches,
          sweepTime: bar.time,
          sweepIndex: j,
          reclaimTime: candles[reclaimIndex].time,
          reclaimIndex: reclaimIndex,
          penetration: round2(penetration),
          penetrationAtr: round2(penetration / a),
          direction: isBuySide ? "bearish" : "bullish",
          barsAgo: candles.length - 1 - reclaimIndex,
        });

        break; // one sweep per pool is enough
      }
    }

    // Most recent sweeps first.
    out.sort(function (x, y) { return x.barsAgo - y.barsAgo; });
    return out;
  }

  // ============================================================
  //  MARKET MAKER BUY / SELL MODEL
  // ============================================================
  //  The full model, in order:
  //
  //    1. ACCUMULATION — price ranges, building stops on both sides
  //    2. MANIPULATION — price sweeps one side of that range
  //    3. DISTRIBUTION — price displaces hard the other way
  //
  //  A sell model sweeps buy-side liquidity (the highs) then
  //  distributes lower. A buy model sweeps sell-side liquidity (the
  //  lows) then distributes higher.
  //
  //  The engine only calls it confirmed when all three legs are
  //  present in sequence, which is what makes it worth the largest
  //  single bonus in the scoring stack.

  function detectMarketMakerModel(candles, tf, atrValue, opts) {
    const c = opts || DEFAULTS;
    const empty = {
      present: false,
      model: null,
      direction: "none",
      accumulation: null,
      manipulation: null,
      distribution: null,
      target: null,
      confidence: 0,
      notes: "no market maker model in the retained window",
    };

    if (!candles || candles.length < c.mmbmRangeMinBars + 4) return empty;

    const a = isNum(atrValue) && atrValue > 0 ? atrValue : 1;
    const lookback = Math.min(candles.length, c.mmbmLookbackBars);
    const start = candles.length - lookback;
    const window = candles.slice(start);

    // ---- Leg 1: find the accumulation range -------------------
    // The range is the longest stretch of bars whose total height
    // stays under the ceiling. Scanning by total height rather than
    // by per-bar breaks is what makes this robust: a range is defined
    // by how wide it is, not by whether individual bars set new
    // extremes inside it.
    //
    // The range must not swallow the manipulation bar, so the scan
    // also stops once a bar clears the running extreme by more than
    // the sweep threshold — that bar is the sweep, not accumulation.
    let best = null;
    // A bar must clear the running extreme by this much to count as the
    // manipulation leg rather than part of the range. Tying it to the
    // range ceiling keeps it proportional to what "wide" means here.
    const breakMargin = a * c.mmbmRangeMaxAtr * 0.25;

    for (let i = 0; i < window.length - c.mmbmRangeMinBars; i++) {
      let hi = window[i].high;
      let lo = window[i].low;

      for (let j = i + 1; j < window.length; j++) {
        const bar = window[j];

        // A decisive break of either extreme is the manipulation leg.
        if (bar.high > hi + breakMargin || bar.low < lo - breakMargin) break;

        if (bar.high > hi) hi = bar.high;
        if (bar.low < lo) lo = bar.low;

        const bars = j - i + 1;
        if (bars < c.mmbmRangeMinBars) continue;

        const height = hi - lo;
        if (height > a * c.mmbmRangeMaxAtr) break; // range too wide to be accumulation

        // Prefer the longest qualifying range.
        if (!best || bars > best.bars) {
          best = { start: i, end: j, high: hi, low: lo, bars: bars, height: height };
        }
      }
    }

    if (!best) return empty;

    // ---- Leg 2: find the manipulation sweep -------------------
    // The sweep must come after the range and take out one side.
    let sweep = null;

    for (let j = best.end + 1; j < window.length; j++) {
      const bar = window[j];
      const tookHighs = bar.high > best.high;
      const tookLows = bar.low < best.low;

      if (!tookHighs && !tookLows) continue;

      // Prefer the larger penetration if both sides got taken.
      const penHigh = tookHighs ? bar.high - best.high : 0;
      const penLow = tookLows ? best.low - bar.low : 0;

      if (penHigh >= penLow && penHigh >= a * c.sweepMinAtr) {
        sweep = { index: j, side: "buySide", price: bar.high, penetration: penHigh, bar: bar };
      } else if (penLow > penHigh && penLow >= a * c.sweepMinAtr) {
        sweep = { index: j, side: "sellSide", price: bar.low, penetration: penLow, bar: bar };
      }

      if (sweep) break;
    }

    if (!sweep) return empty;

    // ---- Leg 3: find the distribution leg ---------------------
    // Displacement away from the swept side, measured from the sweep
    // bar's close to the furthest close that followed.
    let distIndex = -1;
    let distExtreme = sweep.bar.close;

    for (let j = sweep.index + 1; j < window.length; j++) {
      const cl = window[j].close;
      if (sweep.side === "buySide") {
        // Swept the highs — distribution should be lower.
        if (cl < distExtreme) { distExtreme = cl; distIndex = j; }
      } else {
        if (cl > distExtreme) { distExtreme = cl; distIndex = j; }
      }
    }

    if (distIndex < 0) return empty;

    const distLeg = Math.abs(distExtreme - sweep.bar.close);
    if (distLeg < a * c.mmbmDisplacementAtr) return empty;

    // ---- Assemble ---------------------------------------------
    const isSell = sweep.side === "buySide";
    const direction = isSell ? "bearish" : "bullish";

    // Confidence scales with how clean each leg was: a tight range,
    // a decisive sweep, and a large displacement all add.
    const rangeQuality = Math.max(0, 1 - (best.height / (a * c.mmbmRangeMaxAtr)));
    const sweepQuality = Math.min(1, sweep.penetration / (a * 0.5));
    const distQuality = Math.min(1, distLeg / (a * c.mmbmDisplacementAtr * 2));
    const confidence = Math.round((rangeQuality * 0.3 + sweepQuality * 0.3 + distQuality * 0.4) * 100);

    // The target is the opposite side of the range — the liquidity
    // the distribution leg is reaching for.
    const target = isSell ? best.low : best.high;

    return {
      present: true,
      model: isSell ? "sellModel" : "buyModel",
      direction: direction,
      accumulation: {
        startTime: window[best.start].time,
        endTime: window[best.end].time,
        high: round2(best.high),
        low: round2(best.low),
        mid: round2((best.high + best.low) / 2),
        bars: best.bars,
        height: round2(best.height),
        heightAtr: round2(best.height / a),
      },
      manipulation: {
        side: sweep.side,
        price: round2(sweep.price),
        time: sweep.bar.time,
        penetration: round2(sweep.penetration),
        penetrationAtr: round2(sweep.penetration / a),
      },
      distribution: {
        time: window[distIndex].time,
        extreme: round2(distExtreme),
        leg: round2(distLeg),
        legAtr: round2(distLeg / a),
        bars: distIndex - sweep.index,
      },
      target: round2(target),
      confidence: confidence,
      notes: (isSell ? "Sell model" : "Buy model") +
             " — accumulation range swept " + (isSell ? "above" : "below") +
             ", distributing " + (isSell ? "lower" : "higher") +
             " toward " + round2(target) + ".",
    };
  }

  // ---- SMC confluence --------------------------------------
  // Stacks the three institutional families against a price level and
  // returns a single weighted read. This is what makes the engine treat
  // OB and FVG as primary rather than incidental: a level where an order
  // block, a fair value gap and a swing pivot all sit within a fraction
  // of an ATR is a genuine institutional shelf, and it is scored as one.
  function smcConfluence(zones, price, tfAtr, opts) {
    const o = opts || {};
    const proximity = isNum(o.proximityAtr) ? o.proximityAtr : 0.5;
    const ref = isNum(tfAtr) && tfAtr > 0 ? tfAtr : 0;
    const out = {
      orderBlocks: [],
      fairValueGaps: [],
      breakers: [],
      pivots: [],
      families: 0,
      net: 0,
      weight: 0,
      stacked: false,
    };
    if (ref <= 0 || !zones || !zones.length) return out;

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      let d = 0;
      if (price > z.top) d = price - z.top;
      else if (price < z.bottom) d = z.bottom - price;
      const dist = d / ref;
      if (dist > proximity) continue;

      const entry = { zone: z, distance: round2(dist), inside: d === 0 };
      if (z.zoneType === "orderBlock") out.orderBlocks.push(entry);
      else if (z.zoneType === "fairValueGap") out.fairValueGaps.push(entry);
      else if (z.zoneType === "breakerBlock") out.breakers.push(entry);
      else out.pivots.push(entry);
    }

    // Each family that has at least one live member within reach counts
    // once, regardless of how many members it has. Three FVGs stacked
    // on top of each other is one family, not three.
    if (out.orderBlocks.length) out.families++;
    if (out.fairValueGaps.length) out.families++;
    if (out.breakers.length) out.families++;
    if (out.pivots.length) out.families++;

    // Net directional read across every institutional member in reach.
    let net = 0;
    let gross = 0;
    const all = out.orderBlocks.concat(out.fairValueGaps, out.breakers);
    for (let j = 0; j < all.length; j++) {
      const z = all[j].zone;
      const sign = z.kind === "demand" ? 1 : -1;
      const w = isNum(z.strength) ? z.strength : 1;
      net += sign * w;
      gross += w;
    }
    out.net = gross > 0 ? round2(net / gross) : 0;
    out.weight = round2(gross);
    out.stacked = out.families >= 2;
    return out;
  }


  // ============================================================
  // HamzaSignalEngine
  // ============================================================
  class HamzaSignalEngine {
    constructor(options) {
      const opts = options || {};
      this.config = Object.assign({}, DEFAULTS, opts);

      // Per-timeframe state. Each entry holds the candle series, the
      // derived zones, and the cached ATR used for proximity scoring.
      this.frames = {};
      for (let i = 0; i < TF_ORDER.length; i++) {
        const tf = TF_ORDER[i];
        this.frames[tf] = {
          tf: tf,
          intervalMs: TF_MS[tf],
          candles: [],
          zones: [],
          atr: 0,
          lastBucket: null,
          lastClose: null,
          dirty: true,
          // Institutional liquidity state, rebuilt alongside the zones.
          pools: [],
          liquidity: { erl: [], irl: [], range: null },
          sweeps: [],
          mmbm: null,
        };
      }

      this.lastPrice = null;
      this.lastEval = null;
      this.evalCount = 0;
    }

    // ---- Timeframe access ----------------------------------
    timeframes() {
      return TF_ORDER.slice();
    }

    intervalFor(tf) {
      return TF_MS[tf] || TF_MS["1m"];
    }

    frame(tf) {
      return this.frames[tf] || null;
    }

    // ---- Bulk load -----------------------------------------
    // Accepts a raw candle array for one timeframe. Sanitises, sorts,
    // de-duplicates by bucket, then rebuilds that timeframe's zones.
    loadCandles(tf, candles) {
      const f = this.frames[tf];
      if (!f) return 0;

      const src = candles || [];
      const seen = Object.create(null);
      const clean = [];

      for (let i = 0; i < src.length; i++) {
        const row = normalizeCandle(src[i]);
        if (!row) continue;
        if (!isValidCandle(row)) continue;
        if (seen[row.time]) continue;
        seen[row.time] = true;
        clean.push(row);
      }

      clean.sort(function (a, b) { return a.time - b.time; });

      // Ring-buffer ceiling: keep the most recent N bars.
      const cap = this.config.maxCandlesPerTf;
      f.candles = clean.length > cap ? clean.slice(clean.length - cap) : clean;

      const last = f.candles[f.candles.length - 1];
      f.lastClose = last ? last.close : null;
      f.lastBucket = last ? toMs(last.time) : null;
      f.atr = atr(f.candles, this.config.atrPeriod);
      f.dirty = true;

      this.rebuildZones(tf);
      return f.candles.length;
    }

    // ---- Incremental tick ----------------------------------
    // Folds one price into the given timeframe. Returns the affected
    // candle, or null when the tick was rejected.
    applyTick(tf, price, ts) {
      const f = this.frames[tf];
      if (!f) return null;

      const p = Number(price);
      if (!isNum(p) || p <= 0) return null;

      const bucket = bucketMs(ts, f.intervalMs);
      if (!isNum(bucket)) return null;

      const last = f.candles[f.candles.length - 1];

      // No history yet — seed a single bar so the engine can still
      // evaluate rather than sitting mute until a bulk load arrives.
      if (!last) {
        const seed = normalizeCandle({
          time: Math.floor(bucket / 1000),
          open: p, high: p, low: p, close: p, volume: 1,
        });
        if (!seed) return null;
        f.candles.push(seed);
        f.lastClose = p;
        f.lastBucket = bucket;
        f.dirty = true;
        return seed;
      }

      const lastBucket = toMs(last.time);

      if (bucket > lastBucket) {
        const fresh = normalizeCandle({
          time: Math.floor(bucket / 1000),
          open: p, high: p, low: p, close: p, volume: 1,
        });
        if (!fresh) return null;
        f.candles.push(fresh);
        if (f.candles.length > this.config.maxCandlesPerTf) f.candles.shift();
        f.lastClose = p;
        f.lastBucket = bucket;
        f.dirty = true;
        return fresh;
      }

      // Same bucket — mutate the live bar in place.
      last.close = p;
      if (p > last.high) last.high = p;
      if (p < last.low) last.low = p;
      last.volume = (Number(last.volume) || 0) + 1;
      f.lastClose = p;
      f.dirty = true;
      return last;
    }

    // ---- Zone rebuild --------------------------------------
    // Recomputes supply/demand bands for one timeframe from its pivots.
    // Zones that price has already closed through are marked broken
    // rather than deleted, so the evaluator can report a retest.
    rebuildZones(tf) {
      const f = this.frames[tf];
      if (!f) return [];

      const candles = f.candles;
      if (candles.length < this.config.swingLookback * 2 + 1) {
        f.zones = [];
        f.pools = [];
        f.liquidity = { erl: [], irl: [], range: null };
        f.sweeps = [];
        f.mmbm = detectMarketMakerModel(candles, tf, f.atr, this.config);
        f.dirty = false;
        return f.zones;
      }

      const pivots = findPivots(candles, this.config.swingLookback);
      const weight = TF_WEIGHT[tf] || 1;
      const zones = [];

      for (let i = 0; i < pivots.highs.length; i++) {
        const pv = pivots.highs[i];
        zones.push(makeZone("supply", pv.price, pv.time, tf, weight));
      }
      for (let j = 0; j < pivots.lows.length; j++) {
        const pv = pivots.lows[j];
        zones.push(makeZone("demand", pv.price, pv.time, tf, weight));
      }

      // Order blocks ride alongside the pivot bands. They are detected
      // from displacement, not from swing structure, so the two families
      // can legitimately overlap — the merge pass below keeps them apart
      // by zoneType so an OB never gets absorbed into a pivot band.
      const tfAtr = atr(candles, this.config.atrPeriod);
      const blocks = findOrderBlocks(candles, tf, tfAtr, {
        displacementAtr: this.config.obDisplacementAtr,
        rangeAtr: this.config.obRangeAtr,
        volumeFactor: this.config.obVolumeFactor,
        maxBlocks: this.config.maxOrderBlocks,
      });
      for (let b = 0; b < blocks.length; b++) zones.push(blocks[b]);

      // Fair value gaps are the second institutional family. They are
      // detected from three-candle imbalance rather than displacement,
      // so they frequently sit inside or adjacent to an order block —
      // that overlap is the point, and the SMC confluence pass scores
      // it as a stacked level rather than merging it away.
      const gaps = findFairValueGaps(candles, tf, tfAtr, {
        minAtr: this.config.fvgMinAtr,
        maxFvgs: this.config.maxFvgs,
        fillThreshold: this.config.fvgFillThreshold,
      });
      for (let g = 0; g < gaps.length; g++) zones.push(gaps[g]);

      // Breakers are order blocks that price has closed through. They
      // are derived from the block list, so they inherit its geometry
      // and flip its role.
      const breakers = findBreakerBlocks(blocks, candles, tf, tfAtr, {
        maxBreakers: this.config.maxBreakers,
      });
      for (let br = 0; br < breakers.length; br++) zones.push(breakers[br]);

      // Count how many times price has revisited each band — a zone
      // tested repeatedly is weaker, not stronger, so touches feed the
      // evaluator's confidence penalty.
      const lastClose = f.lastClose;
      const mitigationAtr = tfAtr * this.config.obMitigationAtr;
      for (let k = 0; k < zones.length; k++) {
        const z = zones[k];
        let touches = 0;
        for (let m = 0; m < candles.length; m++) {
          const c = candles[m];
          if (c.time <= z.formedAt) continue;
          if (c.high >= z.bottom && c.low <= z.top) touches++;
        }
        z.touches = Math.max(1, touches);
        if (isNum(lastClose)) {
          if (z.kind === "supply" && lastClose > z.top) z.broken = true;
          if (z.kind === "demand" && lastClose < z.bottom) z.broken = true;
        }

        // Order-block mitigation: how far price has traded back into the
        // block since it formed. A block that price has only grazed is
        // still fresh; one that has been driven through is spent. The
        // depth is expressed in ATR so it means the same on 1m and 1D.
        if (z.zoneType === "orderBlock" && isNum(lastClose)) {
          let depth = 0;
          if (z.kind === "demand") {
            // A demand block is consumed from its top edge downward.
            depth = Math.max(0, z.top - lastClose);
          } else {
            // A supply block is consumed from its bottom edge upward.
            depth = Math.max(0, lastClose - z.bottom);
          }
          const height = Math.max(z.top - z.bottom, 1e-9);
          z.mitigation = round2(Math.min(1, depth / height));
          z.mitigated = depth >= mitigationAtr;
        }
      }

      let merged = mergeZones(zones, this.config.zoneMergePct);

      // Keep the strongest, most recent bands.
      merged.sort(function (a, b) {
        if (b.strength !== a.strength) return b.strength - a.strength;
        return b.formedAt - a.formedAt;
      });
      if (merged.length > this.config.maxZonesPerTf) {
        merged = merged.slice(0, this.config.maxZonesPerTf);
      }

      f.zones = merged;
      f.atr = atr(candles, this.config.atrPeriod);
      f.dirty = false;

      // ---- Institutional liquidity layer ----------------------
      //  Built after the zones so the sweep detector can reference
      //  the same ATR the zone scoring uses. Pools are clustered
      //  swing points, split into external (ERL) and internal (IRL)
      //  relative to the dealing range, then scanned for sweeps.
      f.pools = findLiquidityPools(candles, tf, f.atr, this.config);
      f.liquidity = classifyLiquidity(f.pools, candles, tf, f.atr, this.config);
      f.sweeps = findLiquiditySweeps(candles, f.pools, tf, f.atr, this.config);
      f.mmbm = detectMarketMakerModel(candles, tf, f.atr, this.config);

      return f.zones;
    }

    rebuildAll() {
      const tfs = this.timeframes();
      for (let i = 0; i < tfs.length; i++) this.rebuildZones(tfs[i]);
      return this.snapshot();
    }

    // ---- Zone lookup ---------------------------------------
    zonesFor(tf) {
      const f = this.frames[tf];
      if (!f) return [];
      if (f.dirty) this.rebuildZones(tf);
      return f.zones;
    }

    allZones() {
      const out = [];
      const tfs = this.timeframes();
      for (let i = 0; i < tfs.length; i++) {
        const zs = this.zonesFor(tfs[i]);
        for (let j = 0; j < zs.length; j++) out.push(zs[j]);
      }
      return out;
    }

    // ---- Institutional zone access --------------------------
    // Returns only the smart-money families, optionally filtered by
    // timeframe and/or family. This is the accessor a chart overlay or a
    // panel uses when it wants the institutional levels without the
    // swing-pivot noise mixed in.
    smcZones(tf, family) {
      const out = [];
      const tfs = tf ? [tf] : this.timeframes();
      for (let i = 0; i < tfs.length; i++) {
        const zs = this.zonesFor(tfs[i]);
        for (let j = 0; j < zs.length; j++) {
          const z = zs[j];
          if (z.zoneType === "supportResistance") continue;
          if (family && z.zoneType !== family) continue;
          out.push(z);
        }
      }
      return out;
    }

    // Counts the institutional families per timeframe. Handy for a
    // status card that reports how much structure the engine is seeing.
    smcSummary() {
      const tfs = this.timeframes();
      const out = { total: 0, orderBlocks: 0, fairValueGaps: 0, breakers: 0, frames: {} };
      for (let i = 0; i < tfs.length; i++) {
        const tf = tfs[i];
        const zs = this.zonesFor(tf);
        const row = { orderBlocks: 0, fairValueGaps: 0, breakers: 0, pivots: 0 };
        for (let j = 0; j < zs.length; j++) {
          const t = zs[j].zoneType;
          if (t === "orderBlock") row.orderBlocks++;
          else if (t === "fairValueGap") row.fairValueGaps++;
          else if (t === "breakerBlock") row.breakers++;
          else row.pivots++;
        }
        out.orderBlocks += row.orderBlocks;
        out.fairValueGaps += row.fairValueGaps;
        out.breakers += row.breakers;
        out.total += row.orderBlocks + row.fairValueGaps + row.breakers;
        out.frames[tf] = row;
      }
      return out;
    }

    // ---- Session / liquidity accessors ---------------------
    // The live Power of Three read for a given moment. Defaults to now
    // so a panel can call it with no arguments.
    sessionPhase(ts) {
      const t = isNum(Number(ts)) ? Number(ts) : Date.now();
      return amdPhaseAt(t, this.config);
    }

    // The dealing range and its liquidity pools for one timeframe.
    // Returns { range, erl, irl } — ERL is external (beyond the range
    // extremes), IRL is internal (inside it).
    liquidityFor(tf) {
      const f = this.frames[tf];
      if (!f) return { range: null, erl: [], irl: [], pools: [] };
      return {
        range: f.liquidity ? f.liquidity.range : null,
        erl: f.liquidity ? f.liquidity.erl : [],
        irl: f.liquidity ? f.liquidity.irl : [],
        pools: f.pools || [],
      };
    }

    // Every sweep the engine currently sees, across all timeframes,
    // freshest first. `maxBarsAgo` filters to recent sweeps only.
    sweeps(maxBarsAgo) {
      const tfs = this.timeframes();
      const limit = isNum(maxBarsAgo) ? maxBarsAgo : Infinity;
      const out = [];
      for (let i = 0; i < tfs.length; i++) {
        const f = this.frames[tfs[i]];
        if (!f || !f.sweeps) continue;
        for (let j = 0; j < f.sweeps.length; j++) {
          if (f.sweeps[j].barsAgo <= limit) out.push(f.sweeps[j]);
        }
      }
      out.sort(function (a, b) { return a.barsAgo - b.barsAgo; });
      return out;
    }

    // The market maker model for one timeframe, or the strongest one
    // across the whole stack when no timeframe is given.
    marketMakerModel(tf) {
      if (tf) {
        const f = this.frames[tf];
        return f ? f.mmbm : null;
      }
      const tfs = this.timeframes();
      let best = null;
      for (let i = 0; i < tfs.length; i++) {
        const f = this.frames[tfs[i]];
        if (!f || !f.mmbm || !f.mmbm.present) continue;
        if (!best || f.mmbm.confidence > best.confidence) best = f.mmbm;
      }
      return best;
    }

    // Per-timeframe institutional liquidity summary, mirroring
    // smcSummary() for the session and liquidity layer.
    liquiditySummary() {
      const tfs = this.timeframes();
      const out = { erl: 0, irl: 0, sweeps: 0, models: 0, frames: {} };
      for (let i = 0; i < tfs.length; i++) {
        const tf = tfs[i];
        const f = this.frames[tf];
        const liq = f && f.liquidity ? f.liquidity : { erl: [], irl: [], range: null };
        const row = {
          erl: liq.erl.length,
          irl: liq.irl.length,
          sweeps: f && f.sweeps ? f.sweeps.length : 0,
          model: f && f.mmbm && f.mmbm.present ? f.mmbm.model : null,
          range: liq.range,
        };
        out.erl += row.erl;
        out.irl += row.irl;
        out.sweeps += row.sweeps;
        if (row.model) out.models++;
        out.frames[tf] = row;
      }
      return out;
    }

    // ---- Proximity -----------------------------------------
    // Distance from price to a zone, expressed in ATR units so the
    // threshold means the same thing on 1m and 1D.
    distanceInAtr(price, zone, tfAtr) {
      const ref = isNum(tfAtr) && tfAtr > 0 ? tfAtr : 0;
      if (ref <= 0) return Infinity;
      let d = 0;
      if (price > zone.top) d = price - zone.top;
      else if (price < zone.bottom) d = zone.bottom - price;
      else d = 0; // inside the band
      return d / ref;
    }

    // ---- Action mapping ------------------------------------
    // Translates a directional bias plus a confidence score into one of
    // the three trade actions. HOLD is the default state: a zone that is
    // merely nearby is not a trade, it is a watch.
    actionFor(bias, score) {
      if (bias === "bullish" && score >= this.config.minActionScore) return "BUY";
      if (bias === "bearish" && score >= this.config.minActionScore) return "SELL";
      return "HOLD";
    }

    // ---- Trade levels --------------------------------------
    // Derives entry / stop / target from the zone that produced the
    // signal. The stop sits beyond the far edge of the zone (not the
    // near edge) so normal wick noise inside the band cannot take it
    // out; the target is a fixed R multiple of that risk.
    levelsFor(action, zone, tfAtr) {
      if (!zone || action === "HOLD") return null;
      const ref = isNum(tfAtr) && tfAtr > 0 ? tfAtr : 0;
      const buffer = ref * this.config.stopBufferAtr;
      const entry = zone.mid;
      let stop;
      let target;

      if (action === "BUY") {
        stop = zone.bottom - buffer;
        const risk = entry - stop;
        target = entry + risk * this.config.targetRr;
      } else {
        stop = zone.top + buffer;
        const risk = stop - entry;
        target = entry - risk * this.config.targetRr;
      }

      const risk = Math.abs(entry - stop);
      return {
        entry: round2(entry),
        stop: round2(stop),
        target: round2(target),
        risk: round2(risk),
        reward: round2(Math.abs(target - entry)),
        rr: this.config.targetRr,
      };
    }

    // ---- Per-timeframe evaluation --------------------------
    // Scores the live price against one timeframe's zones only. This is
    // the building block the aggregate evaluate() composes, and it is
    // also useful on its own for a per-panel readout.
    evaluateTimeframe(tf, price, ts) {
      const f = this.frames[tf];
      const now = isNum(Number(ts)) ? Number(ts) : Date.now();
      if (!f) {
        return { tf: tf, action: "HOLD", bias: "none", score: 0,
                 confidence: 0, zone: null, zoneType: null, distance: null,
                 smcRank: 0, smc: emptySmc(), reasons: ["unknown timeframe"],
                 session: amdPhaseAt(now, this.config), sweep: null,
                 liquidity: { targetKind: null, target: null, erl: 0, irl: 0, range: null },
                 mmbm: null };
      }

      const p = Number(price);
      if (!isNum(p) || p <= 0) {
        return { tf: tf, action: "HOLD", bias: "none", score: 0,
                 confidence: 0, zone: null, zoneType: null, distance: null,
                 smcRank: 0, smc: emptySmc(), reasons: ["invalid price"],
                 session: amdPhaseAt(now, this.config), sweep: null,
                 liquidity: { targetKind: null, target: null, erl: 0, irl: 0, range: null },
                 mmbm: null };
      }

      if (f.dirty) this.rebuildZones(tf);

      const zones = f.zones;
      const tfAtr = f.atr;
      const proximity = this.config.proximityAtr;
      const reasons = [];

      // Collect every zone this timeframe has within reach of price.
      const hits = [];
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        const dist = this.distanceInAtr(p, z, tfAtr);
        if (dist <= proximity) {
          hits.push({ zone: z, distance: dist, inside: dist === 0 });
        }
      }

      if (!hits.length) {
        // Nothing within reach on this timeframe, but the institutional
        // structure is still real — report it so a per-panel readout can
        // show the shelf price is drifting toward.
        const flatStack = smcConfluence(zones, p, tfAtr, { proximityAtr: proximity });
        return { tf: tf, action: "HOLD", bias: "none", score: 0,
                 confidence: 0, zone: null, zoneType: null, distance: null,
                 smcRank: 0,
                 smc: {
                   families: flatStack.families,
                   stacked: flatStack.stacked,
                   net: flatStack.net,
                   weight: flatStack.weight,
                   orderBlocks: flatStack.orderBlocks.length,
                   fairValueGaps: flatStack.fairValueGaps.length,
                   breakers: flatStack.breakers.length,
                   pivots: flatStack.pivots.length,
                 },
                 reasons: ["price is between " + tf + " structures"] };
      }

      // Nearest wins; ties break toward the stronger zone, then toward
      // institutional families over plain pivot bands. The family rank
      // is explicit so a breaker outranks an order block, which outranks
      // a fair value gap, which outranks a swing pivot.
      hits.sort(function (a, b) {
        if (a.distance !== b.distance) return a.distance - b.distance;
        if (b.zone.strength !== a.zone.strength) return b.zone.strength - a.zone.strength;
        return smcRank(b.zone) - smcRank(a.zone);
      });

      const primary = hits[0];
      const z = primary.zone;

      // Base score from proximity.
      const closeness = Math.max(0, 1 - primary.distance / proximity);
      let score = 30 + closeness * 30;

      reasons.push(
        "price " + (primary.inside ? "inside" : "approaching") + " " +
        tf + " " + z.zoneType + " (" + z.kind + ") " +
        z.bottom.toFixed(2) + "-" + z.top.toFixed(2)
      );

      // Timeframe weight.
      const w = TF_WEIGHT[tf] || 1;
      score += w * 5;
      if (w >= 3) reasons.push(tf + " is a higher-timeframe structure");

      // ---- Institutional zone premium ----------------------
      // This is where OB and FVG stop being incidental and start driving
      // the read. Each family carries its own premium, scaled by the
      // timeframe weight so a 1D order block outweighs a 1m one.
      if (z.zoneType === "orderBlock") {
        // Base premium, plus one step per confirmation the block earned
        // (body / range / volume).
        const conf = isNum(z.confirmations) ? z.confirmations : 1;
        score += 10 + conf * 3;
        reasons.push("order block with " + z.displacement + "x ATR displacement" +
                     " (" + conf + "/3 confirmations)");
        if (z.volumeConfirmed) reasons.push("displacement carried above-average volume");
        if (z.mitigated) {
          score -= 8;
          reasons.push("order block is " + Math.round((z.mitigation || 0) * 100) + "% mitigated");
        } else {
          score += 6;
          reasons.push("order block is unmitigated");
        }
      } else if (z.zoneType === "fairValueGap") {
        score += 9;
        reasons.push("fair value gap of " + z.gapAtr + "x ATR");
        if (z.spent) {
          score -= 10;
          reasons.push("gap is " + Math.round((z.filled || 0) * 100) + "% rebalanced");
        } else {
          score += 7;
          reasons.push("gap is " + Math.round((1 - (z.filled || 0)) * 100) + "% unfilled");
        }
      } else if (z.zoneType === "breakerBlock") {
        // A breaker is the highest-conviction family: the institutional
        // side was proven wrong here and had to reposition.
        score += 14;
        reasons.push("breaker block — failed " + z.flippedFrom + " flipped to " + z.kind);
      }

      // ---- SMC stack ---------------------------------------
      // Count how many institutional families sit within reach of price
      // on this timeframe. Two or more is a genuine shelf, and the read
      // is promoted accordingly rather than treated as a single zone.
      const stack = smcConfluence(zones, p, tfAtr, { proximityAtr: proximity });
      if (stack.families >= 2) {
        const bonus = Math.min(
          this.config.smcStackCap,
          (stack.families - 1) * this.config.smcConfluenceBonus
        );
        // The stack only promotes the read when it agrees with the
        // primary zone's direction. A stack pointing the other way is a
        // warning, not a tailwind.
        const stackAgrees = (z.kind === "demand" && stack.net > 0) ||
                            (z.kind === "supply" && stack.net < 0);
        if (stackAgrees) {
          score += bonus;
          reasons.push(stack.families + " institutional families stacked in agreement");
        } else {
          score -= Math.round(bonus / 2);
          reasons.push("institutional stack opposes the primary zone");
        }
      }

      // Freshness.
      const touches = z.touches || 1;
      if (touches === 1) {
        score += 8;
        reasons.push("zone is untested");
      } else if (touches >= 4) {
        score -= 10;
        reasons.push("zone has been tested " + touches + " times");
      }

      // Directional read. A broken band flips its role.
      let bias;
      if (z.kind === "supply") {
        bias = z.broken ? "bullish" : "bearish";
        if (z.broken) reasons.push("supply broken — now acting as support");
      } else {
        bias = z.broken ? "bearish" : "bullish";
        if (z.broken) reasons.push("demand broken — now acting as resistance");
      }

      // ---- Session phase (Power of Three) -------------------
      //  The clock decides what a signal is worth. A perfect zone
      //  during accumulation is a trap; the same zone during
      //  distribution is the trade.
      const amd = amdPhaseAt(now, this.config);
      if (amd.phase === "off") {
        score -= this.config.deadZonePenalty;
        reasons.push("off-session — no active killzone");
      } else {
        score += this.config.sessionBonus;
        reasons.push(amd.sessionLabel + " session, " + amd.phase + " phase");

        if (amd.killzone) {
          score += this.config.killzoneBonus;
          reasons.push(amd.sessionLabel + " killzone is open");
        }

        if (amd.phase === "distribution") {
          score += this.config.amdDistributionBonus;
          reasons.push("distribution phase — displacement leg underway");
        } else if (amd.phase === "accumulation") {
          score -= this.config.amdAccumulationPenalty;
          reasons.push("accumulation phase — range still building");
        } else if (amd.phase === "manipulation") {
          reasons.push("manipulation phase — expect a sweep before continuation");
        }
      }

      // ---- Liquidity sweep ----------------------------------
      //  A sweep in the trade direction is the manipulation leg
      //  completing. A sweep against it means the market just took
      //  the stops on the side this signal is betting on.
      const sweeps = f.sweeps || [];
      let sweep = null;
      for (let s = 0; s < sweeps.length; s++) {
        if (sweeps[s].barsAgo <= this.config.sweepReclaimBars) { sweep = sweeps[s]; break; }
      }

      if (sweep) {
        const sweepAgrees = (bias === "bullish" && sweep.direction === "bullish") ||
                            (bias === "bearish" && sweep.direction === "bearish");
        if (sweepAgrees) {
          score += this.config.sweepBonus;
          reasons.push("swept " + sweep.side + " liquidity at " + sweep.poolPrice.toFixed(2) +
                       " (" + sweep.penetrationAtr + "x ATR) and reclaimed");
        } else {
          score -= this.config.sweepAgainstPenalty;
          reasons.push("liquidity swept against this direction at " + sweep.poolPrice.toFixed(2));
        }
      }

      // ---- ERL / IRL target ---------------------------------
      //  A trade with external liquidity ahead of it has room to run.
      //  One boxed in by internal liquidity is a scalp at best.
      const liq = f.liquidity || { erl: [], irl: [], range: null };
      let targetKind = null;
      let targetPool = null;

      if (liq.range) {
        const ahead = bias === "bullish"
          ? liq.erl.filter(function (q) { return q.price > p; })
          : liq.erl.filter(function (q) { return q.price < p; });

        if (ahead.length) {
          targetKind = "ERL";
          targetPool = ahead[0];
          score += this.config.erlTargetBonus;
          reasons.push("external liquidity ahead at " + targetPool.price.toFixed(2) +
                       " (" + targetPool.distanceAtr + "x ATR)");
        } else {
          const inner = bias === "bullish"
            ? liq.irl.filter(function (q) { return q.price > p; })
            : liq.irl.filter(function (q) { return q.price < p; });

          if (inner.length) {
            targetKind = "IRL";
            targetPool = inner[0];
            score += this.config.irlTargetBonus;
            reasons.push("internal liquidity ahead at " + targetPool.price.toFixed(2));
          }
        }
      }

      // ---- Market maker model -------------------------------
      //  The full accumulation / manipulation / distribution
      //  sequence. This is the largest single bonus in the stack
      //  because it is the only read that confirms all three legs.
      const mmbm = f.mmbm || null;
      if (mmbm && mmbm.present) {
        const mmbmAgrees = (bias === "bullish" && mmbm.direction === "bullish") ||
                           (bias === "bearish" && mmbm.direction === "bearish");
        if (mmbmAgrees) {
          const scaled = Math.round(this.config.mmbmBonus * (mmbm.confidence / 100));
          score += scaled;
          reasons.push(mmbm.model + " confirmed (" + mmbm.confidence + "% clean) — " + mmbm.notes);
        } else {
          score -= this.config.mmbmAgainstPenalty;
          reasons.push(mmbm.model + " points the other way — " + mmbm.notes);
        }
      }

      // Momentum confirmation on this timeframe's own last bars.
      if (f.candles.length >= 3) {
        const n = f.candles.length;
        const a = f.candles[n - 3].close;
        const b = f.candles[n - 1].close;
        const rising = b > a;
        if ((bias === "bullish" && rising) || (bias === "bearish" && !rising)) {
          score += 6;
          reasons.push(tf + " momentum confirms");
        } else {
          score -= 6;
          reasons.push(tf + " momentum diverges");
        }
      }

      score = Math.max(0, Math.min(100, Math.round(score)));

      return {
        tf: tf,
        action: this.actionFor(bias, score),
        bias: bias,
        score: score,
        confidence: score / 100,
        zone: {
          kind: z.kind,
          zoneType: z.zoneType,
          tf: z.tf,
          top: z.top,
          bottom: z.bottom,
          mid: z.mid,
          touches: z.touches,
          broken: z.broken,
          // Institutional metadata, carried through so a panel can show
          // why the read is what it is.
          displacement: z.displacement,
          confirmations: z.confirmations,
          volumeConfirmed: z.volumeConfirmed,
          mitigated: z.mitigated,
          mitigation: z.mitigation,
          gapAtr: z.gapAtr,
          filled: z.filled,
          spent: z.spent,
          flippedFrom: z.flippedFrom,
        },
        zoneType: z.zoneType,
        smcRank: smcRank(z),
        smc: {
          families: stack.families,
          stacked: stack.stacked,
          net: stack.net,
          weight: stack.weight,
          orderBlocks: stack.orderBlocks.length,
          fairValueGaps: stack.fairValueGaps.length,
          breakers: stack.breakers.length,
          pivots: stack.pivots.length,
        },
        distance: round2(primary.distance),
        inside: primary.inside,
        atr: round2(tfAtr),
        session: amd,
        sweep: sweep,
        liquidity: {
          targetKind: targetKind,
          target: targetPool,
          erl: liq.erl.length,
          irl: liq.irl.length,
          range: liq.range,
        },
        mmbm: mmbm,
        reasons: reasons,
      };
    }

    // ---- Central bank macro read ---------------------------
    //  Folds the static central-bank table into a single directional
    //  read. Each bank votes with its `goldBias`, weighted by `impact`,
    //  so the Fed's stance carries more than the BoE's.
    //
    //  Returns { bias, score, weight, banks: [...] } where `score` is
    //  the net weighted tilt in the range -1..1.
    macroBias() {
      let net = 0;
      let gross = 0;
      const banks = [];

      for (let i = 0; i < CB_ORDER.length; i++) {
        const key = CB_ORDER[i];
        const cb = centralBanks[key];
        if (!cb) continue;

        const sign = cb.goldBias === "bullish" ? 1
                   : cb.goldBias === "bearish" ? -1
                   : 0;
        const w = isNum(cb.impact) ? cb.impact : 0;

        net += sign * w;
        gross += w;

        banks.push({
          key: key,
          name: cb.name,
          currency: cb.currency,
          policyRate: cb.policyRate,
          stance: cb.stance,
          goldBias: cb.goldBias,
          impact: w,
          contribution: round2(sign * w),
        });
      }

      const score = gross > 0 ? net / gross : 0;
      let bias = "neutral";
      if (score > 0.15) bias = "bullish";
      else if (score < -0.15) bias = "bearish";

      return {
        bias: bias,
        score: round2(score),
        weight: round2(gross),
        banks: banks,
      };
    }

    // Raw table access, keyed by bank. Returns a copy so callers cannot
    // mutate the module-level constant.
    centralBanks() {
      const out = {};
      for (let i = 0; i < CB_ORDER.length; i++) {
        const key = CB_ORDER[i];
        if (centralBanks[key]) out[key] = Object.assign({}, centralBanks[key]);
      }
      return out;
    }

    // ---- Live evaluation -----------------------------------
    // The core method: score a live price against every zone the
    // multi-timeframe structure has produced.
    //
    // Returns a signal object:
    //   {
    //     price, ts, action, bias, score, confidence,
    //     zone, zoneType, confluence: [...], signals: [...],
    //     levels, reasons: [...], atr: {...}
    //   }
    evaluate(price, ts) {
      const p = Number(price);
      const now = isNum(Number(ts)) ? Number(ts) : Date.now();
      if (!isNum(p) || p <= 0) {
        return { price: p, ts: now, action: "HOLD", bias: "none", score: 0,
                 confidence: 0, zone: null, zoneType: null, confluence: [],
                 signals: [], levels: null, reasons: ["invalid price"], atr: {},
                 smcRank: 0, smc: emptySmc(), macro: this.macroBias(),
                 session: amdPhaseAt(now, this.config), sweep: null,
                 liquidity: { targetKind: null, target: null, erl: 0, irl: 0, range: null },
                 mmbm: null };
      }

      this.lastPrice = p;
      this.evalCount++;

      const tfs = this.timeframes();
      const atrByTf = {};
      for (let i = 0; i < tfs.length; i++) {
        const f = this.frames[tfs[i]];
        if (f.dirty) this.rebuildZones(tfs[i]);
        atrByTf[tfs[i]] = f.atr;
      }

      // Per-timeframe signals — one structured read per timeframe, each
      // carrying its own action. This is the multi-timeframe breakdown.
      const signals = [];
      for (let i = 0; i < tfs.length; i++) {
        signals.push(this.evaluateTimeframe(tfs[i], p, now));
      }

      const proximity = this.config.proximityAtr;
      const hits = [];

      for (let i = 0; i < tfs.length; i++) {
        const tf = tfs[i];
        const zones = this.zonesFor(tf);
        const tfAtr = atrByTf[tf];
        for (let j = 0; j < zones.length; j++) {
          const z = zones[j];
          const dist = this.distanceInAtr(p, z, tfAtr);
          if (dist <= proximity) {
            hits.push({ zone: z, tf: tf, distance: dist, inside: dist === 0 });
          }
        }
      }

      if (!hits.length) {
        // No zone is within reach, but the institutional structure still
        // exists — report it so a panel or overlay can show the shelf
        // price is drifting toward rather than a bare "nothing here".
        const flatZones = [];
        for (let i = 0; i < tfs.length; i++) {
          const zs = this.zonesFor(tfs[i]);
          for (let j = 0; j < zs.length; j++) flatZones.push(zs[j]);
        }
        const flatStack = smcConfluence(flatZones, p, atrByTf[tfs[0]], {
          proximityAtr: proximity,
        });
        const result = {
          price: round2(p), ts: now, action: "HOLD", bias: "none", score: 0,
          confidence: 0, zone: null, zoneType: null, confluence: [],
          signals: signals, levels: null,
          reasons: ["price is between structures"], atr: atrByTf,
          smcRank: 0,
          smc: {
            families: flatStack.families,
            stacked: flatStack.stacked,
            net: flatStack.net,
            weight: flatStack.weight,
            orderBlocks: flatStack.orderBlocks.length,
            fairValueGaps: flatStack.fairValueGaps.length,
            breakers: flatStack.breakers.length,
            pivots: flatStack.pivots.length,
          },
          // The macro block is structural, not price-dependent — carry it
          // on the flat path too so the panel and the action card always
          // read the same central-bank state.
          macro: this.macroBias(),
          // Session phase and the market maker model are clock- and
          // structure-derived, not price-dependent, so they survive the
          // flat path as well. The sweep and liquidity target are
          // price-relative and stay null here.
          session: amdPhaseAt(now, this.config),
          sweep: null,
          liquidity: { targetKind: null, target: null, erl: 0, irl: 0, range: null },
          mmbm: null,
        };
        this.lastEval = result;
        return result;
      }

      // Nearest hit wins the headline; the rest become confluence. Ties
      // break toward the heavier timeframe, then toward the stronger
      // institutional family.
      hits.sort(function (a, b) {
        if (a.distance !== b.distance) return a.distance - b.distance;
        const wa = TF_WEIGHT[a.tf] || 1;
        const wb = TF_WEIGHT[b.tf] || 1;
        if (wa !== wb) return wb - wa;
        return smcRank(b.zone) - smcRank(a.zone);
      });

      const primary = hits[0];
      const reasons = [];

      // Base score: how close, and how heavy the timeframe.
      const closeness = Math.max(0, 1 - primary.distance / proximity);
      let score = 30 + closeness * 30;
      reasons.push(
        "price " + (primary.inside ? "inside" : "approaching") +
        " " + primary.tf + " " + primary.zone.zoneType +
        " (" + primary.zone.kind + ") " +
        primary.zone.bottom.toFixed(2) + "-" + primary.zone.top.toFixed(2)
      );

      // Timeframe weight.
      const w = TF_WEIGHT[primary.tf] || 1;
      score += w * 5;
      if (w >= 3) reasons.push(primary.tf + " is a higher-timeframe structure");

      // ---- Institutional zone premium ----------------------
      // Mirrors the per-timeframe premium so the headline read is driven
      // by the same institutional logic the breakdown uses.
      const pz = primary.zone;
      if (pz.zoneType === "orderBlock") {
        const conf = isNum(pz.confirmations) ? pz.confirmations : 1;
        score += 10 + conf * 3;
        reasons.push("order block with " + pz.displacement + "x ATR displacement" +
                     " (" + conf + "/3 confirmations)");
        if (pz.volumeConfirmed) reasons.push("displacement carried above-average volume");
        if (pz.mitigated) {
          score -= 8;
          reasons.push("order block is " + Math.round((pz.mitigation || 0) * 100) + "% mitigated");
        } else {
          score += 6;
          reasons.push("order block is unmitigated");
        }
      } else if (pz.zoneType === "fairValueGap") {
        score += 9;
        reasons.push("fair value gap of " + pz.gapAtr + "x ATR");
        if (pz.spent) {
          score -= 10;
          reasons.push("gap is " + Math.round((pz.filled || 0) * 100) + "% rebalanced");
        } else {
          score += 7;
          reasons.push("gap is " + Math.round((1 - (pz.filled || 0)) * 100) + "% unfilled");
        }
      } else if (pz.zoneType === "breakerBlock") {
        score += 14;
        reasons.push("breaker block — failed " + pz.flippedFrom + " flipped to " + pz.kind);
      }

      // ---- Cross-timeframe SMC stack -----------------------
      // The aggregate read gets the same family-stacking promotion the
      // per-timeframe read does, but computed across every timeframe at
      // once. This is the strongest institutional signal the engine
      // produces: an order block on 4h sitting inside a 1D fair value
      // gap is a shelf, not a level.
      const allZones = [];
      for (let i = 0; i < tfs.length; i++) {
        const zs = this.zonesFor(tfs[i]);
        for (let j = 0; j < zs.length; j++) allZones.push(zs[j]);
      }
      const stack = smcConfluence(allZones, p, atrByTf[primary.tf], {
        proximityAtr: proximity,
      });
      if (stack.families >= 2) {
        const bonus = Math.min(
          this.config.smcStackCap,
          (stack.families - 1) * this.config.smcConfluenceBonus
        );
        const stackAgrees = (pz.kind === "demand" && stack.net > 0) ||
                            (pz.kind === "supply" && stack.net < 0);
        if (stackAgrees) {
          score += bonus;
          reasons.push(stack.families + " institutional families stacked across timeframes");
        } else {
          score -= Math.round(bonus / 2);
          reasons.push("institutional stack opposes the primary zone");
        }
      }

      // Confluence: independent timeframes agreeing on the same side.
      const confluence = [];
      const sameSide = {};
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (h.zone.kind !== primary.zone.kind) continue;
        if (sameSide[h.tf]) continue;
        sameSide[h.tf] = true;
        confluence.push({ tf: h.tf, kind: h.zone.kind, zoneType: h.zone.zoneType,
                          mid: h.zone.mid, distance: round2(h.distance) });
      }
      const extraTfs = confluence.length - 1;
      if (extraTfs > 0) {
        score += extraTfs * 8;
        reasons.push(extraTfs + " additional timeframe(s) agree");
      }

      // Freshness: an untested zone holds; a heavily tested one leaks.
      const touches = primary.zone.touches || 1;
      if (touches === 1) {
        score += 8;
        reasons.push("zone is untested");
      } else if (touches >= 4) {
        score -= 10;
        reasons.push("zone has been tested " + touches + " times");
      }

      // Broken structure flips the read: a broken supply band that price
      // is now holding above is support, not resistance.
      let bias;
      if (primary.zone.kind === "supply") {
        bias = primary.zone.broken ? "bullish" : "bearish";
        if (primary.zone.broken) reasons.push("supply broken — acting as support");
      } else {
        bias = primary.zone.broken ? "bearish" : "bullish";
        if (primary.zone.broken) reasons.push("demand broken — acting as resistance");
      }

      // ---- Session phase (Power of Three) -------------------
      //  The aggregate read is gated on the clock exactly like the
      //  per-timeframe read, so a headline BUY during the Asian
      //  accumulation range cannot outrank a London distribution leg.
      const amd = amdPhaseAt(now, this.config);
      if (amd.phase === "off") {
        score -= this.config.deadZonePenalty;
        reasons.push("off-session — no active killzone");
      } else {
        score += this.config.sessionBonus;
        reasons.push(amd.sessionLabel + " session, " + amd.phase + " phase");

        if (amd.killzone) {
          score += this.config.killzoneBonus;
          reasons.push(amd.sessionLabel + " killzone is open");
        }

        if (amd.phase === "distribution") {
          score += this.config.amdDistributionBonus;
          reasons.push("distribution phase — displacement leg underway");
        } else if (amd.phase === "accumulation") {
          score -= this.config.amdAccumulationPenalty;
          reasons.push("accumulation phase — range still building");
        } else if (amd.phase === "manipulation") {
          reasons.push("manipulation phase — expect a sweep before continuation");
        }
      }

      // ---- Cross-timeframe liquidity sweep ------------------
      //  The freshest sweep anywhere in the stack is the one that
      //  matters. A sweep on 15m that agrees with a 4h zone is the
      //  manipulation leg completing inside the higher-timeframe
      //  structure, which is the highest-quality entry the model
      //  produces.
      let sweep = null;
      let sweepTf = null;
      for (let i = 0; i < tfs.length; i++) {
        const fr = this.frames[tfs[i]];
        if (!fr || !fr.sweeps || !fr.sweeps.length) continue;
        for (let j = 0; j < fr.sweeps.length; j++) {
          const sw = fr.sweeps[j];
          if (sw.barsAgo > this.config.sweepReclaimBars) continue;
          if (!sweep || sw.barsAgo < sweep.barsAgo) { sweep = sw; sweepTf = tfs[i]; }
        }
      }

      if (sweep) {
        const sweepAgrees = (bias === "bullish" && sweep.direction === "bullish") ||
                            (bias === "bearish" && sweep.direction === "bearish");
        if (sweepAgrees) {
          score += this.config.sweepBonus;
          reasons.push(sweepTf + " swept " + sweep.side + " liquidity at " +
                       sweep.poolPrice.toFixed(2) + " (" + sweep.penetrationAtr + "x ATR) and reclaimed");
        } else {
          score -= this.config.sweepAgainstPenalty;
          reasons.push(sweepTf + " liquidity swept against this direction at " +
                       sweep.poolPrice.toFixed(2));
        }
      }

      // ---- ERL / IRL target ---------------------------------
      //  Read from the primary timeframe's dealing range. A trade
      //  with external liquidity ahead has room; one boxed in by
      //  internal liquidity is a scalp.
      const pf = this.frames[primary.tf];
      const liq = (pf && pf.liquidity) || { erl: [], irl: [], range: null };
      let targetKind = null;
      let targetPool = null;

      if (liq.range) {
        const ahead = bias === "bullish"
          ? liq.erl.filter(function (q) { return q.price > p; })
          : liq.erl.filter(function (q) { return q.price < p; });

        if (ahead.length) {
          targetKind = "ERL";
          targetPool = ahead[0];
          score += this.config.erlTargetBonus;
          reasons.push("external liquidity ahead at " + targetPool.price.toFixed(2) +
                       " (" + targetPool.distanceAtr + "x ATR)");
        } else {
          const inner = bias === "bullish"
            ? liq.irl.filter(function (q) { return q.price > p; })
            : liq.irl.filter(function (q) { return q.price < p; });

          if (inner.length) {
            targetKind = "IRL";
            targetPool = inner[0];
            score += this.config.irlTargetBonus;
            reasons.push("internal liquidity ahead at " + targetPool.price.toFixed(2));
          }
        }
      }

      // ---- Market maker model -------------------------------
      //  The strongest single read in the engine. When the primary
      //  timeframe has a confirmed accumulation / manipulation /
      //  distribution sequence, the headline score is driven by it.
      const mmbm = (pf && pf.mmbm) || null;
      if (mmbm && mmbm.present) {
        const mmbmAgrees = (bias === "bullish" && mmbm.direction === "bullish") ||
                           (bias === "bearish" && mmbm.direction === "bearish");
        if (mmbmAgrees) {
          const scaled = Math.round(this.config.mmbmBonus * (mmbm.confidence / 100));
          score += scaled;
          reasons.push(mmbm.model + " confirmed on " + primary.tf +
                       " (" + mmbm.confidence + "% clean) — " + mmbm.notes);
        } else {
          score -= this.config.mmbmAgainstPenalty;
          reasons.push(mmbm.model + " on " + primary.tf + " points the other way — " + mmbm.notes);
        }
      }

      // Momentum confirmation on the fastest frame.
      const fast = this.frames["1m"];
      if (fast && fast.candles.length >= 3) {
        const n = fast.candles.length;
        const a = fast.candles[n - 3].close;
        const b = fast.candles[n - 1].close;
        const rising = b > a;
        if ((bias === "bullish" && rising) || (bias === "bearish" && !rising)) {
          score += 6;
          reasons.push("1m momentum confirms");
        } else {
          score -= 6;
          reasons.push("1m momentum diverges");
        }
      }

      // Higher-timeframe veto: a BUY against a live 1D supply band is a
      // counter-trend entry, so the aggregate score is docked rather
      // than silently promoted.
      const daily = signals[0];
      if (daily && daily.tf === "1D" && daily.bias !== "none" &&
          daily.bias !== bias && daily.score >= this.config.minActionScore) {
        score -= 12;
        reasons.push("1D structure opposes this direction");
      }

      // Central-bank macro tilt. A structural tailwind adds to the
      // score, a headwind docks it. Capped at +/-8 so the static table
      // can never outvote live price structure.
      const macro = this.macroBias();
      if (macro.bias !== "neutral") {
        const tilt = Math.round(macro.score * 8);
        if ((bias === "bullish" && macro.bias === "bullish") ||
            (bias === "bearish" && macro.bias === "bearish")) {
          score += Math.abs(tilt);
          reasons.push("central-bank stance supports " + bias + " (" + macro.bias + ")");
        } else {
          score -= Math.abs(tilt);
          reasons.push("central-bank stance opposes " + bias + " (" + macro.bias + ")");
        }
      }

      score = Math.max(0, Math.min(100, Math.round(score)));

      const action = this.actionFor(bias, score);
      const zoneOut = {
        kind: primary.zone.kind,
        zoneType: primary.zone.zoneType,
        tf: primary.zone.tf,
        top: primary.zone.top,
        bottom: primary.zone.bottom,
        mid: primary.zone.mid,
        touches: primary.zone.touches,
        broken: primary.zone.broken,
        displacement: primary.zone.displacement,
        confirmations: primary.zone.confirmations,
        volumeConfirmed: primary.zone.volumeConfirmed,
        mitigated: primary.zone.mitigated,
        mitigation: primary.zone.mitigation,
        gapAtr: primary.zone.gapAtr,
        filled: primary.zone.filled,
        spent: primary.zone.spent,
        flippedFrom: primary.zone.flippedFrom,
      };

      const result = {
        price: round2(p),
        ts: now,
        action: action,
        bias: score >= this.config.minScore ? bias : "none",
        score: score,
        confidence: score / 100,
        zone: zoneOut,
        zoneType: primary.zone.zoneType,
        smcRank: smcRank(primary.zone),
        smc: {
          families: stack.families,
          stacked: stack.stacked,
          net: stack.net,
          weight: stack.weight,
          orderBlocks: stack.orderBlocks.length,
          fairValueGaps: stack.fairValueGaps.length,
          breakers: stack.breakers.length,
          pivots: stack.pivots.length,
        },
        confluence: confluence,
        signals: signals,
        levels: this.levelsFor(action, zoneOut, atrByTf[primary.tf]),
        reasons: reasons,
        atr: atrByTf,
        macro: macro,
        session: amd,
        sweep: sweep,
        liquidity: {
          targetKind: targetKind,
          target: targetPool,
          erl: liq.erl.length,
          irl: liq.irl.length,
          range: liq.range,
        },
        mmbm: mmbm,
      };

      this.lastEval = result;
      return result;
    }

    // ---- Multi-timeframe sweep -----------------------------
    // Explicit alias for the aggregate read, named for what it does so
    // callers wiring a live tick handler have an obvious entry point.
    evaluateAll(price, ts) {
      return this.evaluate(price, ts);
    }

    // ---- Action summary ------------------------------------
    // Tallies the per-timeframe actions into a single consensus line,
    // e.g. { BUY: 2, SELL: 1, HOLD: 1, consensus: "BUY" }. Useful for a
    // status card that shows agreement across the four timeframes.
    summarize(price, ts) {
      const result = this.evaluate(price, ts);
      const tally = { BUY: 0, SELL: 0, HOLD: 0 };
      for (let i = 0; i < result.signals.length; i++) {
        const a = result.signals[i].action;
        if (tally[a] === undefined) tally[a] = 0;
        tally[a]++;
      }
      let consensus = "HOLD";
      if (tally.BUY > tally.SELL && tally.BUY > tally.HOLD) consensus = "BUY";
      else if (tally.SELL > tally.BUY && tally.SELL > tally.HOLD) consensus = "SELL";
      return {
        price: result.price,
        ts: result.ts,
        action: result.action,
        consensus: consensus,
        tally: tally,
        signals: result.signals,
        levels: result.levels,
      };
    }

    // ---- Snapshot ------------------------------------------
    // Compact view of the current multi-timeframe structure, suitable
    // for a status card or a debug dump.
    snapshot() {
      const tfs = this.timeframes();
      const out = { price: this.lastPrice, frames: {}, zones: [] };
      for (let i = 0; i < tfs.length; i++) {
        const tf = tfs[i];
        const f = this.frames[tf];
        const zs = this.zonesFor(tf);
        let supply = 0;
        let demand = 0;
        let orderBlocks = 0;
        let fairValueGaps = 0;
        let breakers = 0;
        for (let j = 0; j < zs.length; j++) {
          if (zs[j].kind === "supply") supply++;
          else demand++;
          const t = zs[j].zoneType;
          if (t === "orderBlock") orderBlocks++;
          else if (t === "fairValueGap") fairValueGaps++;
          else if (t === "breakerBlock") breakers++;
        }
        out.frames[tf] = {
          candles: f.candles.length,
          atr: round2(f.atr),
          lastClose: f.lastClose,
          zones: zs.length,
          supply: supply,
          demand: demand,
          orderBlocks: orderBlocks,
          fairValueGaps: fairValueGaps,
          breakers: breakers,
          pools: f.pools ? f.pools.length : 0,
          erl: f.liquidity ? f.liquidity.erl.length : 0,
          irl: f.liquidity ? f.liquidity.irl.length : 0,
          sweeps: f.sweeps ? f.sweeps.length : 0,
          model: f.mmbm && f.mmbm.present ? f.mmbm.model : null,
          range: f.liquidity ? f.liquidity.range : null,
        };
        for (let k = 0; k < zs.length; k++) out.zones.push(zs[k]);
      }
      out.session = amdPhaseAt(Date.now(), this.config);
      return out;
    }

    reset() {
      const tfs = this.timeframes();
      for (let i = 0; i < tfs.length; i++) {
        const f = this.frames[tfs[i]];
        f.candles = [];
        f.zones = [];
        f.atr = 0;
        f.lastBucket = null;
        f.lastClose = null;
        f.dirty = true;
        f.pools = [];
        f.liquidity = { erl: [], irl: [], range: null };
        f.sweeps = [];
        f.mmbm = null;
      }
      this.lastPrice = null;
      this.lastEval = null;
      this.evalCount = 0;
    }
  }

  // ---- Static surface --------------------------------------
  HamzaSignalEngine.TF_MS = TF_MS;
  HamzaSignalEngine.TF_ORDER = TF_ORDER;
  HamzaSignalEngine.TF_WEIGHT = TF_WEIGHT;
  HamzaSignalEngine.DEFAULTS = DEFAULTS;
  HamzaSignalEngine.centralBanks = centralBanks;
  HamzaSignalEngine.CB_ORDER = CB_ORDER;

  // The institutional families, in conviction order. Exposed so a chart
  // overlay or panel can colour and label them without hard-coding the
  // strings in more than one place.
  HamzaSignalEngine.SMC_FAMILIES = [
    "breakerBlock",
    "orderBlock",
    "fairValueGap",
  ];

  // The three sessions, in the order they open. Exposed so a panel can
  // render the session clock without duplicating the UTC windows.
  HamzaSignalEngine.SESSIONS = SESSION_DEFS;

  // The Power of Three acts, in sequence.
  HamzaSignalEngine.AMD_PHASES = ["accumulation", "manipulation", "distribution"];

  // The two liquidity classes. ERL sits beyond the dealing range
  // extremes, IRL sits inside it.
  HamzaSignalEngine.LIQUIDITY_KINDS = ["ERL", "IRL"];

  HamzaSignalEngine.helpers = {
    toMs: toMs,
    bucketMs: bucketMs,
    isValidCandle: isValidCandle,
    normalizeCandle: normalizeCandle,
    atr: atr,
    ema: ema,
    findPivots: findPivots,
    findOrderBlocks: findOrderBlocks,
    findFairValueGaps: findFairValueGaps,
    findBreakerBlocks: findBreakerBlocks,
    trailingVolumeMean: trailingVolumeMean,
    smcConfluence: smcConfluence,
    smcRank: smcRank,
    emptySmc: emptySmc,
    utcHourOf: utcHourOf,
    sessionAt: sessionAt,
    amdPhaseAt: amdPhaseAt,
    findLiquidityPools: findLiquidityPools,
    classifyLiquidity: classifyLiquidity,
    findLiquiditySweeps: findLiquiditySweeps,
    detectMarketMakerModel: detectMarketMakerModel,
  };

  global.HamzaSignalEngine = HamzaSignalEngine;

  // Node export so the engine can be exercised headless in tests.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = HamzaSignalEngine;
  }
})(typeof window !== "undefined" ? window : globalThis);
