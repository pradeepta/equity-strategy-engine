import type { Candidate } from './finalizers';
import type { Constraints } from './metrics';

export function renderYaml(candidate: Candidate, constraints: Constraints, symbol: string, timeframe: string): string {
  const { name, family, side, entryLow, entryHigh, stop, target, qty } = candidate;

  // Determine arm and trigger rules based on family
  let armRule: string;
  let triggerRule: string;
  let features: string[];

  if (family.includes('breakout')) {
    if (side === 'buy') {
      armRule = 'close > ema20 && rsi > 50';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'ema20', 'rsi'];
    } else {
      armRule = 'close < ema20 && rsi < 50';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'ema20', 'rsi'];
    }
  } else if (family.includes('bounce')) {
    if (side === 'buy') {
      armRule = 'rsi < 45';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'rsi'];
    } else {
      armRule = 'rsi > 55';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'rsi'];
    }
  } else if (family.includes('vwap')) {
    // VWAP reclaim/reject families
    if (side === 'buy') {
      // VWAP Reclaim Long: price reclaims VWAP after dip
      armRule = 'close > vwap && rsi < 55';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'vwap', 'rsi'];
    } else {
      // VWAP Reject Short: price rejects at VWAP after rally
      armRule = 'close < vwap && rsi > 45';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'vwap', 'rsi'];
    }
  } else if (family.includes('ema20')) {
    // EMA20 reclaim/reject families (more specific than generic 'reclaim')
    if (side === 'buy') {
      // EMA20 Reclaim Long: price reclaims EMA20 after dip
      armRule = 'close > ema20 && rsi < 55';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'ema20', 'rsi'];
    } else {
      // EMA20 Reject Short: price rejects at EMA20 after rally
      armRule = 'close < ema20 && rsi > 45';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'ema20', 'rsi'];
    }
  } else if (family.includes('reclaim')) {
    // Generic reclaim (range_midline_reclaim)
    if (side === 'buy') {
      armRule = 'close > ema20';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'ema20'];
    } else {
      armRule = 'close < ema20';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'ema20'];
    }
  } else if (family.includes('reject')) {
    // Generic reject (range_midline_reject) - should come after specific checks
    if (side === 'buy') {
      armRule = 'close > ema20';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'ema20'];
    } else {
      armRule = 'close < ema20';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'ema20'];
    }
  } else if (family.includes('hod')) {
    armRule = 'close > ema20 && rsi > 55';
    triggerRule = `close > ${entryLow}`;
    features = ['close', 'ema20', 'rsi'];
  } else if (family.includes('lod')) {
    armRule = 'close < ema20 && rsi < 45';
    triggerRule = `close < ${entryHigh}`;
    features = ['close', 'ema20', 'rsi'];
  } else if (family.includes('bb_squeeze')) {
    // BB Squeeze families: use BB bands + squeeze detection
    if (side === 'buy') {
      // BB Squeeze Breakout Long: price breaks above compressed BB upper band
      armRule = 'close > ema20 && (bb_upper - bb_lower) / close < 0.02';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'ema20', 'bb_upper', 'bb_lower'];
    } else {
      // BB Squeeze Breakdown Short: price breaks below compressed BB lower band
      armRule = 'close < ema20 && (bb_upper - bb_lower) / close < 0.02';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'ema20', 'bb_upper', 'bb_lower'];
    }
  } else if (family.includes('trend_continuation')) {
    // Trend Continuation families: use ADX for trend strength
    if (side === 'buy') {
      // Trend Continuation Breakout Long: strong uptrend continuation
      armRule = 'close > ema20 && adx > 25 && rsi > 50';
      triggerRule = `close > ${entryLow}`;
      features = ['close', 'ema20', 'adx', 'rsi'];
    } else {
      // Trend Continuation Breakdown Short: strong downtrend continuation
      armRule = 'close < ema20 && adx > 25 && rsi < 50';
      triggerRule = `close < ${entryHigh}`;
      features = ['close', 'ema20', 'adx', 'rsi'];
    }
  } else {
    // Default fallback
    armRule = side === 'buy' ? 'close > ema20' : 'close < ema20';
    triggerRule = side === 'buy' ? `close > ${entryLow}` : `close < ${entryHigh}`;
    features = ['close', 'ema20'];
  }

  const featuresYaml = features.map(f => `  - name: ${f}`).join('\n');

  const invalidateRule = side === 'buy' ? `close < ${stop}` : `close > ${stop}`;

  const yaml = `meta:
  name: "${name}"
  symbol: "${symbol}"
  timeframe: "${timeframe}"

features:
${featuresYaml}

rules:
  arm: "${armRule}"
  trigger: "${triggerRule}"
  invalidate: "${invalidateRule}"

orderPlans:
  - type: bracket
    side: ${side}
    entryZone: [${entryLow}, ${entryHigh}]
    qty: ${qty}
    stopPrice: ${stop}
    targets:
      - price: ${target}
        qty: ${qty}

execution:
  entryTimeoutBars: ${constraints.entryTimeoutBars}
  rthOnly: ${constraints.rthOnly}

risk:
  maxRiskPerTrade: ${constraints.maxRiskPerTrade}
`;

  return yaml;
}
