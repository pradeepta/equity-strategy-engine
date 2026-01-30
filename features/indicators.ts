/**
 * Technical indicator implementations
 *
 * Uses the technicalindicators library for mathematically correct,
 * industry-standard indicator calculations.
 *
 * @see https://github.com/anandanand84/technicalindicators
 */
import { Bar, FeatureComputeContext, FeatureValue } from '../spec/types';
import {
  EMA as EMALib,
  SMA as SMALib,
  RSI as RSILib,
  MACD as MACDLib,
  BollingerBands as BollingerBandsLib,
  ATR as ATRLib,
  ADX as ADXLib,
  Stochastic as StochasticLib,
  CCI as CCILib,
  WilliamsR as WilliamsRLib,
  OBV as OBVLib,
  VWAP as VWAPLib,
} from 'technicalindicators';

// ============================================================================
// Helper Functions for Data Extraction
// ============================================================================

/**
 * Extract values from bars array for a specific field
 * CRITICAL: Validates each value to prevent NaN/Infinity from corrupting indicators
 */
function extractField(bars: Bar[], field: 'open' | 'high' | 'low' | 'close' | 'volume'): number[] {
  return bars.map((b, index) => {
    const value = b[field];
    if (!Number.isFinite(value)) {
      throw new Error(
        `Invalid ${field} value at bar index ${index}: ${value} ` +
        `(timestamp: ${b.timestamp}, bar: ${JSON.stringify(b)})`
      );
    }
    return value;
  });
}

/**
 * Extract OHLC arrays from bars for indicators that need them
 * Uses extractField for validation
 */
function extractOHLC(bars: Bar[]): { high: number[], low: number[], close: number[] } {
  return {
    high: extractField(bars, 'high'),
    low: extractField(bars, 'low'),
    close: extractField(bars, 'close'),
  };
}

/**
 * Extract OHLCV arrays from bars for volume-based indicators
 * Uses extractField for validation
 */
function extractOHLCV(bars: Bar[]): { high: number[], low: number[], close: number[], volume: number[] } {
  return {
    high: extractField(bars, 'high'),
    low: extractField(bars, 'low'),
    close: extractField(bars, 'close'),
    volume: extractField(bars, 'volume'),
  };
}

/**
 * Filter bars to only include those from the current trading day.
 * For intraday strategies, VWAP/HOD/LOD should reset at market open each day.
 *
 * @param bars - All available bars (history + current bar)
 * @param currentBar - The current bar being processed
 * @returns Bars from the same trading day (calendar date in ET) as currentBar
 */
function filterTradingDay(bars: Bar[], currentBar: Bar): Bar[] {
  // Get current bar's date in ET timezone
  const currentDate = new Date(currentBar.timestamp);

  // Convert to ET timezone calendar date (America/New_York)
  // This handles DST automatically (UTC-4 in summer, UTC-5 in winter)
  const etDateStr = currentDate.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  // Filter bars to same calendar date in ET
  return bars.filter(bar => {
    const barDate = new Date(bar.timestamp);
    const barDateStr = barDate.toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return barDateStr === etDateStr;
  });
}

// ============================================================================
// VWAP (Volume Weighted Average Price)
// Uses technicalindicators library
// NOTE: For intraday strategies, VWAP resets daily (uses only today's bars)
// ============================================================================

export function computeVWAP(ctx: FeatureComputeContext): FeatureValue {
  const allBars = [...ctx.history, ctx.bar];

  // For intraday: only use bars from current trading day
  const bars = filterTradingDay(allBars, ctx.bar);

  if (bars.length === 0) return ctx.bar.close;

  const { high, low, close, volume } = extractOHLCV(bars);

  // Check for zero volume - library may have issues
  const totalVolume = volume.reduce((a, b) => a + b, 0);
  if (totalVolume === 0) return ctx.bar.close;

  const result = VWAPLib.calculate({ high, low, close, volume });
  return result[result.length - 1] ?? ctx.bar.close;
}

// ============================================================================
// EMA (Exponential Moving Average)
// Uses technicalindicators library
// ============================================================================

