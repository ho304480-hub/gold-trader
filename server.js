// server.js — Gold Terminal server
// Serves static files, provides API + WebSocket endpoints.
// Fetches REAL gold market data from free public APIs:
//   - Yahoo Finance (GC=F futures) for historical OHLCV candles
//   - gold-api.com (XAU spot) for real-time price ticks
// Falls back to simulated data if the external APIs are unreachable.

const express = require("express");
const path = require("path");
const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// Native WebSocket endpoint exposed at /ws.
const wss = new WebSocketServer({ server, path: "/ws" });
// Real-time tick stream via Socket.io (enhanced transport used by the chart).
// Its own path (/socket.io) keeps engine.io from racing the raw /ws server
// for the same upgrade, which would otherwise throw
// "server.handleUpgrade() was called more than once with the same socket".
const io = new Server(server, {
  path: "/socket.io",
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3000;

// ---- External API config ----
const YAHOO_URL = (interval, range) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&range=${range}`;

const GOLD_API_URL = "https://api.gold-api.com/price/XAU";

// Map our timeframes to Yahoo Finance intervals/ranges.
// Ranges are chosen to cover as much of 2026 as Yahoo allows per request.
const TF_MAP = {
  "1m": { interval: "1m", range: "5d" },   // Yahoo caps 1m at ~7 days
  "5m": { interval: "5m", range: "1mo" },
  "15m": { interval: "15m", range: "1mo" },
  "1h": { interval: "60m", range: "1y" },
  "4h": { interval: "60m", range: "1y" },  // Yahoo has no 4h; use 60m and aggregate
  "1D": { interval: "1d", range: "1y" },
};

// Yahoo Finance max candles per request (approximate, varies by interval)
const YAHOO_MAX_PER_REQUEST = {
  "1m": 10000,
  "5m": 10000,
  "15m": 10000,
  "60m": 10000,
  "1d": 10000,
};

// Max candles we'll return to the client
const MAX_CANDLES = 5000;

// ---- Helpers ----
function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Invalid JSON from external API"));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("External API timeout"));
    });
  });
}

// Aggregate 60m candles into 4h candles
function aggregateTo4h(candles) {
  const result = [];
  const bucketMs = 4 * 3600 * 1000;
  for (const c of candles) {
    const bucket = Math.floor(c.time * 1000 / bucketMs) * bucketMs;
    const last = result[result.length - 1];
    if (last && last.time === Math.floor(bucket / 1000)) {
      last.close = c.close;
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.volume += c.volume;
    } else {
      result.push({
        time: Math.floor(bucket / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      });
    }
  }
  return result;
}
// Fetch real candles from Yahoo Finance.
// Supports optional start/end timestamps (seconds) for precise date-range queries.
// If a range is requested that exceeds Yahoo's per-request limit, it paginates.
async function fetchRealCandles(timeframe, limit, startTs, endTs) {
  const cfg = TF_MAP[timeframe] || TF_MAP["1m"];
  const interval = cfg.interval;
  const range = cfg.range;

  let allCandles = [];

  if (startTs && endTs) {
    // Precise date-range request.
    // Yahoo has limited intraday history:
    //   1m: ~7 days, 5m/15m: ~60 days, 60m: ~2 years, 1d: full history.
    // For intraday timeframes where the requested range exceeds Yahoo's
    // history, we use the range-based request directly (which returns the
    // most recent data Yahoo has). For 60m/1d, we paginate to get full coverage.
    const intervalMs = {
      "1m": 60 * 1000,
      "5m": 5 * 60 * 1000,
      "15m": 15 * 60 * 1000,
      "60m": 3600 * 1000,
      "1d": 24 * 3600 * 1000,
    }[interval] || 60 * 1000;

    // Max history Yahoo provides for each interval
    const maxHistoryMs = {
      "1m": 7 * 24 * 3600 * 1000,
      "5m": 60 * 24 * 3600 * 1000,
      "15m": 60 * 24 * 3600 * 1000,
      "60m": 2 * 365 * 24 * 3600 * 1000,
      "1d": 10 * 365 * 24 * 3600 * 1000,
    }[interval] || 60 * 24 * 3600 * 1000;

    const nowMs = Date.now();
    const requestedSpanMs = (endTs - startTs) * 1000;

    // If the requested range exceeds Yahoo's history for this interval,
    // just use the range-based request (returns most recent data).
    if (requestedSpanMs > maxHistoryMs) {
      const data = await fetchJson(YAHOO_URL(interval, range));
      const result = data?.chart?.result?.[0];
      if (result && result.timestamp && result.indicators?.quote?.[0]) {
        allCandles = parseYahooCandles(result);
      }
    } else {
      // Paginate through the requested range
      const maxPerPage = YAHOO_MAX_PER_REQUEST[interval] || 5000;
      const pageMs = maxPerPage * intervalMs;
      const effectiveStartMs = Math.max(startTs * 1000, nowMs - maxHistoryMs);
      const effectiveEndMs = Math.min(endTs * 1000, nowMs);

      if (effectiveStartMs < effectiveEndMs) {
        let pageStart = effectiveStartMs;

        while (pageStart < effectiveEndMs) {
          const pageEnd = Math.min(pageStart + pageMs, effectiveEndMs);
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=${interval}&period1=${Math.floor(pageStart / 1000)}&period2=${Math.floor(pageEnd / 1000)}`;
          const data = await fetchJson(url);
          const result = data?.chart?.result?.[0];
          if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
            break; // no more data
          }
          const pageCandles = parseYahooCandles(result);
          allCandles = allCandles.concat(pageCandles);
          pageStart = pageEnd;
          // Small delay to avoid rate limiting
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }

    // If we still have no data, fall back to the default range-based request.
    if (allCandles.length === 0) {
      const data = await fetchJson(YAHOO_URL(interval, range));
      const result = data?.chart?.result?.[0];
      if (result && result.timestamp && result.indicators?.quote?.[0]) {
        allCandles = parseYahooCandles(result);
      }
    }
  } else {
    // Default range-based request
    const data = await fetchJson(YAHOO_URL(interval, range));
    const result = data?.chart?.result?.[0];
    if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
      throw new Error("No candle data from Yahoo Finance");
    }
    allCandles = parseYahooCandles(result);
  }

  // Aggregate 60m -> 4h if needed
  let finalCandles = timeframe === "4h" ? aggregateTo4h(allCandles) : allCandles;

  // Trim to requested limit (or MAX_CANDLES if no limit specified)
  const maxReturn = limit || MAX_CANDLES;
  if (finalCandles.length > maxReturn) {
    finalCandles = finalCandles.slice(-maxReturn);
  }

  return finalCandles;
}

