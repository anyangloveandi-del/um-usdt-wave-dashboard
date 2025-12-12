import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 策略参数 =====
const INTERVAL = "1m";
const WINDOW_N = 30;
const SCAN_EVERY_SEC = 60;

const AMP_PCT = 10.0;

const VOL_SPIKE_N = 5;
const VOL_MULT = 1.8;

const BREAK_LOOKBACK = 20;
const NEAR_HIGH_PCT = 0.3;
const BREAK_VOL_N = 3;

const COOLDOWN_SEC = 900;
const MAX_ALERTS = 300;

// ===== Binance UM Futures =====
const BASE = "https://fapi.binance.com";

let symbols = [];
let alerts = [];
const lastAlertTs = new Map();

async function fetchJSON(url, params = {}) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function loadSymbols() {
  const data = await fetchJSON(`${BASE}/fapi/v1/exchangeInfo`);
  symbols = data.symbols
    .filter(s => s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING")
    .map(s => s.symbol);
  console.log("Symbols:", symbols.length);
}

function ampPct(highs, lows) {
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  return lo > 0 ? ((hi - lo) / lo) * 100 : 0;
}

async function checkSymbol(sym) {
  const k = await fetchJSON(`${BASE}/fapi/v1/klines`, {
    symbol: sym,
    interval: INTERVAL,
    limit: WINDOW_N
  });

  const highs = k.map(x => +x[2]);
  const lows = k.map(x => +x[3]);
  const closes = k.map(x => +x[4]);
  const volumes = k.map(x => +x[5]);

  const a = ampPct(highs, lows);

  const n = VOL_SPIKE_N;
  const volRecent = volumes.slice(-n).reduce((a, b) => a + b, 0);
  const volPrev = volumes.slice(-2 * n, -n).reduce((a, b) => a + b, 0);
  const volOk = volPrev > 0 && volRecent >= volPrev * VOL_MULT;

  const look = Math.min(BREAK_LOOKBACK, closes.length - 1);
  const prevHigh = Math.max(...highs.slice(-look - 1, -1));
  const winHigh = Math.max(...highs);
  const lastClose = closes.at(-1);

  const nearHigh = ((winHigh - lastClose) / winHigh) * 100 <= NEAR_HIGH_PCT;
  const breakoutOk = lastClose > prevHigh || nearHigh;

  const triggered = a >= AMP_PCT && volOk && breakoutOk;

  return { sym, a, volOk, breakoutOk, triggered };
}

async function scannerLoop() {
  await loadSymbols();

  while (true) {
    const now = Date.now();
    for (const sym of symbols) {
      const last = lastAlertTs.get(sym) || 0;
      if (now - last < COOLDOWN_SEC * 1000) continue;

      try {
        const r = await checkSymbol(sym);
        if (r.triggered) {
          alerts.unshift({ time: new Date().toLocaleString(), ...r });
          alerts = alerts.slice(0, MAX_ALERTS);
          lastAlertTs.set(sym, now);
          console.log("ALERT:", r.sym, r.a.toFixed(2));
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, SCAN_EVERY_SEC * 1000));
  }
}

app.use(express.static("public"));
app.get("/api/alerts", (req, res) => res.json(alerts));

app.listen(PORT, () => {
  console.log("Server running on", PORT);
  scannerLoop();
});
