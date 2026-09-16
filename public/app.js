// app.js — main dashboard controller

const state = {
  user: null,
  currentTimeframe: "1m",
  currentChartType: "candles",
  currentIndicators: [],
  liveChart: chart.init(),
  candles: [],
  ws: null,
  allIndicators: [],
  activeIndex: null,
  editorMode: "new", // 'new' | 'edit'
  // Performance state
  _indicatorCache: new Map(),   // id -> { result, candleCount }
  _wsBuffer: [],                // pending price ticks
  _wsFlushTimer: null,
  _wsFlushPending: false,
  _resizeTimer: null,
  _lastPriceEl: null,
  _lastPriceChangeEl: null,
  _feedUnsub: null,           // DataFeed subscription cleanup
  _rawWsStarted: false,       // whether the native WebSocket fallback is active
  // MT5-style smooth tick rendering
  _smoothPrice: null,         // current interpolated price (for smooth transitions)
  _smoothTarget: null,        // target price we're animating toward
  _smoothActive: false,       // whether an interpolation is in progress
  _smoothStart: 0,            // start price of current interpolation
  _smoothStartTs: 0,          // timestamp when interpolation started
  _smoothDuration: 120,       // ms to animate each tick transition
  _smoothRaf: null,           // requestAnimationFrame handle for smooth ticks
  _atLatestCandle: true,      // whether the view is pinned to the latest candle
  _lastIndicatorRun: 0,       // timestamp of last indicator recompute
  // AI Anomaly Detection state
  _anomalyTicks: [],          // rolling window of recent ticks for analysis
  _anomalyAlerts: [],         // active anomaly alerts
  _anomalyLastAlertTs: 0,     // timestamp of last alert to prevent spam
};

// ============================================================
// Debounce / throttle helpers
// ============================================================
function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

function throttle(fn, limit) {
  let inThrottle = false;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

// ============================================================
// Init
// ============================================================
async function init() {
  // Cache DOM refs early so they're available even if auth fails
  state._lastPriceEl = document.getElementById("livePrice");
  state._lastPriceChangeEl = document.getElementById("priceChange");

  // Non-blocking auth check — if backend is unavailable, continue with
  // a default user so the dashboard still loads (simulated mode).
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000); // 2s max wait
    const res = await fetch("/api/auth/me", { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      state.user = data.user;
      if (state.user.role === "admin") {
        document.getElementById("logoutBtn").insertAdjacentHTML("afterend", `<a href="admin.html" class="btn-ghost">Admin</a>`);
      }
    }
  } catch (err) {
    // No backend — use simulated mode
    state.user = { username: "guest", role: "user" };
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);

  bindEvents();
  initSettings();
  initQuickNotes();
  initSessionsClock();
  initNewsTicker();
  initWidgetDock();
  initIndicatorBoard();
  IndicatorMenu.init();
  AnalyticsWidgets.init();
  initMarketDepthWidget();
  AnomalyDetector.initWidget();
  initAnalyticsNewsWidget();
  initAnalyticsTechnicalWidget();
  AITradingSystem.initWidget();
  PipsAlertSystem.init();
  VoiceCommand.init();

  // Load data in parallel — none block the UI
  loadCandles();
  loadIndicators();
  bindWebSocket();

  // MT5-style: track whether the user is at the latest candle.
  // When they scroll back to look at history, stop auto-scrolling.
  // When they scroll back to the right edge, resume auto-scroll.
  try {
    chart.onVisibleRangeChange((range) => {
      if (!range || !range.to) return;
      const lastCandleTime = state.candles.length
        ? state.candles[state.candles.length - 1].time
        : 0;
      // If the visible range's right edge is within ~5 candles of the latest,
      // treat the user as "at the latest candle".
      const candleMs = 60 * 1000; // 1m timeframe
      state._atLatestCandle = range.to >= lastCandleTime - 5 * candleMs / 1000;
    });
  } catch (err) {
    // Chart may not expose this API in older versions — default to always-scroll
    state._atLatestCandle = true;
  }

  // Debounced resize
  window.addEventListener("resize", debounce(() => chart.resize(), 150));

  // Initial resize to ensure the chart fills its container
  chart.resize();
}

