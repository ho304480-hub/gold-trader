// chart.js — wraps TradingView Lightweight Charts
const chart = (() => {
  let chartInstance;
  let candleSeries;
  let volumeSeries;
  let currentSeries;
  let currentChartType = "candles";
  let candleData = [];
  let panes = {};
  let overlays = {};
  let markersMark = [];

  // Scale factor used to fit the raw volume onto the candlestick pane's
  // price scale so the volume histogram renders as a bottom strip rather
  // than dominating the whole chart height.
  let volumeScale = 1;

function init() {
    chartInstance = LightweightCharts.createChart(document.getElementById("chartContainer"), {
      layout: {
        background: { color: "#111827" },
        textColor: "#d1d5db",
        fontFamily: "Inter, monospace",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: "#64748b", width: 1, style: LightweightCharts.LineStyle.Dashed },
        horzLine: { color: "#64748b", width: 1, style: LightweightCharts.LineStyle.Dashed },
      },
      // Price axis: normal orientation — low prices at the bottom, high
      // prices at the top, so an uptrend rises up the screen.
      // `invertScale` must stay false; setting it true flips the whole
      // price axis and makes the chart read top-to-bottom.
      rightPriceScale: {
        borderColor: "#374151",
        invertScale: false,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      // Use the browser's local timezone so the time axis is always synced
      // to the user's local clock (hours, minutes, seconds, dates).
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
      // Live time axis: show seconds, precise daily dates, local timezone
      timeScale: {
        timeVisible: true,     // show HH:MM:SS on the time axis
        secondsVisible: true,  // show seconds on the time axis
        borderColor: "#374151",
        // Tight right gutter — 5 bars of empty space looked like a gap.
        rightOffset: 1,
        // Denser candles: 8px per bar left visible gaps between candles.
        // 4px packs them shoulder-to-shoulder like MT5/TradingView default.
        barSpacing: 4,
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        fixRightEdge: false,
        lockVisibleTimeRangeOnResize: true,
        rightBarStaysOnScroll: true,
        borderVisible: true,
        visible: true,
        // MT5-style smooth scrolling
        kineticScroll: {
          mouse: true,
          touch: true,
          deceleration: 0.997,
          maxVelocity: 1000,
        },
      },
      time: { seconds: true }, // enable second-level precision for intraday data
      localization: {
        priceFormatter: (p) => p.toFixed(2),
        // Precise date/time formatting in the user's local timezone
        timeFormatter: (businessDayOrTimestamp) => {
          const pad = (n) => String(n).padStart(2, "0");
          if (typeof businessDayOrTimestamp === "object") {
            // BusinessDay object (daily data) — display as-is
            return `${businessDayOrTimestamp.year}-${pad(businessDayOrTimestamp.month)}-${pad(businessDayOrTimestamp.day)}`;
          }
          // Timestamp (seconds, UTC) — convert to local timezone
          const date = new Date(businessDayOrTimestamp * 1000);
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        },
        dateFormatter: (businessDayOrTimestamp) => {
          const pad = (n) => String(n).padStart(2, "0");
          if (typeof businessDayOrTimestamp === "object") {
            // BusinessDay object (daily data) — display as-is
            return `${businessDayOrTimestamp.year}-${pad(businessDayOrTimestamp.month)}-${pad(businessDayOrTimestamp.day)}`;
          }
          // Timestamp (seconds, UTC) — convert to local timezone
          const date = new Date(businessDayOrTimestamp * 1000);
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        },
      },
      watermark: {
        visible: true,
        text: "حەمزە گۆڵد",
        color: "rgba(255,255,255,0.03)",
        fontSize: 64,
      },
      // Performance: responsive interaction for high-frequency updates
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
        axisDoubleClickReset: true,
      },
    });

    candleSeries = createSeries("candles");
    currentSeries = candleSeries;

// Volume histogram pinned to its own price scale, so it renders as a
    // thin strip along the bottom of the chart without rescaling the candles.
    volumeSeries = chartInstance.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
      base: 0,
    });
    chartInstance.priceScale("volume").applyOptions({
      // Volume occupies the bottom 18% of the pane. The candle price scale
      // reserves the same band via its bottom margin so the two never
      // overlap and the candles keep the full upper area.
      scaleMargins: { top: 0.82, bottom: 0 },
    });