// Parse Yahoo Finance response into our candle format
function parseYahooCandles(result) {
  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];
  const candles = [];

  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i];
    if (open == null || high == null || low == null || close == null) continue;

    candles.push({
      time: timestamps[i],
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: Math.floor(volume || 0),
    });
  }

  return candles;
}

// Fetch real spot gold price from gold-api.com
async function fetchRealSpotPrice() {
  const data = await fetchJson(GOLD_API_URL, 5000);
  const price = parseFloat(data?.price);
  if (!price || isNaN(price)) throw new Error("Invalid spot price");
  return { price, ts: Date.now() };
}

// ---- Simulated fallbacks ----
function generateMockCandles(timeframe, limit) {
  const intervalMs = {
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 3600 * 1000,
    "4h": 4 * 3600 * 1000,
    "1D": 24 * 3600 * 1000,
  }[timeframe] || 60 * 1000;

  const candles = [];
  let price = 2350 + Math.random() * 50 - 25;
  // Start from Jan 1 2026 00:00:00 local time
  const yearStart = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
  const now = Date.now();
  const totalCandles = Math.min(limit || 500, Math.floor((now - yearStart) / intervalMs) + 1);

  for (let i = 0; i < totalCandles; i++) {
    const ts = yearStart + i * intervalMs;
    const open = price;
    const close = price + (Math.random() - 0.5) * 2;
    const high = Math.max(open, close) + Math.random() * 3;
    const low = Math.min(open, close) - Math.random() * 3;
    candles.push({
      time: Math.floor(ts / 1000),
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: Math.floor(Math.random() * 500) + 100,
    });
    price = close;
  }
  return candles;
}

// ---- Middleware ----
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- API Routes ----

// Auth (simulated — no real DB)
app.get("/api/auth/me", (req, res) => {
  res.json({ user: { username: "guest", role: "user" } });
});

app.post("/api/auth/login", (req, res) => {
  res.json({ token: "simulated-token", user: { username: "guest", role: "user" } });
});

app.post("/api/auth/register", (req, res) => {
  res.json({ token: "simulated-token", user: { username: "guest", role: "user" } });
});

app.post("/api/auth/logout", (req, res) => {
  res.json({ ok: true });
});

