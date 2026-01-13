/**
 * Technical indicator implementations
 */
import { Bar, FeatureComputeContext, FeatureValue } from '../spec/types';

// ============================================================================
// VWAP (Volume Weighted Average Price)
// ============================================================================

export function computeVWAP(ctx: FeatureComputeContext): FeatureValue {
  const bars = [
    ...ctx.history,
    ctx.bar,
  ];

  if (bars.length === 0) return ctx.bar.close;

  let cumulativeTypicalPrice = 0;
  let cumulativeVolume = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    cumulativeTypicalPrice += typicalPrice * bar.volume;
    cumulativeVolume += bar.volume;
  }

  if (cumulativeVolume === 0) return ctx.bar.close;
  return cumulativeTypicalPrice / cumulativeVolume;
}

// ============================================================================
// EMA (Exponential Moving Average)
// ============================================================================

export function computeEMA(
  bars: Bar[],
  field: 'open' | 'high' | 'low' | 'close' | 'volume',
  period: number
): FeatureValue {
  if (bars.length === 0) return 0;
  if (bars.length < period) {
    // Insufficient data: use SMA
    const sum = bars.reduce((acc, bar) => acc + bar[field], 0);
    return sum / bars.length;
  }

  const multiplier = 2 / (period + 1);
  let ema = 0;

  // First EMA is SMA of first 'period' values
  for (let i = 0; i < period; i++) {
    ema += bars[i][field];
  }
  ema /= period;

  // Apply smoothing for remaining bars
  for (let i = period; i < bars.length; i++) {
    ema = bars[i][field] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

// ============================================================================
// LOD (Low of Day)
// ============================================================================

export function computeLOD(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  if (bars.length === 0) return ctx.bar.low;
  return Math.min(...bars.map((b) => b.low));
}

// ============================================================================
// Volume Z-Score
// ============================================================================

export function computeVolumeZScore(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history];
  if (bars.length < 2) return 0;

  // Calculate mean volume
  const meanVolume = bars.reduce((sum, bar) => sum + bar.volume, 0) / bars.length;

  // Calculate standard deviation
  const variance =
    bars.reduce((sum, bar) => sum + Math.pow(bar.volume - meanVolume, 2), 0) /
    bars.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  // Z-score of current bar
  return (ctx.bar.volume - meanVolume) / stdDev;
}

// ============================================================================
// RSI (Relative Strength Index)
// ============================================================================

export function computeRSI(ctx: FeatureComputeContext, period: number = 14): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  if (bars.length < period + 1) return 50; // Default to neutral if insufficient data

  let gains = 0;
  let losses = 0;

  // Calculate gains and losses over the period
  for (let i = bars.length - period; i < bars.length; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================================================
// Bollinger Bands
// ============================================================================

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export function computeBollingerBands(
  ctx: FeatureComputeContext,
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBands {
  const bars = [...ctx.history, ctx.bar];
  if (bars.length < period) {
    return {
      upper: ctx.bar.close,
      middle: ctx.bar.close,
      lower: ctx.bar.close,
    };
  }

  const closes = bars.slice(-period).map((b) => b.close);

  // Calculate SMA (middle band)
  const middle = closes.reduce((sum, close) => sum + close, 0) / period;

  // Calculate standard deviation
  const variance = closes.reduce((sum, close) => sum + Math.pow(close - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: middle + stdDev * stdDevMultiplier,
    middle,
    lower: middle - stdDev * stdDevMultiplier,
  };
}

// Helper: Return only the upper band (for use in expressions)
export function computeBBUpper(ctx: FeatureComputeContext): FeatureValue {
  return computeBollingerBands(ctx).upper;
}

// Helper: Return only the middle band
export function computeBBMiddle(ctx: FeatureComputeContext): FeatureValue {
  return computeBollingerBands(ctx).middle;
}

// Helper: Return only the lower band
export function computeBBLower(ctx: FeatureComputeContext): FeatureValue {
  return computeBollingerBands(ctx).lower;
}

// ============================================================================
// MACD (Moving Average Convergence Divergence)
// ============================================================================

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function computeMACD(ctx: FeatureComputeContext): MACDResult {
  const bars = [...ctx.history, ctx.bar];
  const closes = bars.map((b) => b.close);

  // Need at least 26 bars for 26-EMA
  if (closes.length < 26) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0,
    };
  }

  // Calculate 12-EMA and 26-EMA
  const ema12 = computeEMA(bars, 'close', 12) as number;
  const ema26 = computeEMA(bars, 'close', 26) as number;

  // MACD line = 12-EMA - 26-EMA
  const macd = ema12 - ema26;

  // Signal line = 9-EMA of MACD line
  // For simplicity, approximate with recent MACD values
  let signalSum = 0;
  const signalPeriod = Math.min(9, closes.length - 26);

  if (closes.length >= 35) {
    // Can calculate proper signal line
    for (let i = closes.length - signalPeriod; i < closes.length; i++) {
      const tempBars = closes.slice(0, i + 1);
      const tempEma12 = computeEMA(
        bars.slice(0, i + 1),
        'close',
        12
      ) as number;
      const tempEma26 = computeEMA(
        bars.slice(0, i + 1),
        'close',
        26
      ) as number;
      signalSum += tempEma12 - tempEma26;
    }
  }

  const signal = signalPeriod > 0 ? signalSum / signalPeriod : macd;
  const histogram = macd - signal;

  return {
    macd,
    signal,
    histogram,
  };
}

// Helpers: Return individual MACD values (for use in expressions)
export function computeMACDLine(ctx: FeatureComputeContext): FeatureValue {
  return computeMACD(ctx).macd;
}

export function computeMACDSignal(ctx: FeatureComputeContext): FeatureValue {
  return computeMACD(ctx).signal;
}

export function computeMACDHistogram(ctx: FeatureComputeContext): FeatureValue {
  return computeMACD(ctx).histogram;
}