export function computeEMA(
  bars: Bar[],
  field: 'open' | 'high' | 'low' | 'close' | 'volume',
  period: number
): FeatureValue {
  if (bars.length === 0) return 0;

  const values = extractField(bars, field);

  if (values.length < period) {
    // Insufficient data: use simple average as fallback
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  const result = EMALib.calculate({ period, values });
  return result[result.length - 1] ?? 0;
}

// ============================================================================
// LOD (Low of Day) - Keep custom (trivial, no library equivalent)
// NOTE: For intraday strategies, LOD resets daily (uses only today's bars)
// ============================================================================

export function computeLOD(ctx: FeatureComputeContext): FeatureValue {
  const allBars = [...ctx.history, ctx.bar];

  // For intraday: only use bars from current trading day
  const bars = filterTradingDay(allBars, ctx.bar);

  if (bars.length === 0) return ctx.bar.low;
  return Math.min(...bars.map((b) => b.low));
}

// ============================================================================
// Volume Z-Score - Keep custom (statistical, not a standard TA indicator)
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
// Volume SMA (Simple Moving Average of Volume)
// Uses technicalindicators library
// ============================================================================

export function computeVolumeSMA(
  ctx: FeatureComputeContext,
  period: number = 20
): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length === 0) return ctx.bar.volume;

  const values = extractField(bars, 'volume');

  if (values.length < period) {
    // Insufficient data: use all available bars
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  const result = SMALib.calculate({ period, values });
  return result[result.length - 1] ?? ctx.bar.volume;
}

// ============================================================================
// RSI (Relative Strength Index)
// Uses technicalindicators library - provides proper Wilder smoothing
// ============================================================================

export function computeRSI(ctx: FeatureComputeContext, period: number = 14): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  const values = extractField(bars, 'close');

  if (values.length < period + 1) return 50; // Default to neutral if insufficient data

  const result = RSILib.calculate({ period, values });
  return result[result.length - 1] ?? 50;
}

// ============================================================================
// Bollinger Bands
// Uses technicalindicators library
// ============================================================================

export interface BollingerBandsResult {
  upper: number;
  middle: number;
  lower: number;
}

