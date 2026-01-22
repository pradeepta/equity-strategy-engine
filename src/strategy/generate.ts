import type { Bar, Metrics, Constraints } from './metrics';
import type { Candidate } from './finalizers';
import { computeMetrics } from './metrics';
import { pickBest, pickTopN } from './scoring';
import { renderYaml } from './yaml';
import {
  breakoutRangeHighLong,
  rangeBounceLong,
  rangeMidlineReclaimLong,
  hodBreakoutLong,
  lodBreakdownShort,
  breakoutRangeHighShort,
  rangeBounceShort,
} from './families';

export function generateCandidates(metrics: Metrics, constraints: Constraints): Candidate[] {
  const candidates: Candidate[] = [];

  // Parameter grids (small for speed)
  const buffers = [0.05, 0.10];
  const widths = [0.05];
  const stops = [1.0, 1.25];
  const lookbacks = [20, 40];

  // Breakout Range High Long
  for (const lookback of lookbacks) {
    for (const bufferAtr of buffers) {
      for (const widthAtr of widths) {
        for (const stopAtr of stops) {
          const c = breakoutRangeHighLong(metrics, constraints, { lookback, bufferAtr, widthAtr, stopAtr });
          if (c) candidates.push(c);
        }
      }
    }
  }

  // Range Bounce Long
  for (const lookback of lookbacks) {
    for (const aboveLowAtr of [0.1, 0.2]) {
      for (const widthAtr of widths) {
        for (const stopBelowLowAtr of [0.5, 0.75]) {
          const c = rangeBounceLong(metrics, constraints, { lookback, aboveLowAtr, widthAtr, stopBelowLowAtr });
          if (c) candidates.push(c);
        }
      }
    }
  }

  // Range Midline Reclaim Long
  for (const lookback of lookbacks) {
    for (const bufAtr of [0.05, 0.1]) {
      for (const widthAtr of widths) {
        for (const stopAtr of stops) {
          const c = rangeMidlineReclaimLong(metrics, constraints, { lookback, bufAtr, widthAtr, stopAtr });
          if (c) candidates.push(c);
        }
      }
    }
  }

  // HOD Breakout Long
  for (const bufferAtr of buffers) {
    for (const widthAtr of widths) {
      for (const stopAtr of stops) {
        const c = hodBreakoutLong(metrics, constraints, { bufferAtr, widthAtr, stopAtr });
        if (c) candidates.push(c);
      }
    }
  }

  // LOD Breakdown Short
  for (const bufferAtr of buffers) {
    for (const widthAtr of widths) {
      for (const stopAtr of stops) {
        const c = lodBreakdownShort(metrics, constraints, { bufferAtr, widthAtr, stopAtr });
        if (c) candidates.push(c);
      }
    }
  }

  // Breakout Range High Short (bearish breakdown)
  for (const lookback of lookbacks) {
    for (const bufferAtr of buffers) {
      for (const widthAtr of widths) {
        for (const stopAtr of stops) {
          const c = breakoutRangeHighShort(metrics, constraints, { lookback, bufferAtr, widthAtr, stopAtr });
          if (c) candidates.push(c);
        }
      }
    }
  }

  // Range Bounce Short
  for (const lookback of lookbacks) {
    for (const belowHighAtr of [0.1, 0.2]) {
      for (const widthAtr of widths) {
        for (const stopAboveHighAtr of [0.5, 0.75]) {
          const c = rangeBounceShort(metrics, constraints, { lookback, belowHighAtr, widthAtr, stopAboveHighAtr });
          if (c) candidates.push(c);
        }
      }
    }
  }

  return candidates;
}

export interface ProposalResult {
  best: Candidate | null;
  yaml: string | null;
  candidatesTop5: Candidate[];
  metrics: Metrics;
  error?: string;
}

export function proposeBestStrategy(
  bars: Bar[],
  symbol: string,
  timeframe: string,
  constraints: Constraints
): ProposalResult {
  try {
    // 1. Compute metrics
    const metrics = computeMetrics(bars);

    // 2. Generate candidates
    const candidates = generateCandidates(metrics, constraints);

    if (candidates.length === 0) {
      return {
        best: null,
        yaml: null,
        candidatesTop5: [],
        metrics,
        error: 'No valid candidates generated (all failed hard gates)',
      };
    }

    // 3. Pick best
    const best = pickBest(metrics, candidates);
    if (!best) {
      return {
        best: null,
        yaml: null,
        candidatesTop5: [],
        metrics,
        error: 'Failed to pick best candidate',
      };
    }

    // 4. Render YAML
    const yaml = renderYaml(best, constraints, symbol, timeframe);

    // 5. Get top 5 for audit
    const candidatesTop5 = pickTopN(metrics, candidates, 5);

    return {
      best,
      yaml,
      candidatesTop5,
      metrics,
    };
  } catch (err: any) {
    return {
      best: null,
      yaml: null,
      candidatesTop5: [],
      metrics: {} as Metrics,
      error: err.message || 'Unknown error',
    };
  }
}
