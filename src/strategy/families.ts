import type { Metrics, Constraints } from "./metrics";
import type { Candidate, CandidateInput } from "./finalizers";
import { finalizeLong, finalizeShort } from "./finalizers";

interface FamilyParams {
  lookback: number;
  bufferAtr: number;
  widthAtr: number;
  stopAtr: number;
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeLongZone(
  entryLow: number,
  entryHigh: number,
): { entryLow: number; entryHigh: number } {
  return entryLow <= entryHigh
    ? { entryLow, entryHigh }
    : { entryLow: entryHigh, entryHigh: entryLow };
}

// For shorts we represent zone as [entryLow, entryHigh] too, but most callers pass (entryHigh, entryLow).
function normalizeShortZone(
  entryHigh: number,
  entryLow: number,
): { entryHigh: number; entryLow: number } {
  return entryHigh >= entryLow
    ? { entryHigh, entryLow }
    : { entryHigh: entryLow, entryLow: entryHigh };
}

function rrTargetLong(entryHigh: number, stop: number, rr: number): number {
  const riskWorst = entryHigh - stop;
  return entryHigh + riskWorst * rr;
}

function rrTargetShort(entryLow: number, stop: number, rr: number): number {
  const riskWorst = stop - entryLow;
  return entryLow - riskWorst * rr;
}

function nearFarOffsets(
  k1: number,
  k2: number,
  atr: number,
): { near: number; far: number } {
  const a = k1 * atr;
  const b = k2 * atr;
  return { near: Math.min(a, b), far: Math.max(a, b) };
}

// ============================================================================
// Families
// ============================================================================

export function breakoutRangeHighLong(
  metrics: Metrics,
  constraints: Constraints,
  params: FamilyParams,
): Candidate | null {
  const { lookback, bufferAtr, widthAtr, stopAtr } = params;
  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;

  const entryLowRaw = rangeHigh + bufferAtr * metrics.atr;
  const entryHighRaw = entryLowRaw + widthAtr * metrics.atr;
  const stop = entryLowRaw - stopAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  // Long invariant: stop should be below the zone
  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Breakout Range High Long (${lookback}b)`,
    family: "breakout_range_high",
    side: "buy",
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
  params: {
    lookback: number;
    aboveLowAtr: number;
    widthAtr: number;
    stopBelowLowAtr: number;
  },
): Candidate | null {
  const { lookback, aboveLowAtr, widthAtr, stopBelowLowAtr } = params;
  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;

  const entryLowRaw = rangeLow + aboveLowAtr * metrics.atr;
  const entryHighRaw = entryLowRaw + widthAtr * metrics.atr;
  const stop = rangeLow - stopBelowLowAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Range Bounce Long (${lookback}b)`,
    family: "range_bounce",
    side: "buy",
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
  params: {
    lookback: number;
    bufAtr: number;
    widthAtr: number;
    stopAtr: number;
  },
): Candidate | null {
  const { lookback, bufAtr, widthAtr, stopAtr } = params;
  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;
  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;
  const mid = (rangeHigh + rangeLow) / 2;

  const entryLowRaw = mid + bufAtr * metrics.atr;
  const entryHighRaw = entryLowRaw + widthAtr * metrics.atr;
  const stop = mid - stopAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Range Midline Reclaim Long (${lookback}b)`,
    family: "range_midline_reclaim",
    side: "buy",
    entryLow,
    entryHigh,
    stop,
    target,
    params: { lookback, bufAtr, widthAtr, stopAtr },
  };

  return finalizeLong(input, metrics, constraints);
}

export function rangeMidlineRejectShort(
  metrics: Metrics,
  constraints: Constraints,
  params: {
    lookback: number;
    bufAtr: number;
    widthAtr: number;
    stopAtr: number;
  },
): Candidate | null {
  const { lookback, bufAtr, widthAtr, stopAtr } = params;
  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;
  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;
  const mid = (rangeHigh + rangeLow) / 2;

  const entryHighRaw = mid - bufAtr * metrics.atr;
  const entryLowRaw = entryHighRaw - widthAtr * metrics.atr;
  const stop = mid + stopAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  // Short invariant: stop should be above the zone
  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Range Midline Reject Short (${lookback}b)`,
    family: "range_midline_reject",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { lookback, bufAtr, widthAtr, stopAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

export function hodBreakoutLong(
  metrics: Metrics,
  constraints: Constraints,
  params: Omit<FamilyParams, "lookback">,
): Candidate | null {
  const { bufferAtr, widthAtr, stopAtr } = params;

  const entryLowRaw = metrics.hod + bufferAtr * metrics.atr;
  const entryHighRaw = entryLowRaw + widthAtr * metrics.atr;
  const stop = metrics.hod - stopAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "HOD Breakout Long",
    family: "hod_breakout",
    side: "buy",
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
  params: Omit<FamilyParams, "lookback">,
): Candidate | null {
  const { bufferAtr, widthAtr, stopAtr } = params;

  const entryHighRaw = metrics.lod - bufferAtr * metrics.atr;
  const entryLowRaw = entryHighRaw - widthAtr * metrics.atr;
  const stop = entryHighRaw + stopAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "LOD Breakdown Short",
    family: "lod_breakdown",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { bufferAtr, widthAtr, stopAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

// Correct name for this family (it breaks DOWN through range LOW)
export function breakoutRangeLowShort(
  metrics: Metrics,
  constraints: Constraints,
  params: FamilyParams,
): Candidate | null {
  const { lookback, bufferAtr, widthAtr, stopAtr } = params;
  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;

  const entryHighRaw = rangeLow - bufferAtr * metrics.atr;
  const entryLowRaw = entryHighRaw - widthAtr * metrics.atr;
  const stop = entryHighRaw + stopAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Breakout Range Low Short (${lookback}b)`,
    family: "breakout_range_low",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { lookback, bufferAtr, widthAtr, stopAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

/**
 * Backwards-compatible alias (your generator currently imports breakoutRangeHighShort)
 * @deprecated Use breakoutRangeLowShort instead.
 */
export function breakoutRangeHighShort(
  metrics: Metrics,
  constraints: Constraints,
  params: FamilyParams,
): Candidate | null {
  return breakoutRangeLowShort(metrics, constraints, params);
}

export function rangeBounceShort(
  metrics: Metrics,
  constraints: Constraints,
  params: {
    lookback: number;
    belowHighAtr: number;
    widthAtr: number;
    stopAboveHighAtr: number;
  },
): Candidate | null {
  const { lookback, belowHighAtr, widthAtr, stopAboveHighAtr } = params;
  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;

  const entryHighRaw = rangeHigh - belowHighAtr * metrics.atr;
  const entryLowRaw = entryHighRaw - widthAtr * metrics.atr;
  const stop = rangeHigh + stopAboveHighAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Range Bounce Short (${lookback}b)`,
    family: "range_bounce",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { lookback, belowHighAtr, widthAtr, stopAboveHighAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

export function vwapReclaimLong(
  metrics: Metrics,
  constraints: Constraints,
  params: { k1: number; k2: number; stopAtr: number },
): Candidate | null {
  const { k1, k2, stopAtr } = params;

  const { near, far } = nearFarOffsets(k1, k2, metrics.atr);
  const entryLowRaw = metrics.vwap + near;
  const entryHighRaw = metrics.vwap + far;
  const stop = metrics.vwap - stopAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "VWAP Reclaim Long",
    family: "vwap_reclaim",
    side: "buy",
    entryLow,
    entryHigh,
    stop,
    target,
    params: { k1, k2, stopAtr },
  };

  return finalizeLong(input, metrics, constraints);
}

export function vwapRejectShort(
  metrics: Metrics,
  constraints: Constraints,
  params: { k1: number; k2: number; stopAtr: number },
): Candidate | null {
  const { k1, k2, stopAtr } = params;

  const { near, far } = nearFarOffsets(k1, k2, metrics.atr);
  // For shorts, "near" is closer to VWAP (higher), "far" is farther down (lower)
  const entryHighRaw = metrics.vwap - near;
  const entryLowRaw = metrics.vwap - far;
  const stop = metrics.vwap + stopAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "VWAP Reject Short",
    family: "vwap_reject",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { k1, k2, stopAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

export function ema20ReclaimLong(
  metrics: Metrics,
  constraints: Constraints,
  params: { k1: number; k2: number; stopAtr: number },
): Candidate | null {
  if (metrics.ema20 === null) {
    return null;
  }

  const { k1, k2, stopAtr } = params;

  const { near, far } = nearFarOffsets(k1, k2, metrics.atr);
  const entryLowRaw = metrics.ema20 + near;
  const entryHighRaw = metrics.ema20 + far;
  const stop = metrics.ema20 - stopAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "EMA20 Reclaim Long",
    family: "ema20_reclaim",
    side: "buy",
    entryLow,
    entryHigh,
    stop,
    target,
    params: { k1, k2, stopAtr },
  };

  return finalizeLong(input, metrics, constraints);
}

export function ema20RejectShort(
  metrics: Metrics,
  constraints: Constraints,
  params: { k1: number; k2: number; stopAtr: number },
): Candidate | null {
  if (metrics.ema20 === null) {
    return null;
  }

  const { k1, k2, stopAtr } = params;

  const { near, far } = nearFarOffsets(k1, k2, metrics.atr);
  const entryHighRaw = metrics.ema20 - near;
  const entryLowRaw = metrics.ema20 - far;
  const stop = metrics.ema20 + stopAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "EMA20 Reject Short",
    family: "ema20_reject",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { k1, k2, stopAtr },
  };

  return finalizeShort(input, metrics, constraints);
}

export function bbSqueezeBreakoutLong(
  metrics: Metrics,
  constraints: Constraints,
  params: {
    bufferAtr: number;
    widthAtr: number;
    stopAtr: number;
    maxBbWidthPct?: number;
  },
): Candidate | null {
  if (metrics.bbUpper === null || metrics.bbLower === null) {
    return null;
  }

  const { bufferAtr, widthAtr, stopAtr, maxBbWidthPct } = params;

  // Optional squeeze gate: check if BB width is narrow enough
  if (maxBbWidthPct !== undefined) {
    if (
      metrics.ema20 === null ||
      !Number.isFinite(metrics.ema20) ||
      metrics.ema20 <= 0
    ) {
      return null; // can't evaluate squeeze gate safely
    }
    const bbWidth = (metrics.bbUpper - metrics.bbLower) / metrics.ema20;
    if (!Number.isFinite(bbWidth) || bbWidth > maxBbWidthPct) {
      return null;
    }
  }

  const entryLowRaw = metrics.bbUpper + bufferAtr * metrics.atr;
  const entryHighRaw = entryLowRaw + widthAtr * metrics.atr;
  const stop = entryLowRaw - stopAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "BB Squeeze Breakout Long",
    family: "bb_squeeze_breakout",
    side: "buy",
    entryLow,
    entryHigh,
    stop,
    target,
    params: { bufferAtr, widthAtr, stopAtr, maxBbWidthPct },
  };

  return finalizeLong(input, metrics, constraints);
}

export function bbSqueezeBreakdownShort(
  metrics: Metrics,
  constraints: Constraints,
  params: {
    bufferAtr: number;
    widthAtr: number;
    stopAtr: number;
    maxBbWidthPct?: number;
  },
): Candidate | null {
  if (metrics.bbUpper === null || metrics.bbLower === null) {
    return null;
  }

  const { bufferAtr, widthAtr, stopAtr, maxBbWidthPct } = params;

  // Optional squeeze gate: check if BB width is narrow enough
  if (maxBbWidthPct !== undefined) {
    if (
      metrics.ema20 === null ||
      !Number.isFinite(metrics.ema20) ||
      metrics.ema20 <= 0
    ) {
      return null; // can't evaluate squeeze gate safely
    }
    const bbWidth = (metrics.bbUpper - metrics.bbLower) / metrics.ema20;
    if (!Number.isFinite(bbWidth) || bbWidth > maxBbWidthPct) {
      return null;
    }
  }

  const entryHighRaw = metrics.bbLower - bufferAtr * metrics.atr;
  const entryLowRaw = entryHighRaw - widthAtr * metrics.atr;
  const stop = entryHighRaw + stopAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: "BB Squeeze Breakdown Short",
    family: "bb_squeeze_breakdown",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { bufferAtr, widthAtr, stopAtr, maxBbWidthPct },
  };

  return finalizeShort(input, metrics, constraints);
}

export function trendContinuationBreakoutLong(
  metrics: Metrics,
  constraints: Constraints,
  params: {
    lookback: number;
    bufferAtr: number;
    widthAtr: number;
    stopAtr: number;
    minAdx: number;
  },
): Candidate | null {
  const { lookback, bufferAtr, widthAtr, stopAtr, minAdx } = params;

  // ADX gate: only trade if trend strength meets threshold
  if (metrics.adx < minAdx) {
    return null;
  }

  const rangeHigh = lookback === 20 ? metrics.rangeHigh20 : metrics.rangeHigh40;

  const entryLowRaw = rangeHigh + bufferAtr * metrics.atr;
  const entryHighRaw = entryLowRaw + widthAtr * metrics.atr;
  const stop = entryLowRaw - stopAtr * metrics.atr;

  const { entryLow, entryHigh } = normalizeLongZone(entryLowRaw, entryHighRaw);

  if (!(stop < entryLow)) return null;

  const target = rrTargetLong(entryHigh, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Trend Continuation Breakout Long (${lookback}b, ADX>=${minAdx})`,
    family: "trend_continuation_breakout",
    side: "buy",
    entryLow,
    entryHigh,
    stop,
    target,
    params: { lookback, bufferAtr, widthAtr, stopAtr, minAdx },
  };

  return finalizeLong(input, metrics, constraints);
}

export function trendContinuationBreakdownShort(
  metrics: Metrics,
  constraints: Constraints,
  params: {
    lookback: number;
    bufferAtr: number;
    widthAtr: number;
    stopAtr: number;
    minAdx: number;
  },
): Candidate | null {
  const { lookback, bufferAtr, widthAtr, stopAtr, minAdx } = params;

  // ADX gate: only trade if trend strength meets threshold
  if (metrics.adx < minAdx) {
    return null;
  }

  const rangeLow = lookback === 20 ? metrics.rangeLow20 : metrics.rangeLow40;

  const entryHighRaw = rangeLow - bufferAtr * metrics.atr;
  const entryLowRaw = entryHighRaw - widthAtr * metrics.atr;
  const stop = entryHighRaw + stopAtr * metrics.atr;

  const { entryHigh, entryLow } = normalizeShortZone(entryHighRaw, entryLowRaw);

  if (!(stop > entryHigh)) return null;

  const target = rrTargetShort(entryLow, stop, constraints.rrTarget);

  const input: CandidateInput = {
    name: `Trend Continuation Breakdown Short (${lookback}b, ADX>=${minAdx})`,
    family: "trend_continuation_breakdown",
    side: "sell",
    entryHigh,
    entryLow,
    stop,
    target,
    params: { lookback, bufferAtr, widthAtr, stopAtr, minAdx },
  };

  return finalizeShort(input, metrics, constraints);
}