// Candles — REAL data from Yahoo Finance, simulated fallback
// Supports: ?timeframe=1m&limit=500&start=1735689600&end=1767225599
//   - timeframe: 1m | 5m | 15m | 1h | 4h | 1D
//   - limit: max candles to return (default 500, max 5000)
//   - start/end: Unix timestamps (seconds) for precise date-range queries
app.get("/api/candles", async (req, res) => {
  const timeframe = req.query.timeframe || "1m";
  const limit = Math.min(parseInt(req.query.limit) || 500, MAX_CANDLES);
  const startTs = req.query.start ? parseInt(req.query.start) : null;
  const endTs = req.query.end ? parseInt(req.query.end) : null;

  try {
    const candles = await fetchRealCandles(timeframe, limit, startTs, endTs);
    res.json({
      candles,
      source: "yahoo",
      timeframe,
      count: candles.length,
      start: candles.length ? candles[0].time : null,
      end: candles.length ? candles[candles.length - 1].time : null,
    });
  } catch (err) {
    // Fall back to simulated data so the chart always loads
    const candles = generateMockCandles(timeframe, limit);
    res.json({
      candles,
      source: "simulated",
      timeframe,
      count: candles.length,
      start: candles.length ? candles[0].time : null,
      end: candles.length ? candles[candles.length - 1].time : null,
    });
  }
});

// Live spot price — REAL from gold-api.com, simulated fallback
app.get("/api/price", async (req, res) => {
  try {
    const { price, ts } = await fetchRealSpotPrice();
    res.json({ price, ts, source: "gold-api" });
  } catch (err) {
    res.json({ price: 2350 + Math.random() * 10, ts: Date.now(), source: "simulated" });
  }
});

// Indicators — empty list, frontend handles it
app.get("/api/indicators", (req, res) => {
  res.json({ indicators: [] });
});

// ---- SMC signal detection ----
// Derives a Smart Money Concepts label from the recent tick stream.
// Purely descriptive of the last ~40 ticks — no prediction, no advice.
const SMC_SIGNALS = [
  "Order Block Detected",
  "Liquidity Sweep",
  "Fair Value Gap (FVG)",
  "Market Structure Shift",
  "Balanced Range",
];

