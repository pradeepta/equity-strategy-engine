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

export function computeATR(bars: Bar[], period: number = 14): number {
  if (bars.length < period + 1) {
    throw new Error(`Insufficient bars for ATR: need ${period + 1}, got ${bars.length}`);
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // Simple mean of last 'period' TRs
  const recentTRs = trueRanges.slice(-period);
  return recentTRs.reduce((sum, tr) => sum + tr, 0) / period;
}

export function computeTrendPct(bars: Bar[], lookback: number): number {
  if (bars.length < lookback + 1) {
    throw new Error(`Insufficient bars for trend: need ${lookback + 1}, got ${bars.length}`);
  }

  const current = bars[bars.length - 1].close;
  const past = bars[bars.length - 1 - lookback].close;
  return ((current - past) / past) * 100;
}

export function computeRange(bars: Bar[], lookback: number): { hi: number; lo: number } {
  if (bars.length < lookback) {
    throw new Error(`Insufficient bars for range: need ${lookback}, got ${bars.length}`);
  }

  const recentBars = bars.slice(-lookback);
  const hi = Math.max(...recentBars.map(b => b.high));
  const lo = Math.min(...recentBars.map(b => b.low));
  return { hi, lo };
}

export function computeHodLod(bars: Bar[]): { hod: number; lod: number } {
  // Use all bars as proxy for session (splitting by session is more complex)
  const hod = Math.max(...bars.map(b => b.high));
  const lod = Math.min(...bars.map(b => b.low));
  return { hod, lod };
}

export function computeEma(bars: Bar[], period: number = 20): number | null {
  if (bars.length < period) {
    return null;
  }

  const k = 2 / (period + 1);
  let ema = bars.slice(0, period).reduce((sum, b) => sum + b.close, 0) / period;

  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
  }

  return ema;
}

export function computeVwap(bars: Bar[]): number {
  if (bars.length === 0) {
    throw new Error('No bars provided for VWAP calculation');
  }

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativeTPV += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
  }

  if (cumulativeVolume === 0) {
    // Fallback to current close if no volume
    return bars[bars.length - 1].close;
  }

  return cumulativeTPV / cumulativeVolume;
}

export function computeBollingerBands(
  bars: Bar[],
  period: number = 20,
  stdDevMultiplier: number = 2
): { upper: number; middle: number; lower: number } | null {
  if (bars.length < period) {
    return null;
  }

  // Calculate SMA (middle band)
  const recentBars = bars.slice(-period);
  const closes = recentBars.map(b => b.close);
  const middle = closes.reduce((sum, close) => sum + close, 0) / period;

  // Calculate standard deviation
  const squaredDiffs = closes.map(close => Math.pow(close - middle, 2));
  const variance = squaredDiffs.reduce((sum, sq) => sum + sq, 0) / period;
  const stdDev = Math.sqrt(variance);

  // Calculate bands
  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;

  return { upper, middle, lower };
}

export function computeAdx(bars: Bar[], period: number = 14): number {
  if (bars.length < period + 1) {
    return 0; // Not enough data, return 0 (weak trend)
  }

  // Calculate True Range
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  // Calculate +DM and -DM
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const highDiff = bars[i].high - bars[i - 1].high;
    const lowDiff = bars[i - 1].low - bars[i].low;

    plusDM.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    minusDM.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
  }

  // Simple smoothing (Wilder's smoothing would be more accurate but complex)
  const smoothTR = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  const smoothPlusDM = plusDM.slice(-period).reduce((a, b) => a + b, 0) / period;
  const smoothMinusDM = minusDM.slice(-period).reduce((a, b) => a + b, 0) / period;

  // Calculate +DI and -DI
  const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
  const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;

  // Calculate DX
  const diSum = plusDI + minusDI;
  const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;

  // ADX is typically smoothed DX over period, but we'll use DX directly for simplicity
  return dx;
}

export function computeMetrics(bars: Bar[]): Metrics {
  if (bars.length < 50) {
    throw new Error(`Insufficient bars for metrics: need >= 50, got ${bars.length}`);
  }

  const atr = computeATR(bars, 14);
  const trend20 = computeTrendPct(bars, 20);
  const trend40 = computeTrendPct(bars, 40);

  const range20 = computeRange(bars, 20);
  const range40 = computeRange(bars, 40);

  const { hod, lod } = computeHodLod(bars);
  const currentPrice = bars[bars.length - 1].close;
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
