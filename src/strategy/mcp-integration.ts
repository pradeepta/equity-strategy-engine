import { proposeBestStrategy } from './generate';
import type { Bar, Constraints, ProposalResult } from './index';

/**
 * MCP Integration for Deterministic Strategy Generator
 *
 * This module bridges the deterministic strategy generator with the MCP server,
 * allowing AI agents to request strategy proposals without "vibe trading".
 */

export interface ProposeDeterministicInput {
  symbol: string;
  timeframe: string;
  bars: Bar[];
  maxRiskPerTrade: number;
  rrTarget?: number;
  maxEntryDistancePct?: number;
  entryTimeoutBars?: number;
  rthOnly?: boolean;
}

export interface ProposeDeterministicOutput {
  success: boolean;
  result?: {
    best: {
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
    };
    yaml: string;
    candidatesTop5: Array<{
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
    }>;
    metrics: {
      atr: number;
      trend20: number;
      trend40: number;
      rangeHigh20: number;
      rangeLow20: number;
      rangeHigh40: number;
      rangeLow40: number;
      hod: number;
      lod: number;
      currentPrice: number;
      ema20: number | null;
    };
  };
  error?: string;
  message?: string;
}

/**
 * Propose a deterministic strategy based on market data.
 *
 * This function is called by the MCP server when an AI agent requests
 * a strategy proposal. It:
 * 1. Computes metrics from bars
 * 2. Generates candidates from multiple families
 * 3. Enforces hard risk gates
 * 4. Returns ranked strategies with YAML
 *
 * @param input - Configuration including bars and risk parameters
 * @returns Proposal result with best strategy and alternatives
 */
export function proposeDeterministic(
  input: ProposeDeterministicInput
): ProposeDeterministicOutput {
  const {
    symbol,
    timeframe,
    bars,
    maxRiskPerTrade,
    rrTarget = 3.0,
    maxEntryDistancePct = 3.0,
    entryTimeoutBars = 10,
    rthOnly = true,
  } = input;

  // Validate inputs
  if (!bars || bars.length < 50) {
    return {
      success: false,
      error: 'Insufficient bars: need at least 50 bars for metrics computation',
    };
  }

  if (maxRiskPerTrade <= 0) {
    return {
      success: false,
      error: 'maxRiskPerTrade must be positive',
    };
  }

  const constraints: Constraints = {
    maxRiskPerTrade,
    rrTarget,
    maxEntryDistancePct,
    entryTimeoutBars,
    rthOnly,
  };

  try {
    const proposal: ProposalResult = proposeBestStrategy(
      bars,
      symbol,
      timeframe,
      constraints
    );

    if (proposal.error) {
      return {
        success: false,
        error: proposal.error,
        message: `Failed to generate valid strategies: ${proposal.error}`,
      };
    }

    if (!proposal.best || !proposal.yaml) {
      return {
        success: false,
        error: 'No valid candidates generated (all failed hard gates)',
        message: 'All candidate strategies failed hard gate validation. Try adjusting risk parameters or wait for better market conditions.',
      };
    }

    return {
      success: true,
      result: {
        best: proposal.best,
        yaml: proposal.yaml,
        candidatesTop5: proposal.candidatesTop5,
        metrics: proposal.metrics,
      },
      message: `Successfully generated ${proposal.candidatesTop5.length} candidate strategies. Best: ${proposal.best.name} (R:R ${proposal.best.rrWorst}:1, $${proposal.best.dollarRiskWorst} risk, ${proposal.best.entryDistancePct}% away)`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Unknown error during strategy generation',
      message: `Strategy generation failed: ${err.message}`,
    };
  }
}