async function loadCandles() {
  // Show loading state
  showChartLoading();

  // Compute the full-year 2026 date range (Jan 1 00:00:00 to Dec 31 23:59:59 local)
  const yearStart = new Date(2026, 0, 1, 0, 0, 0, 0);
  const yearEnd = new Date(2026, 11, 31, 23, 59, 59, 999);
  const startTs = Math.floor(yearStart.getTime() / 1000);
  const endTs = Math.floor(yearEnd.getTime() / 1000);

  // Try the API first with a timeout; fall back to simulated DataFeed,
  // then to a guaranteed inline mock dataset if DataFeed is unavailable.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s for full-year fetch
    const res = await fetch(`/api/candles?timeframe=${state.currentTimeframe}&limit=5000&start=${startTs}&end=${endTs}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (data.candles && data.candles.length) {
        state.candles = data.candles;
        chart.setCandles(data.candles);
        state._indicatorCache.clear();
        runAllIndicators();
        hideChartLoading();
        // MT5-style: start at the latest candle
        chart.scrollToRealTime();
        return;
      }
    }
  } catch (err) {
    // fall through to DataFeed / mock
  }

  // Simulated fallback — always works, no network dependency
  if (typeof DataFeed !== "undefined") {
    try {
      const candles = await DataFeed.getLiveCandles(state.currentTimeframe, 5000, startTs, endTs);
      state.candles = candles;
      chart.setCandles(candles);
      state._indicatorCache.clear();
      runAllIndicators();
      hideChartLoading();
      // MT5-style: start at the latest candle
      chart.scrollToRealTime();
      return;
    } catch (err) {
      // fall through to inline mock
    }
  }

  // Last-resort inline mock dataset — guarantees the chart always renders
  state.candles = generateMockCandles(state.currentTimeframe, 500);
  chart.setCandles(state.candles);
  state._indicatorCache.clear();
  runAllIndicators();
  hideChartLoading();
  // MT5-style: start at the latest candle
  chart.scrollToRealTime();
}

// Show/hide the chart loading overlay
function showChartLoading() {
  const el = document.getElementById("chartLoading");
  if (el) el.classList.remove("hidden");
}

function hideChartLoading() {
  const el = document.getElementById("chartLoading");
  if (el) el.classList.add("hidden");
}

// ============================================================
// Analytics Widgets Section
// Dedicated container below the chart for future analytics
// widgets (volume profile, order flow, market depth, etc.).
// Exposes a simple registration API: AnalyticsWidgets.register()
// ============================================================
const AnalyticsWidgets = (() => {
  let gridEl = null;
  let bodyEl = null;
  let sectionEl = null;
  let subtitleEl = null;
  const widgets = new Map(); // id -> { title, render, options }

  function init() {
    sectionEl = document.getElementById("analyticsSection");
    bodyEl = document.getElementById("analyticsBody");
    gridEl = document.getElementById("analyticsGrid");
    subtitleEl = document.getElementById("analyticsSubtitle");

    if (!sectionEl || !gridEl) return;

    // Toggle collapse on header click
    const toggleBtn = document.getElementById("analyticsToggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sectionEl.classList.toggle("collapsed");
      });
    }
    sectionEl.querySelector(".analytics-header").addEventListener("click", () => {
      sectionEl.classList.toggle("collapsed");
    });

    // Restore collapsed state from localStorage
    try {
      if (localStorage.getItem("analyticsCollapsed") === "1") {
        sectionEl.classList.add("collapsed");
      }
    } catch (err) {
      // localStorage unavailable — ignore
    }
  }

  function updateSubtitle() {
    if (!subtitleEl) return;
    const count = widgets.size;
    subtitleEl.textContent = count === 0 ? "Widgets" : `${count} widget${count === 1 ? "" : "s"}`;
  }

  function renderAll() {
    if (!gridEl) return;
    // Clear the grid (keep the placeholder if no widgets)
    gridEl.innerHTML = "";

    if (widgets.size === 0) {
      gridEl.innerHTML = `
        <div class="analytics-placeholder">
          <span class="analytics-placeholder-icon">📊</span>
          <span class="analytics-placeholder-text">Analytics widgets will appear here</span>
        </div>`;
      updateSubtitle();
      return;
    }

    widgets.forEach((widget, id) => {
      const card = document.createElement("div");
      card.className = "analytics-widget";
      card.id = `analytics-widget-${id}`;
      card.innerHTML = `
        <div class="analytics-widget-header">
          <span class="analytics-widget-title">${widget.title}</span>
          ${widget.options && widget.options.closeable ? `<button class="analytics-widget-close" data-widget-id="${id}" title="Remove">×</button>` : ""}
        </div>
        <div class="analytics-widget-body"></div>`;

      // Attach close handler if closeable
      const closeBtn = card.querySelector(".analytics-widget-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          unregister(id);
        });
      }

      gridEl.appendChild(card);

      // Call the render function with the widget's body element
      const bodyEl = card.querySelector(".analytics-widget-body");
      if (widget.render) {
        try {
          widget.render(bodyEl);
        } catch (err) {
          bodyEl.textContent = "Widget error: " + err.message;
        }
      }
    });

    updateSubtitle();
  }

  function register(id, title, render, options) {
    if (widgets.has(id)) return false;
    widgets.set(id, { title, render, options: options || {} });
    renderAll();
    return true;
  }

  function unregister(id) {
    if (!widgets.has(id)) return false;
    widgets.delete(id);
    renderAll();
    return true;
  }

  function has(id) {
    return widgets.has(id);
  }

  function getCount() {
    return widgets.size;
  }

  return { init, register, unregister, has, getCount };
})();

// ============================================================
// Market Depth Widget — Order Flow / Book
// First analytics widget: shows bid/ask spread, order book
// depth, and a volume profile mini-chart.
// ============================================================
function initMarketDepthWidget() {
  // Register the widget with the AnalyticsWidgets system
  AnalyticsWidgets.register(
    "market-depth",
    "Market Depth",
    (bodyEl) => {
      bodyEl.innerHTML = `
        <div class="market-depth-widget">
          <div class="md-spread-row">
            <span class="md-spread-label">Spread</span>
            <span class="md-spread-value" id="mdSpreadValue">--</span>
          </div>
          <div class="md-book">
            <div class="md-book-column">
              <div class="md-book-header asks">Asks</div>
              <div id="mdAsksList"></div>
            </div>
            <div class="md-book-column">
              <div class="md-book-header bids">Bids</div>
              <div id="mdBidsList"></div>
            </div>
          </div>
          <div class="md-volume-section">
            <div class="md-volume-title">Volume Profile</div>
            <div class="md-volume-bars" id="mdVolumeBars"></div>
          </div>
        </div>`;

      // Initial render
      updateMarketDepthWidget();

      // Re-render on candle updates
      const origSetCandles = chart.setCandles.bind(chart);
      chart.setCandles = (candles) => {
        origSetCandles(candles);
        updateMarketDepthWidget();
      };
    },
    { closeable: true }
  );
}

function updateMarketDepthWidget() {
  const candles = state.candles;
  if (!candles || candles.length < 5) return;

  const lastCandle = candles[candles.length - 1];
  const lastPrice = lastCandle.close;

  // ---- Spread ----
  const spreadEl = document.getElementById("mdSpreadValue");
  if (spreadEl) {
    // Simulate a realistic gold spread (0.10 - 0.40)
    const spread = 0.10 + Math.random() * 0.30;
    const spreadPct = (spread / lastPrice) * 100;
    spreadEl.textContent = `$${spread.toFixed(2)} (${spreadPct.toFixed(3)}%)`;
    spreadEl.className = "md-spread-value " + (spreadPct < 0.015 ? "positive" : "negative");
  }

  // ---- Order Book ----
  const asksList = document.getElementById("mdAsksList");
  const bidsList = document.getElementById("mdBidsList");

  if (asksList && bidsList) {
    // Generate simulated order book around the last price
    const askLevels = [];
    const bidLevels = [];
    let askPrice = lastPrice + 0.05;
    let bidPrice = lastPrice - 0.05;

    for (let i = 0; i < 5; i++) {
      const askSize = Math.floor(Math.random() * 80) + 10;
      const bidSize = Math.floor(Math.random() * 80) + 10;
      askLevels.push({ price: askPrice, size: askSize });
      bidLevels.push({ price: bidPrice, size: bidSize });
      askPrice += 0.10;
      bidPrice -= 0.10;
    }

    // Find max size for depth bar scaling
    const maxAsk = Math.max(...askLevels.map(l => l.size));
    const maxBid = Math.max(...bidLevels.map(l => l.size));
    const maxSize = Math.max(maxAsk, maxBid);

    asksList.innerHTML = askLevels.map(l => `
      <div class="md-book-row ask">
        <div class="md-depth-bar" style="width: ${(l.size / maxSize) * 100}%"></div>
        <span class="md-book-price">${l.price.toFixed(2)}</span>
        <span class="md-book-size">${l.size}</span>
      </div>`).join("");

    bidsList.innerHTML = bidLevels.map(l => `
      <div class="md-book-row bid">
        <div class="md-depth-bar" style="width: ${(l.size / maxSize) * 100}%"></div>
        <span class="md-book-price">${l.price.toFixed(2)}</span>
        <span class="md-book-size">${l.size}</span>
      </div>`).join("");
  }

  // ---- Volume Profile ----
  const volumeBars = document.getElementById("mdVolumeBars");
  if (volumeBars) {
    // Use the last 20 candles' volumes for the mini-chart
    const recent = candles.slice(-20);
    const volumes = recent.map(c => c.volume || 0);
    const maxVol = Math.max(...volumes, 1);
    const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    volumeBars.innerHTML = volumes.map(v => {
      const height = Math.max(4, (v / maxVol) * 100);
      let cls = "md-volume-bar";
      if (v > avgVol * 1.2) cls += " volume-high";
      else if (v < avgVol * 0.6) cls += " volume-low";
      return `<div class="${cls}" style="height: ${height}%"></div>`;
    }).join("");
  }
}

// ============================================================
// Economic News Widget — analytics grid version
// Renders the headline ticker + high-impact events as a card.
// ============================================================
function initAnalyticsNewsWidget() {
  AnalyticsWidgets.register(
    "economic-news",
    "Economic News",
    (bodyEl) => {
      // Build headline list
      const headlines = NEWS_HEADLINES.map(h => `
        <div class="an-news-item">
          <span class="an-news-flag">${h.flag}</span>
          <span class="an-news-time">${h.time}</span>
          <span class="an-news-title">${h.title}</span>
          <span class="an-news-impact ${h.impact}">${h.impact}</span>
        </div>`).join("");

      // Build upcoming high-impact events
      const now = new Date();
      const events = NEWS_EVENTS.map(ev => {
        const [h, m] = ev.time.split(":").map(Number);
        const d = new Date(now);
        d.setHours(h, m, 0, 0);
        return { ...ev, date: d };
      }).sort((a, b) => a.date - b.date);
      const upcoming = events.filter(ev => ev.date >= now).slice(0, 5);

      const eventsHtml = upcoming.length === 0
        ? `<div class="an-news-empty">No more events today</div>`
        : upcoming.map(ev => `
          <div class="an-event-row">
            <span class="an-event-time">${ev.time}</span>
            <span class="an-event-flag">${ev.flag}</span>
            <span class="an-event-name">${ev.title}</span>
            <span class="an-event-impact ${ev.impact}">${ev.impact}</span>
          </div>`).join("");

      bodyEl.innerHTML = `
        <div class="an-news-widget">
          <div class="an-news-headlines">
            ${headlines}
          </div>
          <div class="an-news-divider"></div>
          <div class="an-news-events-title">High-Impact Events</div>
          <div class="an-news-events">
            ${eventsHtml}
          </div>
        </div>`;
    },
    { closeable: true }
  );
}

// ============================================================
// Technical Summary Widget — analytics grid version
// Renders RSI / MACD / Moving Averages / Overall signal.
// ============================================================
function initAnalyticsTechnicalWidget() {
  AnalyticsWidgets.register(
    "technical-summary",
    "Technical Summary",
    (bodyEl) => {
      bodyEl.innerHTML = `
        <div class="an-tech-widget">
          <div class="an-tech-row">
            <span class="an-tech-label">RSI (14)</span>
            <span class="an-tech-value" id="anRsiValue">--</span>
            <span class="an-tech-status" id="anRsiStatus">--</span>
          </div>
          <div class="an-tech-row">
            <span class="an-tech-label">MACD (12,26,9)</span>
            <span class="an-tech-value" id="anMacdValue">--</span>
            <span class="an-tech-status" id="anMacdStatus">--</span>
          </div>
          <div class="an-tech-row">
            <span class="an-tech-label">SMA 20</span>
            <span class="an-tech-value" id="anSma20">--</span>
            <span class="an-tech-status" id="anSma20Signal">--</span>
          </div>
          <div class="an-tech-row">
            <span class="an-tech-label">SMA 50</span>
            <span class="an-tech-value" id="anSma50">--</span>
            <span class="an-tech-status" id="anSma50Signal">--</span>
          </div>
          <div class="an-tech-row">
            <span class="an-tech-label">EMA 200</span>
            <span class="an-tech-value" id="anEma200">--</span>
            <span class="an-tech-status" id="anEma200Signal">--</span>
          </div>
          <div class="an-tech-overall">
            <span class="an-tech-overall-label">Overall Signal</span>
            <span class="an-tech-overall-value" id="anOverallValue">--</span>
          </div>
        </div>`;

      // Initial computation
      updateAnalyticsTechnicalWidget();

      // Recompute on candle updates
      const origSetCandles = chart.setCandles.bind(chart);
      chart.setCandles = (candles) => {
        origSetCandles(candles);
        updateAnalyticsTechnicalWidget();
      };
    },
    { closeable: true }
  );
}

function updateAnalyticsTechnicalWidget() {
  const candles = state.candles;
  if (!candles || candles.length < 30) return;

  const closes = candles.map(c => c.close);
  const lastPrice = closes[closes.length - 1];

  // RSI
  const rsi = computeRSI(closes, 14);
  const rsiVal = rsi[rsi.length - 1];
  const rsiEl = document.getElementById("anRsiValue");
  const rsiStatus = document.getElementById("anRsiStatus");
  if (rsiEl) rsiEl.textContent = rsiVal.toFixed(1);
  if (rsiStatus) {
    if (rsiVal >= 70) { rsiStatus.textContent = "Overbought"; rsiStatus.className = "an-tech-status bearish"; }
    else if (rsiVal <= 30) { rsiStatus.textContent = "Oversold"; rsiStatus.className = "an-tech-status bullish"; }
    else if (rsiVal >= 55) { rsiStatus.textContent = "Bullish"; rsiStatus.className = "an-tech-status bullish"; }
    else if (rsiVal <= 45) { rsiStatus.textContent = "Bearish"; rsiStatus.className = "an-tech-status bearish"; }
    else { rsiStatus.textContent = "Neutral"; rsiStatus.className = "an-tech-status neutral"; }
  }

  // MACD
  const macdResult = computeMACD(closes, 12, 26, 9);
  const macdLine = macdResult.macd[macdResult.macd.length - 1];
  const signalLine = macdResult.signal[macdResult.signal.length - 1];
  const histogram = macdLine - signalLine;
  const macdEl = document.getElementById("anMacdValue");
  const macdStatus = document.getElementById("anMacdStatus");
  if (macdEl) macdEl.textContent = macdLine.toFixed(3);
  if (macdStatus) {
    if (histogram > 0 && macdLine > signalLine) { macdStatus.textContent = "Bullish"; macdStatus.className = "an-tech-status bullish"; }
    else if (histogram < 0 && macdLine < signalLine) { macdStatus.textContent = "Bearish"; macdStatus.className = "an-tech-status bearish"; }
    else { macdStatus.textContent = "Neutral"; macdStatus.className = "an-tech-status neutral"; }
  }

  // Moving averages
  const sma20 = computeSMA(closes, 20);
  const sma50 = computeSMA(closes, 50);
  const ema200 = computeEMA(closes, 200);
  const sma20Val = sma20[sma20.length - 1];
  const sma50Val = sma50[sma50.length - 1];
  const ema200Val = ema200[ema200.length - 1];

  updateAnalyticsMaRow("anSma20", "anSma20Signal", sma20Val, lastPrice);
  updateAnalyticsMaRow("anSma50", "anSma50Signal", sma50Val, lastPrice);
  updateAnalyticsMaRow("anEma200", "anEma200Signal", ema200Val, lastPrice);

  // Overall signal
  const overallEl = document.getElementById("anOverallValue");
  if (overallEl) {
    const bullishCount = [sma20Val, sma50Val, ema200Val].filter(v => lastPrice > v).length;
    let overall = "Neutral";
    let cls = "neutral";
    if (rsiVal >= 55 && bullishCount >= 2 && histogram > 0) { overall = "Strong Buy"; cls = "bullish"; }
    else if (rsiVal <= 45 && bullishCount <= 1 && histogram < 0) { overall = "Strong Sell"; cls = "bearish"; }
    else if (bullishCount >= 2) { overall = "Buy"; cls = "bullish"; }
    else if (bullishCount <= 1) { overall = "Sell"; cls = "bearish"; }
    overallEl.textContent = overall;
    overallEl.className = "an-tech-overall-value " + cls;
  }
}

function updateAnalyticsMaRow(valueId, signalId, maVal, lastPrice) {
  const valueEl = document.getElementById(valueId);
  const signalEl = document.getElementById(signalId);
  if (valueEl) valueEl.textContent = maVal !== undefined ? maVal.toFixed(2) : "--";
  if (signalEl) {
    if (maVal === undefined) { signalEl.textContent = "--"; signalEl.className = "an-tech-status neutral"; }
    else if (lastPrice > maVal) { signalEl.textContent = "Bullish"; signalEl.className = "an-tech-status bullish"; }
    else { signalEl.textContent = "Bearish"; signalEl.className = "an-tech-status bearish"; }
  }
}

// ============================================================
// AI Trading System — Multi-Factor Fundamental + Technical Engine
// ============================================================
// A comprehensive predictive matrix that scores ALL 15 major global
// macroeconomic drivers together with classic candlestick + indicator
// analysis. Every factor is a modular scorer returning a signed bias
// (score), a per-observation justification, and a confidence weight.
// The engine blends live news headlines, the high-impact economic
// calendar, real-time market data (gold price, volatility, trend) and
// a deterministic market snapshot into one high-probability directional
// call.
//
// Real-API integration points (swap as available):
//   - macro.macro.dxy / realYield10y / cpiYoy / etfHoldings /
//     cryptoIndex ...: replace the seeded proxy values with live feeds.
//   - macro.headlinesText: feed a live news-classification model output.
//   - macro.events:        wire a live economic-calendar API.
// ============================================================
const AITradingSystem = (() => {
  // ---- Configuration: model weights, cadence, thresholds ----
  const CONFIG = {
    techWeight: 0.30,     // candlestick + indicator layer weight
    macroWeight: 0.70,    // 15 macro-driver layer weight
    minCandles: 15,       // minimum candles needed for analysis
    refreshMs: 3000,      // auto re-evaluate cadence (ms)
    capAbs: 100,          // per-factor score cap (-100..100)
    strongBuyTh: 35,      // net >= this => STRONG BUY
    buyTh: 8,             // net >= this => BUY
    strongSellTh: -35,    // net <= -35 => STRONG SELL
    sellTh: -8,           // net <= -8 => SELL
  };

  let widgetBodyEl = null;
  let widgetInitialized = false;
  let analysisTimer = null;

  // ---- Generic-seeded PRNG (deterministic per evaluation tick) ----
  // Gives the macro factors stable-but-evolving snapshots without
  // requiring a live API, mirroring the simulated datafeed pattern.
  function seededRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---- Candlestick helpers ----
  const bodySize = (c) => Math.abs(c.close - c.open);
  const upperWick = (c) => c.high - Math.max(c.open, c.close);
  const lowerWick = (c) => Math.min(c.open, c.close) - c.low;
  const candleRange = (c) => Math.max(c.high - c.low, 1e-9);
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;

  // ---- Candlestick pattern readers (each returns {s,name}) ----
  // s is bullish(+)/bearish(-)/neutral(0) strength

  // Bullish / Bearish Engulfing
  function detectEngulfing(prev, curr) {
    const bull = isBear(prev) && isBull(curr) &&
      curr.open <= prev.close && curr.close >= prev.open &&
      bodySize(curr) > bodySize(prev);
    const bear = isBull(prev) && isBear(curr) &&
      curr.open >= prev.close && curr.close <= prev.open &&
      bodySize(curr) > bodySize(prev);
    if (bull) return { s: 1, name: "Bullish Engulfing" };
    if (bear) return { s: -1, name: "Bearish Engulfing" };
    return { s: 0, name: null };
  }

  // Hammer (bullish) / Shooting Star (bearish)
  function detectHammerStar(c) {
    const body = bodySize(c);
    const lw = lowerWick(c), uw = upperWick(c);
    if (lw > body * 2 && uw < body * 0.5 && body > 0) return { s: 1, name: "Hammer (bullish)" };
    if (uw > body * 2 && lw < body * 0.5 && body > 0) return { s: -1, name: "Shooting Star (bearish)" };
    return { s: 0, name: null };
  }

  // Doji (indecision)
  function detectDoji(c) {
    const body = bodySize(c), range = candleRange(c);
    if (body / range < 0.15 && range > 0) return { s: 1, name: "Doji (indecision)" };
    return { s: 0, name: null };
  }

  // Bullish Piercing Line
  function detectPiercing(candles) {
    const n = candles.length; if (n < 2) return { s: 0, name: null };
    const a = candles[n - 2], b = candles[n - 1];
    if (isBear(a) && isBull(b) && b.open < a.close && b.close > (a.open + a.close) / 2 && b.close < a.open) {
      return { s: 1, name: "Bullish Piercing Line" };
    }
    return { s: 0, name: null };
  }

  // Bullish / Bearish Harami
  function detectHarami(candles) {
    const n = candles.length; if (n < 2) return { s: 0, name: null };
    const a = candles[n - 2], b = candles[n - 1];
    if (bodySize(b) < bodySize(a) * 0.6) {
      if (isBull(a) && isBear(b) && b.high < a.high && b.low > a.low) return { s: -1, name: "Bearish Harami" };
      if (isBear(a) && isBull(b) && b.high < a.high && b.low > a.low) return { s: 1, name: "Bullish Harami" };
    }
    return { s: 0, name: null };
  }

  // Three White Soldiers / Three Black Crows
  function detectSoldiersCrows(candles) {
    const n = candles.length;
    if (n < 3) return { s: 0, name: null };
    const a = candles[n - 3], b = candles[n - 2], c = candles[n - 1];
    if (isBull(a) && isBull(b) && isBull(c) && b.close > a.close && c.close > b.close) {
      return { s: 1, name: "Three White Soldiers" };
    }
    if (isBear(a) && isBear(b) && isBear(c) && b.close < a.close && c.close < b.close) {
      return { s: -1, name: "Three Black Crows" };
    }
    return { s: 0, name: null };
  }

  // Morning / Evening Star (3-candle reversal)
  function detectStar(candles) {
    const n = candles.length;
    if (n < 3) return { s: 0, name: null };
    const a = candles[n - 3], b = candles[n - 2], c = candles[n - 1];
    const gap1 = Math.abs(b.close - a.close) / Math.max(a.close, 1e-9);
    const gap2 = Math.abs(c.close - b.close) / Math.max(b.close, 1e-9);
    if (isBear(a) && bodySize(b) < bodySize(a) * 0.5 && isBull(c) && gap1 > 0.0001 && gap2 > 0.0001) {
      return { s: 1, name: "Morning Star" };
    }
    if (isBull(a) && bodySize(b) < bodySize(a) * 0.5 && isBear(c) && gap1 > 0.0001 && gap2 > 0.0001) {
      return { s: -1, name: "Evening Star" };
    }
    return { s: 0, name: null };
  }

  const patternDetectors = [
    (cs) => detectEngulfing(cs[cs.length - 2], cs[cs.length - 1]),
    (cs) => detectHammerStar(cs[cs.length - 1]),
    (cs) => detectDoji(cs[cs.length - 1]),
    (cs) => detectPiercing(cs),
    (cs) => detectHarami(cs),
    (cs) => detectSoldiersCrows(cs),
    (cs) => detectStar(cs),
  ];

  // ---- Technical layer: patterns + indicators => score -100..100 ----
  function technicalScore(candles) {
    const closes = candles.map(c => c.close);
    const lastPrice = closes[closes.length - 1];
    let score = 0;
    const reasons = [];
    const patterns = [];

    const patWeights = {
      "Bullish Engulfing": 2, "Bearish Engulfing": 2,
      "Hammer (bullish)": 1.5, "Shooting Star (bearish)": 1.5,
      "Doji (indecision)": 0.4, "Bullish Piercing Line": 1.8,
      "Bullish Harami": 1.2, "Bearish Harami": 1.2,
      "Three White Soldiers": 2.5, "Three Black Crows": 2.5,
      "Morning Star": 2.5, "Evening Star": 2.5,
    };
    const c1 = candles[candles.length - 1];
    const c0 = candles[candles.length - 2];
    for (const d of patternDetectors) {
      const p = d(candles);
      if (p.s !== 0 && p.name) {
        const w = patWeights[p.name] || 1;
        score += p.s * w;
        patterns.push(p.name);
        reasons.push("Pattern: " + p.name);
      }
    }
    if (c1 && c0) {
      const delta = (c1.close - c0.close) / Math.max(c0.close, 1e-9);
      score += clamp(delta / 0.001, -1, 1);
      if (delta > 0.0005) reasons.push("Last candle closed higher (+" + (delta * 100).toFixed(2) + "%)");
      else if (delta < -0.0005) reasons.push("Last candle closed lower (" + (delta * 100).toFixed(2) + "%)");
    }

    // Moving averages & crossovers (reuse app.js indicator helpers)
    const sma20 = computeSMA(closes, 20);
    const sma50 = computeSMA(closes, 50);
    const sma20v = sma20[sma20.length - 1], sma20p = sma20[sma20.length - 2];
    const sma50v = sma50[sma50.length - 1];
    if (sma20v > 0) {
      score += (lastPrice > sma20v) ? 0.7 : -0.7;
      reasons.push("Price " + (lastPrice > sma20v ? "above" : "below") + " SMA20");
    }
    if (sma20v > 0 && sma50v > 0) {
      score += (sma20v > sma50v) ? 0.8 : -0.8;
      reasons.push(sma20v > sma50v ? "SMA20 > SMA50 (uptrend)" : "SMA20 < SMA50 (downtrend)");
      if (sma20p <= sma50v && sma20v > sma50v) { score += 1.2; reasons.push("Golden Cross SMA20/50"); }
      if (sma20p >= sma50v && sma20v < sma50v) { score -= 1.2; reasons.push("Death Cross SMA20/50"); }
    }

    // MACD
    const macdResult = computeMACD(closes, 12, 26, 9);
    const macdLine = macdResult.macd[macdResult.macd.length - 1];
    const macdPrev = macdResult.macd[macdResult.macd.length - 2];
    const macdSig = macdResult.signal[macdResult.signal.length - 1];
    const macdSigPrev = macdResult.signal[macdResult.signal.length - 2];
    if (macdLine !== undefined && macdSig !== undefined) {
      score += (macdLine > macdSig) ? 0.7 : -0.7;
      reasons.push(macdLine > macdSig ? "MACD above signal" : "MACD below signal");
      if (macdPrev <= macdSigPrev && macdLine > macdSig) { score += 1.1; reasons.push("MACD golden cross"); }
      if (macdPrev >= macdSigPrev && macdLine < macdSig) { score -= 1.1; reasons.push("MACD bearish cross"); }
    }

    // RSI
    const rsi = computeRSI(closes, 14);
    const rsiVal = rsi[rsi.length - 1];
    if (rsiVal !== undefined) {
      if (rsiVal < 30) { score += 1.3; reasons.push("RSI oversold (" + rsiVal.toFixed(0) + ")"); }
      else if (rsiVal > 70) { score -= 1.3; reasons.push("RSI overbought (" + rsiVal.toFixed(0) + ")"); }
      else if (rsiVal >= 55) { score += 0.5; reasons.push("RSI bullish (" + rsiVal.toFixed(0) + ")"); }
      else if (rsiVal <= 45) { score -= 0.5; reasons.push("RSI bearish (" + rsiVal.toFixed(0) + ")"); }
    }

    score = clamp(score, -CONFIG.capAbs, CONFIG.capAbs);
    return { score, reasons, patterns, lastPrice };
  }

  // ---- Build contextual macro snapshot (live-ish state) ----
  // ctx.json merges real feeds (gold price, candles, headlines, calendar)
  // with a deterministic market snapshot so every factor sees a coherent,
  // evolving picture even before external APIs are wired in.
  function buildContext(candles) {
    const closes = candles.map(c => c.close);
    const lastPrice = closes[closes.length - 1];
    let livePrice = lastPrice;
    if (typeof DataFeed !== "undefined" && DataFeed.getLiveData) {
      const live = DataFeed.getLiveData();
      if (live && typeof live.price === "number") livePrice = live.price;
    }

    // Trend context from last 20 closes
    const look = closes.slice(-20);
    const start = look.length ? look[0] : lastPrice;
    const trend = look.length ? (lastPrice - start) / Math.max(Math.abs(start), 1e-9) : 0;

    // Volatility (avg true range % over last candles)
    let sumRange = 0, cnt = 0;
    for (let i = 1; i < candles.length && cnt < 20; i++) {
      const hi = Math.max(candles[i].high, candles[i].close, candles[i].open);
      const lo = Math.min(candles[i].low, candles[i].close, candles[i].open);
      sumRange += Math.abs(hi - lo) / Math.max(candles[i].close, 1e-9);
      cnt++;
    }
    const volatility = cnt ? sumRange / cnt : 0.001;

    // Deterministic macro snapshot seeded by the eval-time bucket, so
    // factors evolve smoothly across refreshes. Replace with live data.
    const rng = seededRandom(Math.floor(Date.now() / CONFIG.refreshMs) * 2654435761);

    return {
      goldPrice: lastPrice,
      livePrice,
      trend,
      volatility,
      rng,
      headlinesText: (Array.isArray(NEWS_HEADLINES) ? NEWS_HEADLINES : []).map(h => ({
        title: (h.title || "").toLowerCase(),
        impact: h.impact || "low",
        flag: h.flag || "",
      })),
      events: (Array.isArray(NEWS_EVENTS) ? NEWS_EVENTS : []).map(ev => ({
        title: (ev.title || "").toLowerCase(),
        impact: ev.impact || "low",
        flag: ev.flag || "",
        country: ev.country || "",
        forecast: ev.forecast || "",
      })),
      // Global macro proxy values (deterministic; swap for live feeds)
      macro: {
        dxy: 100 + rng() * 10 - 5,             // US Dollar Index
        realYield10y: 3.5 + rng() * 0.8 - 0.4, // 10Y real yield %
        cpiYoy: 3.0 + rng() * 2.2 - 1.1,       // US CPI y/y %
        fediBias: rng() * 3 - 1.5,             // + hawkish price-in
        etfHoldings: 860 + rng() * 20 - 10,    // SPDR GLD tonnes
        cbReserve: 36000 + rng() * 1500 - 750, // tonnes global
        cryptoIndex: rng() * 4 - 2,            // + crypto risk-on
        djt: 34 + rng() * 3 - 1.5,             // USD trillion debt
        pmIndex: 2.4 + rng() * 0.8 - 0.4,      // silver proxy
        platinum: 1.6 + rng() * 0.6 - 0.3,     // platinum proxy
        palladium: 1.4 + rng() * 0.6 - 0.3,    // palladium proxy
      },
    };
  }

// ============================================================
  // THE 15 GLOBAL MACRO FACTORS (modular scoring pipeline)
  // ============================================================
  // Each factor exposes { id, label, short, icon, weight, scoreFn(ctx) }
  // scoreFn returns { score (-100..100), justification, confidence }.
  // Weights express each driver's expected influence on gold; they are
  // normalized before fusion so the final bias is on a stable scale.
  // ============================================================
  const MACRO_FACTORS = [
    // 1. Fed Interest Rates & Monetary Policy
    {
      id: "fed", label: "Fed Interest Rates & Policy", short: "Fed Rates", icon: "🏦", weight: 1.0,
      scoreFn: (ctx) => {
        const j = ctx.macro;
        let score = 0; const just = [];
        score -= j.fediBias * 18;
        const hawk = (j.dxy - 100) * 3;
        score -= hawk;
        if (j.fediBias > 0) just.push("Fed stance hawkish → higher-for-longer rates weigh on gold");
        else if (j.fediBias < 0) just.push("Fed leaning dovish → rate-cut hopes lift gold");
        if (hawk > 0) just.push("Dollar firmness compounds the rate headwind");
        else if (hawk < 0) just.push("Dollar softness eases the rate drag");
        for (const e of ctx.events) {
          if (/(fomc|rate decision|interest rate)/.test(e.title) && e.impact === "high") {
            score -= 3; just.push("Upcoming FOMC / rate decision heightens uncertainty");
          }
        }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No notable Fed signal", confidence: 0.62 };
      },
    },
    // 2. Inflation (CPI / PPI data releases)
    {
      id: "inflation", label: "Inflation (CPI / PPI)", short: "Inflation", icon: "🔥", weight: 0.95,
      scoreFn: (ctx) => {
        const c = ctx.macro.cpiYoy;
        let score = 0, just = [];
        if (c > 3.5) { score += 3.2; just.push("CPI " + c.toFixed(1) + "% — sticky inflation boosts gold's store-of-value bid"); }
        else if (c < 2.5) { score -= 2.8; just.push("CPI " + c.toFixed(1) + "% cooling — softens inflation-hedge demand"); }
        else { score += 0.6; just.push("CPI " + c.toFixed(1) + "% within benign range"); }
        for (const e of ctx.events) {
          if (/(cpi|pce|ppi|inflation)/.test(e.title) && e.impact === "high") {
            score += 2; just.push("High-impact inflation print ahead (" + e.title + ")");
          }
        }
        const h = ctx.headlinesText.find(h => /inflation|cpi|ppi/.test(h.title));
        if (h) {
          if (/cool|falls|slow|eases/.test(h.title)) { score -= 2.2; just.push("News: " + h.title); }
          if (/hot|rises|surges|above/.test(h.title)) { score += 2.2; just.push("News: " + h.title); }
        }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No inflation-led signal", confidence: 0.6 };
      },
    },
    // 3. US Dollar Index (DXY) inverse correlation
    {
      id: "dxy", label: "US Dollar (DXY)", short: "DXY", icon: "💵", weight: 1.1,
      scoreFn: (ctx) => {
        const dxy = ctx.macro.dxy;
        let score = 0, just = [];
        if (dxy > 104) { score = -14; just.push("DXY strong (" + dxy.toFixed(1) + ") — dollar bid pressures gold"); }
        else if (dxy < 96) { score = 14; just.push("DXY soft (" + dxy.toFixed(1) + ") — cheapens gold for foreign buyers"); }
        else if (dxy >= 100) { score = -5; just.push("DXY firm (" + dxy.toFixed(1) + ") — mild headwind"); }
        else { score = 6; just.push("DXY neutral-soft (" + dxy.toFixed(1) + ") — mildly supportive"); }
        return { score: clamp(score, -100, 100), justification: just.join("; "), confidence: 0.7 };
      },
    },
    // 4. Geopolitical Tensions & Safe-Haven flows
    {
      id: "geopolitical", label: "Geopolitical Tensions", short: "Geopolitics", icon: "🌍", weight: 0.9,
      scoreFn: (ctx) => {
        let score = 0, just = [];
        const hot = ["war", "conflict", "invade", "strike", "sanction", "tension", "attack", "crisis", "militar", "nuclear"];
        const calm = ["ceasefire", "deal", "peace", "truce", "diploma", "accord"];
        for (const h of ctx.headlinesText) {
          if (hot.some(k => h.title.includes(k))) { score += 6; just.push("Safe-haven bid: " + h.title); break; }
          if (calm.some(k => h.title.includes(k))) { score -= 3; just.push("De-escalation eases safe-haven demand: " + h.title); break; }
        }
        if (ctx.volatility > 0.004) score += 4;
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No geopolitical catalyst", confidence: 0.42 };
      },
    },
    // 5. Central Bank Gold Reserves & Purchases
    {
      id: "cbreserves", label: "Central Bank Gold Reserves", short: "CB Reserves", icon: "🏛️", weight: 0.85,
      scoreFn: (ctx) => {
        const cb = ctx.macro.cbReserve;
        let score = 0, just = [];
        if (cb > 36500) { score += 5; just.push("Global reserves " + (cb / 1000).toFixed(1) + "K t — ongoing official buying trend"); }
        else if (cb < 35500) { score -= 4; just.push("Reserves " + (cb / 1000).toFixed(1) + "K t — lighter official demand"); }
        else { score += 1; just.push("CB reserves stable " + (cb / 1000).toFixed(1) + "K t"); }
        return { score: clamp(score, -100, 100), justification: just.join("; "), confidence: 0.55 };
      },
    },
// 6. Non-Farm Payrolls (NFP) & Employment Data
    {
      id: "nfp", label: "Non-Farm Payrolls (NFP)", short: "NFP/Jobs", icon: "💼", weight: 0.7,
      scoreFn: (ctx) => {
        let score = 0, just = [];
        for (const e of ctx.events) {
          if (/(non-farm|payrolls|employment change|unemployment)/.test(e.title)) {
            score += 2;
            just.push("Upcoming jobs print (" + e.title + (e.forecast ? " ~" + e.forecast : "") + ") — volatility ahead");
            if (e.impact === "high") score += 1;
          }
        }
        for (const h of ctx.headlinesText) {
          if (/jobs|unemployment|payrolls|employment/.test(h.title)) {
            if (/(slow|weak|miss|less|drop|unemploy.*rises)/.test(h.title)) { score += 2.5; just.push("Soft jobs reading: " + h.title); }
            else if (/(beat|surge|gain|strong|add)/.test(h.title)) { score -= 2; just.push("Hot jobs reading: " + h.title); }
          }
        }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No NFP signal", confidence: 0.5 };
      },
    },
    // 7. Global Economic Growth & GDP reports
    {
      id: "gdp", label: "Global Growth & GDP", short: "Global GDP", icon: "📈", weight: 0.55,
      scoreFn: (ctx) => {
        let score = 0, just = [];
        for (const e of ctx.events) {
          if (/(gdp|recession|growth)/.test(e.title)) {
            score += e.impact === "high" ? 3 : 1;
            just.push("Growth print: " + e.title);
          }
        }
        for (const h of ctx.headlinesText) {
          if (/recession|slowdown|gdp|growth/.test(h.title) && /risk|slow|weak|contract|miss/.test(h.title)) {
            score += 2.5; just.push("Weak growth headlines: " + h.title);
          }
        }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No growth signal", confidence: 0.48 };
      },
    },
    // 8. Physical Supply & Demand metrics
    {
      id: "physical", label: "Physical Supply & Demand", short: "Physical", icon: "⚖️", weight: 0.5,
      scoreFn: (ctx) => {
        let score = 0, just = [];
        score += ctx.volatility > 0.003 ? 2 : -1;
        if (ctx.trend > 0) { score += 2; just.push("Gold rally sustained — retail/jewelry demand absorbing supply"); }
        else { score -= 1; just.push("Soft price trend — weaker physical bid"); }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "Physical flows balanced", confidence: 0.35 };
      },
    },
    // 9. US Treasury Yields (10-year bond competition)
    {
      id: "treasury", label: "US 10-Year Treasury Yield", short: "Treasury Yield", icon: "🏦", weight: 0.85,
      scoreFn: (ctx) => {
        const y = ctx.macro.realYield10y;
        let score = 0, just = [];
        if (y > 3.8) { score = -10; just.push("Nominal 10Y " + y.toFixed(2) + "% high — yield competition saps gold"); }
        else if (y < 3.2) { score = 8; just.push("10Y yield " + y.toFixed(2) + "% low — low opportunity cost favors gold"); }
        else { score = -2; just.push("10Y yield " + y.toFixed(2) + "% — moderate headwind"); }
        return { score: clamp(score, -100, 100), justification: just.join("; "), confidence: 0.66 };
      },
    },
    // 10. Physical Demand seasons in India & China
    {
      id: "seasonal", label: "Seasonal Demand (India/China)", short: "Seasonality", icon: "💍", weight: 0.45,
      scoreFn: (ctx) => {
        const m = new Date().getMonth() + 1;
        let score = 0, just = [];
        if (m === 5) { score += 5; just.push("Akshaya Tritiya wedding-gold peak in India"); }
        else if (m === 10) { score += 4; just.push("Diwali + China Golden Week jewelry demand"); }
        else if (m === 2) { score += 3; just.push("Lunar New Year China bullion demand"); }
        else if (m === 11) { score += 4; just.push("Diwali shopping season supports prices"); }
        else { score += 0; just.push("Off-peak wedding/seasonal demand"); }
        return { score: clamp(score, -100, 100), justification: just.join("; "), confidence: 0.5 };
      },
    },
  // 11. Cryptocurrencies & Alternative asset sentiment
    {
      id: "crypto", label: "Crypto & Risk Sentiment", short: "Crypto", icon: "🪙", weight: 0.4,
      scoreFn: (ctx) => {
        const ci = ctx.macro.cryptoIndex;
        let score = 0, just = [];
        if (ci > 1) { score -= 3; just.push("Crypto risk-on firms — capital rotating to digital assets"); }
        else if (ci < -1) { score += 3; just.push("Crypto risk-off — investors default to gold as safe haven"); }
        else { score += 0.5; just.push("Crypto sentiment neutral — limited spillover"); }
        for (const h of ctx.headlinesText) {
          if (/bitcoin|crypto|btc/.test(h.title)) {
            if (/falls|crash|plunge|fal|drop|crack/.test(h.title)) { score += 2; just.push("Crypto shakeout: " + h.title); }
            else if (/surge|rally|high|boom/.test(h.title)) { score -= 1.5; just.push("Crypto rally: " + h.title); }
          }
        }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No crypto spillover signal", confidence: 0.35 };
      },
    },
    // 12. International Trade Policies & Tariffs
    {
      id: "trade", label: "Trade Policy & Tariffs", short: "Tariffs", icon: "🚢", weight: 0.45,
      scoreFn: (ctx) => {
        let score = 0, just = [];
        for (const h of ctx.headlinesText) {
          if (/(tariff|trade war|trade|import duty|export ban)/.test(h.title)) {
            if (/(rise|raise|new|impose|threaten|war|ban)/.test(h.title)) { score += 3; just.push("Trade/tariff friction: " + h.title); }
            if (/deal|ease|resol|exempt|delay/.test(h.title)) { score -= 2; just.push("Trade easing: " + h.title); }
          }
        }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No trade-policy signal", confidence: 0.42 };
      },
    },
    // 13. Major ETF Flows (e.g., SPDR GLD holdings)
    {
      id: "etf", label: "ETF Flows (SPDR GLD)", short: "ETF Flows", icon: "📊", weight: 0.6,
      scoreFn: (ctx) => {
        const et = ctx.macro.etfHoldings;
        let score = 0, just = [];
        if (et > 875) { score += 8; just.push("SPDR GLD holdings " + et.toFixed(0) + " t — sustained institutional accumulation"); }
        else if (et < 850) { score -= 5; just.push("ETF holdings " + et.toFixed(0) + " t — investors lightening up"); }
        else { score += 1; just.push("ETF holdings " + et.toFixed(0) + " t — neutral"); }
        return { score: clamp(score, -100, 100), justification: just.join("; "), confidence: 0.58 };
      },
    },
    // 14. Fiscal Policy & Deficit/Stimulus
    {
      id: "fiscal", label: "Fiscal Policy & Stimulus", short: "Fiscal", icon: "🏛️", weight: 0.5,
      scoreFn: (ctx) => {
        let score = 0, just = [];
        for (const h of ctx.headlinesText) {
          if (/(stimulus|deficit|fiscal|spending|infrastructure bill|bond issuance|QE|quantitative easing)/.test(h.title)) {
            if (/(stimulus|spending|inject|billion|trillion|deficit|easing|emergency fund)/.test(h.title)) { score += 3; just.push("Fiscal expansion (debt-financed): " + h.title); }
            if (/(austerity|cuts|debt ceiling|shutdown|budget slash)/.test(h.title)) { score -= 2; just.push("Fiscal tightening: " + h.title); }
          }
        }
        return { score: clamp(score, -100, 100), justification: just.join("; ") || "No fiscal-policy signal", confidence: 0.4 };
      },
    },
    // 15. Cross-Metals & Precious-Metal Interlink (silver, platinum)
    {
      id: "metals", label: "Cross-Metals (Ag, Pt)", short: "Metals", icon: "🥈", weight: 0.35,
      scoreFn: (ctx) => {
        const ag = ctx.macro.pmIndex;
        let score = 0, just = [];
        if (ag < 2.2) { score += 4; just.push("Silver proxy " + ag.toFixed(2) + " — broad precious-metals bid widening"); }
        else if (ag > 2.8) { score -= 2; just.push("Silver proxy " + ag.toFixed(2) + " — silver lagging, stress-focused gold bid only"); }
        else { score += 0; just.push("Silver proxy " + ag.toFixed(2) + " — neutral cross-metal tone"); }
        return { score: clamp(score, -100, 100), justification: just.join("; "), confidence: 0.4 };
      },
    },
  ];

  // ---- Fuse all layers into the overall verdict ----
  function analyze() {
    const candles = state.candles || [];
    if (!candles || candles.length < CONFIG.minCandles) {
      return { status: "insufficient", tech: null, factors: null, macro: 0, net: 0, probability: 50, confidence: 0 };
    }
    const ctx = buildContext(candles);
    const tech = technicalScore(candles);

    // Score every macro factor via the pipeline
    const macroResults = MACRO_FACTORS.map(f => {
      let r;
      try { r = f.scoreFn(ctx); } catch (e) { r = { score: 0, justification: "factor error", confidence: 0 }; }
      r.score = clamp(typeof r.score === "number" ? r.score : 0, -CONFIG.capAbs, CONFIG.capAbs);
      r.confidence = clamp(typeof r.confidence === "number" ? r.confidence : 0.5, 0, 1);
      if (!r.justification) r.justification = "No strong signal";
      r.weighted = r.score * f.weight;
      return { ...f, ...r };
    });

    // Macro composite: confidence-weighted mean of factor scores
    let wSum = 0;
    for (const f of macroResults) wSum += f.confidence * f.weight;
    const macroScore = macroResults.reduce((acc, f) => {
      const confScale = wSum ? (f.confidence * f.weight) / wSum : 1 / MACRO_FACTORS.length;
      return acc + f.score * confScale;
    }, 0);

    // Overall directional net on -100..100
    const net = (tech.score * CONFIG.techWeight) + (macroScore * CONFIG.macroWeight);

    // Probability transform: squeeze net into 0..100 around ~50 baseline
    const probability = clamp(50 + net * 0.5, 3, 97);
    const confidence = clamp((Math.abs(macroScore) / 100) * 0.7 + (Math.abs(tech.score) / 100) * 0.3, 0.1, 0.97);

    return { status: "ready", tech, factors: macroResults, macro: macroScore, net, probability, confidence };
  }

  // ---- Build a concise Kurdish explanation of the verdict ----
  function buildKurdishExplanation(a, direction) {
    const top = [...a.factors].sort((x, y) => y.score - x.score);
    const bull = top.filter(f => f.score > 0).slice(0, 2);
    const bear = top.filter(f => f.score < 0).slice(0, 2);

    let parts = [];
    if (a.net > 0) {
      parts.push("ئاراستەی گشتی بەرەو سەرەوەیە (زێڕ بەهێزە).");
    } else if (a.net < 0) {
      parts.push("ئاراستەی گشتی بەرەو خوارەوەیە (زێڕ لاوازە).");
    } else {
      parts.push("ئاراستەکە بێلایەنە و بازاڕەکە هاوسەنگە.");
    }

    if (bull.length) {
      parts.push("هۆکارە ئەرێنییەکان: " + bull.map(f => f.label).join("، ") + ".");
    }
    if (bear.length) {
      parts.push("هۆکارە نەرێنییەکان: " + bear.map(f => f.label).join("، ") + ".");
    }

    parts.push("ئەگەری بەرزبوونەوە: " + Math.round(a.probability) + "٪، متمانە: " + Math.round(a.confidence * 100) + "٪.");
    return parts.join(" ");
  }

  // ---- Render the widget ----
  function renderWidget() {
    if (!widgetBodyEl) return;
    const a = analyze();
    const candles = state.candles || [];
    const lastPrice = candles.length ? candles[candles.length - 1].close : null;

    if (a.status === "insufficient") {
      widgetBodyEl.innerHTML = `
        <div class="ai-widget">
          <div class="ai-status-row"><span class="ai-status-dot neutral"></span>
            <span>Analyzing… (need more candles)</span></div>
        </div>`;
      return;
    }

    const direction = a.net > 2 ? "STRONG BUY" :
      a.net > 0 ? "BUY" :
      a.net < -2 ? "STRONG SELL" :
      a.net < 0 ? "SELL" : "NEUTRAL";
    const dirClass = a.net > 0.5 ? "bullish" : a.net < -0.5 ? "bearish" : "neutral";

    const techReasons = a.tech.reasons.slice(0, 4);
    const patternList = a.tech.patterns;

    // Sort factors by score for the grid + top drivers
    const sortedFactors = [...a.factors].sort((x, y) => y.score - x.score);
    const topBull = sortedFactors.filter(f => f.score > 0).slice(0, 3);
    const topBear = sortedFactors.filter(f => f.score < 0).slice(0, 3);

    const bar = (score, label) => {
      const pct = Math.min(100, Math.abs(score) * 5);
      const cls = score >= 0 ? "fill-bull" : "fill-bear";
      return `
        <div class="ai-score-row">
          <span class="ai-score-label">${label}</span>
          <div class="ai-score-track">
            <div class="ai-score-fill ${cls}" style="width:${pct}%"></div>
          </div>
          <span class="${score >= 0 ? "ai-score-pos" : "ai-score-neg"}">${score > 0 ? "+" : ""}${score.toFixed(1)}</span>
        </div>`;
    };

    // Per-factor grid row
    const factorRow = (f) => {
      const cls = f.score >= 0 ? "fill-bull" : "fill-bear";
      const pct = Math.min(100, Math.abs(f.score) * 5);
      return `
        <div class="ai-factor-row" title="${f.justification}">
          <span class="ai-factor-icon">${f.icon}</span>
          <span class="ai-factor-label">${f.short}</span>
          <div class="ai-factor-track">
            <div class="ai-score-fill ${cls}" style="width:${pct}%"></div>
          </div>
          <span class="${f.score >= 0 ? "ai-score-pos" : "ai-score-neg"}">${f.score > 0 ? "+" : ""}${f.score.toFixed(1)}</span>
        </div>`;
    };

    const probPct = Math.round(a.probability);
    const probClass = probPct >= 55 ? "bullish" : probPct <= 45 ? "bearish" : "neutral";

    widgetBodyEl.innerHTML = `
      <div class="ai-widget">
        <div class="ai-verdict-row">
          <div class="ai-arrow ${dirClass}">${a.net > 0 ? "▲" : a.net < 0 ? "▼" : "▬"}</div>
          <div class="ai-verdict">
            <span class="ai-direction ${dirClass}">${direction}</span>
            <span class="ai-score-big">${a.net > 0 ? "+" : ""}${a.net.toFixed(1)}</span>
          </div>
          <span class="ai-live-price">${lastPrice !== null ? "$" + lastPrice.toFixed(2) : "--"}</span>
        </div>

        <div class="ai-prob-row">
          <span class="ai-prob-label">Uptrend Probability</span>
          <div class="ai-prob-track">
            <div class="ai-prob-fill ${probClass}" style="width:${probPct}%"></div>
          </div>
          <span class="ai-prob-value ${probClass}">${probPct}%</span>
        </div>

        <div class="ai-layer-scores">
          ${bar(a.tech.score, "Technical")}
          ${bar(a.macro, "Macro Composite")}
        </div>

        <div class="ai-section">
          <div class="ai-section-title">🌐 15-Factor Macro Grid</div>
          <div class="ai-factor-grid">
            ${a.factors.map(factorRow).join("")}
          </div>
        </div>

        <div class="ai-section">
          <div class="ai-section-title">🕯 Candlestick Patterns</div>
          ${patternList.length
            ? `<div class="ai-pattern-chips">${patternList.map(p => `<span class="ai-chip">${p}</span>`).join("")}</div>`
            : `<div class="ai-empty">No strong reversal pattern</div>`}
          <ul class="ai-reason-list">${techReasons.map(r => `<li>${r}</li>`).join("")}</ul>
        </div>

        <div class="ai-section">
          <div class="ai-section-title">📈 Top Bullish Drivers</div>
          ${topBull.length
            ? `<ul class="ai-reason-list">${topBull.map(f => `<li>${f.icon} ${f.label}: ${f.justification}</li>`).join("")}</ul>`
            : `<div class="ai-empty">No dominant bullish factor</div>`}
        </div>

        <div class="ai-section">
          <div class="ai-section-title">📉 Top Bearish Drivers</div>
          ${topBear.length
            ? `<ul class="ai-reason-list">${topBear.map(f => `<li>${f.icon} ${f.label}: ${f.justification}</li>`).join("")}</ul>`
            : `<div class="ai-empty">No dominant bearish factor</div>`}
        </div>

        <div class="ai-section ai-reasoning">
          <div class="ai-section-title">🧠 AI Reasoning</div>
          <p class="ai-explanation">${buildKurdishExplanation(a, direction)}</p>
        </div>
      </div>`;
  }

  // ---- Auto-refresh timer ----
  function scheduleAutoRefresh() {
    if (analysisTimer) clearTimeout(analysisTimer);
    analysisTimer = setTimeout(() => renderWidget(), CONFIG.refreshMs);
  }

  // ---- Widget entry point ----
  function initWidget() {
    if (widgetInitialized) return;
    AnalyticsWidgets.register(
      "ai-trading",
      "AI Trading Intelligence",
      (bodyEl) => {
        widgetBodyEl = bodyEl;
        widgetInitialized = true;
        renderWidget();

        // Re-render on candle updates
        const origSetCandles = chart.setCandles.bind(chart);
        chart.setCandles = (candles) => {
          origSetCandles(candles);
          renderWidget();
          scheduleAutoRefresh();
        };
        scheduleAutoRefresh();
      },
      { closeable: true }
    );
  }

  return { initWidget };
})();

  // ============================================================
  // AI Anomaly & Liquidity Trap Detection
// Analyzes incoming tick data in real-time for:
//   - Sudden price spikes (potential manipulation / stop hunts)
//   - Liquidity traps (sharp reversal after a spike)
//   - Abnormal tick velocity / acceleration
//   - Volume anomalies (spike without price confirmation)
//   - Price clamping (repeated identical ticks = market maker control)
// ============================================================
const AnomalyDetector = (() => {
  // Detection thresholds (tunable)
  const CONFIG = {
    tickWindow: 60,           // number of ticks to keep in rolling window
    spikeThreshold: 0.15,     // % move within a short window to flag as spike
    velocityThreshold: 0.08,  // % move per second to flag as abnormal velocity
    trapReversalPct: 0.10,    // % reversal after a spike to flag as liquidity trap
    clampThreshold: 0.02,     // % move to consider a tick "clamped"
    clampCount: 8,            // consecutive clamped ticks to flag
    alertCooldown: 3000,      // ms between alerts of the same type
    maxAlerts: 5,             // max active alerts displayed
    alertLifetime: 30000,     // ms before an alert auto-expires
  };

  // Internal state
  let ticks = [];             // rolling window: { price, ts }
  let alerts = [];            // active alerts: { id, type, severity, message, ts }
  let clampStreak = 0;        // consecutive clamped ticks
  let lastPrice = null;
  let lastTs = null;
  let lastAlertByType = {};   // type -> timestamp of last alert
  let alertCounter = 0;
  let widgetBodyEl = null;
  let widgetInitialized = false;

  // ---- Public: feed a new tick into the detector ----
  function feedTick(price, ts) {
    if (typeof price !== "number" || !isFinite(price)) return;

    const now = ts || Date.now();

    // Push to rolling window
    ticks.push({ price, ts: now });
    if (ticks.length > CONFIG.tickWindow) ticks.shift();

    // Need at least 3 ticks for meaningful analysis
    if (ticks.length < 3) {
      lastPrice = price;
      lastTs = now;
      return;
    }

    // Run detection passes
    detectPriceSpike(price, now);
    detectVelocity(price, now);
    detectLiquidityTrap(price, now);
    detectClamping(price, now);

    lastPrice = price;
    lastTs = now;

    // Prune expired alerts
    pruneAlerts(now);

    // Update the widget UI if it's mounted
    if (widgetBodyEl && widgetInitialized) {
      renderWidget();
    }
  }
// ---- Detection: sudden price spike ----
  function detectPriceSpike(price, now) {
    // Compare against the average of the last N ticks (excluding current)
    const lookback = Math.min(10, ticks.length - 1);
    if (lookback < 3) return;

    const prevTicks = ticks.slice(-(lookback + 1), -1);
    const avgPrice = prevTicks.reduce((s, t) => s + t.price, 0) / prevTicks.length;
    const pctMove = Math.abs((price - avgPrice) / avgPrice) * 100;

    if (pctMove >= CONFIG.spikeThreshold) {
      const direction = price > avgPrice ? "UP" : "DOWN";
      const severity = pctMove >= CONFIG.spikeThreshold * 2 ? "critical" : "warning";
      addAlert(
        "spike",
        severity,
        `Price spike ${direction} ${pctMove.toFixed(2)}% in ${lookback} ticks`,
        now
      );
    }
  }

  // ---- Detection: abnormal tick velocity ----
  function detectVelocity(price, now) {
    if (ticks.length < 5) return;

    // Measure velocity over the last ~1 second of ticks
    const recent = ticks.slice(-5);
    const timeSpan = (recent[recent.length - 1].ts - recent[0].ts) / 1000;
    if (timeSpan < 0.1) return; // too fast to measure meaningfully

    const priceChange = Math.abs(recent[recent.length - 1].price - recent[0].price);
    const pctPerSec = (priceChange / recent[0].price) * 100 / timeSpan;

    if (pctPerSec >= CONFIG.velocityThreshold) {
      const direction = price > recent[0].price ? "accelerating up" : "accelerating down";
      addAlert(
        "velocity",
        "warning",
        `Abnormal velocity: ${pctPerSec.toFixed(2)}%/s ${direction}`,
        now
      );
    }
  }

  // ---- Detection: liquidity trap (spike then sharp reversal) ----
  function detectLiquidityTrap(price, now) {
    if (ticks.length < 8) return;

    // Look for a recent spike followed by a reversal
    const recent = ticks.slice(-8);
    const first = recent[0];
    const mid = recent[Math.floor(recent.length / 2)];
    const last = recent[recent.length - 1];

    // Spike from first to mid
    const spikePct = Math.abs((mid.price - first.price) / first.price) * 100;
    // Reversal from mid to last
    const reversalPct = Math.abs((last.price - mid.price) / mid.price) * 100;

    // Trap: significant spike followed by significant reversal in opposite direction
    const spikeDir = mid.price > first.price ? 1 : -1;
    const reversalDir = last.price > mid.price ? 1 : -1;

    if (spikePct >= CONFIG.spikeThreshold && reversalPct >= CONFIG.trapReversalPct && spikeDir !== reversalDir) {
      const trapType = spikeDir > 0 ? "bull trap" : "bear trap";
      addAlert(
        "trap",
        "critical",
        `Liquidity ${trapType}: ${spikePct.toFixed(2)}% spike reversed ${reversalPct.toFixed(2)}%`,
        now
      );
    }
  }

  // ---- Detection: price clamping (market maker control) ----
  function detectClamping(price, now) {
    if (lastPrice === null) return;

    const pctMove = Math.abs((price - lastPrice) / lastPrice) * 100;

    if (pctMove <= CONFIG.clampThreshold) {
      clampStreak++;
      if (clampStreak >= CONFIG.clampCount) {
        addAlert(
          "clamp",
          "info",
          `Price clamped: ${clampStreak} ticks within ${CONFIG.clampThreshold}%`,
          now
        );
        clampStreak = 0; // reset to avoid spamming
      }
    } else {
      clampStreak = 0;
    }
  }
// ---- Alert management ----
  function addAlert(type, severity, message, ts) {
    // Cooldown per type
    const lastTsForType = lastAlertByType[type] || 0;
    if (ts - lastTsForType < CONFIG.alertCooldown) return;

    lastAlertByType[type] = ts;

    // Create alert
    const alert = {
      id: ++alertCounter,
      type,
      severity,
      message,
      ts,
    };

    alerts.unshift(alert);

    // Cap the number of alerts
    if (alerts.length > CONFIG.maxAlerts) {
      alerts.length = CONFIG.maxAlerts;
    }
  }

  function pruneAlerts(now) {
    const cutoff = now - CONFIG.alertLifetime;
    alerts = alerts.filter(a => a.ts >= cutoff);
  }

  // ---- Widget rendering ----
  function initWidget() {
    if (widgetInitialized) return;

    AnalyticsWidgets.register(
      "anomaly-detector",
      "AI Anomaly Detection",
      (bodyEl) => {
        widgetBodyEl = bodyEl;
        widgetInitialized = true;
        renderWidget();
      },
      { closeable: true }
    );
  }

  function renderWidget() {
    if (!widgetBodyEl) return;

    // Build the widget HTML
    const statusColor = alerts.length === 0 ? "normal" :
      alerts.some(a => a.severity === "critical") ? "critical" :
      alerts.some(a => a.severity === "warning") ? "warning" : "info";

    const statusText = alerts.length === 0 ? "Monitoring" :
      alerts.some(a => a.severity === "critical") ? "Critical" :
      alerts.some(a => a.severity === "warning") ? "Warning" : "Info";

    const alertHtml = alerts.length === 0
      ? `<div class="anomaly-empty">No anomalies detected</div>`
      : alerts.map(a => `
        <div class="anomaly-alert anomaly-${a.severity}">
          <span class="anomaly-alert-badge">${getSeverityIcon(a.severity)}</span>
          <span class="anomaly-alert-msg">${escapeHtml(a.message)}</span>
          <span class="anomaly-alert-time">${formatAlertTime(a.ts)}</span>
        </div>`).join("");

    widgetBodyEl.innerHTML = `
      <div class="anomaly-widget">
        <div class="anomaly-status-row">
          <span class="anomaly-status-dot anomaly-${statusColor}"></span>
          <span class="anomaly-status-text">${statusText}</span>
          <span class="anomaly-tick-count">${ticks.length} ticks</span>
        </div>
        <div class="anomaly-alerts-list">
          ${alertHtml}
        </div>
        <div class="anomaly-metrics">
          <div class="anomaly-metric">
            <span class="anomaly-metric-label">Last Price</span>
            <span class="anomaly-metric-value">${lastPrice !== null ? lastPrice.toFixed(2) : "--"}</span>
          </div>
          <div class="anomaly-metric">
            <span class="anomaly-metric-label">Volatility</span>
            <span class="anomaly-metric-value">${computeVolatility()}</span>
          </div>
          <div class="anomaly-metric">
            <span class="anomaly-metric-label">Clamp Streak</span>
            <span class="anomaly-metric-value">${clampStreak}</span>
          </div>
        </div>
      </div>`;
  }

  function getSeverityIcon(severity) {
    switch (severity) {
      case "critical": return "⚠";
      case "warning": return "▲";
      case "info": return "ℹ";
      default: return "•";
    }
  }

  function formatAlertTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 1000) return "now";
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    return `${Math.floor(diff / 60000)}m ago`;
  }

  function computeVolatility() {
    if (ticks.length < 5) return "--";
    const recent = ticks.slice(-10);
    const prices = recent.map(t => t.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    return (stdDev / mean * 100).toFixed(3) + "%";
  }

  // ---- Public API ----
  return {
    feedTick,
    initWidget,
    getAlerts: () => alerts.slice(),
    getTickCount: () => ticks.length,
    reset: () => {
      ticks = [];
      alerts = [];
      clampStreak = 0;
      lastPrice = null;
      lastTs = null;
      lastAlertByType = {};
    },
  };
})();
// Inline mock candle generator — used only if DataFeed failed to load.
// Produces a realistic-looking random-walk series for any timeframe.
// Generates data covering the full year 2026.
function generateMockCandles(timeframe, count) {
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
  const totalCandles = Math.min(count || 500, Math.floor((now - yearStart) / intervalMs) + 1);

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

function bindEvents() {
  // Chart type buttons
  document.querySelectorAll(".chart-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelector(".chart-type-btn.active")?.classList.remove("active");
      btn.classList.add("active");
      state.currentChartType = btn.dataset.chartType;
      chart.setChartType(state.currentChartType);
    });
  });

  // Timeframe buttons
  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelector(".tf-btn.active")?.classList.remove("active");
      btn.classList.add("active");
      state.currentTimeframe = btn.dataset.tf;
      loadCandles();
    });
  });

document.getElementById("newIndBtn").addEventListener("click", () => {
    state.editorMode = "new";
    state.activeIndex = null;
    document.getElementById("indicatorName").value = "";
    document.getElementById("scriptArea").value = defaultScript();
    document.getElementById("deleteIndBtn").style.display = "none";
    showEditor();
  });

document.getElementById("logoutBtn").addEventListener("click", logout);
}

function defaultScript() {
  return `// Example: SMA crossover
const sma20 = SMA(close, 20);
const sma50 = SMA(close, 50);

let signals = [];
if (crossAbove(sma20, sma50)) {
  signals.push({ type: "buy", text: "BULLISH CROSS", position: "belowBar" });
}
if (crossBelow(sma20, sma50)) {
  signals.push({ type: "sell", text: "SELL CROSS", position: "aboveBar" });
}

return {
  overlays: [
    { name: "SMA 20", data: sma20, color: "#f59e0b" },
    { name: "SMA 50", data: sma50, color: "#3b82f6" }
  ],
  signals: signals
};`;
}

async function loadIndicators() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000); // 3s max wait
    const res = await fetch("/api/indicators", { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      state.allIndicators = data.indicators || [];
      renderIndicatorList();
      refreshIndicatorMenu();
      return;
    }
  } catch (err) {
    // fall through
  }
  // No backend — empty indicator list, dashboard still works
  state.allIndicators = [];
  renderIndicatorList();
  refreshIndicatorMenu();
}

// Ask the Indicators Panel to re-tally its custom-script list (if initialized).
function refreshIndicatorMenu() {
  if (typeof IndicatorMenu !== "undefined" && IndicatorMenu.renderAll) {
    IndicatorMenu.renderAll();
  }
}

function renderIndicatorList() {
  const listEl = document.getElementById("indicatorList");
  if (!listEl) return;

  // Build with DocumentFragment — single DOM insertion, no innerHTML teardown
  const frag = document.createDocumentFragment();

  if (!state.allIndicators.length) {
    const p = document.createElement("p");
    p.className = "empty-list";
    p.textContent = "No indicators yet.";
    frag.appendChild(p);
  } else {
    for (const ind of state.allIndicators) {
      const item = document.createElement("div");
      item.className = "indicator-item";
      item.dataset.id = ind.id;

      const name = document.createElement("span");
      name.className = "ind-name";
      name.textContent = ind.name;

      const actions = document.createElement("div");
      actions.className = "ind-actions";

      const editBtn = document.createElement("button");
      editBtn.className = "icon-btn";
      editBtn.title = "Edit";
      editBtn.textContent = "✏️";
      editBtn.addEventListener("click", () => editIndicator(ind.id));

      actions.appendChild(editBtn);

      if (!ind.is_default) {
        const delBtn = document.createElement("button");
        delBtn.className = "icon-btn";
        delBtn.title = "Delete";
        delBtn.textContent = "🗑️";
        delBtn.addEventListener("click", () => deleteIndicator(ind.id));
        actions.appendChild(delBtn);
      }

      item.appendChild(name);
      item.appendChild(actions);
      frag.appendChild(item);
    }
  }

  listEl.replaceChildren(frag);
}

function editIndicator(id) {
  const ind = state.allIndicators.find(i => i.id === id);
  if (!ind) return;
  state.editorMode = "edit";
  state.activeIndex = id;
  document.getElementById("indicatorName").value = ind.name;
  document.getElementById("scriptArea").value = ind.script;
  document.getElementById("deleteIndBtn").style.display = "block";
  showEditor();
}

function showEditor() {
  document.getElementById("editorModal").classList.remove("hidden");
}

function openEditor() {
  showEditor();
}

function closeEditor() {
  document.getElementById("editorModal").classList.add("hidden");
}

async function saveIndicator() {
  const name = document.getElementById("indicatorName").value.trim();
  const script = document.getElementById("scriptArea").value;

  if (!name || !script) {
    alert("Name and script are required.");
    return;
  }

  const url = state.editorMode === "edit" ? `/api/indicators/${state.activeIndex}` : "/api/indicators";
  const method = state.editorMode === "edit" ? "PUT" : "POST";

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, script }),
    });
    if (!res.ok) throw new Error();
    closeEditor();
    await loadIndicators();
    state._indicatorCache.clear(); // invalidate cache — scripts changed
    runAllIndicators();
  } catch (err) {
    // No backend — keep indicator in-memory so the dashboard still works
    const newInd = {
      id: state.editorMode === "edit" ? state.activeIndex : Date.now(),
      name,
      script,
      is_default: false,
    };
    if (state.editorMode === "edit") {
      const idx = state.allIndicators.findIndex(i => i.id === state.activeIndex);
      if (idx >= 0) state.allIndicators[idx] = newInd;
    } else {
      state.allIndicators.push(newInd);
      // Newly created scripts default to ON so they appear on the chart
      // immediately (mirrors the pre-panel behavior).
      if (!state.indOn) state.indOn = {};
      state.indOn[newInd.id] = true;
      try {
        localStorage.setItem("gold_indOn", JSON.stringify(state.indOn));
      } catch (e) {}
    }
    closeEditor();
    renderIndicatorList();
    refreshIndicatorMenu();
    state._indicatorCache.clear();
    runAllIndicators();
  }
}

async function deleteIndicator(id) {
  if (!id && state.activeIndex !== null) {
    id = state.activeIndex;
  }
  if (!confirm("Delete this indicator?")) return;
  try {
    const res = await fetch(`/api/indicators/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error();
    await loadIndicators();
  } catch (err) {
    // No backend — remove from in-memory list
    state.allIndicators = state.allIndicators.filter(i => i.id !== id);
    renderIndicatorList();
    refreshIndicatorMenu();
    if (state.indOn) delete state.indOn[id];
    if (state.favs) state.favs.delete(id);
    try {
      localStorage.setItem("gold_indOn", JSON.stringify(state.indOn || {}));
      localStorage.setItem("gold_indFav", JSON.stringify(state.favs ? [...state.favs] : []));
    } catch (e) {}
  }
  state._indicatorCache.delete(id); // remove from cache
  runAllIndicators();
  closeEditor();
}

