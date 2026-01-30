import type { Candidate } from './finalizers';
import type { Constraints } from './metrics';

export function renderYaml(candidate: Candidate, constraints: Constraints, symbol: string, timeframe: string): string {
  const { name, family, side, qty } = candidate;

  // Determine arm and trigger rules based on family
  let armRule: string;
  let triggerRule: string;
  let features: string[];

  // Dynamic entry zone expressions based on strategy family
  let entryZoneExpr: [string, string];

  // Standard ATR multipliers for dynamic levels
  const STOP_ATR_MULTIPLIER = 1.5;
  const TARGET_ATR_MULTIPLIER = 3.0; // Aims for ~2:1 R:R minimum

  if (family.includes('breakout')) {
    if (side === 'buy') {
      armRule = 'close > ema20 && rsi > 50';
      triggerRule = 'close > range_high_20';
      features = ['close', 'ema20', 'rsi', 'range_high_20', 'atr'];
      entryZoneExpr = ['range_high_20 - 0.1 * atr', 'range_high_20'];
    } else {
      armRule = 'close < ema20 && rsi < 50';
      triggerRule = 'close < range_low_20';
      features = ['close', 'ema20', 'rsi', 'range_low_20', 'atr'];
      entryZoneExpr = ['range_low_20', 'range_low_20 + 0.1 * atr'];
    }
  } else if (family.includes('bounce')) {
    if (side === 'buy') {
      armRule = 'rsi < 45';
      triggerRule = 'close > range_low_20';
      features = ['close', 'rsi', 'range_low_20', 'atr'];
      entryZoneExpr = ['range_low_20', 'range_low_20 + 0.2 * atr'];
    } else {
      armRule = 'rsi > 55';
      triggerRule = 'close < range_high_20';
      features = ['close', 'rsi', 'range_high_20', 'atr'];
      entryZoneExpr = ['range_high_20 - 0.2 * atr', 'range_high_20'];
    }
  } else if (family.includes('vwap')) {
    // VWAP reclaim/reject families
    if (side === 'buy') {
      // VWAP Reclaim Long: price reclaims VWAP after dip
      armRule = 'close < vwap && rsi < 45';
      triggerRule = 'close > vwap';
      features = ['close', 'vwap', 'rsi', 'atr'];
      entryZoneExpr = ['vwap - 0.2 * atr', 'vwap'];
    } else {
      // VWAP Reject Short: price rejects at VWAP after rally
      armRule = 'close > vwap && rsi > 55';
      triggerRule = 'close < vwap';
      features = ['close', 'vwap', 'rsi', 'atr'];
      entryZoneExpr = ['vwap', 'vwap + 0.2 * atr'];
    }
  } else if (family.includes('ema20')) {
    // EMA20 reclaim/reject families (more specific than generic 'reclaim')
    if (side === 'buy') {
      // EMA20 Reclaim Long: price reclaims EMA20 after dip
      armRule = 'close < ema20 && rsi < 45';
      triggerRule = 'close > ema20';
      features = ['close', 'ema20', 'rsi', 'atr'];
      entryZoneExpr = ['ema20 - 0.3 * atr', 'ema20'];
    } else {
      // EMA20 Reject Short: price rejects at EMA20 after rally
      armRule = 'close > ema20 && rsi > 55';
      triggerRule = 'close < ema20';
      features = ['close', 'ema20', 'rsi', 'atr'];
      entryZoneExpr = ['ema20', 'ema20 + 0.3 * atr'];
    }
  } else if (family.includes('reclaim')) {
    // Generic reclaim (range_midline_reclaim)
    if (side === 'buy') {
      armRule = 'close < range_mid_20';
      triggerRule = 'close > range_mid_20';
      features = ['close', 'range_mid_20', 'atr'];
      entryZoneExpr = ['range_mid_20 - 0.2 * atr', 'range_mid_20'];
    } else {
      armRule = 'close > range_mid_20';
      triggerRule = 'close < range_mid_20';
      features = ['close', 'range_mid_20', 'atr'];
      entryZoneExpr = ['range_mid_20', 'range_mid_20 + 0.2 * atr'];
    }
  } else if (family.includes('reject')) {
    // Generic reject (range_midline_reject) - should come after specific checks
    if (side === 'buy') {
      armRule = 'close < range_mid_20 && rsi < 45';
      triggerRule = 'close > range_mid_20';
      features = ['close', 'range_mid_20', 'rsi', 'atr'];
      entryZoneExpr = ['range_mid_20 - 0.2 * atr', 'range_mid_20'];
    } else {
      armRule = 'close > range_mid_20 && rsi > 55';
      triggerRule = 'close < range_mid_20';
      features = ['close', 'range_mid_20', 'rsi', 'atr'];
      entryZoneExpr = ['range_mid_20', 'range_mid_20 + 0.2 * atr'];
    }
  } else if (family.includes('hod')) {
    armRule = 'close > ema20 && rsi > 55';
    triggerRule = 'close > hod';
    features = ['close', 'ema20', 'rsi', 'hod', 'atr'];
    entryZoneExpr = ['hod - 0.1 * atr', 'hod'];
  } else if (family.includes('lod')) {
    armRule = 'close < ema20 && rsi < 45';
    triggerRule = 'close < lod';
    features = ['close', 'ema20', 'rsi', 'lod', 'atr'];
    entryZoneExpr = ['lod', 'lod + 0.1 * atr'];
  } else if (family.includes('bb_squeeze')) {
    // BB Squeeze families: use BB bands + squeeze detection
    if (side === 'buy') {
      // BB Squeeze Breakout Long: price breaks above compressed BB upper band
      armRule = 'close > bb_middle && (bb_upper - bb_lower) / close < 0.02';
      triggerRule = 'close > bb_upper';
      features = ['close', 'bb_upper', 'bb_middle', 'bb_lower', 'atr'];
      entryZoneExpr = ['bb_upper', 'bb_upper + 0.2 * atr'];
    } else {
      // BB Squeeze Breakdown Short: price breaks below compressed BB lower band
      armRule = 'close < bb_middle && (bb_upper - bb_lower) / close < 0.02';
      triggerRule = 'close < bb_lower';
      features = ['close', 'bb_upper', 'bb_middle', 'bb_lower', 'atr'];
      entryZoneExpr = ['bb_lower - 0.2 * atr', 'bb_lower'];
    }
  } else if (family.includes('trend_continuation')) {
    // Trend Continuation families: use ADX for trend strength
    if (side === 'buy') {
      // Trend Continuation Breakout Long: strong uptrend continuation
      armRule = 'close > ema20 && adx > 25 && rsi > 50';
      triggerRule = 'close > range_high_20';
      features = ['close', 'ema20', 'adx', 'rsi', 'range_high_20', 'atr'];
      entryZoneExpr = ['range_high_20 - 0.1 * atr', 'range_high_20'];
    } else {
      // Trend Continuation Breakdown Short: strong downtrend continuation
      armRule = 'close < ema20 && adx > 25 && rsi < 50';
      triggerRule = 'close < range_low_20';
      features = ['close', 'ema20', 'adx', 'rsi', 'range_low_20', 'atr'];
      entryZoneExpr = ['range_low_20', 'range_low_20 + 0.1 * atr'];
    }
  } else {
    // Default fallback - use range levels
    if (side === 'buy') {
      armRule = 'close > ema20';
      triggerRule = 'close > range_high_20';
      features = ['close', 'ema20', 'range_high_20', 'atr'];
      entryZoneExpr = ['range_high_20 - 0.2 * atr', 'range_high_20'];
    } else {
      armRule = 'close < ema20';
      triggerRule = 'close < range_low_20';
      features = ['close', 'ema20', 'range_low_20', 'atr'];
      entryZoneExpr = ['range_low_20', 'range_low_20 + 0.2 * atr'];
    }
  }

  const featuresYaml = features.map(f => `  - name: ${f}\n    type: ${f === 'close' || f === 'open' || f === 'high' || f === 'low' || f === 'volume' ? 'builtin' : 'indicator'}`).join('\n');

  // Dynamic stop and target expressions - ANCHOR TO STRUCTURE, NOT ENTRY
  // This prevents "entry recentering" feedback loop that causes swap churn
  let stopPriceExpr: string;
  let targetPriceExpr: string;
  let invalidateRule: string;

  if (family.includes('breakout')) {
    if (side === 'buy') {
      // Breakout long: stop below breakout level, target above
      stopPriceExpr = `"range_high_20 - ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_high_20 + ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close < (range_high_20 - ${STOP_ATR_MULTIPLIER} * atr)"`;
    } else {
      // Breakdown short: stop above breakdown level, target below
      stopPriceExpr = `"range_low_20 + ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_low_20 - ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close > (range_low_20 + ${STOP_ATR_MULTIPLIER} * atr)"`;
    }
  } else if (family.includes('bounce')) {
    if (side === 'buy') {
      // Bounce long: stop below range low, target at mid or above
      stopPriceExpr = `"range_low_20 - 1.2 * atr"`;
      targetPriceExpr = `"range_low_20 + 2.5 * atr"`;
      invalidateRule = `"close < (range_low_20 - 1.2 * atr)"`;
    } else {
      // Bounce short: stop above range high, target at mid or below
      stopPriceExpr = `"range_high_20 + 1.2 * atr"`;
      targetPriceExpr = `"range_high_20 - 2.5 * atr"`;
      invalidateRule = `"close > (range_high_20 + 1.2 * atr)"`;
    }
  } else if (family.includes('vwap')) {
    if (side === 'buy') {
      // VWAP reclaim long: stop below VWAP, target above
      stopPriceExpr = `"vwap - ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"vwap + ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close < (vwap - ${STOP_ATR_MULTIPLIER} * atr)"`;
    } else {
      // VWAP reject short: stop above VWAP, target below
      stopPriceExpr = `"vwap + ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"vwap - ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close > (vwap + ${STOP_ATR_MULTIPLIER} * atr)"`;
    }
  } else if (family.includes('ema20')) {
    if (side === 'buy') {
      // EMA20 reclaim long: stop below EMA20, target above
      stopPriceExpr = `"ema20 - ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"ema20 + ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close < (ema20 - ${STOP_ATR_MULTIPLIER} * atr)"`;
    } else {
      // EMA20 reject short: stop above EMA20, target below
      stopPriceExpr = `"ema20 + ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"ema20 - ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close > (ema20 + ${STOP_ATR_MULTIPLIER} * atr)"`;
    }
  } else if (family.includes('reclaim') || family.includes('reject')) {
    if (side === 'buy') {
      // Reclaim/reject long: stop below range mid, target above
      stopPriceExpr = `"range_mid_20 - ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_mid_20 + ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close < (range_mid_20 - ${STOP_ATR_MULTIPLIER} * atr)"`;
    } else {
      // Reclaim/reject short: stop above range mid, target below
      stopPriceExpr = `"range_mid_20 + ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_mid_20 - ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close > (range_mid_20 + ${STOP_ATR_MULTIPLIER} * atr)"`;
    }
  } else if (family.includes('bb_squeeze')) {
    if (side === 'buy') {
      // BB squeeze breakout: stop at middle band, target above upper
      stopPriceExpr = `"bb_middle - 0.5 * atr"`;
      targetPriceExpr = `"bb_upper + ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close < bb_middle"`;
    } else {
      // BB squeeze breakdown: stop at middle band, target below lower
      stopPriceExpr = `"bb_middle + 0.5 * atr"`;
      targetPriceExpr = `"bb_lower - ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close > bb_middle"`;
    }
  } else if (family.includes('trend_continuation')) {
    if (side === 'buy') {
      // Trend continuation long: stop below range high, target well above
      stopPriceExpr = `"range_high_20 - ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_high_20 + ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close < (range_high_20 - ${STOP_ATR_MULTIPLIER} * atr)"`;
    } else {
      // Trend continuation short: stop above range low, target well below
      stopPriceExpr = `"range_low_20 + ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_low_20 - ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close > (range_low_20 + ${STOP_ATR_MULTIPLIER} * atr)"`;
    }
  } else if (family.includes('hod')) {
    // HOD breakout: stop below HOD, target above
    stopPriceExpr = `"hod - ${STOP_ATR_MULTIPLIER} * atr"`;
    targetPriceExpr = `"hod + ${TARGET_ATR_MULTIPLIER} * atr"`;
    invalidateRule = `"close < (hod - ${STOP_ATR_MULTIPLIER} * atr)"`;
  } else if (family.includes('lod')) {
    // LOD breakdown: stop above LOD, target below
    stopPriceExpr = `"lod + ${STOP_ATR_MULTIPLIER} * atr"`;
    targetPriceExpr = `"lod - ${TARGET_ATR_MULTIPLIER} * atr"`;
    invalidateRule = `"close > (lod + ${STOP_ATR_MULTIPLIER} * atr)"`;
  } else {
    // Default: anchor to range levels
    if (side === 'buy') {
      stopPriceExpr = `"range_high_20 - ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_high_20 + ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close < (range_high_20 - ${STOP_ATR_MULTIPLIER} * atr)"`;
    } else {
      stopPriceExpr = `"range_low_20 + ${STOP_ATR_MULTIPLIER} * atr"`;
      targetPriceExpr = `"range_low_20 - ${TARGET_ATR_MULTIPLIER} * atr"`;
      invalidateRule = `"close > (range_low_20 + ${STOP_ATR_MULTIPLIER} * atr)"`;
    }
  }

  const yaml = `meta:
  name: "${name}"
  symbol: "${symbol}"
  timeframe: "${timeframe}"

features:
${featuresYaml}

rules:
  arm: "${armRule}"
  trigger: "${triggerRule}"
  invalidate:
    when_any:
      - ${invalidateRule}

orderPlans:
  - name: ${symbol.toLowerCase()}_${side}
    side: ${side}
    entryZone: [${entryZoneExpr[0]}, ${entryZoneExpr[1]}]
    qty: ${qty}
    stopPrice: ${stopPriceExpr}
    targets:
      - price: ${targetPriceExpr}
        ratioOfPosition: 1.0

execution:
  entryTimeoutBars: ${constraints.entryTimeoutBars}
  rthOnly: ${constraints.rthOnly}
  freezeLevelsOn: triggered

risk:
  maxRiskPerTrade: ${constraints.maxRiskPerTrade}
`;

  return yaml;
}