export function computeBollingerBands(
  ctx: FeatureComputeContext,
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBandsResult {
  const bars = [...ctx.history, ctx.bar];
  const values = extractField(bars, 'close');

  if (values.length < period) {
    return {
      upper: ctx.bar.close,
      middle: ctx.bar.close,
      lower: ctx.bar.close,
    };
  }

  const result = BollingerBandsLib.calculate({
    period,
    stdDev: stdDevMultiplier,
    values,
  });

  const last = result[result.length - 1];
  return {
    upper: last?.upper ?? ctx.bar.close,
    middle: last?.middle ?? ctx.bar.close,
    lower: last?.lower ?? ctx.bar.close,
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
// Uses technicalindicators library - provides proper EMA signal line
// ============================================================================

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export function computeMACD(ctx: FeatureComputeContext): MACDResult {
  const bars = [...ctx.history, ctx.bar];
  const values = extractField(bars, 'close');

  // Need at least 26 bars for 26-EMA
  if (values.length < 26) {
    return {
      macd: 0,
      signal: 0,
      histogram: 0,
    };
  }

  const result = MACDLib.calculate({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
    values,
  });

  const last = result[result.length - 1];
  return {
    macd: last?.MACD ?? 0,
    signal: last?.signal ?? 0,
    histogram: last?.histogram ?? 0,
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

// ============================================================================
// MACD Momentum Helpers (for detecting crossovers without array indexing)
// Keep custom - domain-specific logic
// ============================================================================

/**
 * MACD Histogram Rising - Current histogram > previous histogram
 * Use case: Detect bullish momentum increase
 */
export function computeMACDHistogramRising(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;

  const current = computeMACD(ctx).histogram;

  // Compute MACD for previous bar
  const prevCtx: FeatureComputeContext = {
    bar: ctx.history[ctx.history.length - 1],
    history: ctx.history.slice(0, -1),
    features: ctx.features,
    now: ctx.now,
  };
  const previous = computeMACD(prevCtx).histogram;

  return current > previous ? 1 : 0;
}

/**
 * MACD Histogram Falling - Current histogram < previous histogram
 * Use case: Detect bearish momentum decrease
 */
export function computeMACDHistogramFalling(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;

  const current = computeMACD(ctx).histogram;

  const prevCtx: FeatureComputeContext = {
    bar: ctx.history[ctx.history.length - 1],
    history: ctx.history.slice(0, -1),
    features: ctx.features,
    now: ctx.now,
  };
  const previous = computeMACD(prevCtx).histogram;

  return current < previous ? 1 : 0;
}

/**
 * MACD Bullish Crossover - MACD line crossed above signal line
 * Use case: Buy signal in MACD strategy
 */
export function computeMACDBullishCrossover(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;

  const current = computeMACD(ctx);
  const currentDiff = current.macd - current.signal;

  const prevCtx: FeatureComputeContext = {
    bar: ctx.history[ctx.history.length - 1],
    history: ctx.history.slice(0, -1),
    features: ctx.features,
    now: ctx.now,
  };
  const previous = computeMACD(prevCtx);
  const previousDiff = previous.macd - previous.signal;

  // Crossover: was below (<=0), now above (>0)
  return previousDiff <= 0 && currentDiff > 0 ? 1 : 0;
}

/**
 * MACD Bearish Crossover - MACD line crossed below signal line
 * Use case: Sell signal in MACD strategy
 */
export function computeMACDBearishCrossover(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;

  const current = computeMACD(ctx);
  const currentDiff = current.macd - current.signal;

  const prevCtx: FeatureComputeContext = {
    bar: ctx.history[ctx.history.length - 1],
    history: ctx.history.slice(0, -1),
    features: ctx.features,
    now: ctx.now,
  };
  const previous = computeMACD(prevCtx);
  const previousDiff = previous.macd - previous.signal;

  // Crossover: was above (>=0), now below (<0)
  return previousDiff >= 0 && currentDiff < 0 ? 1 : 0;
}

// ============================================================================
// RSI Momentum Helpers - Keep custom (domain-specific logic)
// ============================================================================

/**
 * RSI Rising - Current RSI > previous RSI
 * Use case: Detect momentum building
 */
export function computeRSIRising(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;

  const current = computeRSI(ctx, 14);

  const prevCtx: FeatureComputeContext = {
    bar: ctx.history[ctx.history.length - 1],
    history: ctx.history.slice(0, -1),
    features: ctx.features,
    now: ctx.now,
  };
  const previous = computeRSI(prevCtx, 14);

  return current > previous ? 1 : 0;
}

/**
 * RSI Falling - Current RSI < previous RSI
 * Use case: Detect momentum fading
 */
export function computeRSIFalling(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;

  const current = computeRSI(ctx, 14);

  const prevCtx: FeatureComputeContext = {
    bar: ctx.history[ctx.history.length - 1],
    history: ctx.history.slice(0, -1),
    features: ctx.features,
    now: ctx.now,
  };
  const previous = computeRSI(prevCtx, 14);

  return current < previous ? 1 : 0;
}

// ============================================================================
// Price Action Helpers - Keep custom (trivial, no library equivalent)
// ============================================================================

/**
 * Price Rising - Current close > previous close
 * Use case: Simple upward momentum
 */
export function computePriceRising(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;
  const previous = ctx.history[ctx.history.length - 1];
  return ctx.bar.close > previous.close ? 1 : 0;
}

/**
 * Price Falling - Current close < previous close
 * Use case: Simple downward momentum
 */
export function computePriceFalling(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 1) return 0;
  const previous = ctx.history[ctx.history.length - 1];
  return ctx.bar.close < previous.close ? 1 : 0;
}

/**
 * Green Bar - Close > Open
 * Use case: Bullish bar pattern
 */
export function computeGreenBar(ctx: FeatureComputeContext): FeatureValue {
  return ctx.bar.close > ctx.bar.open ? 1 : 0;
}

/**
 * Red Bar - Close < Open
 * Use case: Bearish bar pattern
 */
export function computeRedBar(ctx: FeatureComputeContext): FeatureValue {
  return ctx.bar.close < ctx.bar.open ? 1 : 0;
}

// ============================================================================
// SMA (Simple Moving Average)
// Uses technicalindicators library
// ============================================================================

/**
 * Simple Moving Average (SMA) - Generic
 */
export function computeSMA(
  bars: Bar[],
  period: number
): number {
  if (bars.length === 0) return 0;

  const values = extractField(bars, 'close');

  if (values.length < period) {
    // Return SMA of available bars if less than period
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  const result = SMALib.calculate({ period, values });
  return result[result.length - 1] ?? 0;
}

/**
 * SMA150 - 150-day simple moving average
 */
export function computeSMA150(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  return computeSMA(bars, 150);
}

/**
 * SMA200 - 200-day simple moving average
 */
export function computeSMA200(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  return computeSMA(bars, 200);
}

/**
 * Check if SMA is rising (positive slope over lookback period)
 * Keep custom - domain-specific logic
 */
function isSMAGrowing(
  bars: Bar[],
  period: number,
  lookbackDays: number = 20
): boolean {
  if (bars.length < period + lookbackDays + 1) {
    return false; // Not enough data
  }

  // Calculate SMA at current point
  const currentSMA = computeSMA(bars, period);

  // Calculate SMA from lookbackDays ago
  const pastBars = bars.slice(0, -lookbackDays);
  const pastSMA = computeSMA(pastBars, period);

  // Rising if current > past
  return currentSMA > pastSMA;
}

/**
 * SMA50_Rising - Is 50-day MA trending up?
 */
export function computeSMA50Rising(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  return isSMAGrowing(bars, 50, 20) ? 1 : 0;
}

/**
 * SMA150_Rising - Is 150-day MA trending up?
 */
export function computeSMA150Rising(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  return isSMAGrowing(bars, 150, 20) ? 1 : 0;
}

/**
 * SMA200_Rising - Is 200-day MA trending up?
 */
export function computeSMA200Rising(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  return isSMAGrowing(bars, 200, 20) ? 1 : 0;
}

/**
 * 52-Week High - Maximum price in last 252 trading days
 * Keep custom - trivial
 */
export function computeFiftyTwoWeekHigh(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  // 252 trading days ≈ 1 year
  const lookbackBars = Math.min(252, bars.length);
  const recentBars = bars.slice(-lookbackBars);

  if (recentBars.length === 0) return 0;

  const highs = recentBars.map(b => b.high);
  return Math.max(...highs);
}

/**
 * 52-Week Low - Minimum price in last 252 trading days
 * Keep custom - trivial
 */
export function computeFiftyTwoWeekLow(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  const lookbackBars = Math.min(252, bars.length);
  const recentBars = bars.slice(-lookbackBars);

  if (recentBars.length === 0) return 0;

  const lows = recentBars.map(b => b.low);
  return Math.min(...lows);
}

// ============================================================================
// Cup & Handle Pattern Detection - Keep custom (complex pattern logic)
// ============================================================================

function findLocalPeaks(prices: number[], window: number = 10): number[] {
  const peaks: number[] = [];

  for (let i = window; i < prices.length - window; i++) {
    // Check if this is a local maximum
    let isMaximum = true;
    for (let j = i - window; j <= i + window; j++) {
      if (prices[j] > prices[i]) {
        isMaximum = false;
        break;
      }
    }
    if (isMaximum) {
      peaks.push(i);
    }
  }

  return peaks;
}

function findLocalTroughs(prices: number[], window: number = 10): number[] {
  const troughs: number[] = [];

  for (let i = window; i < prices.length - window; i++) {
    // Check if this is a local minimum
    let isMinimum = true;
    for (let j = i - window; j <= i + window; j++) {
      if (prices[j] < prices[i]) {
        isMinimum = false;
        break;
      }
    }
    if (isMinimum) {
      troughs.push(i);
    }
  }

  return troughs;
}

interface CupHandleMetrics {
  detected: boolean;
  confidence: number;
}

function detectCupAndHandle(prices: number[]): CupHandleMetrics {
  // Need at least 100 bars to detect a pattern
  if (prices.length < 100) {
    return {
      detected: false,
      confidence: 0,
    };
  }

  const window = 10;
  const peaks = findLocalPeaks(prices, window);
  const troughs = findLocalTroughs(prices, window);

  if (peaks.length < 2 || troughs.length < 1) {
    return {
      detected: false,
      confidence: 0,
    };
  }

  // Find the best cup structure
  let bestCupScore = 0;
  let bestCupData: {
    leftPeakIdx: number;
    rightPeakIdx: number;
    cupBottomIdx: number;
    cupDepthPct: number;
    cupWidth: number;
    peakDiffPct: number;
  } | null = null;

  for (let i = 0; i < peaks.length - 1; i++) {
    const leftPeakIdx = peaks[i];
    const rightPeakIdx = peaks[i + 1];

    // Find troughs between peaks
    const troughsBetween = troughs.filter(
      t => t > leftPeakIdx && t < rightPeakIdx
    );

    if (troughsBetween.length === 0) continue;

    // Find deepest trough
    let cupBottomIdx = troughsBetween[0];
    for (const idx of troughsBetween) {
      if (prices[idx] < prices[cupBottomIdx]) {
        cupBottomIdx = idx;
      }
    }

    const leftPeakPrice = prices[leftPeakIdx];
    const rightPeakPrice = prices[rightPeakIdx];
    const cupBottomPrice = prices[cupBottomIdx];

    // Calculate metrics
    const cupDepth = (leftPeakPrice + rightPeakPrice) / 2 - cupBottomPrice;
    const cupDepthPct = (cupDepth / leftPeakPrice) * 100;
    const cupWidth = rightPeakIdx - leftPeakIdx;

    // Cup validation: 15-50% depth, 20+ days wide
    if (cupDepthPct >= 15 && cupDepthPct <= 50 && cupWidth >= 20) {
      // Check peak similarity (should be within 15%)
      const peakDiffPct =
        (Math.abs(rightPeakPrice - leftPeakPrice) / leftPeakPrice) * 100;

      if (peakDiffPct <= 15) {
        // Score the cup (higher is better)
        // Optimal: 25% depth, 5% peak difference
        const cupScore = 100 - Math.abs(cupDepthPct - 25) - Math.abs(peakDiffPct - 5);

        if (cupScore > bestCupScore) {
          bestCupScore = cupScore;
          bestCupData = {
            leftPeakIdx,
            rightPeakIdx,
            cupBottomIdx,
            cupDepthPct,
            cupWidth,
            peakDiffPct,
          };
        }
      }
    }
  }

  if (!bestCupData) {
    return {
      detected: false,
      confidence: 0,
    };
  }

  // Now look for handle pattern after right peak
  const handleStartIdx = bestCupData.rightPeakIdx;
  const handlePrices = prices.slice(handleStartIdx);

  if (handlePrices.length < 10) {
    return {
      detected: false,
      confidence: Math.floor(Math.min(100, bestCupScore)),
    };
  }

  // Find handle trough
  let handleTroughIdx = 0;
  for (let i = 1; i < handlePrices.length; i++) {
    if (handlePrices[i] < handlePrices[handleTroughIdx]) {
      handleTroughIdx = i;
    }
  }

  const handleTroughPrice = handlePrices[handleTroughIdx];
  const handlePeakPrice = handlePrices[0];
  const handleDepth = handlePeakPrice - handleTroughPrice;
  const handleDepthPct = (handleDepth / handlePeakPrice) * 100;

  // Handle validation: 5-15% depth
  const handleValid = handleDepthPct >= 5 && handleDepthPct <= 15;

  // Calculate confidence
  let confidence = Math.min(100, bestCupScore);
  if (handleValid) {
    confidence += 20; // Bonus for valid handle
  }

  confidence = Math.min(100, confidence);
  const detected = confidence >= 70;

  return {
    detected,
    confidence: Math.floor(confidence),
  };
}

/**
 * Cup & Handle Confidence - Pattern detection score (0-100)
 */
export function computeCupHandleConfidence(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  const prices = bars.map(b => b.close);

  const metrics = detectCupAndHandle(prices);
  return metrics.confidence;
}

// ============================================================================
// ATR (Average True Range)
// Uses technicalindicators library
// ============================================================================

export function computeATR(ctx: FeatureComputeContext, period: number = 14): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length < 2) return 0;

  const { high, low, close } = extractOHLC(bars);

  const result = ATRLib.calculate({ period, high, low, close });
  return result[result.length - 1] ?? 0;
}

// ============================================================================
// ADX (Average Directional Index)
// Uses technicalindicators library
// ============================================================================

export function computeADX(ctx: FeatureComputeContext, period: number = 14): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length < period + 1) return 0;

  const { high, low, close } = extractOHLC(bars);

  const result = ADXLib.calculate({ period, high, low, close });
  return result[result.length - 1]?.adx ?? 0;
}

// ============================================================================
// Stochastic Oscillator
// Uses technicalindicators library - provides proper %D calculation
// ============================================================================

export function computeStochastic(
  ctx: FeatureComputeContext,
  kPeriod: number = 14,
  dPeriod: number = 3
): { k: number; d: number } {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length < kPeriod) {
    return { k: 50, d: 50 };
  }

  const { high, low, close } = extractOHLC(bars);

  const result = StochasticLib.calculate({
    period: kPeriod,
    signalPeriod: dPeriod,
    high,
    low,
    close,
  });

  const last = result[result.length - 1];
  return {
    k: last?.k ?? 50,
    d: last?.d ?? 50,
  };
}