function testIndicator() {
  const scriptable = document.getElementById("scriptArea").value;
  const result = runIndicatorScript(scriptable, state.candles);
  document.getElementById("previewOutput").textContent = JSON.stringify(result.overlays ? {
    overlays: result.overlays.length,
    panes: result.panes?.length || 0,
    signals: result.signals?.length || 0,
  } : result, null, 2);
}

async function runAllIndicators() {
  // Delegate to the Indicators Panel renderer — it clears the chart once and
  // redraws every enabled built-in + custom indicator (respecting toggles).
  if (typeof IndicatorMenu !== "undefined" && IndicatorMenu.renderChartIndicators) {
    IndicatorMenu.renderChartIndicators();
    return;
  }
  // Fallback (panel not available): legacy behavior covering only custom scripts.
  chart.clearAll();
  const candleCount = state.candles.length;

  for (const ind of state.allIndicators) {
    try {
      const cached = state._indicatorCache.get(ind.id);
      if (cached && cached.candleCount === candleCount) {
        applyIndicatorResult(ind, cached.result);
        continue;
      }

      const result = runIndicatorScript(ind.script, state.candles);
      state._indicatorCache.set(ind.id, { result, candleCount });
      applyIndicatorResult(ind, result);
    } catch (err) {
      console.error(`Indicator "${ind.name}" failed:`, err.message);
    }
  }
}

