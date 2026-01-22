import type { Metrics, Constraints } from './metrics';
import type { Candidate, CandidateInput } from './finalizers';
import { finalizeLong, finalizeShort } from './finalizers';

interface FamilyParams {
  lookback: number;
  bufferAtr: number;
  widthAtr: number;
  stopAtr: number;
}

export function breakoutRangeHighLong(
  metrics: Metrics,
  constraints: Constraints,
  params: FamilyParams
): Candidate | null {
  const { lookback, bufferAtr, widthAtr, stopAtr } = params;
  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;

  const entryLow = rangeHigh + bufferAtr * metrics.atr;
  const entryHigh = entryLow + widthAtr * metrics.atr;
  const stop = entryLow - stopAtr * metrics.atr;

  // Compute target to achieve rrTarget from worst fill
  const riskWorst = entryHigh - stop;
  const target = entryHigh + riskWorst * constraints.rrTarget;

  const input: CandidateInput = {
    name: `Breakout Range High Long (${lookback}b)`,
    family: 'breakout_range_high',
    side: 'buy',
    entryLow,
    entryHigh,
    stop,
    target,
    params: { lookback, bufferAtr, widthAtr, stopAtr },
  };

  return finalizeLong(input, metrics, constraints);
}

export function rangeBounceLong(
  metrics: Metrics,
  constraints: Constraints,
  params: { lookback: number; aboveLowAtr: number; widthAtr: number; stopBelowLowAtr: number }
): Candidate | null {
  const { lookback, aboveLowAtr, widthAtr, stopBelowLowAtr } = params;
  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;

  const entryLow = rangeLow + aboveLowAtr * metrics.atr;
  const entryHigh = entryLow + widthAtr * metrics.atr;
  const stop = rangeLow - stopBelowLowAtr * metrics.atr;

  const riskWorst = entryHigh - stop;
  const target = entryHigh + riskWorst * constraints.rrTarget;

  const input: CandidateInput = {
    name: `Range Bounce Long (${lookback}b)`,
    family: 'range_bounce',
    side: 'buy',
    entryLow,
    entryHigh,
    stop,
    target,
    params: { lookback, aboveLowAtr, widthAtr, stopBelowLowAtr },
  };

  return finalizeLong(input, metrics, constraints);
}

export function rangeMidlineReclaimLong(
  metrics: Metrics,
  constraints: Constraints,
  params: { lookback: number; bufAtr: number; widthAtr: number; stopAtr: number }
): Candidate | null {
  const { lookback, bufAtr, widthAtr, stopAtr } = params;
  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;
  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;
  const mid = (rangeHigh + rangeLow) / 2;

  const entryLow = mid + bufAtr * metrics.atr;
  const entryHigh = entryLow + widthAtr * metrics.atr;
  const stop = mid - stopAtr * metrics.atr;

  const riskWorst = entryHigh - stop;
  const target = entryHigh + riskWorst * constraints.rrTarget;

  const input: CandidateInput = {
    name: `Range Midline Reclaim Long (${lookback}b)`,
    family: 'range_midline_reclaim',
    side: 'buy',
    entryLow,
    entryHigh,
    stop,
    target,
    params: { lookback, bufAtr, widthAtr, stopAtr },
  };

  return finalizeLong(input, metrics, constraints);
}

export function hodBreakoutLong(
  metrics: Metrics,
  constraints: Constraints,
  params: Omit<FamilyParams, 'lookback'>
): Candidate | null {
  const { bufferAtr, widthAtr, stopAtr } = params;

  const entryLow = metrics.hod + bufferAtr * metrics.atr;
  const entryHigh = entryLow + widthAtr * metrics.atr;
  const stop = metrics.hod - stopAtr * metrics.atr;

  const riskWorst = entryHigh - stop;
  const target = entryHigh + riskWorst * constraints.rrTarget;

  const input: CandidateInput = {
    name: 'HOD Breakout Long',
    family: 'hod_breakout',
    side: 'buy',
    entryLow,
    entryHigh,
    stop,
    target,
    params: { bufferAtr, widthAtr, stopAtr },
  };

  return finalizeLong(input, metrics, constraints);
}

export function lodBreakdownShort(
  metrics: Metrics,
  constraints: Constraints,
  params: Omit<FamilyParams, 'lookback'>
): Candidate | null {
  const { bufferAtr, widthAtr, stopAtr } = params;

  const entryHigh = metrics.lod - bufferAtr * metrics.atr;
  const entryLow = entryHigh - widthAtr * metrics.atr;
  const stop = entryHigh + stopAtr * metrics.atr;

  const riskWorst = stop - entryLow;
  const target = entryLow - riskWorst * constraints.rrTarget;

  const input: CandidateInput = {
    name: 'LOD Breakdown Short',
    family: 'lod_breakdown',
    side: 'sell',
    entryHigh,
    entryLow,
    stop,
    target,
    params: { bufferAtr, widthAtr, stopAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

export function breakoutRangeHighShort(
  metrics: Metrics,
  constraints: Constraints,
  params: FamilyParams
): Candidate | null {
  const { lookback, bufferAtr, widthAtr, stopAtr } = params;
  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;

  const entryHigh = rangeLow - bufferAtr * metrics.atr;
  const entryLow = entryHigh - widthAtr * metrics.atr;
  const stop = entryHigh + stopAtr * metrics.atr;

  const riskWorst = stop - entryLow;
  const target = entryLow - riskWorst * constraints.rrTarget;

  const input: CandidateInput = {
    name: `Breakout Range Low Short (${lookback}b)`,
    family: 'breakout_range_low',
    side: 'sell',
    entryHigh,
    entryLow,
    stop,
    target,
    params: { lookback, bufferAtr, widthAtr, stopAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

export function rangeBounceShort(
  metrics: Metrics,
  constraints: Constraints,
  params: { lookback: number; belowHighAtr: number; widthAtr: number; stopAboveHighAtr: number }
): Candidate | null {
  const { lookback, belowHighAtr, widthAtr, stopAboveHighAtr } = params;
  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;

  const entryHigh = rangeHigh - belowHighAtr * metrics.atr;
  const entryLow = entryHigh - widthAtr * metrics.atr;
  const stop = rangeHigh + stopAboveHighAtr * metrics.atr;

  const riskWorst = stop - entryLow;
  const target = entryLow - riskWorst * constraints.rrTarget;

  const input: CandidateInput = {
    name: `Range Bounce Short (${lookback}b)`,
    family: 'range_bounce',
    side: 'sell',
    entryHigh,
    entryLow,
    stop,
    target,
    params: { lookback, belowHighAtr, widthAtr, stopAboveHighAtr },
  };

  return finalizeShort(input, metrics, constraints);
}
