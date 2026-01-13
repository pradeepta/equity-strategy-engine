/**
 * Microstructure feature stubs
 * In production, these would integrate with market data feeds for bid/ask,
 * trade tape analysis, etc.
 */
import { FeatureComputeContext, FeatureValue } from '../spec/types';

// ============================================================================
// Delta (Placeholder)
// ============================================================================
/**
 * Delta: difference between up-volume and down-volume
 * Stub: simulates based on close movement within bar
 */
export function computeDelta(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length === 0) {
    // Assume up day for opening bars
    return ctx.bar.volume * 0.6;
  }

  const prevClose = ctx.history[ctx.history.length - 1].close;
  const currentClose = ctx.bar.close;

  // Heuristic: if close > prev close, assume more up volume
  if (currentClose > prevClose) {
    return ctx.bar.volume * 0.6; // 60% up
  } else if (currentClose < prevClose) {
    return -ctx.bar.volume * 0.4; // 40% down = -40% of vol
  } else {
    return 0; // Unchanged
  }
}

// ============================================================================
// Absorption (Placeholder)
// ============================================================================
/**
 * Absorption: whether large volume is absorbed at levels
 * Stub: returns boolean based on volume zscore
 */
export function computeAbsorption(ctx: FeatureComputeContext): FeatureValue {
  if (ctx.history.length < 5) {
    return false;
  }

  // Simple heuristic: if volume is > 1.5 std above mean AND price didn't move much
  const recentBars = ctx.history.slice(-5);
  const meanVolume = recentBars.reduce((sum, b) => sum + b.volume, 0) / recentBars.length;
  const variance = recentBars.reduce(
    (sum, b) => sum + Math.pow(b.volume - meanVolume, 2),
    0
  ) / recentBars.length;
  const stdDev = Math.sqrt(variance);

  const volumeZScore = stdDev === 0 ? 0 : (ctx.bar.volume - meanVolume) / stdDev;
  const priceRange = ctx.bar.high - ctx.bar.low;
  const avgBodySize =
    recentBars.reduce((sum, b) => sum + Math.abs(b.close - b.open), 0) /
    recentBars.length;

  // Absorption: high volume relative to normal, but small price movement
  return volumeZScore > 1.5 && priceRange < avgBodySize * 0.5;
}