function applyIndicatorResult(ind, result) {
  if (result.overlays) {
    result.overlays.forEach((ov, i) => {
      chart.plotOverlay(`${ind.id}-ov-${i}`, ov.data.map((val, idx) => ({
        time: state.candles[idx].time,
        value: val,
      })), { color: ov.color || "#22d3ee", lineWidth: 2 });
    });
  }
  if (result.panes) {
    result.panes.forEach((p, i) => {
      chart.plotPane(`${ind.id}-pane-${i}`, p.data.map((val, idx) => ({
        time: state.candles[idx].time,
        value: val,
      })), { color: p.color || "#a78bfa", lineWidth: 1.5 });
    });
  }
  if (result.signals?.length) {
    chart.plotSignals(result.signals);
  }
}

// Lightweight live-tick update: only recompute indicators that depend on
// the last candle, without clearing/re-plotting the whole chart.
function updateIndicatorsLive() {
  const candleCount = state.candles.length;
  const on = (state.indOn || {});

  for (const ind of state.allIndicators) {
    if (!on[ind.id]) continue; // indicator is toggled off — skip live update
    const cached = state._indicatorCache.get(ind.id);
    if (!cached || cached.candleCount !== candleCount) {
      // Dataset changed (new candle) — full recompute for this indicator
      try {
        const result = runIndicatorScript(ind.script, state.candles);
        state._indicatorCache.set(ind.id, { result, candleCount });
        // Re-plot this indicator's series
        chart.removeIndicatorSeries(ind.id);
        applyIndicatorResult(ind, result);
      } catch (err) {
        console.error(`Indicator "${ind.name}" live update failed:`, err.message);
      }
    }
    // If candleCount matches, the last candle was just mutated in place —
    // the cached result's last value is stale but the series data is
    // already updated via chart.updateLastCandle. Skip recompute.
  }
}

// Route an incoming price tick into the shared buffer so the chart
// renders it live (see flushPriceBuffer below).
function enqueuePriceTick(price, ts) {
  state._wsBuffer.push({ type: "price", price, ts });
  if (!state._wsFlushPending) {
    state._wsFlushPending = true;
    requestAnimationFrame(flushPriceBuffer);
  }
}

function bindWebSocket() {
  // Prefer the Socket.io real-time tick stream (keeps the chart constantly
  // animating); fall back to the native WebSocket, then to DataFeed simulation.
  if (typeof window.io !== "undefined") {
    try {
      const socket = io({ transports: ["websocket", "polling"] });
      state.ws = socket;
      state._feedConnected = false;

      socket.on("connect", () => {
        state._feedConnected = false; // history event below marks it
      });

      // Catch-up history on connect
      socket.on("tick_history", (data) => {
        state._feedConnected = true;
        if (data && Array.isArray(data.ticks) && data.ticks.length > 0) {
          const lastTick = data.ticks[data.ticks.length - 1];
          enqueuePriceTick(lastTick.price, lastTick.ts);
        }
      });

      // Live XAU/USD tick
      socket.on("price", (tick) => {
        state._feedConnected = true;
        if (tick && typeof tick.price === "number") {
          enqueuePriceTick(tick.price, tick.ts || Date.now());
        }
      });
      socket.on("tick", (tick) => {
        state._feedConnected = true;
        if (tick && typeof tick.price === "number") {
          enqueuePriceTick(tick.price, tick.ts || Date.now());
        }
      });

      socket.on("disconnect", () => {
        state._feedConnected = false;
      });
      socket.on("connect_error", () => {
        // Socket.io unavailable at runtime — try the raw WebSocket endpoint.
        startRawWebSocket();
      });

      return;
    } catch (err) {
      // Fall through to the raw WebSocket / DataFeed simulation
    }
  }

  startRawWebSocket();
}

// Native WebSocket fallback if Socket.io can't connect.
function startRawWebSocket() {
  if (state._rawWsStarted) return;
  state._rawWsStarted = true;

  let wsConnected = false;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    state.ws = ws;

    ws.onopen = () => {
      wsConnected = true;
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      // Handle tick history catch-up on connect
      if (data.type === "tick_history" && Array.isArray(data.ticks)) {
        if (data.ticks.length > 0) {
          const lastTick = data.ticks[data.ticks.length - 1];
          enqueuePriceTick(lastTick.price, lastTick.ts);
        }
        return;
      }

      if (data.type === "price") {
        enqueuePriceTick(data.price, data.ts);
      }
    };

    ws.onerror = () => {
      wsConnected = false;
      startDataFeedFallback();
    };

    ws.onclose = () => {
      if (!wsConnected) startDataFeedFallback();
    };
  } catch (err) {
    startDataFeedFallback();
  }
}

// Fallback: use the simulated DataFeed price stream
function startDataFeedFallback() {
  if (state._feedUnsub || typeof DataFeed === "undefined") return;
  state._feedUnsub = DataFeed.subscribePrice((price, ts) => {
    state._wsBuffer.push({ type: "price", price, ts });
    if (!state._wsFlushPending) {
      state._wsFlushPending = true;
      requestAnimationFrame(flushPriceBuffer);
    }
  });
}

// ============================================================
// 100 Pips Price Shift Alert System
// Detects when XAU/USD moves $10.00 (100 pips) within a short
// window and triggers an audio beep + prominent red banner.
// ============================================================
const PipsAlertSystem = (() => {
  // 1 pip for XAU/USD = $0.10, so 100 pips = $10.00
  const SHIFT_THRESHOLD = 10.00;
  const WINDOW_MS = 60 * 1000; // 60-second rolling window
  const COOLDOWN_MS = 30 * 1000; // min 30s between alerts
  const BANNER_AUTO_HIDE_MS = 15 * 1000; // auto-hide banner after 15s

  let priceHistory = [];       // { price, ts }
  let lastAlertTs = 0;
  let bannerEl = null;
  let bannerTimer = null;
  let audioCtx = null;

  function init() {
    bannerEl = document.getElementById("pipsAlertBanner");
    const closeBtn = document.getElementById("pipsAlertClose");
    if (closeBtn) {
      closeBtn.addEventListener("click", hideBanner);
    }
  }

  // Feed a price tick into the detector
  function feedTick(price, ts) {
    if (typeof price !== "number" || !isFinite(price)) return;
    const now = ts || Date.now();

    // Add to rolling window
    priceHistory.push({ price, ts: now });

    // Prune entries older than the window
    const cutoff = now - WINDOW_MS;
    priceHistory = priceHistory.filter(p => p.ts >= cutoff);

    // Need at least 2 points to measure a shift
    if (priceHistory.length < 2) return;

    // Check if price moved >= $10.00 within the window
    const first = priceHistory[0];
    const last = priceHistory[priceHistory.length - 1];
    const shift = Math.abs(last.price - first.price);

    if (shift >= SHIFT_THRESHOLD) {
      // Check cooldown
      if (now - lastAlertTs < COOLDOWN_MS) return;
      lastAlertTs = now;

      triggerAlert(shift, first.price, last.price, now);
    }
  }

  function triggerAlert(shift, fromPrice, toPrice, ts) {
    const direction = toPrice > fromPrice ? "UP" : "DOWN";
    const shiftFormatted = shift.toFixed(2);
    const fromFormatted = fromPrice.toFixed(2);
    const toFormatted = toPrice.toFixed(2);

    // Play audio beep
    playAlertBeep();

    // Show the red banner
    showBanner(direction, shiftFormatted, fromFormatted, toFormatted);

    // Speak the alert via voice if TTS is enabled
    if (typeof VoiceCommand !== "undefined") {
      const saved = localStorage.getItem("gold_lang");
      const lang = saved === "ckb" || saved === "ar" ? "ckb" : "en";
      const msg = lang === "ckb"
        ? `ئاگاداری! نرخی زێڕ ${shiftFormatted} دۆلار گۆڕا بۆ ${direction === "UP" ? "سەرەوە" : "خوارەوە"} لە ${fromFormatted} بۆ ${toFormatted}`
        : `Alert! Gold price shifted ${shiftFormatted} dollars ${direction === "UP" ? "up" : "down"} from ${fromFormatted} to ${toFormatted}`;
      VoiceCommand.speak(msg);
    }
  }

  function showBanner(direction, shift, fromPrice, toPrice) {
    if (!bannerEl) return;

    const titleEl = document.getElementById("pipsAlertTitle");
    const detailEl = document.getElementById("pipsAlertDetail");

    if (titleEl) {
      titleEl.textContent = direction === "UP"
        ? "⚠️ PRICE SHIFT UP — 100+ PIPS"
        : "⚠️ PRICE SHIFT DOWN — 100+ PIPS";
    }
    if (detailEl) {
      detailEl.textContent = `Gold moved $${shift} ${direction === "UP" ? "up" : "down"} from $${fromPrice} to $${toPrice} in the last minute`;
    }

    // Show banner
    bannerEl.classList.remove("hidden");
    bannerEl.classList.add("pulse");

    // Auto-hide after a delay
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, BANNER_AUTO_HIDE_MS);
  }

  function hideBanner() {
    if (!bannerEl) return;
    bannerEl.classList.add("hidden");
    bannerEl.classList.remove("pulse");
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
  }

  // Play a loud alert beep using Web Audio API
  function playAlertBeep() {
    try {
      if (!audioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        audioCtx = new AudioCtx();
      }

      // Three beeps: high-low-high
      const beepPattern = [
        { freq: 880, duration: 0.15, delay: 0 },
        { freq: 660, duration: 0.15, delay: 0.2 },
        { freq: 880, duration: 0.3, delay: 0.4 },
      ];

      beepPattern.forEach(({ freq, duration, delay }) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.5, audioCtx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + delay + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + duration);
      });
    } catch (e) {
      // Audio not available — fall back to a simple beep via Audio element
      try {
        const beep = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA");
        beep.play();
      } catch (e2) {
        // No audio available at all
      }
    }
  }

  // Public API
  return {
    init,
    feedTick,
    hideBanner,
  };
})();

function flushPriceBuffer() {
  state._wsFlushPending = false;
  if (state._wsBuffer.length === 0) return;

  // Feed ALL buffered ticks to the anomaly detector for real-time analysis
  for (const tick of state._wsBuffer) {
    AnomalyDetector.feedTick(tick.price, tick.ts);
  }

  // Feed ticks to the 100 Pips Price Shift Alert System
  for (const tick of state._wsBuffer) {
    PipsAlertSystem.feedTick(tick.price, tick.ts);
  }

  // Check price alerts against the latest tick
  const latestTick = state._wsBuffer[state._wsBuffer.length - 1];
  if (latestTick && typeof VoiceCommand !== "undefined") {
    VoiceCommand.checkPriceAlerts(latestTick.price);
  }

  // Take the latest tick only — intermediate ticks are redundant for display
  const latest = state._wsBuffer[state._wsBuffer.length - 1];
  state._wsBuffer.length = 0;

  // Update price display (lightweight DOM write)
  if (state._lastPriceEl) {
    state._lastPriceEl.textContent = latest.price.toFixed(2);
  }

  // Update the DataFeed store for ALL timeframes (MT5-style multi-TF sync)
  if (typeof DataFeed !== "undefined") {
    DataFeed.addTickToStore(latest.price, latest.ts);
  }

  // Update candle
  const last = state.candles[state.candles.length - 1];
  if (!last) return;

  const currentBucket = Math.floor(latest.ts / (60 * 1000)); // 1m
  const lastBucket = Math.floor(last.time * 1000);

  if (currentBucket > lastBucket) {
    // New candle — push, update chart, drop oldest
    const newCandle = {
      time: Math.floor(latest.ts / 1000),
      open: latest.price,
      high: latest.price,
      low: latest.price,
      close: latest.price,
      volume: 0,
    };
    state.candles.push(newCandle);
    chart.updateLastCandle(newCandle);
    state.candles.shift();
    // MT5-style: auto-scroll only if the user is still at the latest candle
    if (state._atLatestCandle) {
      chart.scrollToRealTime();
    }
    // Dataset length changed — recompute indicators (throttled)
    const now = Date.now();
    if (now - state._lastIndicatorRun > 500) {
      state._lastIndicatorRun = now;
      updateIndicatorsLive();
    }
  } else {
    // Mutate last candle in place — use smooth interpolation for the close
    last.high = Math.max(last.high, latest.price);
    last.low = Math.min(last.low, latest.price);

    // Smooth price transition: animate the close from its current value
    // toward the new tick price over ~120ms. This gives the MT5 "liquid" feel
    // instead of the price jumping instantly.
    const prevClose = last.close;
    last.close = latest.price;

    if (prevClose !== latest.price) {
      // Start a smooth interpolation from the previous close to the new price
      state._smoothStart = prevClose;
      state._smoothTarget = latest.price;
      state._smoothStartTs = performance.now();
      state._smoothActive = true;

      // Kick off the animation loop if not already running
      if (!state._smoothRaf) {
        state._smoothRaf = requestAnimationFrame(smoothTickFrame);
      }
    } else {
      // No change — just update the chart directly
      chart.updateLastCandle(last);
    }
  }
}

// Smooth tick interpolation — animates the last candle's close from its
// previous value toward the target over _smoothDuration ms. Called on each
// animation frame while an interpolation is active.
function smoothTickFrame(now) {
  state._smoothRaf = null;

  if (!state._smoothActive) return;

  const elapsed = now - state._smoothStartTs;
  const t = Math.min(1, elapsed / state._smoothDuration);

  // Ease-out curve for a natural, non-jarring transition
  const eased = 1 - Math.pow(1 - t, 3);

  const interpolated = state._smoothStart + (state._smoothTarget - state._smoothStart) * eased;

  const last = state.candles[state.candles.length - 1];
  if (last) {
    last.close = parseFloat(interpolated.toFixed(2));
    chart.updateLastCandle(last);
  }

  if (t < 1) {
    // Continue the animation
    state._smoothRaf = requestAnimationFrame(smoothTickFrame);
  } else {
    // Animation complete
    state._smoothActive = false;
    if (last) {
      last.close = state._smoothTarget;
      chart.updateLastCandle(last);
    }
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (err) {
    // No backend — just redirect
  }
  window.location.href = "login.html";
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================
// Settings Modal — Language & Theme
// ============================================================
function initSettings() {
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsModal = document.getElementById("settingsModal");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");
  const languageSelect = document.getElementById("languageSelect");
  const themeToggle = document.getElementById("themeToggle");

  if (!settingsBtn || !settingsModal || !closeSettingsBtn || !languageSelect || !themeToggle) return;

  // Open settings
  settingsBtn.addEventListener("click", () => {
    settingsModal.classList.remove("hidden");
  });

  // Close settings
  closeSettingsBtn.addEventListener("click", () => {
    settingsModal.classList.add("hidden");
  });

  // Close on backdrop click
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) {
      settingsModal.classList.add("hidden");
    }
  });

  // Load saved preferences
  const savedLang = localStorage.getItem("gold_lang") || "en";
  const savedTheme = localStorage.getItem("gold_theme") || "dark";
  languageSelect.value = savedLang;
  themeToggle.checked = savedTheme === "light";

  // Apply saved theme on load
  if (savedTheme === "light") {
    document.body.classList.add("light-theme");
  }

  // Apply saved language on load
  applyLanguage(savedLang);

  // Language change
  languageSelect.addEventListener("change", () => {
    localStorage.setItem("gold_lang", languageSelect.value);
    applyLanguage(languageSelect.value);
  });

  // Theme toggle
  themeToggle.addEventListener("change", () => {
    const theme = themeToggle.checked ? "light" : "dark";
    localStorage.setItem("gold_theme", theme);
    document.body.classList.toggle("light-theme", themeToggle.checked);
  });
}

// Simple language dictionary
const translations = {
  en: {
    brand: "⚡ حەمزە گۆڵد",
    livePrice: "Live Price",
    indicators: "Indicators",
    newIndicator: "+ New Indicator",
    quickNotes: "📝 Quick Notes",
    notesPlaceholder: "Type your trading notes here...",
    save: "Save",
    clear: "Clear",
    settings: "⚙ Settings",
    logout: "Log out",
    chartType: "Chart Type",
    timeframe: "Timeframe",
    candles: "Candles",
    bars: "Bars",
    line: "Line",
    area: "Area",
    baseline: "Baseline",
    histogram: "Histogram",
    noIndicators: "No indicators yet.",
    settingsTitle: "⚙ Settings",
    language: "Language",
    languageDesc: "Choose your display language",
    theme: "Theme",
    themeDesc: "Switch between light and dark mode",
  },
  ckb: {
    brand: "⚡ حەمزە گۆڵد",
    livePrice: "نرخی ڕاستەوخۆ",
    indicators: "ئینдикаتەرەکان",
    newIndicator: "+ ئینдикаتەری نوێ",
    quickNotes: "📝 تێبینیەکان",
    notesPlaceholder: "تێبینییەکانی بازرگانییەکەت لێرە بنووسە...",
    save: "پاشەکەوت",
    clear: "سڕینەوە",
    settings: "⚙ ڕێکخستنەکان",
    logout: "چوونەدەرەوە",
    chartType: "جۆری چارت",
    timeframe: "ماوە",
    candles: "شمعدان",
    bars: "ستوون",
    line: "هێڵ",
    area: "ناوچە",
    baseline: "هێڵی بنەڕەت",
    histogram: "هیستۆگرام",
    noIndicators: "هیچ ئینдикаتەرێک نییە.",
    settingsTitle: "⚙ ڕێکخستنەکان",
    language: "زمان",
    languageDesc: "زمانی نمایش هەڵبژێرە",
    theme: "ڕووکار",
    themeDesc: "گۆڕین لە نێوان ڕووناک و تاریک",
  },
  ar: {
    brand: "⚡ حەمزە گۆڵد",
    livePrice: "السعر المباشر",
    indicators: "المؤشرات",
    newIndicator: "+ مؤشر جديد",
    quickNotes: "📝 ملاحظات سريعة",
    notesPlaceholder: "اكتب ملاحظات التداول هنا...",
    save: "حفظ",
    clear: "مسح",
    settings: "⚙ الإعدادات",
    logout: "تسجيل الخروج",
    chartType: "نوع الرسم",
    timeframe: "الإطار الزمني",
    candles: "شموع",
    bars: "أعمدة",
    line: "خط",
    area: "منطقة",
    baseline: "خط أساس",
    histogram: "مدرج تكراري",
    noIndicators: "لا توجد مؤشرات بعد.",
    settingsTitle: "⚙ الإعدادات",
    language: "اللغة",
    languageDesc: "اختر لغة العرض",
    theme: "السمة",
    themeDesc: "التبديل بين الوضع الفاتح والداكن",
  },
};

function applyLanguage(lang) {
  const t = translations[lang] || translations.en;

  // Sidebar
  const brand = document.querySelector(".brand");
  if (brand) brand.textContent = t.brand;

  const sections = document.querySelectorAll(".sidebar-section h3");
  if (sections[0]) sections[0].textContent = t.livePrice;
  if (sections[1]) sections[1].textContent = t.indicators;
  if (sections[2]) sections[2].textContent = t.quickNotes;

  const newIndBtn = document.getElementById("newIndBtn");
  if (newIndBtn) newIndBtn.textContent = t.newIndicator;

  const notesTextarea = document.getElementById("quickNotes");
  if (notesTextarea) notesTextarea.placeholder = t.notesPlaceholder;

  const saveNotesBtn = document.getElementById("saveNotesBtn");
  if (saveNotesBtn) saveNotesBtn.textContent = t.save;

  const clearNotesBtn = document.getElementById("clearNotesBtn");
  if (clearNotesBtn) clearNotesBtn.textContent = t.clear;

  const settingsBtn = document.getElementById("settingsBtn");
  if (settingsBtn) settingsBtn.textContent = t.settings;

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.textContent = t.logout;

  // Chart controls
  const controlLabels = document.querySelectorAll(".control-label");
  if (controlLabels[0]) controlLabels[0].textContent = t.chartType;
  if (controlLabels[1]) controlLabels[1].textContent = t.timeframe;

  const chartTypeBtns = document.querySelectorAll(".chart-type-btn");
  const chartTypeMap = { candles: t.candles, bars: t.bars, line: t.line, area: t.area, baseline: t.baseline, histogram: t.histogram };
  chartTypeBtns.forEach(btn => {
    btn.textContent = chartTypeMap[btn.dataset.chartType] || btn.textContent;
  });

  // Settings modal
  const settingsTitle = document.querySelector("#settingsModal .modal-header h3");
  if (settingsTitle) settingsTitle.textContent = t.settingsTitle;

  const settingLabels = document.querySelectorAll(".setting-label");
  if (settingLabels[0]) settingLabels[0].textContent = t.language;
  if (settingLabels[1]) settingLabels[1].textContent = t.theme;

  const settingDescs = document.querySelectorAll(".setting-desc");
  if (settingDescs[0]) settingDescs[0].textContent = t.languageDesc;
  if (settingDescs[1]) settingDescs[1].textContent = t.themeDesc;

  // Empty list message
  const emptyList = document.querySelector(".empty-list");
  if (emptyList) emptyList.textContent = t.noIndicators;

  // RTL for Arabic
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
}