export function computeStochasticK(ctx: FeatureComputeContext): FeatureValue {
  return computeStochastic(ctx).k;
}

export function computeStochasticD(ctx: FeatureComputeContext): FeatureValue {
  return computeStochastic(ctx).d;
}

// ============================================================================
// OBV (On Balance Volume)
// Uses technicalindicators library
// ============================================================================

export function computeOBV(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length < 2) return 0;

  const close = extractField(bars, 'close');
  const volume = extractField(bars, 'volume');

  const result = OBVLib.calculate({ close, volume });
  return result[result.length - 1] ?? 0;
}

// ============================================================================
// Volume EMA (Exponential Moving Average of Volume)
// Uses technicalindicators library
// ============================================================================

export function computeVolumeEMA(
  ctx: FeatureComputeContext,
  period: number = 20
): FeatureValue {
  const bars = [...ctx.history, ctx.bar];
  return computeEMA(bars, 'volume', period);
}

// ============================================================================
// CCI (Commodity Channel Index)
// Uses technicalindicators library
// ============================================================================

export function computeCCI(ctx: FeatureComputeContext, period: number = 20): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length < period) return 0;

  const { high, low, close } = extractOHLC(bars);

  const result = CCILib.calculate({ period, high, low, close });
  return result[result.length - 1] ?? 0;
}

