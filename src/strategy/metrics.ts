// metrics.ts
export interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Metrics {
  atr: number;
  trend20: number;
  trend40: number;
  rangeHigh20: number;
  rangeLow20: number;
  rangeHigh40: number;
  rangeLow40: number;
  hod: number;
  lod: number;
  currentPrice: number;
  ema20: number | null;
  vwap: number;
  bbUpper: number | null;
  bbLower: number | null;
  adx: number;
}

export interface Constraints {
  maxRiskPerTrade: number;
  rrTarget: number;
  maxEntryDistancePct: number;
  entryTimeoutBars: number;
  rthOnly: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Defensive numeric validation to prevent NaN/Infinity from corrupting metrics.
 */
function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for ${label}: ${value}`);
  }
  return value;
}

function getRecentBars(bars: Bar[], lookback: number): Bar[] {
  if (bars.length < lookback) {
    throw new Error(`Insufficient bars: need ${lookback}, got ${bars.length}`);
  }
  return bars.slice(-lookback);
}

// ============================================================================
// ATR
// ============================================================================

export function computeATR(bars: Bar[], period: number = 14): number {
  if (bars.length < period + 1) {
    throw new Error(
      `Insufficient bars for ATR: need ${period + 1}, got ${bars.length}`,
    );
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = assertFinite(bars[i].high, `high@${i}`);
    const low = assertFinite(bars[i].low, `low@${i}`);
    const prevClose = assertFinite(bars[i - 1].close, `close@${i - 1}`);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );

    trueRanges.push(assertFinite(tr, `tr@${i}`));
  }

  const recentTRs = trueRanges.slice(-period);
  const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / period;

  return assertFinite(atr, "atr");
}

// ============================================================================
// Trend (%)
// ============================================================================

export function computeTrendPct(bars: Bar[], lookback: number): number {
  if (bars.length < lookback + 1) {
    throw new Error(
      `Insufficient bars for trend: need ${lookback + 1}, got ${bars.length}`,
    );
  }

  const current = assertFinite(bars[bars.length - 1].close, "currentClose");
  const past = assertFinite(
    bars[bars.length - 1 - lookback].close,
    "pastClose",
  );

  if (past === 0) {
    throw new Error("Invalid past close (0) for trend calculation");
  }

  const pct = ((current - past) / past) * 100;
  return assertFinite(pct, `trend${lookback}`);
}

// ============================================================================
// Range (hi/lo)
// ============================================================================

export function computeRange(
  bars: Bar[],
  lookback: number,
): { hi: number; lo: number } {
  const recentBars = getRecentBars(bars, lookback);

  const hi = Math.max(
    ...recentBars.map((b, i) =>
      assertFinite(b.high, `high@range${lookback}:${i}`),
    ),
  );
  const lo = Math.min(
    ...recentBars.map((b, i) =>
      assertFinite(b.low, `low@range${lookback}:${i}`),
    ),
  );

  return {
    hi: assertFinite(hi, `rangeHi${lookback}`),
    lo: assertFinite(lo, `rangeLo${lookback}`),
  };
}

// ============================================================================
// HOD / LOD
// ============================================================================

export function computeHodLod(bars: Bar[]): { hod: number; lod: number } {
  if (bars.length === 0) {
    throw new Error("No bars provided for HOD/LOD");
  }

  // NOTE: still using all bars as session proxy (intraday session slicing can be added later)
  const hod = Math.max(
    ...bars.map((b, i) => assertFinite(b.high, `high@hod:${i}`)),
  );
  const lod = Math.min(
    ...bars.map((b, i) => assertFinite(b.low, `low@lod:${i}`)),
  );

  return { hod: assertFinite(hod, "hod"), lod: assertFinite(lod, "lod") };
}

// ============================================================================
// EMA
// ============================================================================

export function computeEma(bars: Bar[], period: number = 20): number | null {
  if (bars.length < period) {
    return null;
  }

  const k = 2 / (period + 1);

  let ema =
    bars
      .slice(0, period)
      .reduce(
        (sum, b, i) => sum + assertFinite(b.close, `close@emaSeed:${i}`),
        0,
      ) / period;

  ema = assertFinite(ema, "emaSeed");

  for (let i = period; i < bars.length; i++) {
    const close = assertFinite(bars[i].close, `close@ema:${i}`);
    ema = close * k + ema * (1 - k);
    ema = assertFinite(ema, `ema@${i}`);
  }

  return ema;
}

// ============================================================================
// VWAP
// ============================================================================

export function computeVwap(bars: Bar[]): number {
  if (bars.length === 0) {
    throw new Error("No bars provided for VWAP calculation");
  }

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const high = assertFinite(bar.high, `high@vwap:${i}`);
    const low = assertFinite(bar.low, `low@vwap:${i}`);
    const close = assertFinite(bar.close, `close@vwap:${i}`);
    const vol = assertFinite(bar.volume, `volume@vwap:${i}`);

    const typicalPrice = (high + low + close) / 3;

    cumulativeTPV += typicalPrice * vol;
    cumulativeVolume += vol;
  }

  if (cumulativeVolume === 0) {
    // Fallback to current close if no volume
    return assertFinite(bars[bars.length - 1].close, "close@vwapFallback");
  }

  const vwap = cumulativeTPV / cumulativeVolume;
  return assertFinite(vwap, "vwap");
}

// ============================================================================
// Bollinger Bands
// ============================================================================

export function computeBollingerBands(
  bars: Bar[],
  period: number = 20,
  stdDevMultiplier: number = 2,
): { upper: number; middle: number; lower: number } | null {
  if (bars.length < period) {
    return null;
  }

  const recentBars = bars.slice(-period);
  const closes = recentBars.map((b, i) =>
    assertFinite(b.close, `close@bb:${i}`),
  );

  const middle = closes.reduce((sum, c) => sum + c, 0) / period;
  const m = assertFinite(middle, "bbMiddle");

  const variance =
    closes.map((c) => (c - m) ** 2).reduce((sum, sq) => sum + sq, 0) / period;

  const stdDev = Math.sqrt(assertFinite(variance, "bbVariance"));

  const upper = m + stdDevMultiplier * stdDev;
  const lower = m - stdDevMultiplier * stdDev;

  return {
    upper: assertFinite(upper, "bbUpper"),
    middle: m,
    lower: assertFinite(lower, "bbLower"),
  };
}

// ============================================================================
// ADX (simple DX proxy - same behavior as your original code, but safer)
// ============================================================================

export function computeAdx(bars: Bar[], period: number = 14): number {
  if (bars.length < period + 1) {
    return 0; // Not enough data, return 0 (weak trend)
  }

  const trueRanges: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const high = assertFinite(bars[i].high, `high@adx:${i}`);
    const low = assertFinite(bars[i].low, `low@adx:${i}`);
    const prevHigh = assertFinite(bars[i - 1].high, `high@adxPrev:${i - 1}`);
    const prevLow = assertFinite(bars[i - 1].low, `low@adxPrev:${i - 1}`);
    const prevClose = assertFinite(bars[i - 1].close, `close@adxPrev:${i - 1}`);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trueRanges.push(assertFinite(tr, `tr@adx:${i}`));

    const highDiff = high - prevHigh;
    const lowDiff = prevLow - low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
  }

  const recentTR = trueRanges.slice(-period);
  const recentPlusDM = plusDM.slice(-period);
  const recentMinusDM = minusDM.slice(-period);

  const smoothTR = recentTR.reduce((a, b) => a + b, 0) / period;
  const smoothPlusDM = recentPlusDM.reduce((a, b) => a + b, 0) / period;
  const smoothMinusDM = recentMinusDM.reduce((a, b) => a + b, 0) / period;

  const trVal = assertFinite(smoothTR, "adxSmoothTR");
  if (trVal <= 0) return 0;

  const plusDI = (smoothPlusDM / trVal) * 100;
  const minusDI = (smoothMinusDM / trVal) * 100;

  const diSum = plusDI + minusDI;
  if (diSum <= 0) return 0;

  const dx = (Math.abs(plusDI - minusDI) / diSum) * 100;
  return Number.isFinite(dx) ? dx : 0;
}

// ============================================================================
// Metrics
// ============================================================================

export function computeMetrics(bars: Bar[]): Metrics {
  if (bars.length < 50) {
    throw new Error(
      `Insufficient bars for metrics: need >= 50, got ${bars.length}`,
    );
  }

  const atr = computeATR(bars, 14);
  const trend20 = computeTrendPct(bars, 20);
  const trend40 = computeTrendPct(bars, 40);

  const range20 = computeRange(bars, 20);
  const range40 = computeRange(bars, 40);

  const { hod, lod } = computeHodLod(bars);
  const currentPrice = assertFinite(
    bars[bars.length - 1].close,
    "currentPrice",
  );

  const ema20 = computeEma(bars, 20);
  const vwap = computeVwap(bars);
  const bb = computeBollingerBands(bars, 20, 2);
  const adx = computeAdx(bars, 14);

  return {
    atr,
    trend20,
    trend40,
    rangeHigh20: range20.hi,
    rangeLow20: range20.lo,
    rangeHigh40: range40.hi,
    rangeLow40: range40.lo,
    hod,
    lod,
    currentPrice,
    ema20,
    vwap,
    bbUpper: bb?.upper ?? null,
    bbLower: bb?.lower ?? null,
    adx,
  };
}