// ============================================================
// Market Sessions Clock
// ============================================================
// Session definitions in UTC. Forex sessions (approximate):
//   Sydney:   22:00 - 07:00 UTC
//   Tokyo:    00:00 - 09:00 UTC
//   London:   08:00 - 17:00 UTC
//   New York: 13:00 - 22:00 UTC
const SESSIONS = [
  { id: "sydney",   name: "Sydney",   start: 22, end: 7,  tz: "Australia/Sydney" },
  { id: "tokyo",    name: "Tokyo",    start: 0,  end: 9,  tz: "Asia/Tokyo" },
  { id: "london",   name: "London",   start: 8,  end: 17, tz: "Europe/London" },
  { id: "newyork",  name: "New York", start: 13, end: 22, tz: "America/New_York" },
];

function initSessionsClock() {
  const widget = document.querySelector(".sessions-widget");
  if (!widget) return;

  // Update immediately, then every 30 seconds
  updateSessions();
  setInterval(updateSessions, 30000);
}

function updateSessions() {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const openSessions = [];

  for (const s of SESSIONS) {
    const row = document.querySelector(`[data-session="${s.id}"]`);
    if (!row) continue;

    // Handle sessions that cross midnight (start > end)
    let isOpen;
    if (s.start <= s.end) {
      isOpen = utcHour >= s.start && utcHour < s.end;
    } else {
      isOpen = utcHour >= s.start || utcHour < s.end;
    }

    // Update row classes
    row.classList.toggle("open", isOpen);
    row.classList.toggle("closed", !isOpen);

    // Update time display (local time of the session's exchange)
    const timeEl = document.getElementById(`${s.id}Time`);
    if (timeEl) {
      try {
        timeEl.textContent = now.toLocaleTimeString("en-GB", {
          timeZone: s.tz,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
      } catch (e) {
        // Fallback if timezone unsupported
        timeEl.textContent = "--:--";
      }
    }

    // Update status label
    const statusEl = document.getElementById(`${s.id}Status`);
    if (statusEl) {
      statusEl.textContent = isOpen ? "Open" : "Closed";
    }

    if (isOpen) openSessions.push(s.name);
  }

  // Update overlap indicator
  const overlapEl = document.getElementById("sessionOverlap");
  if (overlapEl) {
    if (openSessions.length === 0) {
      overlapEl.textContent = "All markets closed";
    } else if (openSessions.length === 1) {
      overlapEl.textContent = `${openSessions[0]} session active`;
    } else {
      overlapEl.textContent = `Overlap: ${openSessions.join(" + ")}`;
    }
  }
}

// ============================================================
// Live Economic News / Calendar Ticker
// ============================================================
// Country flags and high-impact economic events (simulated feed).
// In production, swap the data source for a real API (e.g. ForexFactory,
// Investing.com, or a paid economic calendar feed).
const NEWS_EVENTS = [
  { time: "08:30", flag: "🇺🇸", country: "US", title: "Non-Farm Payrolls", impact: "high", forecast: "185K" },
  { time: "10:00", flag: "🇺🇸", country: "US", title: "ISM Manufacturing PMI", impact: "high", forecast: "49.8" },
  { time: "14:00", flag: "🇺🇸", country: "US", title: "FOMC Rate Decision", impact: "high", forecast: "5.50%" },
  { time: "07:00", flag: "🇬🇧", country: "UK", title: "CPI YoY", impact: "high", forecast: "2.1%" },
  { time: "09:30", flag: "🇬🇧", country: "UK", title: "GDP m/m", impact: "medium", forecast: "0.2%" },
  { time: "04:30", flag: "🇯🇵", country: "JP", title: "BoJ Policy Rate", impact: "high", forecast: "-0.10%" },
  { time: "06:00", flag: "🇯🇵", country: "JP", title: "Industrial Production m/m", impact: "medium", forecast: "0.5%" },
  { time: "02:00", flag: "🇦🇺", country: "AU", title: "RBA Rate Statement", impact: "high", forecast: "4.35%" },
  { time: "03:30", flag: "🇦🇺", country: "AU", title: "CPI q/q", impact: "high", forecast: "1.0%" },
  { time: "08:00", flag: "🇪🇺", country: "EU", title: "ECB Interest Rate Decision", impact: "high", forecast: "4.00%" },
  { time: "09:00", flag: "🇪🇺", country: "EU", title: "Eurozone CPI Flash Estimate", impact: "high", forecast: "2.4%" },
  { time: "12:30", flag: "🇨🇦", country: "CA", title: "Employment Change", impact: "medium", forecast: "25K" },
  { time: "13:30", flag: "🇺🇸", country: "US", title: "Core PCE Price Index m/m", impact: "high", forecast: "0.2%" },
  { time: "15:00", flag: "🇺🇸", country: "US", title: "Crude Oil Inventories", impact: "medium", forecast: "-1.2M" },
  { time: "05:00", flag: "🇨🇳", country: "CN", title: "GDP y/y", impact: "high", forecast: "5.0%" },
  { time: "07:30", flag: "🇨🇭", country: "CH", title: "SNB Policy Rate", impact: "medium", forecast: "1.50%" },
];

// Headline news items for the ticker
const NEWS_HEADLINES = [
  { flag: "🇺🇸", time: "10:32", title: "Fed's Powell signals patience on rate cuts", impact: "high" },
  { flag: "🇪🇺", time: "09:45", title: "ECB holds rates, hints at June cut", impact: "high" },
  { flag: "🇬🇧", time: "08:15", title: "UK inflation cools to 2.1%, BoE on watch", impact: "medium" },
  { flag: "🇯🇵", time: "04:20", title: "BoJ intervenes as yen weakens past 155", impact: "high" },
  { flag: "🇨🇳", time: "03:05", title: "China GDP beats estimates at 5.2%", impact: "high" },
  { flag: "🇦🇺", time: "02:30", title: "RBA holds cash rate at 4.35%", impact: "medium" },
  { flag: "🇺🇸", time: "14:00", title: "Gold hits record high above $2,400", impact: "high" },
  { flag: "🇨🇦", time: "12:45", title: "Canada adds 25K jobs, unemployment steady", impact: "low" },
];

function initNewsTicker() {
  const ticker = document.getElementById("newsTicker");
  const track = document.getElementById("newsTickerTrack");
  const calendar = document.getElementById("newsCalendar");
  const toggle = document.getElementById("newsTickerToggle");
  const calendarList = document.getElementById("newsCalendarList");
  const calendarCount = document.getElementById("newsCalendarCount");

  if (!ticker || !track || !calendar || !toggle || !calendarList || !calendarCount) return;

  // Build ticker items (duplicate for seamless loop)
  const items = NEWS_HEADLINES.map(headline => {
    const el = document.createElement("span");
    el.className = "news-ticker-item";
    el.innerHTML = `
      <span class="news-flag">${headline.flag}</span>
      <span class="news-time">${headline.time}</span>
      <span class="news-title">${headline.title}</span>
      <span class="news-impact ${headline.impact}">${headline.impact}</span>
    `;
    return el;
  });

  // Duplicate items for seamless infinite scroll
  items.forEach(item => track.appendChild(item.cloneNode(true)));
  items.forEach(item => track.appendChild(item.cloneNode(true)));

  // Build calendar events
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const events = NEWS_EVENTS.map(ev => {
    const [h, m] = ev.time.split(":").map(Number);
    const eventDate = new Date(now);
    eventDate.setHours(h, m, 0, 0);
    return { ...ev, date: eventDate };
  }).sort((a, b) => a.date - b.date);

  // Show only upcoming events (today)
  const upcoming = events.filter(ev => ev.date >= now);

  calendarList.innerHTML = "";
  if (upcoming.length === 0) {
    calendarList.innerHTML = `<div class="news-event"><span class="news-event-name" style="color:var(--text-muted)">No more events today</span></div>`;
    calendarCount.textContent = "0 events";
  } else {
    upcoming.forEach(ev => {
      const el = document.createElement("div");
      el.className = "news-event";
      el.innerHTML = `
        <span class="news-event-time">${ev.time}</span>
        <span class="news-event-flag">${ev.flag}</span>
        <div class="news-event-info">
          <div class="news-event-name">${ev.title}</div>
          <div class="news-event-forecast">Forecast: ${ev.forecast}</div>
        </div>
        <span class="news-event-impact ${ev.impact}">${ev.impact}</span>
      `;
      calendarList.appendChild(el);
    });
    calendarCount.textContent = `${upcoming.length} events`;
  }

  // Toggle calendar panel
  toggle.addEventListener("click", () => {
    const isCollapsed = ticker.classList.toggle("collapsed");
    calendar.classList.toggle("hidden", !isCollapsed);
  });
}

// ============================================================
// Draggable Widget Dock
// Economic News / High-Impact Events / Technical Summary can be
// reordered by dragging their grips, or pinned to the top/bottom
// of the page. Order + position are persisted to localStorage.
// ============================================================
const WidgetDock = (() => {
  const STORAGE_KEY = "gold_widget_dock";
  const DOCK_ID = "widget-dock";
  const DOCKABLE = [
    { id: "newsTicker", selector: ".news-ticker-header", label: "Economic News" },
    { id: "newsCalendar", selector: ".news-calendar-header", label: "High-Impact Events" },
    { id: "indicatorBoard", selector: ".indicator-board-header", label: "Technical Summary" },
  ];

  function loadLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveLayout(orderIds, bottom) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ order: orderIds, bottom: !!bottom }));
    } catch (e) {}
  }

  function clearLayout() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function dockElement() {
    const first = document.getElementById(DOCKABLE[0].id);
    return first ? first.closest("#" + DOCK_ID) : null;
  }

  function currentOrder() {
    const out = [];
    const dock = dockElement();
    if (dock) dock.querySelectorAll("[data-dockable]").forEach((el) => { if (el.id) out.push(el.id); });
    return out;
  }

  function reorderTo(orderIds) {
    const dock = dockElement();
    if (!dock) return;
    orderIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) dock.appendChild(el);
    });
  }

  function setBottom(isBottom) {
    const dock = dockElement();
    if (!dock) return;
    const main = dock.closest(".main");
    const chartFooter = main ? main.querySelector(".chart-footer") : null;

    // The main chart always stays at the very top of the page. The widget
    // dock lives in the analytics zone below the chart: "bottom" pins it to
    // the end of the main column, "top" pins it just under the chart footer.
    if (isBottom) {
      dock.classList.add("bottom-docked");
      if (main) main.appendChild(dock);
    } else {
      dock.classList.remove("bottom-docked");
      if (main && chartFooter) chartFooter.insertAdjacentElement("afterend", dock);
    }

    const pinBottom = document.getElementById("dockPinBottom");
    const pinTop = document.getElementById("dockPinTop");
    if (pinBottom) pinBottom.hidden = !!isBottom;
    if (pinTop) pinTop.hidden = !isBottom;
  }

  function addGrip(widget, header) {
    if (!header || header.querySelector(".dock-widget-grip")) return;
    const label = (DOCKABLE.find((d) => d.id === widget.id) || {}).label || "widget";
    const grip = document.createElement("span");
    grip.className = "dock-widget-grip";
    grip.setAttribute("draggable", "true");
    grip.setAttribute("title", "Drag to reorder " + label);
    grip.setAttribute("aria-label", "Drag to reorder " + label);
    grip.textContent = "\u22EE\u22EE"; // ⋮⋮
    header.insertBefore(grip, header.firstChild);

    grip.addEventListener("dragstart", (e) => {
      const w = grip.closest("[data-dockable]");
      if (!w) return;
      e.dataTransfer.setData("text/plain", w.id);
      e.dataTransfer.effectAllowed = "move";
      w.classList.add("dragging");
      const dock = dockElement();
      if (dock) dock.classList.add("drag-active");
    });
  }

  function attachHandlers(dock) {
    dock.querySelectorAll("[data-dockable]").forEach((widget) => {
      widget.addEventListener("dragend", () => {
        widget.classList.remove("dragging", "drop-target", "drag-hint");
        dock.classList.remove("drag-active");
      });
      widget.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const sourceId = e.dataTransfer.getData("text/plain");
        if (!sourceId || sourceId === widget.id) {
          widget.classList.remove("drag-hint", "drop-target");
          return;
        }
        widget.classList.add("drag-hint");
      });
      widget.addEventListener("dragleave", () => widget.classList.remove("drop-target"));
      widget.addEventListener("drop", (e) => {
        e.preventDefault();
        const sourceId = e.dataTransfer.getData("text/plain");
        widget.classList.remove("drop-target", "drag-hint");
        dock.classList.remove("drag-active");
        if (!sourceId || sourceId === widget.id) return;
        const source = document.getElementById(sourceId);
        if (!source || source === widget) return;

        // Insert before or after the hovered widget depending on the
        // pointer's vertical position within the widget.
        const rect = widget.getBoundingClientRect();
        const belowMidpoint = e.clientY > rect.top + rect.height / 2;
        if (belowMidpoint) {
          if (widget.nextSibling) widget.parentNode.insertBefore(source, widget.nextSibling);
          else dock.appendChild(source);
        } else {
          dock.insertBefore(source, widget);
        }
        saveLayout(currentOrder(), dock.classList.contains("bottom-docked"));
      });
    });
  }

  function init() {
    const dock = dockElement();
    if (!dock) return;

    DOCKABLE.forEach((d) => {
      const widget = document.getElementById(d.id);
      if (!widget) return;
      widget.setAttribute("data-dockable", "true");
      const header = widget.querySelector(".news-ticker-header, .news-calendar-header, .indicator-board-header");
      addGrip(widget, header);
    });

    // Wire drag-and-drop reordering on each dockable widget
    attachHandlers(dock);

    const layout = loadLayout();
    if (layout) {
      if (Array.isArray(layout.order) && layout.order.length) {
        const known = layout.order.filter((id) => document.getElementById(id));
        if (known.length) reorderTo(known);
      }
      if (layout.bottom) setBottom(true);
    }

    const pinBottom = document.getElementById("dockPinBottom");
    const pinTop = document.getElementById("dockPinTop");
    const reset = document.getElementById("dockReset");
    if (pinBottom) pinBottom.addEventListener("click", () => { setBottom(true); saveLayout(currentOrder(), true); });
    if (pinTop) pinTop.addEventListener("click", () => { setBottom(false); saveLayout(currentOrder(), false); });
    if (reset) reset.addEventListener("click", () => {
      clearLayout();
      reorderTo(DOCKABLE.map((d) => d.id));
      setBottom(false);
      saveLayout(currentOrder(), false);
    });
  }

  return { init };
})();

function initWidgetDock() {
  WidgetDock.init();
}

// ============================================================
// ============================================================
// TradingView-style Indicators Panel
// Professional indicator menu: search, categorized sections
// (Favorites / Built-in / Custom), interactive toggles.
// ============================================================
const IndicatorMenu = (() => {
  // Local helper computes (kept separate from board helpers to stay modular and
  // avoid polluting the global indicator function namespace).
  const computeBands = (data, period, mult) => {
    const mid = computeSMA(data, period);
    const up = new Array(data.length).fill(0);
    const lo = new Array(data.length).fill(0);
    for (let i = period - 1; i < data.length; i++) {
      let s = 0;
      for (let j = 0; j < period; j++) s += (data[i - j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / period);
      up[i] = mid[i] + mult * sd;
      lo[i] = mid[i] - mult * sd;
    }
    return { mid, up, lo };
  };

  const computeStoch = (high, low, close, kPeriod, dPeriod) => {
    const k = new Array(close.length).fill(50);
    const d = new Array(close.length).fill(50);
    for (let i = kPeriod - 1; i < close.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = 0; j < kPeriod; j++) {
        hh = Math.max(hh, high[i - j]);
        ll = Math.min(ll, low[i - j]);
      }
      k[i] = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    }
    const dData = computeSMA(k, dPeriod);
    for (let i = 0; i < close.length; i++) d[i] = dData[i];
    return { k, d };
  };

  const computeATR = (candles, period) => {
    const out = new Array(candles.length).fill(0);
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      out[i] = i === 1 ? tr : (out[i - 1] * (period - 1) + tr) / period;
    }
    return out;
  };
// Built-in indicator catalog. Each entry: { id, name, desc, color,
  // pane, defaultOn, compute(candles) -> points or { multi, colors } }.
  const BUILT_IN = [
    {
      id: "rsi", name: "RSI (14)", desc: "Relative Strength Index",
      color: "#22d3ee", pane: true, defaultOn: true,
      compute(candles) {
        const closes = candles.map((c) => c.close);
        const rsi = computeRSI(closes, 14);
        return candles.map((c, i) => ({ time: c.time, value: rsi[i] }));
      },
    },
    {
      id: "macd", name: "MACD (12,26,9)", desc: "Moving Average Convergence Divergence",
      color: "#a78bfa", pane: true, defaultOn: true,
      compute(candles) {
        const closes = candles.map((c) => c.close);
        const { macd } = computeMACD(closes, 12, 26, 9);
        return candles.map((c, i) => ({ time: c.time, value: macd[i] }));
      },
    },
    {
      id: "sma20", name: "SMA (20)", desc: "Simple Moving Average", color: "#f59e0b", pane: false,
      compute(candles) {
        const v = computeSMA(candles.map((c) => c.close), 20);
        return candles.map((c, i) => ({ time: c.time, value: v[i] }));
      },
    },
    {
      id: "sma50", name: "SMA (50)", desc: "Simple Moving Average", color: "#3b82f6", pane: false,
      compute(candles) {
        const v = computeSMA(candles.map((c) => c.close), 50);
        return candles.map((c, i) => ({ time: c.time, value: v[i] }));
      },
    },
    {
      id: "ema20", name: "EMA (20)", desc: "Exponential Moving Average", color: "#10b981", pane: false,
      compute(candles) {
        const v = computeEMA(candles.map((c) => c.close), 20);
        return candles.map((c, i) => ({ time: c.time, value: v[i] }));
      },
    },
    {
      id: "ema200", name: "EMA (200)", desc: "Exponential Moving Average", color: "#f43f5e", pane: false,
      compute(candles) {
        const v = computeEMA(candles.map((c) => c.close), 200);
        return candles.map((c, i) => ({ time: c.time, value: v[i] }));
      },
    },
    {
      id: "bb", name: "Bollinger Bands (20,2)", desc: "Volatility bands around a 20 SMA",
      color: "#e879f9", pane: false,
      compute(candles) {
        const closes = candles.map((c) => c.close);
        const bands = computeBands(closes, 20, 2);
        const mid = candles.map((c, i) => ({ time: c.time, value: bands.mid[i] }));
        const upper = candles.map((c, i) => ({ time: c.time, value: bands.up[i] }));
        const lower = candles.map((c, i) => ({ time: c.time, value: bands.lo[i] }));
        return { multi: [mid, upper, lower], colors: ["#e879f9", "#f0abfc", "#f0abfc"] };
      },
    },
    {
      id: "stoch", name: "Stochastic (14,3,3)", desc: "%K / %D momentum oscillator",
      color: "#34d399", pane: true,
      compute(candles) {
        const s = computeStoch(
          candles.map((c) => c.high),
          candles.map((c) => c.low),
          candles.map((c) => c.close),
          14, 3
        );
        const k = candles.map((c, i) => ({ time: c.time, value: s.k[i] }));
        const d = candles.map((c, i) => ({ time: c.time, value: s.d[i] }));
        return { multi: [k, d], colors: ["#34d399", "#fbbf24"] };
      },
    },
    {
      id: "atr", name: "ATR (14)", desc: "Average True Range", color: "#fb923c", pane: true,
      compute(candles) {
        const v = computeATR(candles, 14);
        return candles.map((c, i) => ({ time: c.time, value: v[i] }));
      },
    },
  ];

  // ---- Local state (DOM refs, filter) ----
  let el = {};
  let search = "";
  let currentCat = "favs"; // 'favs' | 'builtin' | 'custom'

  const defaultIndOn = () => {
    const store = {};
    BUILT_IN.forEach((b) => (store[b.id] = !!b.defaultOn));
    (state.allIndicators || []).forEach((c) => {
      if (typeof state.indOn[c.id] === "boolean") store[c.id] = state.indOn[c.id];
    });
    return store;
  };

  // Persist enabled/toggle + favorite state
  const persist = () => {
    try {
      localStorage.setItem("gold_indOn", JSON.stringify(state.indOn || {}));
      localStorage.setItem("gold_indFav", JSON.stringify(state.favs ? [...state.favs] : []));
    } catch (e) { /* storage unavailable — non-fatal */ }
  };
// ---- Helpers to open / close the panel ----
  function open() {
    if (el.modal) {
      el.modal.classList.remove("hidden");
      if (el.search) el.search.focus();
      renderAll();
    }
  }
  function close() {
    if (el.modal) el.modal.classList.add("hidden");
  }

  // Build a single indicator row element (shared by built-in + custom + favs).
  function buildRow(id, name, desc, enabled, isFav, opts = {}) {
    const row = document.createElement("div");
    row.className = "indicator-row";
    row.dataset.indId = id;
    row.dataset.search = (name + " " + desc).toLowerCase();

    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = "indicator-fav" + (isFav ? " is-fav" : "");
    fav.title = isFav ? "Remove from favorites" : "Add to favorites";
    fav.textContent = "★";
    fav.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(id); });

    const info = document.createElement("div");
    info.className = "indicator-info";
    const nm = document.createElement("span");
    nm.className = "indicator-name";
    nm.textContent = name;
    const ds = document.createElement("span");
    ds.className = "indicator-desc";
    ds.textContent = desc || "";
    info.appendChild(nm);
    info.appendChild(ds);

    row.appendChild(fav);
    row.appendChild(info);

    // Edit button for custom scripts (when a handler is provided)
    if (opts.editHandler) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "indicator-edit";
      editBtn.title = "Edit script";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (e) => { e.stopPropagation(); opts.editHandler(); });
      row.appendChild(editBtn);
    }

    // Toggle switch
    const sw = document.createElement("label");
    sw.className = "switch";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!on;
    box.addEventListener("change", (e) => { e.stopPropagation(); toggleOn(id, box.checked); });
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.appendChild(box);
    sw.appendChild(slider);
    row.appendChild(sw);

    return row;
  }

  // Build the static built-in indicator list once.
  function buildBuiltInRows() {
    if (!el.builtInList) return;
    const frag = document.createDocumentFragment();
    BUILT_IN.forEach((b) => {
      frag.appendChild(
        buildRow(b.id, b.name, b.desc, !!state.indOn[b.id], !!state.favs.has(b.id))
      );
    });
    el.builtInList.replaceChildren(frag);
  }

  // Build the custom / script indicators list (from state.allIndicators).
  function buildCustomRows() {
    if (!el.customList) return;
    const frag = document.createDocumentFragment();
    const items = state.allIndicators || [];
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "indicator-empty-note";
      p.textContent = "No custom scripts yet. Write one with \"+ New Custom Indicator\".";
      frag.appendChild(p);
    } else {
      items.forEach((ind) => {
        frag.appendChild(
          buildRow(ind.id, ind.name, "Custom script", !!state.indOn[ind.id], !!state.favs.has(ind.id), {
            editHandler: () => { if (typeof editIndicator === "function") editIndicator(ind.id); },
          })
        );
      });
    }
    el.customList.replaceChildren(frag);
  }

  // Rebuild the favorites section with all star'd indicators (built-in + custom).
  function buildFavRows() {
    if (!el.favList) return;
    const frag = document.createDocumentFragment();
    const favIds = state.favs || new Set();
    if (!favIds.size) {
      const p = document.createElement("p");
      p.className = "indicator-empty-note";
      p.textContent = "Star indicators to pin them here.";
      frag.appendChild(p);
    } else {
      BUILT_IN.forEach((b) => {
        if (favIds.has(b.id)) {
          frag.appendChild(buildRow(b.id, b.name, b.desc, !!state.indOn[b.id], true));
        }
      });
      (state.allIndicators || []).forEach((ind) => {
        if (favIds.has(ind.id)) {
          frag.appendChild(buildRow(ind.id, ind.name, "Script indicator", !!state.indOn[ind.id], true, {
            editHandler: () => { if (typeof editIndicator === "function") editIndicator(ind.id); },
          }));
        }
      });
      if (!frag.childElementCount) {
        const p = document.createElement("p");
        p.className = "indicator-empty-note";
        p.textContent = "Star indicators to pin them here.";
        frag.appendChild(p);
      }
    }
    el.favList.replaceChildren(frag);
  }

  // Switch the active category tab and show only that section.
  function switchCat(cat) {
    currentCat = cat || "favs";
    el.catTabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.cat === currentCat);
    });
    const map = { favs: el.favCat, builtin: el.builtInCat, custom: el.customCat };
    Object.keys(map).forEach((key) => {
      if (map[key]) map[key].classList.toggle("hidden", key !== currentCat);
    });
    if (el.panelScroll) el.panelScroll.scrollTop = 0;
  }

  // When searching, reveal every category so matches across tabs are visible.
  function showAllCats() {
    [el.favCat, el.builtInCat, el.customCat].forEach((c) => {
      if (c) c.classList.remove("hidden");
    });
    el.catTabs.forEach((tab) => tab.classList.remove("active"));
  }

  // Instant filtering across all rows; hides empty categories.
  function applyFilter() {
    const q = search.toLowerCase();
    document.querySelectorAll(".indicator-panel-scroll .indicator-row").forEach((row) => {
      row.classList.toggle("filtered-out", q.length > 0 && !row.dataset.search.includes(q));
    });
    document.querySelectorAll(".indicator-panel-scroll .indicator-cat").forEach((cat) => {
      const rows = cat.querySelectorAll(".indicator-row");
      const hasAny = [...rows].some((r) => !r.classList.contains("filtered-out"));
      cat.classList.toggle("no-results", !hasAny);
    });
  }