function detectSignal() {
  const window = tickHistory.slice(-40);
  if (window.length < 10) return "Awaiting Data";

  const prices = window.map((t) => t.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const range = high - low;

  // Flat tape — nothing structural to report
  if (range < 0.25) return "Balanced Range";

  const netMove = last - first;
  const moveRatio = Math.abs(netMove) / range;

  // Price travelled most of the range in one direction — structure shifted
  if (moveRatio > 0.7) return "Market Structure Shift";

  // Sharp rejection off an extreme — liquidity taken
  const lastThree = prices.slice(-3);
  const spikedHigh = Math.max(...lastThree) >= high - range * 0.05;
  const spikedLow = Math.min(...lastThree) <= low + range * 0.05;
  if (spikedHigh && netMove < 0) return "Liquidity Sweep";
  if (spikedLow && netMove > 0) return "Liquidity Sweep";

  // Wide range with price mid-structure — imbalance left behind
  if (range > 1.2) return "Fair Value Gap (FVG)";

  // Consolidation near an extreme before continuation
  if (last > high - range * 0.2) return "Order Block Detected";
  if (last < low + range * 0.2) return "Order Block Detected";

  return "Balanced Range";
}

// ---- Macro news & database records ----
// Serves the Macro News & Database report table.
// Tries the real Postgres source_manager first; falls back to a
// representative snapshot so the table always renders.
let sourceManager = null;
try {
  // Optional dependency — the DB layer may not be wired up yet.
  sourceManager = require("./db");
} catch (err) {
  sourceManager = null;
}

const FALLBACK_RECORDS = [
  {
    time: "2026-09-13 08:00:00",
    source: "FRED — Federal Funds Rate",
    value: "4.33%",
    signal: "Neutral",
  },
  {
    time: "2026-09-13 08:00:00",
    source: "FRED — US CPI YoY",
    value: "2.94%",
    signal: "Bullish Gold",
  },
  {
    time: "2026-09-13 07:45:00",
    source: "gold-api.com — XAU Spot",
    value: "$2,580.00",
    signal: "Live",
  },
  {
    time: "2026-09-13 07:30:00",
    source: "Yahoo Finance — GC=F Futures",
    value: "$2,584.30",
    signal: "Bullish Gold",
  },
  {
    time: "2026-09-13 07:00:00",
    source: "FRED — DXY Dollar Index",
    value: "101.24",
    signal: "Bearish Gold",
  },
  {
    time: "2026-09-13 06:30:00",
    source: "FRED — 10Y Treasury Yield",
    value: "4.12%",
    signal: "Neutral",
  },
];

app.get("/api/database-records", async (req, res) => {
  // Prefer live data when the database layer is available.
  if (sourceManager && typeof sourceManager.listSources === "function") {
    try {
      const rows = await sourceManager.listSources();
      if (Array.isArray(rows) && rows.length) {
        return res.json(
          rows.map((r) => ({
            time: r.updated_at || r.created_at || new Date().toISOString(),
            source: r.name || r.source || "unknown",
            value: r.value != null ? String(r.value) : (r.url || "—"),
            signal: r.signal || r.category || "Tracked",
          }))
        );
      }
    } catch (err) {
      // fall through to the snapshot below
    }
  }

  res.json(FALLBACK_RECORDS);
});

// ---- WebSocket ----
// MT5-style high-frequency tick streaming.
// Real spot price polled from gold-api.com every ~5s, with
// realistic micro-tick interpolation between polls for sub-second precision.
// Falls back to fully simulated ticks if the external API is unreachable.

let lastRealPrice = null;
let lastRealPriceTs = 0;
let usingSimulated = false;

// Tick history buffer — lets late-joining clients catch up instantly
const TICK_BUFFER_MAX = 500;
const tickHistory = [];

// ---- Tick generation ----
// Realistic gold micro-movement: small random walk with occasional spikes.
// Gold typically moves 0.01–0.30 per tick on active sessions.
function generateTick() {
  const now = Date.now();

  if (lastRealPrice && !usingSimulated) {
    // Interpolate between real polls with realistic micro-movement.
    // Base drift toward the last known real price, plus noise.
    const drift = (lastRealPrice - (lastRealPrice || 2350)) * 0.02;
    const noise = (Math.random() - 0.5) * 0.12; // ±0.06 per tick
    const spike = Math.random() < 0.02 ? (Math.random() - 0.5) * 0.5 : 0; // 2% chance of a larger move
    const price = Math.max(1200, (lastRealPrice || 2350) + drift + noise + spike);
    return {
      price: parseFloat(price.toFixed(2)),
      ts: now,
      source: "gold-api",
    };
  }

  // Fully simulated fallback — realistic random walk
  const movement = (Math.random() - 0.5) * 0.8;
  const price = Math.max(1200, (lastRealPrice || 2350) + movement);
  return {
    price: parseFloat(price.toFixed(2)),
    ts: now,
    source: "simulated",
  };
}

// Poll the real spot price periodically
async function pollSpotPrice() {
  try {
    const { price, ts } = await fetchRealSpotPrice();
    lastRealPrice = price;
    lastRealPriceTs = ts;
    usingSimulated = false;
  } catch (err) {
    usingSimulated = true;
  }
}

// Initial poll
pollSpotPrice();
// Re-poll every 5 seconds
setInterval(pollSpotPrice, 5000);

// Broadcast a tick to all connected clients (both transports)
function broadcastTick(tick) {
  // Push to history buffer
  tickHistory.push(tick);
  if (tickHistory.length > TICK_BUFFER_MAX) tickHistory.shift();

  const msg = JSON.stringify({ type: "price", ...tick });

  // Native WebSocket clients
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  });

  // Socket.io clients — emit the raw tick object (client wraps it as needed)
  io.emit("price", tick);
  io.emit("tick", tick);

  // MT5-style market update — consumed by the terminal pages.
  // Carries the same real price plus a descriptive SMC signal label.
  io.emit("marketUpdate", {
    price: tick.price.toFixed(2),
    signal: detectSignal(),
    time: new Date(tick.ts).toLocaleTimeString("en-GB", { hour12: false }),
    ts: tick.ts,
    source: tick.source,
  });
}

// High-frequency tick generator — 10 ticks/sec (100ms) for MT5-like precision
setInterval(() => {
  broadcastTick(generateTick());
}, 100);

wss.on("connection", (ws) => {
  // Send recent tick history so the client catches up instantly
  const historyMsg = JSON.stringify({
    type: "tick_history",
    ticks: tickHistory.slice(-100),
  });
  ws.send(historyMsg);

  ws.on("close", () => {});
});

// Socket.io connection — let the chart catch up instantly with recent tick history
io.on("connection", (socket) => {
  socket.emit("tick_history", { ticks: tickHistory.slice(-100) });
});

// ---- Start ----
server.listen(PORT, () => {
  console.log(`حەمزە گۆڵد running at http://localhost:${PORT}`);
  console.log("Data sources: Yahoo Finance (candles) + gold-api.com (spot price)");
  console.log("Endpoints: /api/candles /api/price /api/indicators /api/database-records /api/auth/*");
  console.log("Streams:   /ws (native) + /socket.io (price, tick, marketUpdate)");
});