return chartInstance;
  }

  function createSeries(type) {
    const baseOptions = {
      priceLineVisible: false,
      lastValueVisible: true,
    };

    switch (type) {
      case "bars":
        return chartInstance.addBarSeries({
          upColor: "#4ade80",
          downColor: "#f87171",
          thinBars: false,
          ...baseOptions,
        });
      case "line":
        return chartInstance.addLineSeries({
          color: "#22d3ee",
          lineWidth: 2,
          ...baseOptions,
        });
      case "area":
        return chartInstance.addAreaSeries({
          lineColor: "#22d3ee",
          topColor: "rgba(34, 211, 238, 0.4)",
          bottomColor: "rgba(34, 211, 238, 0.02)",
          lineWidth: 2,
          ...baseOptions,
        });
      case "baseline":
        return chartInstance.addBaselineSeries({
          baseValue: { type: "price", price: 2350 },
          topLineColor: "#4ade80",
          topFillColor1: "rgba(74, 222, 128, 0.3)",
          topFillColor2: "rgba(74, 222, 128, 0.05)",
          bottomLineColor: "#f87171",
          bottomFillColor1: "rgba(248, 113, 113, 0.3)",
          bottomFillColor2: "rgba(248, 113, 113, 0.05)",
          lineWidth: 2,
          ...baseOptions,
        });
      case "histogram":
        return chartInstance.addHistogramSeries({
          color: "#22d3ee",
          base: 0,
          ...baseOptions,
        });
      case "candles":
      default:
        return chartInstance.addCandlestickSeries({
          upColor: "#4ade80",
          downColor: "#f87171",
          borderVisible: false,
          wickUpColor: "#4ade80",
          wickDownColor: "#f87171",
          // MT5-style price precision — 2 decimal places for gold
          priceFormat: {
            type: "price",
            precision: 2,
            minMove: 0.01,
          },
          ...baseOptions,
        });
    }
  }

  function setChartType(type) {
    if (type === currentChartType) return;
    currentChartType = type;

    // Remove old series
    if (currentSeries) {
      chartInstance.removeSeries(currentSeries);
    }

    // Create new series
    currentSeries = createSeries(type);
    candleSeries = currentSeries;

    // Re-plot data
    if (candleData.length > 0) {
      if (type === "histogram") {
        // Histogram needs { time, value } format
        const histData = candleData.map(c => ({
          time: c.time,
          value: c.close,
        }));
        currentSeries.setData(histData);
      } else if (type === "line" || type === "area" || type === "baseline") {
        // Line/Area/Baseline need { time, value } format
        const lineData = candleData.map(c => ({
          time: c.time,
          value: c.close,
        }));
        currentSeries.setData(lineData);
      } else {
        // Candles/Bars need full OHLC data
        currentSeries.setData(candleData);
      }
    }

    // Re-plot overlays and panes
    Object.values(overlays).forEach((s) => chartInstance.removeSeries(s));
    const oldOverlays = overlays;
    overlays = {};
    Object.entries(oldOverlays).forEach(([id, series]) => {
      const newSeries = chartInstance.addLineSeries({
        color: series.options().color || "#22d3ee",
        lineWidth: series.options().lineWidth || 2,
      });
      newSeries.setData(series.data());
      overlays[id] = newSeries;
    });

    Object.values(panes).forEach((s) => chartInstance.removeSeries(s));
    const oldPanes = panes;
    panes = {};
    Object.entries(oldPanes).forEach(([id, series]) => {
      const newSeries = chartInstance.addLineSeries({
        color: series.options().color || "#a78bfa",
        lineWidth: series.options().lineWidth || 1.5,
      });
      newSeries.setData(series.data());
      panes[id] = newSeries;
    });

    // MT5-style: keep the view at the latest candle after switching
    chartInstance.timeScale().scrollToRealTime();
  }

function clearOverlays() {
    Object.values(overlays).forEach((s) => chartInstance.removeSeries(s));
    overlays = {};
  }

function clearPanes() {
    Object.values(panes).forEach((s) => chartInstance.removeSeries(s));
    panes = {};
  }