function toggleOn(id, on) {
    state.indOn = state.indOn || {};
    state.indOn[id] = on;
    persist();
    renderChartIndicators();
    updateSidebarCount();
    // Refresh all row toggles (built-ins, custom, favorites)
    buildBuiltInRows();
    buildCustomRows();
    buildFavRows();
  }

  function toggleFav(id) {
    if (!state.favs) state.favs = new Set();
    if (state.favs.has(id)) state.favs.delete(id);
    else state.favs.add(id);
    persist();
    buildBuiltInRows();
    buildCustomRows();
    buildFavRows();
    // Re-apply the active tab so panel visibility stays consistent.
    if (search) showAllCats();
    else switchCat(currentCat);
  }

  function renderAll() {
    buildBuiltInRows();
    buildCustomRows();
    buildFavRows();
    if (el.favCat) el.favCat.classList.toggle("hidden", !(state.favs && state.favs.size));
    updateSidebarCount();
    // Re-apply the active tab (or reveal all when a search is active).
    if (search) showAllCats();
    else switchCat(currentCat);
  }

  // Reset enabled toggles + favorites back to defaults.
  function resetAll() {
    state.indOn = defaultIndOn();
    state.favs = new Set();
    persist();
    renderChartIndicators();
    renderAll();
  }

  // Show the number of active (enabled) indicators in the sidebar launcher badge.
  function updateSidebarCount() {
    if (!el.count) return;
    let n = 0;
    n = Object.values(state.indOn || {}).filter(Boolean).length;
    el.count.textContent = n;
  }

  // ---- Chart rendering ----
  // Re-draw every enabled indicator (built-in + custom) on the chart.
  // Single clear avoids overlay/selection churn across toggles.
  function renderChartIndicators() {
    if (!chart || !state.candles || !state.candles.length) return;
    chart.clearAll();

    const on = state.indOn || {};

    // Built-in overlays/pane lines
    BUILT_IN.forEach((b) => {
      if (!on[b.id]) return;
      try {
        const points = b.compute(state.candles);
        const color = b.color || "#22d3ee";
        if (points.multi) {
          const colors = points.colors || [];
          points.multi.forEach((arr, i) => {
            plotSeries(`${b.id}-${i}`, arr, colors[i] || color);
          });
        } else {
          plotSeries(b.id, points, color);
        }
      } catch (err) {
        console.error(`Built-in indicator "${b.id}" failed:`, err.message);
      }
    });

    // Enabled custom scripts
    (state.allIndicators || []).forEach((ind) => {
      if (!on[ind.id]) return;
      try {
        const result = runIndicatorScript(ind.script, state.candles);
        applyIndicatorResult(ind, result);
      } catch (err) {
        console.error(`Custom indicator "${ind.name}" failed:`, err.message);
      }
    });
  }

  // Plot a single line (helper). Pane flag is honoured by overlay chart API.
  function plotSeries(id, points, color) {
    chart.plotOverlay(id, points, { color: color || "#22d3ee", lineWidth: 2 });
  }

  function init() {
    el = {
      modal: document.getElementById("indicatorMenuModal"),
      open: document.getElementById("openIndicatorMenu"),
      close: document.getElementById("closeIndicatorMenu"),
      search: document.getElementById("indicatorSearch"),
      searchClear: document.getElementById("indicatorSearchClear"),
      builtInList: document.getElementById("indBuiltInList"),
      customList: document.getElementById("indCustomList"),
      favList: document.getElementById("indFavList"),
      builtInCat: document.getElementById("indCatBuiltIn"),
      customCat: document.getElementById("indCatCustom"),
      favCat: document.getElementById("indCatFavs"),
      count: document.getElementById("indOnCount"),
      panelScroll: document.getElementById("indicatorPanelScroll"),
      reset: document.getElementById("indMenuReset"),
      newInd: document.getElementById("indMenuNewInd"),
      catTabs: document.querySelectorAll(".indicator-cat-rail .indicator-cat-tab"),
    };
    if (!el.modal || !el.open) return;

    // Load persisted toggle/favorite state.
    try {
      state.indOn = JSON.parse(localStorage.getItem("gold_indOn") || "null") || defaultIndOn();
      state.favs = new Set(JSON.parse(localStorage.getItem("gold_indFav") || "[]"));
    } catch (e) {
      state.indOn = defaultIndOn();
      state.favs = new Set();
    }
    BUILT_IN.forEach((b) => {
      if (typeof state.indOn[b.id] !== "boolean") state.indOn[b.id] = !!b.defaultOn;
    });

    el.open.addEventListener("click", open);
    el.close.addEventListener("click", close);
    el.modal.addEventListener("click", (e) => { if (e.target === el.modal) close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.modal.classList.contains("hidden")) close();
    });

    el.search.addEventListener("input", () => {
      search = el.search.value.trim().toLowerCase();
      el.searchClear.classList.toggle("hidden", !search);
      // When searching, show all categories so results are visible across tabs.
      if (search) showAllCats();
      applyFilter();
    });
    el.searchClear.addEventListener("click", () => {
      el.search.value = "";
      search = "";
      el.searchClear.classList.add("hidden");
      applyFilter();
      switchCat(currentCat);
      el.search.focus();
    });

    // Category rail tabs (TradingView-style navigation)
    el.catTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        switchCat(tab.dataset.cat);
      });
    });

    el.reset.addEventListener("click", resetAll);
    el.newInd.addEventListener("click", () => {
      if (typeof showEditor === "function") showEditor();
    });

    buildBuiltInRows();
    updateSidebarCount();
  }

  // Public API
  return {
    init,
    open,
    close,
    renderAll,
    renderChartIndicators,
    updateSidebarCount,
    toggleOn,
  };
})();
// Technical Indicators Summary Board
// ============================================================
function initIndicatorBoard() {
  const board = document.getElementById("indicatorBoard");
  const body = document.getElementById("indicatorBoardBody");
  const toggle = document.getElementById("indicatorBoardToggle");
  const tfLabel = document.getElementById("indicatorBoardTf");

  if (!board || !body || !toggle || !tfLabel) return;

  // Update timeframe label
  tfLabel.textContent = state.currentTimeframe;

  // Toggle collapse
  toggle.addEventListener("click", () => {
    const isCollapsed = board.classList.toggle("collapsed");
    body.style.display = isCollapsed ? "none" : "";
  });

  // Initial computation
  updateIndicatorBoard();

  // Recompute when candles change
  const origSetCandles = chart.setCandles.bind(chart);
  chart.setCandles = (candles) => {
    origSetCandles(candles);
    updateIndicatorBoard();
  };

  // Also update on timeframe change
  document.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      tfLabel.textContent = btn.dataset.tf;
    });
  });
}

function updateIndicatorBoard() {
  const candles = state.candles;
  if (!candles || candles.length < 30) return;

  const closes = candles.map(c => c.close);
  const lastPrice = closes[closes.length - 1];

  // ---- RSI (14) ----
  const rsi = computeRSI(closes, 14);
  const rsiVal = rsi[rsi.length - 1];
  const rsiEl = document.getElementById("indRsiValue");
  const rsiFill = document.getElementById("indRsiFill");
  const rsiStatus = document.getElementById("indRsiStatus");

  if (rsiEl) rsiEl.textContent = rsiVal.toFixed(1);
  if (rsiFill) rsiFill.style.width = `${Math.min(100, Math.max(0, rsiVal))}%`;

  if (rsiStatus) {
    if (rsiVal >= 70) {
      rsiStatus.textContent = "Overbought";
      rsiStatus.className = "indicator-card-status bearish";
    } else if (rsiVal <= 30) {
      rsiStatus.textContent = "Oversold";
      rsiStatus.className = "indicator-card-status bullish";
    } else if (rsiVal >= 55) {
      rsiStatus.textContent = "Bullish";
      rsiStatus.className = "indicator-card-status bullish";
    } else if (rsiVal <= 45) {
      rsiStatus.textContent = "Bearish";
      rsiStatus.className = "indicator-card-status bearish";
    } else {
      rsiStatus.textContent = "Neutral";
      rsiStatus.className = "indicator-card-status neutral";
    }
  }

  // ---- MACD (12, 26, 9) ----
  const macdResult = computeMACD(closes, 12, 26, 9);
  const macdLine = macdResult.macd[macdResult.macd.length - 1];
  const signalLine = macdResult.signal[macdResult.signal.length - 1];
  const histogram = macdLine - signalLine;

  const macdValueEl = document.getElementById("indMacdValue");
  const macdHistEl = document.getElementById("indMacdHistogram");
  const macdSignalEl = document.getElementById("indMacdSignal");
  const macdStatus = document.getElementById("indMacdStatus");

  if (macdValueEl) macdValueEl.textContent = macdLine.toFixed(3);

  const maxAbs = Math.max(Math.abs(histogram), 1);
  const histWidth = Math.min(100, Math.abs(histogram) / maxAbs * 100);
  if (macdHistEl) {
    macdHistEl.style.width = `${histWidth}%`;
    macdHistEl.classList.toggle("negative", histogram < 0);
  }
  if (macdSignalEl) {
    const signalWidth = Math.min(100, Math.abs(signalLine) / (Math.abs(macdLine) + 1) * 100);
    macdSignalEl.style.width = `${signalWidth}%`;
  }

  if (macdStatus) {
    if (histogram > 0 && macdLine > signalLine) {
      macdStatus.textContent = "Bullish";
      macdStatus.className = "indicator-card-status bullish";
    } else if (histogram < 0 && macdLine < signalLine) {
      macdStatus.textContent = "Bearish";
      macdStatus.className = "indicator-card-status bearish";
    } else {
      macdStatus.textContent = "Neutral";
      macdStatus.className = "indicator-card-status neutral";
    }
  }

  // ---- Moving Averages ----
  const sma20 = computeSMA(closes, 20);
  const sma50 = computeSMA(closes, 50);
  const ema200 = computeEMA(closes, 200);

  const sma20Val = sma20[sma20.length - 1];
  const sma50Val = sma50[sma50.length - 1];
  const ema200Val = ema200[ema200.length - 1];

  const maValueEl = document.getElementById("indMaValue");
  if (maValueEl) maValueEl.textContent = lastPrice.toFixed(2);

  updateMaRow("indSma20", "indSma20Signal", sma20Val, lastPrice);
  updateMaRow("indSma50", "indSma50Signal", sma50Val, lastPrice);
  updateMaRow("indEma200", "indEma200Signal", ema200Val, lastPrice);

  const maStatus = document.getElementById("indMaStatus");
  if (maStatus) {
    const bullishCount = [sma20Val, sma50Val, ema200Val].filter(v => lastPrice > v).length;
    if (bullishCount >= 2) {
      maStatus.textContent = "Bullish";
      maStatus.className = "indicator-card-status bullish";
    } else if (bullishCount <= 1) {
      maStatus.textContent = "Bearish";
      maStatus.className = "indicator-card-status bearish";
    } else {
      maStatus.textContent = "Neutral";
      maStatus.className = "indicator-card-status neutral";
    }
  }

  // ---- Overall Signal ----
  let score = 0;

  if (rsiVal >= 55 && rsiVal < 70) score += 1;
  else if (rsiVal >= 70) score -= 1;
  else if (rsiVal <= 45 && rsiVal > 30) score -= 1;
  else if (rsiVal <= 30) score += 1;

  if (histogram > 0 && macdLine > signalLine) score += 1;
  else if (histogram < 0 && macdLine < signalLine) score -= 1;

  if (lastPrice > sma20Val) score += 1; else score -= 1;
  if (lastPrice > sma50Val) score += 1; else score -= 1;
  if (lastPrice > ema200Val) score += 1; else score -= 1;

  const normalized = (score + 3) / 6 * 100;

  const overallValue = document.getElementById("indOverallValue");
  const overallFill = document.getElementById("indOverallFill");
  const overallStatus = document.getElementById("indOverallStatus");

  if (overallValue) {
    overallValue.textContent = score > 0 ? "BUY" : score < 0 ? "SELL" : "HOLD";
  }
  if (overallFill) {
    overallFill.style.width = `${normalized}%`;
    overallFill.style.background = score > 0 ? "var(--success)" : score < 0 ? "var(--danger)" : "var(--accent)";
  }
  if (overallStatus) {
    if (score >= 2) {
      overallStatus.textContent = "Strong Buy";
      overallStatus.className = "indicator-card-status bullish";
    } else if (score > 0) {
      overallStatus.textContent = "Buy";
      overallStatus.className = "indicator-card-status bullish";
    } else if (score <= -2) {
      overallStatus.textContent = "Strong Sell";
      overallStatus.className = "indicator-card-status bearish";
    } else if (score < 0) {
      overallStatus.textContent = "Sell";
      overallStatus.className = "indicator-card-status bearish";
    } else {
      overallStatus.textContent = "Neutral";
      overallStatus.className = "indicator-card-status neutral";
    }
  }
}

function updateMaRow(valueId, signalId, maValue, lastPrice) {
  const valueEl = document.getElementById(valueId);
  const signalEl = document.getElementById(signalId);
  if (!valueEl || !signalEl) return;

  valueEl.textContent = maValue.toFixed(2);

  if (lastPrice > maValue) {
    signalEl.textContent = "↑ Above";
    signalEl.className = "ma-signal bullish";
  } else {
    signalEl.textContent = "↓ Below";
    signalEl.className = "ma-signal bearish";
  }
}

// ---- Indicator computation helpers ----
function computeSMA(data, period) {
  const out = new Array(data.length).fill(0);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j];
    out[i] = sum / period;
  }
  return out;
}

function computeEMA(data, period) {
  const out = new Array(data.length).fill(0);
  const mult = 2 / (period + 1);
  if (data.length > 0) out[0] = data[0];
  for (let i = 1; i < data.length; i++) {
    out[i] = (data[i] - out[i - 1]) * mult + out[i - 1];
  }
  return out;
}

function computeRSI(data, period) {
  const out = new Array(data.length).fill(50);
  if (data.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    gain = Math.max(diff, 0);
    loss = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function computeMACD(data, fastPeriod, slowPeriod, signalPeriod) {
  const emaFast = computeEMA(data, fastPeriod);
  const emaSlow = computeEMA(data, slowPeriod);
  const macdLine = data.map((_, i) => emaFast[i] - emaSlow[i]);
  const signal = computeEMA(macdLine, signalPeriod);
  return { macd: macdLine, signal };
}

// ============================================================
// Quick Notes — localStorage persistence
// ============================================================
function initQuickNotes() {
  const notesTextarea = document.getElementById("quickNotes");
  const saveBtn = document.getElementById("saveNotesBtn");
  const clearBtn = document.getElementById("clearNotesBtn");
  const statusEl = document.getElementById("notesStatus");

  if (!notesTextarea || !saveBtn || !clearBtn || !statusEl) return;

  // Load saved notes
  const savedNotes = localStorage.getItem("gold_notes") || "";
  notesTextarea.value = savedNotes;

  // Save notes
  saveBtn.addEventListener("click", () => {
    localStorage.setItem("gold_notes", notesTextarea.value);
    statusEl.textContent = "✓ Saved";
    statusEl.classList.add("visible");
    setTimeout(() => statusEl.classList.remove("visible"), 2000);
  });

  // Clear notes
  clearBtn.addEventListener("click", () => {
    notesTextarea.value = "";
    localStorage.removeItem("gold_notes");
    statusEl.textContent = "✓ Cleared";
    statusEl.classList.add("visible");
    setTimeout(() => statusEl.classList.remove("visible"), 2000);
  });

  // Auto-save on Ctrl+S
  notesTextarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      localStorage.setItem("gold_notes", notesTextarea.value);
      statusEl.textContent = "✓ Saved";
      statusEl.classList.add("visible");
      setTimeout(() => statusEl.classList.remove("visible"), 2000);
    }
  });
}

