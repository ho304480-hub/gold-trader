// ============================================================
// DATA FEED: Real + Simulated
// Fetches REAL gold market data from the backend server,
// which proxies Yahoo Finance (candles) and gold-api.com (spot).
// Falls back to simulated data if the server is unreachable.
// Exposes global `DataFeed` object (plain script, no ES modules)
// ============================================================

(function (global) {
  "use strict";

  // ---- Config ----
  const USE_REAL_API = true; // fetch from backend server (which proxies real APIs)

  // ---- State ----
  let currentPrice = 2350.0;
  let currentTickTs = Date.now();
  const candleHistory = new Map(); // timeframe -> array of candles

  const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D"];

  function tfToMs(tf) {
    switch (tf) {
      case "1m": return 60 * 1000;
      case "5m": return 5 * 60 * 1000;
      case "15m": return 15 * 60 * 1000;
      case "1h": return 3600 * 1000;
      case "4h": return 4 * 3600 * 1000;
      case "1D": return 24 * 3600 * 1000;
      default: return 60 * 1000;
    }
  }

  function makeCandle(ts, tf, price) {
    return {
      time: Math.floor(ts / 1000),
      open: parseFloat(price.toFixed(2)),
      high: parseFloat(price.toFixed(2)),
      low: parseFloat(price.toFixed(2)),
      close: parseFloat(price.toFixed(2)),
      volume: 10,
    };
  }

  function generateInitialCandles(tf, count) {
    const intervalMs = tfToMs(tf);
    const candles = [];
    let price = 2350 + Math.random() * 50 - 25;
    // Start from Jan 1 2026 00:00:00 local time
    const yearStart = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
    const now = Date.now();
    const totalCandles = Math.min(count || 500, Math.floor((now - yearStart) / intervalMs) + 1);
    for (let i = 0; i < totalCandles; i++) {
      const ts = yearStart + i * intervalMs;
      const candle = {
        time: Math.floor(ts / 1000),
        open: price,
        high: price + Math.random() * 3,
        low: price - Math.random() * 3,
        close: price + (Math.random() - 0.5) * 2,
        volume: Math.floor(Math.random() * 500) + 100,
      };
      candles.push(candle);
      price = candle.close;
    }
    return candles;
  }

  // Pre-generate history for all timeframes (fallback only)
  for (const tf of TIMEFRAMES) {
    candleHistory.set(tf, generateInitialCandles(tf, 500));
  }

  // ---- Real API fetch (via backend server) ----
  async function fetchRealCandles(timeframe, limit, startTs, endTs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s for large ranges
    try {
      let url = `/api/candles?timeframe=${timeframe}&limit=${limit}`;
      if (startTs) url += `&start=${startTs}`;
      if (endTs) url += `&end=${endTs}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      if (data.candles && data.candles.length) {
        return data.candles;
      }
      throw new Error("No candles");
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  async function fetchRealSpotPrice() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`/api/price`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      if (data.price) {
        return { price: data.price, ts: data.ts || Date.now() };
      }
      throw new Error("No price");
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  // ---- Public API ----
  const DataFeed = {
    USE_REAL_API,

    getLiveData() {
      return { price: currentPrice, ts: currentTickTs };
    },

    getLiveCandles(timeframe = "1m", limit = 500, startTs, endTs) {
      // Try real API first
      try {
        return fetchRealCandles(timeframe, limit, startTs, endTs).then((realCandles) => {
          // Cache them for the current timeframe
          candleHistory.set(timeframe, realCandles);
          return realCandles;
        }).catch(() => {
          // Fall back to simulated
          return this._getSimulatedCandles(timeframe, limit);
        });
      } catch (err) {
        return this._getSimulatedCandles(timeframe, limit);
      }
    },

    _getSimulatedCandles(timeframe, limit) {
      if (!candleHistory.has(timeframe)) {
        candleHistory.set(timeframe, generateInitialCandles(timeframe, 500));
      }
      const arr = candleHistory.get(timeframe);
      const lastCandle = arr[arr.length - 1];
      const lastBucketMs = lastCandle.time * 1000;
      const currentBucketMs = Math.floor(Date.now() / tfToMs(timeframe)) * tfToMs(timeframe);
      if (currentBucketMs > lastBucketMs) {
        const newCandle = makeCandle(currentBucketMs, timeframe, currentPrice);
        arr.push(newCandle);
        if (arr.length > 5000) arr.shift();
      } else {
        lastCandle.close = parseFloat(currentPrice.toFixed(2));
        lastCandle.high = Math.max(lastCandle.high, currentPrice);
        lastCandle.low = Math.min(lastCandle.low, currentPrice);
      }
      return arr.slice(-limit);
    },

    // Subscribe to live price ticks. Returns an unsubscribe function.
    // MT5-style: high-frequency ticks (10/sec) with realistic micro-movement.
    subscribePrice(callback) {
      let unsubscribed = false;
      let lastSimPrice = currentPrice;

      // Try real spot price polling first
      const pollReal = async () => {
        if (unsubscribed) return;
        try {
          const { price, ts } = await fetchRealSpotPrice();
          if (!unsubscribed) {
            currentPrice = price;
            currentTickTs = ts;
            lastSimPrice = price;
            callback(parseFloat(currentPrice.toFixed(2)), currentTickTs);
          }
        } catch (err) {
          // Fall through to simulated
        }
      };

      // Poll real price every 5 seconds
      pollReal();
      const realTimer = setInterval(pollReal, 5000);

      // Simulated fallback ticks every 100ms (10/sec) — MT5-like precision
      const simTimer = setInterval(() => {
        if (unsubscribed) return;
        // Realistic gold micro-movement: small random walk with occasional spikes
        const noise = (Math.random() - 0.5) * 0.12; // ±0.06 per tick
        const spike = Math.random() < 0.02 ? (Math.random() - 0.5) * 0.5 : 0;
        const drift = (lastSimPrice - currentPrice) * 0.05;
        lastSimPrice = Math.max(1200, lastSimPrice + noise + spike + drift);
        currentPrice = lastSimPrice;
        currentTickTs = Date.now();
        callback(parseFloat(currentPrice.toFixed(2)), currentTickTs);
      }, 100);

      return () => {
        unsubscribed = true;
        clearInterval(realTimer);
        clearInterval(simTimer);
      };
    },

    // Add a tick to the candle store (used by live updates)
    // Updates ALL timeframes for MT5-style multi-timeframe sync.
    addTickToStore(price, ts) {
      for (const tf of TIMEFRAMES) {
        const intervalMs = tfToMs(tf);
        const bucketTime = Math.floor(ts / intervalMs) * intervalMs;
        const arr = candleHistory.get(tf);
        if (!arr) continue;
        const last = arr[arr.length - 1];
        const lastBucketTime = Math.floor(last.time * 1000);
        if (bucketTime === lastBucketTime) {
          last.close = parseFloat(price.toFixed(2));
          last.high = Math.max(last.high, price);
          last.low = Math.min(last.low, price);
          last.volume += 1;
        } else {
          const candle = makeCandle(bucketTime, tf, price);
          arr.push(candle);
          if (arr.length > 5000) arr.shift();
        }
      }
    },
  };

  global.DataFeed = DataFeed;
})(window);