// Normalise candle order to strictly ascending time. Lightweight Charts
  // plots left-to-right in array order, so a descending feed renders the
  // series mirrored — the newest bar lands on the left and the chart reads
  // backwards. Sorting here guarantees oldest-left / newest-right.
  function normalizeCandles(candles) {
    if (!candles || candles.length < 2) return candles || [];
    let ascending = true;
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].time < candles[i - 1].time) { ascending = false; break; }
    }
    if (ascending) return candles;
    return candles.slice().sort((a, b) => a.time - b.time);
  }

  function showCandles(candles) {
    // Skip if identical reference (no-op guard)
    if (candleData === candles) return;
    candles = normalizeCandles(candles);
    candleData = candles;
    if (currentChartType === "histogram" || currentChartType === "line" || currentChartType === "area" || currentChartType === "baseline") {
      const lineData = candles.map(c => ({
        time: c.time,
        value: c.close,
      }));
      currentSeries.setData(lineData);
    } else {
      currentSeries.setData(candles);
    }
    renderVolume(candles);
  }

function updateLastCandle(candle) {
    if (currentChartType === "histogram" || currentChartType === "line" || currentChartType === "area" || currentChartType === "baseline") {
      currentSeries.update({ time: candle.time, value: candle.close });
    } else {
      currentSeries.update(candle);
    }
    if (volumeSeries && candle) {
      const vol = Math.max(0, Number(candle.volume) || 0) * volumeScale;
      volumeSeries.update({
        time: candle.time,
        value: vol,
        color: candle.close >= candle.open ? "rgba(74, 222, 128, 0.5)" : "rgba(248, 113, 113, 0.5)",
      });
    }
  }

  // Build the volume histogram data from the candle array and push it to
  // the dedicated volume series. Bars are colored by candle direction.
  function renderVolume(candles) {
    if (!volumeSeries || !candles || candles.length === 0) return;

    // Auto-scale so the tallest bar maps to a comfortable strip height.
    let maxVol = 1;
    for (const c of candles) {
      const v = Number(c.volume) || 0;
      if (v > maxVol) maxVol = v;
    }
    volumeScale = maxVol > 0 ? 1 / maxVol : 1;

    const volData = candles.map(c => {
      const v = Math.max(0, Number(c.volume) || 0) * volumeScale;
      return {
        time: c.time,
        value: v,
        color: c.close >= c.open ? "rgba(74, 222, 128, 0.5)" : "rgba(248, 113, 113, 0.5)",
      };
    });
    volumeSeries.setData(volData);
  }

function plotOverlay(id, data, options) {
    if (overlays[id]) chartInstance.removeSeries(overlays[id]);
    const series = chartInstance.addLineSeries({...options});
    series.setData(data);
    overlays[id] = series;
    return series;
  }

function plotPane(id, data, options) {
    if (panes[id]) chartInstance.removeSeries(panes[id]);
    const series = chartInstance.addLineSeries({...options});
    series.setData(data);
    panes[id] = series;
    return series;
  }

function plotSignals(signals) {
    if (!signals || signals.length === 0) return;
    currentSeries.setMarkers(signals);
  }

function clearAll() {
    clearOverlays();
    clearPanes();
    currentSeries.setMarkers([]);
  }

  // Remove all series belonging to a specific indicator (by id prefix)
  function removeIndicatorSeries(indId) {
    const prefix = `${indId}-`;
    Object.keys(overlays).forEach((id) => {
      if (id.startsWith(prefix)) {
        chartInstance.removeSeries(overlays[id]);
        delete overlays[id];
      }
    });
    Object.keys(panes).forEach((id) => {
      if (id.startsWith(prefix)) {
        chartInstance.removeSeries(panes[id]);
        delete panes[id];
      }
    });
  }

function resize() {
    if (!chartInstance) return;
    const container = document.getElementById("chartContainer");
    if (!container) return;
    // Read layout once, apply once — avoids layout thrashing
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0) {
      chartInstance.applyOptions({ width: w, height: h });
    }
  }

  // MT5-style: auto-scroll to the latest candle
  function scrollToRealTime() {
    if (!chartInstance) return;
    chartInstance.timeScale().scrollToRealTime();
  }

  // Register a callback for when the visible time range changes (user scroll/zoom)
  function onVisibleRangeChange(cb) {
    if (!chartInstance) return;
    chartInstance.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      // Convert logical range to time range for the callback
      const bars = chartInstance.timeScale().getVisibleRange();
      cb(bars);
    });
  }

  return { init, showCandles, setCandles: showCandles, updateLastCandle, plotOverlay, plotPane, plotSignals, clearAll, removeIndicatorSeries, resize, scrollToRealTime, onVisibleRangeChange, setChartType };
})();