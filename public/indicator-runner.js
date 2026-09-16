// indicator-runner.js — safe sandbox for custom indicator scripts
// The user writes JS using our built-in functions. We compile in a sandbox.

const IndLib = {
  SMA: (data, period) => {
    const out = new Array(data.length).fill(0);
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      out[i] = sum / period;
    }
    return out;
  },
  EMA: (data, period) => {
    const out = new Array(data.length).fill(0);
    const mult = 2 / (period + 1);
    if (data.length > 0) out[0] = data[0];
    for (let i = 1; i < data.length; i++) {
      out[i] = (data[i] - out[i - 1]) * mult + out[i - 1];
    }
    return out;
  },
  RSI: (data, period = 14) => {
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
  },
  BB: (data, period = 20, mult = 2) => {
    const sma = IndLib.SMA(data, period);
    const upper = new Array(data.length).fill(0);
    const lower = new Array(data.length).fill(0);
    for (let i = period - 1; i < data.length; i++) {
      let variance = 0;
      for (let j = 0; j < period; j++) {
        variance += Math.pow(data[i - j] - sma[i], 2);
      }
      const sd = Math.sqrt(variance / period);
      upper[i] = sma[i] + mult * sd;
      lower[i] = sma[i] - mult * sd;
    }
    return { middle: sma, upper, lower };
  },
  crossAbove: (arr1, arr2) => {
    if (!arr1.length || !arr2.length) return false;
    const i = arr1.length - 1;
    return arr1[i - 1] <= arr2[i - 1] && arr1[i] > arr2[i];
  },
  crossBelow: (arr1, arr2) => {
    if (!arr1.length || !arr2.length) return false;
    const i = arr1.length - 1;
    return arr1[i - 1] >= arr2[i - 1] && arr1[i] < arr2[i];
  },
  highest: (data, period) => {
    if (!data.length) return 0;
    return Math.max(...data.slice(-period));
  },
  lowest: (data, period) => {
    if (!data.length) return 0;
    return Math.min(...data.slice(-period));
  },
};

const IndAPI = IndLib;

function runIndicatorScript(script, candles) {
  try {
    // Build arrays
    const open = candles.map(c => c.open);
    const high = candles.map(c => c.high);
    const low = candles.map(c => c.low);
    const close = candles.map(c => c.close);
    const volume = candles.map(c => c.volume);

// Merge API into scope
    const sandbox = Object.create(null);
    Object.assign(sandbox, IndAPI);
    sandbox.open = open; sandbox.high = high; sandbox.low = low; sandbox.close = close; sandbox.volume = volume;
    sandbox.candles = candles;
    sandbox.SMA = IndAPI.SMA;
    sandbox.EMA = IndAPI.EMA;
    sandbox.RSI = IndAPI.RSI;
    sandbox.BB = IndAPI.BB;
    sandbox.crossAbove = IndAPI.crossAbove;
    sandbox.crossBelow = IndAPI.crossBelow;
    sandbox.highest = IndAPI.highest;
    sandbox.lowest = IndAPI.lowest;

const fn = new Function("sandbox", `
      with(sandbox) {
        ${script}
      }
    `);
    const result = fn(sandbox);
    // result is whatever the script returns (object with overlays, panes, signals)
    return result || {};
  } catch (err) {
    throw new Error("Script error: " + err.message);
  }
}