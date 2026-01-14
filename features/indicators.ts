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

// ============================================================================
// SEPA INDICATORS (Mark Minervini Growth Screener)
// ============================================================================

/**
 * Simple Moving Average (SMA) - Generic
 */
export function computeSMA(
  bars: Bar[],
  period: number
): number {
  if (bars.length < period) {
    // Return SMA of available bars if less than period
    if (bars.length === 0) return 0;
    const closes = bars.map(b => b.close);
    return closes.reduce((a, b) => a + b) / closes.length;
  }

  const closes = bars.slice(-period).map(b => b.close);
  const sum = closes.reduce((a, b) => a + b, 0);
  return sum / period;
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
 */
export function computeFiftyTwoWeekLow(ctx: FeatureComputeContext): FeatureValue {
  const bars = [...ctx.history, ctx.bar];

  const lookbackBars = Math.min(252, bars.length);
  const recentBars = bars.slice(-lookbackBars);

  if (recentBars.length === 0) return 0;

  const lows = recentBars.map(b => b.low);
  return Math.min(...lows);
}

/**
 * Cup & Handle Pattern Detection
 * Returns confidence score (0-100)
 */
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
  let bestCupData: any = null;

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