// ============================================================
// Voice Command Module — Web Speech API
// Dynamically handles Kurdish (ckb) and English (en-US) input.
// Commands can be issued in either language interchangeably.
// ============================================================
const VoiceCommand = (() => {
  // ---- Feature detection ----
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SpeechSynthesis = window.speechSynthesis;
  const SUPPORTED = !!SpeechRecognition && !!SpeechSynthesis;

  // ---- State ----
  let recognition = null;
  let listening = false;
  let currentLang = "en-US";
  let micBtn = null;
  let voiceStatusEl = null;
  let micBtnLabel = null;
  let singleToggleTimer = null;
  let interimText = "";

  // ---- Command dictionaries (English + Kurdish Sorani) ----
  const COMMANDS = {
    timeframe: {
      en: ["timeframe", "switch to", "change to", "go to", "set to", "show me"],
      ckb: ["ماوە", "گۆڕین بۆ", "بگۆڕە بۆ", "بڕۆ بۆ", "دابنێ بۆ", "نیشانم بدە"],
    },
    chartType: {
      en: ["chart type", "chart", "candles", "bars", "line chart", "area chart", "baseline", "histogram"],
      ckb: ["جۆری چارت", "چارت", "شمعدان", "ستوون", "هێڵ", "ناوچە", "هیستۆگرام"],
    },
    price: {
      en: ["price", "what's the price", "what is the price", "current price", "live price", "how much"],
      ckb: ["نرخ", "نرخی چەندە", "نرخی ئێستا", "نرخی ڕاستەوخۆ", "چەندە"],
    },
    analytics: {
      en: ["analytics", "widgets", "show analytics", "hide analytics", "toggle analytics"],
      ckb: ["ئانالیتیکس", "ویجێتەکان", "ئانالیتیکس نیشان بدە", "ئانالیتیکس بشارەوە"],
    },
    theme: {
      en: ["theme", "dark mode", "light mode", "switch theme", "toggle theme"],
      ckb: ["ڕووکار", "دۆخی تاریک", "دۆخی ڕووناک", "ڕووکار بگۆڕە"],
    },
    settings: {
      en: ["settings", "open settings", "show settings"],
      ckb: ["ڕێکخستنەکان", "ڕێکخستنەکان بکەرەوە", "ڕێکخستنەکان نیشان بدە"],
    },
    news: {
      en: ["news", "economic news", "calendar", "show news", "show calendar"],
      ckb: ["هەواڵ", "هەواڵی ئابووری", "ڕۆژژمێر", "هەواڵ نیشان بدە"],
    },
    indicators: {
      en: ["indicators", "technical summary", "show indicators", "show summary"],
      ckb: ["ئینдикаتەرەکان", "پوختەی تەکنیکی", "ئینдикаتەرەکان نیشان بدە"],
    },
    sessions: {
      en: ["sessions", "market sessions", "show sessions"],
      ckb: ["سێشنەکان", "سێشنەکانی بازاڕ", "سێشنەکان نیشان بدە"],
    },
    notes: {
      en: ["notes", "quick notes", "show notes"],
      ckb: ["تێبینی", "تێبینی خێرا", "تێبینیەکان نیشان بدە"],
    },
    stop: {
      en: ["stop", "cancel", "quit listening", "stop listening"],
      ckb: ["بوەستە", "هەڵوەشێنە", "واز لە گوێگرتن بێنە"],
    },
    help: {
      en: ["help", "what can you do", "commands", "voice commands"],
      ckb: ["یارمەتی", "دەتوانیت چی بکەیت", "فەرمانەکان", "فەرمانە دەنگییەکان"],
    },
    say: {
      en: ["say", "speak", "repeat after me", "tell me"],
      ckb: ["بڵێ", "قسە بکە", "دووبارە بکەرەوە", "پێم بڵێ"],
    },
    readStatus: {
      en: ["read status", "status report", "what's the status", "what is the status", "current status", "dashboard status"],
      ckb: ["دۆخ بخوێنەوە", "ڕاپۆرتی دۆخ", "دۆخی ئێستا", "دۆخی داشبۆرد"],
    },
    readNews: {
      en: ["read news", "read headlines", "read the news", "tell me the news", "news headlines"],
      ckb: ["هەواڵ بخوێنەوە", "سەرنووسەکان بخوێنەوە", "هەواڵەکان پێم بڵێ"],
    },
    readIndicators: {
      en: ["read indicators", "read summary", "read indicator summary", "tell me indicators"],
      ckb: ["ئینдикаتەرەکان بخوێنەوە", "پوختە بخوێنەوە", "پوختەی ئینдикаتەرەکان"],
    },
    ttsOn: {
      en: ["turn on voice", "enable voice", "voice on", "speak on", "turn on speech"],
      ckb: ["دەنگ بکەرەوە", "دەنگ چالاک بکە", "دەنگ لەسەر"],
    },
    ttsOff: {
      en: ["turn off voice", "disable voice", "voice off", "speak off", "turn off speech", "mute"],
      ckb: ["دەنگ بکوژێنەوە", "دەنگ ناچالاک بکە", "دەنگ لەسەر نییە", "بێدەنگ"],
    },
    sentiment: {
      en: ["sentiment", "market sentiment", "buyer seller", "show sentiment", "toggle sentiment", "hide sentiment"],
      ckb: ["هەست", "هەستی بازاڕ", "کڕیار فرۆشیار", "هەست نیشان بدە", "هەست بشارەوە"],
    },
    readSentiment: {
      en: ["read sentiment", "read market sentiment", "tell me sentiment", "what's the sentiment", "what is the sentiment"],
      ckb: ["هەست بخوێنەوە", "هەستی بازاڕ بخوێنەوە", "هەست پێم بڵێ"],
    },
    marketDepth: {
      en: ["market depth", "order book", "depth", "show depth", "toggle depth", "hide depth", "show order book", "toggle order book"],
      ckb: ["قوڵی بازاڕ", "کتێبی داواکاری", "قوڵی", "قوڵی نیشان بدە", "کتێبی داواکاری نیشان بدە"],
    },
    readMarketDepth: {
      en: ["read depth", "read market depth", "read order book", "tell me the depth", "tell me the order book"],
      ckb: ["قوڵی بخوێنەوە", "قوڵی بازاڕ بخوێنەوە", "کتێبی داواکاری بخوێنەوە"],
    },
    anomalies: {
      en: ["anomalies", "anomaly", "alerts", "show anomalies", "toggle anomalies", "show alerts", "toggle alerts"],
      ckb: ["نائاسایی", "ئاگاداری", "نائاسایی نیشان بدە", "ئاگاداری نیشان بدە"],
    },
    readAnomalies: {
      en: ["read anomalies", "read alerts", "read anomaly alerts", "tell me anomalies", "tell me alerts", "any anomalies"],
      ckb: ["نائاسایی بخوێنەوە", "ئاگاداری بخوێنەوە", "ئاگادارییەکان پێم بڵێ"],
    },
    clearAlerts: {
      en: ["clear alerts", "clear anomalies", "dismiss alerts", "dismiss anomalies", "reset alerts"],
      ckb: ["ئاگاداری پاک بکەرەوە", "نائاسایی پاک بکەرەوە", "ئاگاداری لابە"],
    },
    readSessions: {
      en: ["read sessions", "read market sessions", "which sessions are open", "what sessions are open", "tell me sessions"],
      ckb: ["سێشنەکان بخوێنەوە", "سێشنەکانی بازاڕ بخوێنەوە", "کام سێشنەکان کراوەن"],
    },
    setAlert: {
      en: ["alert me", "set alert", "set price alert", "alert at", "notify me", "warn me"],
      ckb: ["ئاگادارم بکە", "ئاگاداری دابنێ", "ئاگاداری نرخ دابنێ", "ئاگادارم بکە لە"],
    },
    listAlerts: {
      en: ["list alerts", "show my alerts", "what alerts", "my alerts"],
      ckb: ["ئاگادارییەکانم نیشان بدە", "ئاگادارییەکانم لیست بکە"],
    },
    clearPriceAlerts: {
      en: ["clear price alerts", "remove alerts", "delete alerts", "clear all alerts"],
      ckb: ["ئاگادارییەکانی نرخ پاک بکەرەوە", "هەموو ئاگادارییەکان لابە"],
    },
    toggleWidget: {
      en: ["toggle widget", "show widget", "hide widget", "toggle panel", "show panel", "hide panel"],
      ckb: ["ویجێت بگۆڕە", "ویجێت نیشان بدە", "ویجێت بشارەوە", "پانێڵ نیشان بدە", "پانێڵ بشارەوە"],
    },
    navigate: {
      en: ["go to", "scroll to", "navigate to", "jump to", "open", "switch to", "take me to", "show me"],
      ckb: ["بڕۆ بۆ", "بڕۆ", "بگۆڕە بۆ", "باز بدە بۆ", "بکەرەوە", "نیشانم بدە"],
    },
    scrollUp: {
      en: ["scroll up", "go up", "scroll top", "back to top"],
      ckb: ["بڕۆ سەرەوە", "بڕۆ بۆ سەرەوە", "بگەڕێوە سەرەوە"],
    },
    scrollDown: {
      en: ["scroll down", "go down", "scroll bottom"],
      ckb: ["بڕۆ خوارەوە", "بڕۆ بۆ خوارەوە", "بگەڕێوە خوارەوە"],
    },
    readPriceAlerts: {
      en: ["read price alerts", "read my alerts", "read alerts", "tell me my alerts"],
      ckb: ["ئاگادارییەکانی نرخ بخوێنەوە", "ئاگادارییەکانم بخوێنەوە"],
    },
    showPriceAlerts: {
      en: ["show price alerts", "show alerts panel", "show my alerts panel"],
      ckb: ["ئاگادارییەکانی نرخ نیشان بدە", "پانێڵی ئاگاداری نیشان بدە"],
    },
  };
// ---- Timeframe values ----
  const TIMEFRAMES = {
    en: {
      "1 minute": "1m", "one minute": "1m", "1m": "1m",
      "5 minutes": "5m", "five minutes": "5m", "5m": "5m",
      "15 minutes": "15m", "fifteen minutes": "15m", "15m": "15m",
      "1 hour": "1h", "one hour": "1h", "1h": "1h",
      "4 hours": "4h", "four hours": "4h", "4h": "4h",
      "1 day": "1D", "one day": "1D", "daily": "1D", "1D": "1D",
    },
    ckb: {
      "١ خولەک": "1m", "1 خولەک": "1m", "یەک خولەک": "1m", "خولەک": "1m",
      "٥ خولەک": "5m", "5 خولەک": "5m", "پێنج خولەک": "5m",
      "١٥ خولەک": "15m", "15 خولەک": "15m", "پازدە خولەک": "15m",
      "١ کاتژمێر": "1h", "1 کاتژمێر": "1h", "یەک کاتژمێر": "1h", "کاتژمێر": "1h",
      "٤ کاتژمێر": "4h", "4 کاتژمێر": "4h", "چوار کاتژمێر": "4h",
      "١ ڕۆژ": "1D", "1 ڕۆژ": "1D", "یەک ڕۆژ": "1D", "ڕۆژانە": "1D",
    },
  };

  // ---- Chart types ----
  const CHART_TYPES = {
    en: {
      "candles": "candles", "candle": "candles", "candlestick": "candles", "candlesticks": "candles",
      "bars": "bars", "bar": "bars", "ohlc": "bars",
      "line": "line", "line chart": "line",
      "area": "area", "area chart": "area",
      "baseline": "baseline", "baseline chart": "baseline",
      "histogram": "histogram", "histogram chart": "histogram",
    },
    ckb: {
      "شمعدان": "candles", "شمعدانەکان": "candles",
      "ستوون": "bars", "ستوونەکان": "bars",
      "هێڵ": "line", "هێڵی چارت": "line",
      "ناوچە": "area", "ناوچەی چارت": "area",
      "هیستۆگرام": "histogram",
    },
  };

  // ---- Voice feedback messages ----
  const FEEDBACK = {
    en: {
      listening: "Listening...",
      notSupported: "Voice commands not supported in this browser",
      commandExecuted: "Command executed",
      price: (p) => `The current gold price is ${p.toFixed(2)} dollars`,
      help: "You can say: switch to 5 minute, show candles, what's the price, show analytics, dark mode, open settings, show news, show indicators, read status, read news, read sentiment, read depth, read anomalies, read sessions, alert me at 2400, list alerts, clear alerts, say hello, turn off voice, or stop.",
      noCommand: "Sorry, I didn't understand that command",
      error: "Voice recognition error",
      ttsOn: "Voice feedback enabled",
      ttsOff: "Voice feedback disabled",
      sayPrompt: "What would you like me to say?",
      sentiment: (buyers, sellers) => `Market sentiment is ${buyers} buyers versus ${sellers} sellers`,
      sentimentNeutral: "Market sentiment is neutral",
      noSentiment: "Sentiment data not available",
      depth: (spread, asks, bids) => `Order book spread is ${spread} dollars, with ${asks} ask levels and ${bids} bid levels`,
      noDepth: "Market depth data not available",
      anomalies: (count) => count === 0 ? "No anomalies detected" : `${count} active anomaly alert${count === 1 ? "" : "s"}`,
      noAnomalies: "No anomalies detected",
      anomaliesCleared: "Anomaly alerts cleared",
      sessions: (open) => open.length === 0 ? "All markets are closed" : `Open sessions: ${open.join(", ")}`,
      noSessions: "Session data not available",
      alertSet: (price) => `Price alert set at ${price.toFixed(2)} dollars`,
      alertRemoved: (price) => `Price alert removed at ${price.toFixed(2)} dollars`,
      alertTriggered: (price) => `Alert! Gold price reached ${price.toFixed(2)} dollars`,
      noAlerts: "No price alerts set",
      alertsList: (alerts) => `Active price alerts: ${alerts.join(", ")}`,
      alertsCleared: "All price alerts cleared",
      alertPrompt: "What price should I alert you at?",
      widgetToggled: "Widget toggled",
      widgetNotFound: "Widget not found",
    },
    ckb: {
      listening: "گوێ دەگرم...",
      notSupported: "فەرمانە دەنگییەکان لەم وێبگەڕەدا پشتگیری ناکرێن",
      commandExecuted: "فەرمان جێبەجێ کرا",
      price: (p) => `نرخی ئێستای زێڕ ${p.toFixed(2)} دۆلارە`,
      help: "دەتوانیت بڵێیت: بگۆڕە بۆ ٥ خولەک، شمعدان نیشان بدە، نرخی چەندە، ئانالیتیکس نیشان بدە، دۆخی تاریک، ڕێکخستنەکان بکەرەوە، هەواڵ نیشان بدە، ئینдикаتەرەکان نیشان بدە، دۆخ بخوێنەوە، هەواڵ بخوێنەوە، هەست بخوێنەوە، قوڵی بخوێنەوە، نائاسایی بخوێنەوە، سێشنەکان بخوێنەوە، ئاگادارم بکە لە ٢٤٠٠، ئاگادارییەکانم نیشان بدە، ئاگاداری پاک بکەرەوە، بڵێ سڵاو، دەنگ بکوژێنەوە، یان بوەستە.",
      noCommand: "ببورە، ئەو فەرمانە تێنەگەیشتم",
      error: "هەڵەی ناسینەوەی دەنگ",
      ttsOn: "دەنگ چالاک کرا",
      ttsOff: "دەنگ ناچالاک کرا",
      sayPrompt: "دەتەوێت چی بڵێم؟",
      sentiment: (buyers, sellers) => `هەستی بازاڕ ${buyers} کڕیارە بەرامبەر ${sellers} فرۆشیار`,
      sentimentNeutral: "هەستی بازاڕ بێلایەنە",
      noSentiment: "زانیاری هەست بەردەست نییە",
      depth: (spread, asks, bids) => `فراوانی کتێبی داواکاری ${spread} دۆلارە، لەگەڵ ${asks} ئاستی داواکاری و ${bids} ئاستی پێشنیار`,
      noDepth: "زانیاری قوڵی بازاڕ بەردەست نییە",
      anomalies: (count) => count === 0 ? "هیچ نائاسایییەک نەدۆزراوەتەوە" : `${count} ئاگاداری چالاک هەیە`,
      noAnomalies: "هیچ نائاسایییەک نەدۆزراوەتەوە",
      anomaliesCleared: "ئاگادارییەکانی نائاسایی پاک کرانەوە",
      sessions: (open) => open.length === 0 ? "هەموو بازاڕەکان داخراون" : `سێشنە کراوەکان: ${open.join("، ")}`,
      noSessions: "زانیاری سێشن بەردەست نییە",
      alertSet: (price) => `ئاگاداری نرخ لە ${price.toFixed(2)} دۆلار دانرا`,
      alertRemoved: (price) => `ئاگاداری نرخ لە ${price.toFixed(2)} دۆلار لابرا`,
      alertTriggered: (price) => `ئاگاداری! نرخی زێڕ گەیشتە ${price.toFixed(2)} دۆلار`,
      noAlerts: "هیچ ئاگادارییەکی نرخ دانەنراوە",
      alertsList: (alerts) => `ئاگادارییە چالاکەکان: ${alerts.join("، ")}`,
      alertsCleared: "هەموو ئاگادارییەکانی نرخ پاک کرانەوە",
      alertPrompt: "لە چ نرخێک ئاگادارت بکەم؟",
      widgetToggled: "ویجێت گۆڕدرا",
      widgetNotFound: "ویجێت نەدۆزرایەوە",
    },
  };
// ---- Init ----
  function init() {
    if (!SUPPORTED) return;

    micBtn = document.getElementById("micBtn");
    voiceStatusEl = document.getElementById("voiceStatus");
    micBtnLabel = document.getElementById("micBtnLabel");
    if (!micBtn) return;

    // Set initial language from saved preference
    const savedLang = localStorage.getItem("gold_lang") || "en";
    setLanguage(savedLang);

    // ---- Unified mic button ----
    // Single click → toggle listening; double-click → read live terminal status.
    micBtn.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (singleToggleTimer) { clearTimeout(singleToggleTimer); singleToggleTimer = null; }
      if (listening) stopListening();
      if (!ttsEnabled) setTTSEnabled(true);
      readStatus();
      flashMicActivated();
    });

    micBtn.addEventListener("click", () => {
      // A double-click fires two clicks + a dblclick. Defer the single-click
      // action briefly so a double-click cancels it and reads status instead.
      if (singleToggleTimer) { clearTimeout(singleToggleTimer); singleToggleTimer = null; }
      singleToggleTimer = setTimeout(() => {
        singleToggleTimer = null;
        if (listening) stopListening();
        else startListening();
      }, 260);
    });

    // Sentiment toggle button
    const sentimentToggleBtn = document.getElementById("sentimentToggle");
    if (sentimentToggleBtn) {
      sentimentToggleBtn.addEventListener("click", () => {
        toggleSentiment();
      });
    }

    // Keyboard shortcut: Ctrl+Space
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.code === "Space") {
        e.preventDefault();
        if (listening) stopListening();
        else startListening();
      }
    });

    // Listen for language changes
    const langSelect = document.getElementById("languageSelect");
    if (langSelect) {
      langSelect.addEventListener("change", () => {
        setLanguage(langSelect.value);
      });
    }

    // Render saved price alerts panel on load
    renderPriceAlertsPanel();
  }

  // ---- Language management ----
  function setLanguage(lang) {
    // Map app language codes to Web Speech API codes
    if (lang === "ckb") {
      currentLang = "ckb";
    } else if (lang === "ar") {
      currentLang = "ar";
    } else {
      currentLang = "en-US";
    }
    if (recognition) {
      recognition.lang = currentLang;
    }
  }

  // ---- Recognition setup ----
  function createRecognition() {
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = currentLang;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      listening = true;
      updateUI(true);
      speak(FEEDBACK[currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en"].listening);
    };

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      // Normalize and lower-case the raw transcript, collapsing whitespace,
      // unifying apostrophes, and converting Arabic-Indic digits to Western.
      const normalized = normalizeTranscript(transcript);
      interimText = normalized;

      // Only dispatch if there's meaningful content. Process final results,
      // and rate-limit repeated interim bursts so partial same-utterance
      // fragments don't trigger double actions or "didn't understand" spam.
      let isFinal = true;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!event.results[i].isFinal) { isFinal = false; break; }
      }
      if (!isFinal) return; // wait for a final result before acting

      processCommand(normalized);
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        updateUI(false);
        speak(FEEDBACK[currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en"].notSupported);
      } else if (event.error === "no-speech") {
        // Keep listening — user may be thinking
      } else {
        updateUI(false);
      }
    };

    recognition.onend = () => {
      listening = false;
      updateUI(false);
    };
  }
// ---- Start / stop ----
  function startListening() {
    if (!SUPPORTED) return;
    if (!recognition) createRecognition();
    try {
      recognition.lang = currentLang;
      recognition.start();
    } catch (e) {
      // Already started
    }
  }

  function stopListening() {
    if (recognition) {
      try { recognition.stop(); } catch (e) {}
    }
    listening = false;
    updateUI(false);
  }

  // ---- UI updates ----
  function updateUI(isListening) {
    if (!micBtn) return;
    micBtn.classList.toggle("listening", isListening);
    micBtn.classList.remove("speaking");
    if (micBtnLabel) {
      micBtnLabel.textContent = isListening
        ? (currentLang === "ckb" || currentLang === "ar" ? "گوێگرتن" : "Listening")
        : (currentLang === "ckb" || currentLang === "ar" ? "دەنگ" : "Voice");
    }
    if (voiceStatusEl) {
      voiceStatusEl.textContent = isListening ? "●" : "";
      voiceStatusEl.classList.toggle("active", isListening);
    }
    // Show/hide waveform indicator
    const waveform = document.getElementById("voiceWaveform");
    if (waveform) {
      waveform.classList.toggle("hidden", !isListening);
    }
  }

  // Brief visual "reading" pulse on the unified mic button.
  function flashMicActivated() {
    if (!micBtn) return;
    micBtn.classList.remove("speaking");
    // force reflow to restart the animation
    void micBtn.offsetWidth;
    micBtn.classList.add("speaking");
    if (singleToggleTimer) { clearTimeout(singleToggleTimer); singleToggleTimer = null; }
    setTimeout(() => micBtn.classList.remove("speaking"), 3000);
  }

  // ---- Command processing ----
  function processCommand(transcript) {
    if (!transcript || transcript.length < 2) return;

    // Skip pure filler / non-command noise so brief interjections or echo
    // of TTS output never trigger a confusing "didn't understand" response.
    const filler = transcript
      .replace(/[^\p{L}\p{N}\u0600-\u06FF]+/gu, " ")
      .trim();
    const fillerWords = new Set(["a", "an", "the", "ok", "okay", "yes", "no", "uh", "um", "ah", "من", "بە"]);

    const before = filler.length;
    const after = filler
      .split(/\s+/)
      .filter(w => !fillerWords.has(w))
      .join(" ")
      .trim()
      .length;

    if (before > 0 && after === 0) return; // transcript contained only filler words

    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    // Check for stop command first
    if (matchesAny(transcript, COMMANDS.stop[lang])) {
      stopListening();
      return;
    }

    // Help
    if (matchesAny(transcript, COMMANDS.help[lang])) {
      speak(fb.help);
      return;
    }

    // Smart UI navigation — check early so "go to price" navigates
    // instead of reading the price aloud
    {
      const navKeywords = COMMANDS.navigate[lang];
      const hasNavKeyword = matchesAny(transcript, navKeywords);
      if (hasNavKeyword) {
        const targets = NAV_TARGETS[lang];
        let navigated = false;
        for (const [key, fn] of Object.entries(targets)) {
          if (hasPhrase(transcript, key)) {
            fn();
            navigated = true;
            speak(lang === "ckb" ? `بڕۆیت بۆ ${key}` : `Navigated to ${key}`);
            break;
          }
        }
        if (navigated) return;
        // No target found — fall through to other commands
      }
    }

    // Price query — always reads the real-time XAU/USD live price.
    if (matchesAny(transcript, COMMANDS.price[lang])) {
      readLivePrice();
      return;
    }

    // Timeframe
    if (matchesAny(transcript, COMMANDS.timeframe[lang])) {
      const tf = extractTimeframe(transcript, lang);
      if (tf) {
        setTimeframe(tf);
        speak(fb.commandExecuted);
        return;
      }
      // No timeframe found — fall through to other commands
    }

    // Chart type
    if (matchesAny(transcript, COMMANDS.chartType[lang])) {
      const ct = extractChartType(transcript, lang);
      if (ct) {
        setChartType(ct);
        speak(fb.commandExecuted);
        return;
      }
      // No chart type found — fall through to other commands
    }

    // Analytics toggle
    if (matchesAny(transcript, COMMANDS.analytics[lang])) {
      toggleAnalytics();
      speak(fb.commandExecuted);
      return;
    }

    // Theme toggle
    if (matchesAny(transcript, COMMANDS.theme[lang])) {
      toggleTheme();
      speak(fb.commandExecuted);
      return;
    }

    // Settings
    if (matchesAny(transcript, COMMANDS.settings[lang])) {
      openSettings();
      speak(fb.commandExecuted);
      return;
    }

    // News / Calendar
    if (matchesAny(transcript, COMMANDS.news[lang])) {
      toggleNews();
      speak(fb.commandExecuted);
      return;
    }

    // Indicators
    if (matchesAny(transcript, COMMANDS.indicators[lang])) {
      toggleIndicators();
      speak(fb.commandExecuted);
      return;
    }

    // Sessions
    if (matchesAny(transcript, COMMANDS.sessions[lang])) {
      toggleSessions();
      speak(fb.commandExecuted);
      return;
    }

    // Notes
    if (matchesAny(transcript, COMMANDS.notes[lang])) {
      toggleNotes();
      speak(fb.commandExecuted);
      return;
    }

    // Sentiment toggle
    if (matchesAny(transcript, COMMANDS.sentiment[lang])) {
      toggleSentiment();
      speak(fb.commandExecuted);
      return;
    }

    // Market depth toggle
    if (matchesAny(transcript, COMMANDS.marketDepth[lang])) {
      toggleMarketDepth();
      speak(fb.commandExecuted);
      return;
    }

    // ---- Price-alert commands (checked before generic anomaly "alerts"
    // ---- keywords so "show price alerts" / "list my alerts" resolve here)
    if (matchesAny(transcript, COMMANDS.setAlert[lang])) {
      const price = extractAlertPrice(transcript, lang);
      if (price !== null) {
        setPriceAlert(price);
      } else {
        speak(fb.alertPrompt);
      }
      return;
    }

    if (matchesAny(transcript, COMMANDS.readPriceAlerts[lang])) {
      listPriceAlerts();
      return;
    }

    if (matchesAny(transcript, COMMANDS.listAlerts[lang])) {
      listPriceAlerts();
      return;
    }

    if (matchesAny(transcript, COMMANDS.clearPriceAlerts[lang])) {
      clearPriceAlerts();
      return;
    }

    if (matchesAny(transcript, COMMANDS.showPriceAlerts[lang])) {
      renderPriceAlertsPanel();
      const panel = document.getElementById("priceAlertsPanel");
      if (panel) {
        panel.classList.remove("hidden");
        panel.scrollIntoView({ behavior: "smooth", block: "center" });
        speak(fb.alertsList(priceAlerts.filter(a => !a.triggered).map(a => a.price.toFixed(2))));
      }
      return;
    }

    if (matchesAny(transcript, COMMANDS.anomalies[lang])) {
      toggleAnomalies();
      speak(fb.commandExecuted);
      return;
    }

    // Generic widget toggle
    if (matchesAny(transcript, COMMANDS.toggleWidget[lang])) {
      // Extract widget name from transcript
      const widgetKeywords = COMMANDS.toggleWidget[lang];
      let widgetName = transcript;
      for (const kw of widgetKeywords) {
        const idx = widgetName.indexOf(kw);
        if (idx !== -1) {
          widgetName = widgetName.substring(idx + kw.length).trim();
          break;
        }
      }
      if (widgetName.length > 1) {
        toggleWidgetByName(widgetName);
      } else {
        speak(fb.widgetNotFound);
      }
      return;
    }

    // Read sentiment
    if (matchesAny(transcript, COMMANDS.readSentiment[lang])) {
      readSentiment();
      return;
    }

    // Read market depth
    if (matchesAny(transcript, COMMANDS.readMarketDepth[lang])) {
      readMarketDepth();
      return;
    }

    // Read anomalies
    if (matchesAny(transcript, COMMANDS.readAnomalies[lang])) {
      readAnomalies();
      return;
    }

    // Clear anomaly alerts
    if (matchesAny(transcript, COMMANDS.clearAlerts[lang])) {
      clearAnomalyAlerts();
      return;
    }

    // Read sessions
    if (matchesAny(transcript, COMMANDS.readSessions[lang])) {
      readSessions();
      return;
    }

    // TTS on/off
    if (matchesAny(transcript, COMMANDS.ttsOn[lang])) {
      setTTSEnabled(true);
      speak(fb.ttsOn);
      return;
    }
    if (matchesAny(transcript, COMMANDS.ttsOff[lang])) {
      setTTSEnabled(false);
      return;
    }

    // Read status
    if (matchesAny(transcript, COMMANDS.readStatus[lang])) {
      readStatus();
      return;
    }

    // Read news
    if (matchesAny(transcript, COMMANDS.readNews[lang])) {
      readNews();
      return;
    }

    // Read indicators
    if (matchesAny(transcript, COMMANDS.readIndicators[lang])) {
      readIndicators();
      return;
    }

    // Say / speak arbitrary text
    if (matchesAny(transcript, COMMANDS.say[lang])) {
      // Extract the text after the command keyword
      const sayKeywords = COMMANDS.say[lang];
      let textToSpeak = transcript;
      for (const kw of sayKeywords) {
        const idx = textToSpeak.indexOf(kw);
        if (idx !== -1) {
          textToSpeak = textToSpeak.substring(idx + kw.length).trim();
          break;
        }
      }
      // Remove leading punctuation/connectors
      textToSpeak = textToSpeak.replace(/^[,:\s]+/, "").replace(/^that\s+/, "").replace(/^this\s+/, "");
      if (textToSpeak.length > 1) {
        speak(textToSpeak);
      } else {
        speak(fb.sayPrompt);
      }
      return;
    }

    // Scroll up
    if (matchesAny(transcript, COMMANDS.scrollUp[lang])) {
      scrollToTop();
      speak(lang === "ckb" ? "بڕۆیت بۆ سەرەوە" : "Scrolled to top");
      return;
    }

    // Scroll down
    if (matchesAny(transcript, COMMANDS.scrollDown[lang])) {
      scrollToBottom();
      speak(lang === "ckb" ? "بڕۆیت بۆ خوارەوە" : "Scrolled to bottom");
      return;
    }

    // No match — give feedback
    speak(fb.noCommand);
  }