// ============================================================================
// Williams %R
// Uses technicalindicators library
// ============================================================================

export function computeWilliamsR(ctx: FeatureComputeContext, period: number = 14): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length < period) return -50;

  const { high, low, close } = extractOHLC(bars);

  const result = WilliamsRLib.calculate({ period, high, low, close });
  return result[result.length - 1] ?? -50;
}

// ============================================================================
// HOD (High of Day) - Keep custom (trivial, no library equivalent)
// NOTE: For intraday strategies, HOD resets daily (uses only today's bars)
// ============================================================================

export function computeHOD(ctx: FeatureComputeContext): FeatureValue {
  const allBars = [...ctx.history, ctx.bar];

  // For intraday: only use bars from current trading day
  const bars = filterTradingDay(allBars, ctx.bar);

  if (bars.length === 0) return ctx.bar.high;
  return Math.max(...bars.map((b) => b.high));
}

// ============================================================================
// Rolling Range Features (20-bar lookback)
// Enable adaptive breakout/breakdown strategies without static levels
// ============================================================================

/**
 * 20-bar rolling high
 * Highest high in the last 20 bars (dynamic resistance level)
 * Use case: Breakout triggers - `close > range_high_20`
 */
export function computeRangeHigh20(ctx: FeatureComputeContext): number {
  const bars = [...ctx.history, ctx.bar];
  const lookback = Math.min(20, bars.length);
  const recentBars = bars.slice(-lookback);
  return Math.max(...recentBars.map(b => b.high));
}

