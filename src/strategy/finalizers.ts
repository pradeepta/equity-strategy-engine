import type { Constraints, Metrics } from './metrics';

export interface Candidate {
  name: string;
  family: string;
  side: 'buy' | 'sell';
  entryLow: number;
  entryHigh: number;
  stop: number;
  target: number;
  qty: number;
  rrWorst: number;
  dollarRiskWorst: number;
  entryDistancePct: number;
  params: Record<string, any>;
}

export interface CandidateInput {
  name: string;
  family: string;
  side: 'buy' | 'sell';
  entryLow: number;
  entryHigh: number;
  stop: number;
  target: number;
  params: Record<string, any>;
}

function round(value: number, decimals: number = 2): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

export function finalizeLong(
  input: CandidateInput,
  metrics: Metrics,
  constraints: Constraints
): Candidate | null {
  const { entryLow, entryHigh, stop, target } = input;

  // HARD GATE A: Stop must be below entry (riskWorstPerShare > 0)
  const riskWorstPerShare = entryHigh - stop;
  if (riskWorstPerShare <= 0) {
    return null; // Invalid: stop on wrong side
  }

  // HARD GATE D: Target must be above worst fill (rewardWorstPerShare > 0)
  const rewardWorstPerShare = target - entryHigh;
  if (rewardWorstPerShare <= 0) {
    return null; // Invalid: target not beyond worst fill
  }

  // Compute worst-case R:R
  const rrWorst = round(rewardWorstPerShare / riskWorstPerShare, 2);

  // HARD GATE B: R:R must meet target
  if (rrWorst < constraints.rrTarget) {
    return null;
  }

  // Compute qty based on worst-case risk
  const qty = Math.max(1, Math.floor(constraints.maxRiskPerTrade / riskWorstPerShare));
  const dollarRiskWorst = round(qty * riskWorstPerShare, 2);

  // HARD GATE B (refined): Dollar risk must not exceed max
  if (dollarRiskWorst > constraints.maxRiskPerTrade) {
    return null;
  }

  // Compute entry distance
  const entryMid = (entryLow + entryHigh) / 2;
  const entryDistancePct = round(Math.abs(entryMid - metrics.currentPrice) / metrics.currentPrice * 100, 2);

  // HARD GATE E: Entry distance sanity check
  if (entryDistancePct > constraints.maxEntryDistancePct) {
    return null;
  }

  return {
    ...input,
    qty,
    rrWorst,
    dollarRiskWorst,
    entryDistancePct,
    entryLow: round(entryLow, 2),
    entryHigh: round(entryHigh, 2),
    stop: round(stop, 2),
    target: round(target, 2),
  };
}

export function finalizeShort(
  input: CandidateInput,
  metrics: Metrics,
  constraints: Constraints
): Candidate | null {
  const { entryLow, entryHigh, stop, target } = input;

  // HARD GATE A: Stop must be above entry (riskWorstPerShare > 0)
  const riskWorstPerShare = stop - entryLow;
  if (riskWorstPerShare <= 0) {
    return null; // Invalid: stop on wrong side
  }

  // HARD GATE D: Target must be below worst fill (rewardWorstPerShare > 0)
  const rewardWorstPerShare = entryLow - target;
  if (rewardWorstPerShare <= 0) {
    return null; // Invalid: target not beyond worst fill
  }

  // Compute worst-case R:R
  const rrWorst = round(rewardWorstPerShare / riskWorstPerShare, 2);

  // HARD GATE B: R:R must meet target
  if (rrWorst < constraints.rrTarget) {
    return null;
  }

  // Compute qty based on worst-case risk
  const qty = Math.max(1, Math.floor(constraints.maxRiskPerTrade / riskWorstPerShare));
  const dollarRiskWorst = round(qty * riskWorstPerShare, 2);

  // HARD GATE B (refined): Dollar risk must not exceed max
  if (dollarRiskWorst > constraints.maxRiskPerTrade) {
    return null;
  }

  // Compute entry distance
  const entryMid = (entryLow + entryHigh) / 2;
  const entryDistancePct = round(Math.abs(entryMid - metrics.currentPrice) / metrics.currentPrice * 100, 2);

  // HARD GATE E: Entry distance sanity check
  if (entryDistancePct > constraints.maxEntryDistancePct) {
    return null;
  }

  return {
    ...input,
    qty,
    rrWorst,
    dollarRiskWorst,
    entryDistancePct,
    entryLow: round(entryLow, 2),
    entryHigh: round(entryHigh, 2),
    stop: round(stop, 2),
    target: round(target, 2),
  };
}
