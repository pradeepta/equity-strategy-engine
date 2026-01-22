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
  } else if (family.includes('reclaim')) {
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