/**
 * 20-bar rolling low
 * Lowest low in the last 20 bars (dynamic support level)
 * Use case: Breakdown triggers - `close < range_low_20`
 */
export function computeRangeLow20(ctx: FeatureComputeContext): number {
  const bars = [...ctx.history, ctx.bar];
  const lookback = Math.min(20, bars.length);
  const recentBars = bars.slice(-lookback);
  return Math.min(...recentBars.map(b => b.low));
}

/**
 * 20-bar range midpoint
 * Midpoint of 20-bar high/low range (dynamic pivot level)
 * Use case: Reclaim triggers - `close > range_mid_20`
 */
export function computeRangeMid20(ctx: FeatureComputeContext): number {
  const high = computeRangeHigh20(ctx);
  const low = computeRangeLow20(ctx);
  return (high + low) / 2;
}

/**
 * 20-bar trend strength
 * Percentage change from 20 bars ago to current bar (trend momentum)
 * Use case: Trend filter - `arm: "trend_20_pct > 5"` for bullish bias
 */
export function computeTrend20Pct(ctx: FeatureComputeContext): number {
  const bars = [...ctx.history, ctx.bar];

  if (bars.length < 20) {
    // Not enough bars - calculate from what we have
    const oldestBar = bars[0];
    const currentBar = bars[bars.length - 1];
    return ((currentBar.close - oldestBar.close) / oldestBar.close) * 100;
  }

  const bar20ago = bars[bars.length - 20];
  const currentBar = bars[bars.length - 1];
  return ((currentBar.close - bar20ago.close) / bar20ago.close) * 100;
}