// ---- Helper: normalize transcript for robust matching ----
  // - lower-cases and trims
  // - collapses internal whitespace/runs
  // - unifies curly/straight apostrophes and quotes
  // - converts Arabic-Indic (٠-٩) and Persian (۰-۹) digits to Western (0-9)
  function normalizeTranscript(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[‘’`´]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[\u0660-\u0669]/g, d => String("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669".indexOf(d)))
      .replace(/[\u06F0-\u06F9]/g, d => String("\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9".indexOf(d)))
      .replace(/[.,!?;:]+$/g, "")          // trailing punctuation
      .replace(/\s+/g, " ")                 // collapse all whitespace runs
      .trim();
  }

  // ---- Helper: check if transcript contains any (already-normalized) keyword ----
  function matchesAny(transcript, keywords) {
    if (!transcript) return false;
    return keywords.some(kw => {
      const needle = normalizeTranscript(kw);
      return needle && transcript.includes(needle);
    });
  }

  // ---- Helper: substring presence using normalized phrase ----
  function hasPhrase(transcript, phrase) {
    const needle = normalizeTranscript(phrase);
    return !!needle && transcript.includes(needle);
  }

  // ---- Helper: extract timeframe from transcript ----
  function extractTimeframe(transcript, lang) {
    const tfMap = TIMEFRAMES[lang];
    for (const [phrase, value] of Object.entries(tfMap)) {
      if (hasPhrase(transcript, phrase)) {
        return value;
      }
    }
    return null;
  }

  // ---- Helper: extract chart type from transcript ----
  function extractChartType(transcript, lang) {
    const ctMap = CHART_TYPES[lang];
    for (const [phrase, value] of Object.entries(ctMap)) {
      if (hasPhrase(transcript, phrase)) {
        return value;
      }
    }
    return null;
  }

  // ---- Command actions ----
  function setTimeframe(tf) {
    state.currentTimeframe = tf;
    document.querySelectorAll(".tf-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tf === tf);
    });
    loadCandles();
  }

  function setChartType(type) {
    state.currentChartType = type;
    document.querySelectorAll(".chart-type-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.chartType === type);
    });
    chart.setChartType(type);
  }

  function toggleAnalytics() {
    const section = document.getElementById("analyticsSection");
    if (section) {
      section.classList.toggle("collapsed");
    }
  }

  function toggleTheme() {
    const themeToggle = document.getElementById("themeToggle");
    if (themeToggle) {
      themeToggle.checked = !themeToggle.checked;
      const theme = themeToggle.checked ? "light" : "dark";
      localStorage.setItem("gold_theme", theme);
      document.body.classList.toggle("light-theme", theme === "light");
    }
  }

  function openSettings() {
    const modal = document.getElementById("settingsModal");
    if (modal) modal.classList.remove("hidden");
  }

  function toggleNews() {
    const ticker = document.getElementById("newsTicker");
    const calendar = document.getElementById("newsCalendar");
    if (ticker) {
      const isCollapsed = ticker.classList.toggle("collapsed");
      if (calendar) calendar.classList.toggle("hidden", !isCollapsed);
    }
  }

  function toggleIndicators() {
    const board = document.getElementById("indicatorBoard");
    if (board) {
      const body = document.getElementById("indicatorBoardBody");
      const isCollapsed = board.classList.toggle("collapsed");
      if (body) body.style.display = isCollapsed ? "none" : "";
    }
  }

  function toggleSentiment() {
    const panel = document.getElementById("sentimentPanel");
    const btn = document.getElementById("sentimentToggle");
    if (panel) {
      const isHidden = panel.classList.toggle("hidden");
      if (btn) btn.classList.toggle("active", !isHidden);
      if (!isHidden) populateSentiment();
    }
  }

  function toggleSessions() {
    const section = document.querySelector(".sessions-section");
    if (section) {
      const isCollapsed = section.classList.toggle("collapsed");
      const widget = section.querySelector(".sessions-widget");
      if (widget) widget.style.display = isCollapsed ? "none" : "";
    }
  }

  function toggleNotes() {
    const section = document.querySelector(".notes-section");
    if (section) {
      const isCollapsed = section.classList.toggle("collapsed");
      const widget = section.querySelector(".notes-widget");
      if (widget) widget.style.display = isCollapsed ? "none" : "";
    }
  }

  function toggleMarketDepth() {
    const section = document.getElementById("analyticsSection");
    if (section) section.classList.toggle("collapsed");
  }

  function toggleAnomalies() {
    const section = document.getElementById("analyticsSection");
    if (section) section.classList.toggle("collapsed");
  }

  // ---- Populate sentiment data (simulated) ----
  function populateSentiment() {
    const buyerEl = document.getElementById("buyerCount");
    const sellerEl = document.getElementById("sellerCount");
    const ratioEl = document.getElementById("sentimentRatio");
    const valueEl = document.getElementById("sentimentValue");
    const fillEl = document.getElementById("sentimentFill");
    const statusEl = document.getElementById("sentimentStatus");

    if (!buyerEl || !sellerEl) return;

    // Only generate data once — keep it stable across reads
    if (buyerEl.textContent !== "--") return;

    const buyers = Math.floor(Math.random() * 40) + 30;
    const sellers = 100 - buyers;
    const ratio = (buyers / sellers).toFixed(2);

    buyerEl.textContent = buyers;
    sellerEl.textContent = sellers;
    ratioEl.textContent = ratio;
    valueEl.textContent = `${buyers} / ${sellers}`;
    fillEl.style.width = `${buyers}%`;

    let statusText = "Neutral";
    let statusClass = "neutral";
    if (buyers > 60) { statusText = "Bullish"; statusClass = "bullish"; }
    else if (buyers < 40) { statusText = "Bearish"; statusClass = "bearish"; }

    statusEl.textContent = statusText;
    statusEl.className = "sentiment-status " + statusClass;
  }

  // ---- Read back sentiment data ----
  function readSentiment() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    populateSentiment();

    const buyerEl = document.getElementById("buyerCount");
    const sellerEl = document.getElementById("sellerCount");
    if (buyerEl && sellerEl && buyerEl.textContent !== "--") {
      const buyers = parseInt(buyerEl.textContent);
      const sellers = parseInt(sellerEl.textContent);
      if (!isNaN(buyers) && !isNaN(sellers)) {
        speak(fb.sentiment(buyers, sellers));
        return;
      }
    }
    speak(fb.noSentiment);
  }

  // ---- Read back market depth ----
  function readMarketDepth() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const spreadEl = document.getElementById("mdSpreadValue");
    const asksEl = document.getElementById("mdAsksList");
    const bidsEl = document.getElementById("mdBidsList");

    if (spreadEl && asksEl && bidsEl) {
      const spreadText = spreadEl.textContent;
      const spreadMatch = spreadText.match(/\$([\d.]+)/);
      const spread = spreadMatch ? parseFloat(spreadMatch[1]) : null;
      const askCount = asksEl.querySelectorAll(".md-book-row").length;
      const bidCount = bidsEl.querySelectorAll(".md-book-row").length;

      if (spread !== null) {
        speak(fb.depth(spread.toFixed(2), askCount, bidCount));
        return;
      }
    }
    speak(fb.noDepth);
  }

  // ---- Read back anomaly alerts ----
  function readAnomalies() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    if (typeof AnomalyDetector !== "undefined") {
      const alerts = AnomalyDetector.getAlerts();
      if (alerts.length > 0) {
        const messages = alerts.slice(0, 3).map(a => a.message);
        const msg = lang === "ckb"
          ? `ئاگادارییەکان: ${messages.join(". ")}`
          : `Anomaly alerts: ${messages.join(". ")}`;
        speak(msg);
        return;
      }
      speak(fb.noAnomalies);
      return;
    }
    speak(fb.noAnomalies);
  }

  // ---- Clear anomaly alerts ----
  function clearAnomalyAlerts() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    if (typeof AnomalyDetector !== "undefined") {
      AnomalyDetector.reset();
      speak(fb.anomaliesCleared);
    }
  }

  // ---- Read back open market sessions ----
  function readSessions() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const openSessions = [];
    document.querySelectorAll(".session-row").forEach(row => {
      if (row.classList.contains("open")) {
        const name = row.querySelector(".session-name");
        if (name) openSessions.push(name.textContent);
      }
    });

    if (openSessions.length > 0 || document.querySelectorAll(".session-row").length > 0) {
      speak(fb.sessions(openSessions));
      return;
    }
    speak(fb.noSessions);
  }

  // ---- Price alert system ----
  let priceAlerts = [];
  let alertCounter = 0;

  try {
    const saved = localStorage.getItem("gold_price_alerts");
    if (saved) priceAlerts = JSON.parse(saved);
  } catch (e) {}

  function saveAlerts() {
    localStorage.setItem("gold_price_alerts", JSON.stringify(priceAlerts));
  }

  function setPriceAlert(price) {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    if (typeof price !== "number" || !isFinite(price) || price <= 0) {
      speak(fb.alertPrompt);
      return;
    }

    const existing = priceAlerts.find(a => Math.abs(a.price - price) < 0.01 && !a.triggered);
    if (existing) {
      speak(fb.alertSet(price));
      return;
    }

    priceAlerts.push({
      id: ++alertCounter,
      price: parseFloat(price.toFixed(2)),
      triggered: false,
      ts: Date.now(),
    });
    saveAlerts();
    renderPriceAlertsPanel();
    speak(fb.alertSet(price));
  }

  function removePriceAlert(price) {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const idx = priceAlerts.findIndex(a => Math.abs(a.price - price) < 0.01);
    if (idx !== -1) {
      priceAlerts.splice(idx, 1);
      saveAlerts();
      renderPriceAlertsPanel();
      speak(fb.alertRemoved(price));
      return true;
    }
    return false;
  }

  function listPriceAlerts() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const active = priceAlerts.filter(a => !a.triggered);
    if (active.length === 0) {
      speak(fb.noAlerts);
      return;
    }
    const prices = active.map(a => a.price.toFixed(2));
    speak(fb.alertsList(prices));
  }

  function clearPriceAlerts() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    priceAlerts = [];
    saveAlerts();
    renderPriceAlertsPanel();
    speak(fb.alertsCleared);
  }

  // Check price alerts against current price — called on each tick
  function checkPriceAlerts(price) {
    if (!priceAlerts.length || typeof price !== "number") return;

    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    let anyTriggered = false;
    for (const alert of priceAlerts) {
      if (alert.triggered) continue;

      const crossed = (price >= alert.price && alert.price >= price - 0.5) ||
                      (price <= alert.price && alert.price <= price + 0.5);

      if (crossed) {
        alert.triggered = true;
        anyTriggered = true;
        speak(fb.alertTriggered(alert.price));
      }
    }

    const now = Date.now();
    priceAlerts = priceAlerts.filter(a => !a.triggered || now - a.ts < 60000);
    saveAlerts();

    // Update the visual panel if anything changed
    if (anyTriggered) {
      renderPriceAlertsPanel();
    }
  }

// ---- Extract price from alert command ----
  function extractAlertPrice(transcript, lang) {
    // Look for a number in a reasonable gold price range (1000-5000)
    const numMatch = transcript.match(/(\d{3,4}(?:[.,]\d{1,2})?)/);
    if (numMatch) {
      const price = parseFloat(numMatch[1].replace(",", "."));
      if (price >= 1000 && price <= 5000) {
        return price;
      }
    }

    // Defense-in-depth: if raw Arabic-Indic digits slipped through, convert.
    const rawMatch = transcript.match(/([\u0660-\u0669]{3,4}(?:[\u060C\u066B][\u0660-\u0669]{1,2})?)/);
    if (rawMatch) {
      const arabicToWestern = rawMatch[1]
        .replace(/[\u0660-\u0669]/g, d => String("\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669".indexOf(d)))
        .replace(/[\u066B\u060C]/g, ".");
      const price = parseFloat(arabicToWestern);
      if (price >= 1000 && price <= 5000) {
        return price;
      }
    }

    return null;
  }

// ---- Generic widget toggle ----
  function toggleWidgetByName(name) {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const lower = name.toLowerCase();
    const widgetMap = {
      "analytics": () => toggleAnalytics(),
      "widgets": () => toggleAnalytics(),
      "news": () => toggleNews(),
      "calendar": () => toggleNews(),
      "indicators": () => toggleIndicators(),
      "summary": () => toggleIndicators(),
      "sentiment": () => toggleSentiment(),
      "sessions": () => toggleSessions(),
      "notes": () => toggleNotes(),
      "depth": () => toggleMarketDepth(),
      "order book": () => toggleMarketDepth(),
      "anomalies": () => toggleAnomalies(),
      "alerts": () => toggleAnomalies(),
    };

    for (const [key, fn] of Object.entries(widgetMap)) {
      if (lower.includes(key)) {
        fn();
        speak(fb.widgetToggled);
        return;
      }
    }
    speak(fb.widgetNotFound);
  }

  // ---- Smart UI Navigator ----
  // Maps spoken phrases to panel elements and scrolls/highlights them.
  const NAV_TARGETS = {
    en: {
      "chart": () => scrollToPanel("chartContainer"),
      "price": () => scrollToPanel("livePrice"),
      "sentiment": () => { toggleSentiment(); scrollToPanel("sentimentPanel"); },
      "sessions": () => { toggleSessions(); scrollToPanel("sessions-section"); },
      "notes": () => { toggleNotes(); scrollToPanel("notes-section"); },
      "news": () => { toggleNews(); scrollToPanel("newsTicker"); },
      "calendar": () => { toggleNews(); scrollToPanel("newsCalendar"); },
      "indicators": () => { toggleIndicators(); scrollToPanel("indicatorBoard"); },
      "summary": () => { toggleIndicators(); scrollToPanel("indicatorBoard"); },
      "analytics": () => { toggleAnalytics(); scrollToPanel("analyticsSection"); },
      "widgets": () => { toggleAnalytics(); scrollToPanel("analyticsSection"); },
      "depth": () => { toggleMarketDepth(); scrollToPanel("analyticsSection"); },
      "order book": () => { toggleMarketDepth(); scrollToPanel("analyticsSection"); },
      "anomalies": () => { toggleAnomalies(); scrollToPanel("analyticsSection"); },
      "alerts": () => scrollToPanel("priceAlertsPanel"),
      "settings": () => scrollToPanel("settingsModal"),
      "top": () => scrollToTop(),
      "bottom": () => scrollToBottom(),
    },
    ckb: {
      "چارت": () => scrollToPanel("chartContainer"),
      "نرخ": () => scrollToPanel("livePrice"),
      "هەست": () => { toggleSentiment(); scrollToPanel("sentimentPanel"); },
      "سێشن": () => { toggleSessions(); scrollToPanel("sessions-section"); },
      "تێبینی": () => { toggleNotes(); scrollToPanel("notes-section"); },
      "هەواڵ": () => { toggleNews(); scrollToPanel("newsTicker"); },
      "ڕۆژژمێر": () => { toggleNews(); scrollToPanel("newsCalendar"); },
      "ئینдикаتەر": () => { toggleIndicators(); scrollToPanel("indicatorBoard"); },
      "پوختە": () => { toggleIndicators(); scrollToPanel("indicatorBoard"); },
      "ئانالیتیکس": () => { toggleAnalytics(); scrollToPanel("analyticsSection"); },
      "ویجێت": () => { toggleAnalytics(); scrollToPanel("analyticsSection"); },
      "قوڵی": () => { toggleMarketDepth(); scrollToPanel("analyticsSection"); },
      "نائاسایی": () => { toggleAnomalies(); scrollToPanel("analyticsSection"); },
      "ئاگاداری": () => scrollToPanel("priceAlertsPanel"),
      "ڕێکخستن": () => scrollToPanel("settingsModal"),
      "سەرەوە": () => scrollToTop(),
      "خوارەوە": () => scrollToBottom(),
    },
  };

  function scrollToPanel(id) {
    let el = document.getElementById(id);
    if (!el) {
      // Try querySelector for class-based targets
      const byClass = document.querySelector("." + id);
      if (byClass) {
        el = byClass;
      }
    }
    if (!el) return false;

    // If it's a modal, open it instead of scrolling
    if (el.classList.contains("modal-backdrop") || el.classList.contains("modal")) {
      el.classList.remove("hidden");
      return true;
    }

    // If it's a hidden panel, show it first
    if (el.classList.contains("hidden")) {
      el.classList.remove("hidden");
    }

    // If it's a collapsed section, expand it
    if (el.classList.contains("collapsed")) {
      el.classList.remove("collapsed");
      const body = el.querySelector(".analytics-body, .indicator-board-body, .sessions-widget, .notes-widget");
      if (body) body.style.display = "";
    }

    // Scroll the element into view
    el.scrollIntoView({ behavior: "smooth", block: "center" });

    // Add highlight animation
    el.classList.remove("panel-highlight");
    void el.offsetWidth; // force reflow to restart animation
    el.classList.add("panel-highlight");
    setTimeout(() => el.classList.remove("panel-highlight"), 1500);

    return true;
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    return true;
  }

  // ---- Price Alerts Panel rendering ----
  function renderPriceAlertsPanel() {
    const panel = document.getElementById("priceAlertsPanel");
    const list = document.getElementById("priceAlertsList");
    if (!panel || !list) return;

    const active = priceAlerts.filter(a => !a.triggered);
    const triggered = priceAlerts.filter(a => a.triggered);

    if (priceAlerts.length === 0) {
      panel.classList.add("hidden");
      return;
    }

    panel.classList.remove("hidden");

    const items = [];
    active.forEach(a => {
      items.push(`
        <div class="price-alert-item">
          <span class="price-alert-price">$${a.price.toFixed(2)}</span>
          <span class="price-alert-status">Waiting</span>
        </div>`);
    });
    triggered.forEach(a => {
      items.push(`
        <div class="price-alert-item triggered">
          <span class="price-alert-price">$${a.price.toFixed(2)}</span>
          <span class="price-alert-status triggered">Triggered</span>
        </div>`);
    });

    list.innerHTML = items.join("");

    // Wire up clear button
    const clearBtn = document.getElementById("priceAlertsClearBtn");
    if (clearBtn) {
      clearBtn.onclick = () => {
        clearPriceAlerts();
        renderPriceAlertsPanel();
      };
    }
  }

  // ---- Speech synthesis (voice feedback) ----
  // Cache voices since getVoices() may return empty on first call
  let cachedVoices = [];
  let voicesLoaded = false;

  function loadVoices() {
    if (!SpeechSynthesis) return;
    cachedVoices = SpeechSynthesis.getVoices();
    voicesLoaded = cachedVoices.length > 0;
  }

  // Load voices immediately and on the async 'voiceschanged' event
  if (SpeechSynthesis) {
    loadVoices();
    SpeechSynthesis.onvoiceschanged = loadVoices;
  }

  // TTS enabled flag (persisted)
  let ttsEnabled = localStorage.getItem("gold_tts") !== "off";

  function speak(text) {
    if (!SpeechSynthesis || !ttsEnabled) return;
    // Cancel any ongoing speech to avoid overlap
    SpeechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const isCkb = currentLang === "ckb";
    const isAr = currentLang === "ar";
    utterance.lang = isCkb ? "ckb" : isAr ? "ar" : "en-US";
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Try to find a matching voice (reload if not yet loaded)
    if (!voicesLoaded) loadVoices();

    if (isCkb) {
      // Kurdish (ckb) — try exact match first, then fall back to
      // Arabic (ar) or Turkish (tr) which share phonetic characteristics
      const ckbVoice = cachedVoices.find(v => v.lang.toLowerCase().startsWith("ckb"));
      const arVoice = cachedVoices.find(v => v.lang.toLowerCase().startsWith("ar"));
      const trVoice = cachedVoices.find(v => v.lang.toLowerCase().startsWith("tr"));
      const fallbackVoice = ckbVoice || arVoice || trVoice;
      if (fallbackVoice) {
        utterance.voice = fallbackVoice;
        // If using a fallback voice, adjust the lang to match
        if (!ckbVoice) {
          utterance.lang = fallbackVoice.lang;
        }
      }
    } else if (isAr) {
      // Arabic — find an Arabic voice
      const arVoice = cachedVoices.find(v => v.lang.toLowerCase().startsWith("ar"));
      if (arVoice) {
        utterance.voice = arVoice;
      }
    } else {
      const langPrefix = "en";
      const matchingVoice = cachedVoices.find(v => v.lang.startsWith(langPrefix));
      if (matchingVoice) {
        utterance.voice = matchingVoice;
      }
    }

    // Show visual feedback toast
    showFeedbackToast(text);

    SpeechSynthesis.speak(utterance);
  }

  // ---- Visual feedback toast for voice commands ----
  let toastTimer = null;
  function showFeedbackToast(text) {
    const toast = document.getElementById("voiceFeedbackToast");
    const toastText = document.getElementById("voiceFeedbackText");
    if (!toast || !toastText) return;

    // Truncate long text for the toast
    const display = text.length > 80 ? text.substring(0, 77) + "..." : text;
    toastText.textContent = display;
    toast.classList.add("visible");

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("visible");
    }, 3000);
  }

  // Public method to speak arbitrary text (used by external callers)
  function speakText(text) {
    speak(text);
  }

  // Toggle TTS on/off
  function setTTSEnabled(enabled) {
    ttsEnabled = enabled;
    localStorage.setItem("gold_tts", enabled ? "on" : "off");
    if (!enabled) {
      SpeechSynthesis.cancel();
    }
  }

  function isTTSEnabled() {
    return ttsEnabled;
  }

// ---- Read back the real-time XAU/USD live price ----
  // Primary source is the live terminal price via DataFeed (real spot polled
  // from the backend every ~5s + sub-second micro-ticks). Falls back to the
  // #livePrice DOM element so the voice always reflects the same real-time
  // number shown on the terminal, never a stale generic string.
  function readLivePrice() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const live = typeof DataFeed !== "undefined" ? DataFeed.getLiveData() : null;
    let price = live && typeof live.price === "number" ? live.price : null;

    // Prefer the same number the terminal displays if it exists.
    const priceEl = document.getElementById("livePrice");
    if (priceEl && priceEl.textContent && priceEl.textContent !== "--") {
      const shown = parseFloat(priceEl.textContent.replace(/[^\d.\-]/g, ""));
      if (!isNaN(shown)) price = shown;
    }

    if (price !== null && !isNaN(price)) {
      speak(fb.price(price));
      return;
    }

    speak(fb.noCommand);
  }

// ---- Read back current dashboard status ----
  function readStatus() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    // Get current price from the live terminal feed
    let priceText = "";
    const live = typeof DataFeed !== "undefined" ? DataFeed.getLiveData() : null;
    if (live && typeof live.price === "number") {
      priceText = fb.price(live.price);
    } else {
      const priceEl = document.getElementById("livePrice");
      if (priceEl && priceEl.textContent !== "--") {
        priceText = fb.price(parseFloat(priceEl.textContent.replace(/[^\d.\-]/g, "")));
      }
    }

    // Get current timeframe and chart type
    const tfLabel = state.currentTimeframe || "1m";
    const ctLabel = state.currentChartType || "candles";

    // Build status message
    let statusMsg;
    if (lang === "ckb") {
      statusMsg = `ماوەی ئێستا ${tfLabel}، جۆری چارت ${ctLabel}. ${priceText}`;
    } else {
      statusMsg = `Current timeframe is ${tfLabel}, chart type is ${ctLabel}. ${priceText}`;
    }

    speak(statusMsg);
  }

  // ---- Read back latest news headlines ----
  function readNews() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const ticker = document.getElementById("newsTicker");
    if (!ticker) {
      speak(fb.noCommand);
      return;
    }

    // Try to extract news items from the ticker
    const items = ticker.querySelectorAll(".news-item, .news-ticker-item, li");
    if (items.length > 0) {
      const headlines = [];
      items.forEach(item => {
        const text = item.textContent.trim();
        if (text && text.length > 3) headlines.push(text);
      });

      if (headlines.length > 0) {
        const limit = Math.min(3, headlines.length);
        const msg = lang === "ckb"
          ? `ئەمە سەرەکیترین هەواڵەکانە: ${headlines.slice(0, limit).join(". ")}`
          : `Here are the latest headlines: ${headlines.slice(0, limit).join(". ")}`;
        speak(msg);
        return;
      }
    }

    speak(lang === "ckb" ? "هیچ هەواڵێک بەردەست نییە" : "No news available right now");
  }

  // ---- Read back indicator summary ----
  function readIndicators() {
    const lang = currentLang === "ckb" || currentLang === "ar" ? "ckb" : "en";
    const fb = FEEDBACK[lang];

    const board = document.getElementById("indicatorBoard");
    if (!board) {
      speak(fb.noCommand);
      return;
    }

    const cards = board.querySelectorAll(".indicator-card");
    if (cards.length > 0) {
      const summaries = [];
      cards.forEach(card => {
        const name = card.querySelector(".indicator-card-name, h4, .card-title");
        const status = card.querySelector(".indicator-card-status, .status");
        if (name) {
          const nameText = name.textContent.trim();
          const statusText = status ? status.textContent.trim() : "";
          summaries.push(statusText ? `${nameText}: ${statusText}` : nameText);
        }
      });

      if (summaries.length > 0) {
        const msg = lang === "ckb"
          ? `پوختەی ئینдикаتەرەکان: ${summaries.join(". ")}`
          : `Indicator summary: ${summaries.join(". ")}`;
        speak(msg);
        return;
      }
    }

    speak(lang === "ckb" ? "هیچ ئینдикаتەرێک بەردەست نییە" : "No indicators available");
  }

  // ---- Public API ----
  return {
    init,
    startListening,
    stopListening,
    isListening: () => listening,
    setLanguage,
    isSupported: () => SUPPORTED,
    speak: speakText,
    setTTSEnabled,
    isTTSEnabled,
    readStatus,
    readNews,
    readIndicators,
    readSentiment,
    readMarketDepth,
    readAnomalies,
    readSessions,
    setPriceAlert,
    listPriceAlerts,
    clearPriceAlerts,
    checkPriceAlerts,
    renderPriceAlertsPanel,
    toggleSentiment,
    toggleSessions,
    toggleNotes,
    toggleMarketDepth,
    toggleAnomalies,
    toggleWidgetByName,
  };
})();
window.addEventListener("DOMContentLoaded", init);