import type { Candidate } from './finalizers';
import type { Metrics } from './metrics';

export function scoreCandidate(metrics: Metrics, candidate: Candidate): number {
  let score = 0;

  // Reward smaller entry distance (more likely to trigger soon)
  // Normalize to 0-50 points (0% distance = 50 points, 3% = 0 points)
  const distanceScore = Math.max(0, 50 - (candidate.entryDistancePct / 3) * 50);
  score += distanceScore;

  // Reward R:R closer to target but not excessively high
  // rrWorst >= rrTarget already enforced; reward modestly for higher R:R
  // Cap at 25 points for R:R >= 6.0
  const rrScore = Math.min(25, (candidate.rrWorst - 2) * 5);
  score += Math.max(0, rrScore);

  // Regime alignment (simple thresholds)
  if (candidate.side === 'buy') {
    if (candidate.family.includes('breakout') && metrics.trend20 > 1) {
      score += 25; // Breakout prefers bullish trend
    } else if (candidate.family.includes('bounce') && Math.abs(metrics.trend20) <= 1) {
      score += 25; // Range bounce prefers sideways
    } else if (candidate.family.includes('reclaim') && metrics.trend20 > 1) {
      score += 20; // Reclaim prefers bullish trend
    }
  } else if (candidate.side === 'sell') {
    if (candidate.family.includes('breakout') && metrics.trend20 < -1) {
      score += 25; // Bearish breakout prefers bearish trend
    } else if (candidate.family.includes('bounce') && Math.abs(metrics.trend20) <= 1) {
      score += 25; // Range bounce prefers sideways
    }
  }

  return score;
}

export function pickBest(metrics: Metrics, candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const scored = candidates.map(c => ({
    candidate: c,
    score: scoreCandidate(metrics, c),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored[0].candidate;
}

export function pickTopN(metrics: Metrics, candidates: Candidate[], n: number): Candidate[] {
  const scored = candidates.map(c => ({
    candidate: c,
    score: scoreCandidate(metrics, c),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, n).map(s => s.candidate);
}
