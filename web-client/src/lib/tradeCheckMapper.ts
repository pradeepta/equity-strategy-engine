/**
 * Utility functions to map TradeCheck analysis to strategy creation prompts
 */

import type { TradeCheckAnalysis, MarketRegime } from './tradeCheckClient';

export interface StrategyCreationPrompt {
  prompt: string;
  metadata: {
    symbol: string;
    side: 'buy' | 'sell';
    entryPrice: number;
    stopLoss: number;
    targets: number[];
    confidence: number;
    patterns: string[];
    marketRegime: string;
  };
}

/**
 * Convert TradeCheck analysis into a chat prompt for strategy creation
 */
export function createStrategyPrompt(
  analysis: TradeCheckAnalysis,
  regime: MarketRegime
): StrategyCreationPrompt {
  const side = analysis.setup_type === 'long' ? 'buy' : 'sell';
  const entryPrice = parseFloat(analysis.trade_plan?.entry || '0');
  const stopLoss = parseFloat(analysis.trade_plan?.stop_loss || '0');
  const targets = analysis.trade_plan?.targets || [];

  // Create entry zone around entry price (±0.3%)
  const entryZoneWidth = entryPrice * 0.003;
  const entryZoneLower = entryPrice - entryZoneWidth;
  const entryZoneHigher = entryPrice + entryZoneWidth;

  // Format patterns for display
  const patternsList = analysis.patterns
    .map(p => p.replace(/_/g, ' '))
    .join(', ');

  // Calculate risk amount per share
  const riskPerShare = Math.abs(entryPrice - stopLoss);
  const riskPercentage = ((riskPerShare / entryPrice) * 100).toFixed(2);

  // Calculate reward to first target
  const firstTarget = targets[0] || 0;
  const rewardPerShare = Math.abs(firstTarget - entryPrice);
  const rrRatio = rewardPerShare / riskPerShare;

  const prompt = `Create a trading strategy for ${analysis.ticker} based on this AI analysis:

**Market Context:**
- Overall Bias: ${regime.overall_bias.toUpperCase()}
- SPY: ${regime.spy_trend} (${regime.spy_vwap_position} VWAP)
- QQQ: ${regime.qqq_trend} (${regime.qqq_relative_strength})
- VIX: ${regime.vix_level} (${regime.vix_status})
- Note: ${regime.regime_note}

**Trade Setup:**
- Type: ${analysis.setup_type.toUpperCase()}
- Confidence: ${analysis.confidence}/10
- Patterns: ${patternsList}
- Risk/Reward: ${rrRatio.toFixed(2)}:1 (${analysis.risk_reward?.quality || 'N/A'} quality)

**Key Levels:**
${analysis.key_levels ? `
- VWAP: $${analysis.key_levels.vwap}
- EMA 9: $${analysis.key_levels.ema_9}
- EMA 20: $${analysis.key_levels.ema_20}
- EMA 50: $${analysis.key_levels.ema_50}
- Support: ${analysis.key_levels.support.slice(0, 3).map(s => `$${s}`).join(', ')}
- Resistance: ${analysis.key_levels.resistance.slice(0, 3).map(r => `$${r}`).join(', ')}
` : 'N/A'}

**Trade Parameters:**
- Entry Zone: $${entryZoneLower.toFixed(2)} - $${entryZoneHigher.toFixed(2)} (centered at $${entryPrice.toFixed(2)})
- Stop Loss: $${stopLoss.toFixed(2)} (${riskPercentage}% risk)
- Targets: ${targets.map(t => `$${t}`).join(' → ')}
- Invalidation: ${analysis.trade_plan?.invalidation_condition || 'N/A'}

**AI Reasoning:**
${analysis.reasoning}

**Risk Factors:**
${analysis.counter_argument}

**Request:**
Please create a deterministic strategy YAML for this setup with:
1. Use the entry zone specified above
2. Set stop loss at $${stopLoss.toFixed(2)}
3. Add targets at ${targets.map(t => `$${t}`).join(', ')} with equal fractions
4. Choose appropriate features (RSI, MACD, VWAP, EMAs) based on the patterns identified
5. Set maxRiskPerTrade to $${(riskPerShare * 100).toFixed(0)} (for 100 shares)
6. Use 5-minute timeframe for intraday execution

Make sure the strategy aligns with the ${regime.overall_bias} market bias and respects the invalidation condition.`;

  return {
    prompt,
    metadata: {
      symbol: analysis.ticker,
      side,
      entryPrice,
      stopLoss,
      targets,
      confidence: analysis.confidence,
      patterns: analysis.patterns,
      marketRegime: regime.overall_bias,
    },
  };
}

/**
 * Generate a quick summary of the analysis for display
 */
export function getAnalysisSummary(analysis: TradeCheckAnalysis): string {
  const entryPrice = analysis.trade_plan?.entry || 'N/A';
  const stopLoss = analysis.trade_plan?.stop_loss || 'N/A';
  const targets = analysis.trade_plan?.targets || [];
  const rrRatio = analysis.risk_reward?.ratio || 'N/A';

  return `${analysis.setup_type.toUpperCase()} ${analysis.ticker} @ $${entryPrice} | SL: $${stopLoss} | Targets: ${targets.map(t => `$${t}`).join(', ')} | ${rrRatio}:1 R:R | ${analysis.confidence}/10 confidence`;
}

/**
 * Validate if analysis is suitable for strategy creation
 */
export function validateAnalysis(analysis: TradeCheckAnalysis): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (analysis.setup_type === 'no_trade') {
    errors.push('Analysis recommends NO TRADE - not suitable for strategy creation');
  }

  if (!analysis.trade_plan) {
    errors.push('Missing trade plan (entry, stop loss, targets)');
  }

  if (analysis.confidence < 5) {
    errors.push(`Low confidence score (${analysis.confidence}/10) - consider skipping this setup`);
  }

  if (analysis.risk_reward?.quality === 'low') {
    errors.push('Low risk/reward quality - R:R ratio below 2:1');
  }

  if (!analysis.trade_plan?.entry || !analysis.trade_plan?.stop_loss) {
    errors.push('Missing entry price or stop loss');
  }

  if (!analysis.trade_plan?.targets || analysis.trade_plan.targets.length === 0) {
    errors.push('No profit targets specified');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get suggested position size based on risk parameters
 */
export function suggestPositionSize(
  analysis: TradeCheckAnalysis,
  accountSize: number,
  riskPercentage: number = 1.0 // Default 1% risk per trade
): {
  shares: number;
  dollarRisk: number;
  notionalValue: number;
} {
  const entryPrice = parseFloat(analysis.trade_plan?.entry || '0');
  const stopLoss = parseFloat(analysis.trade_plan?.stop_loss || '0');
  const riskPerShare = Math.abs(entryPrice - stopLoss);

  if (riskPerShare === 0) {
    return { shares: 0, dollarRisk: 0, notionalValue: 0 };
  }

  const maxDollarRisk = accountSize * (riskPercentage / 100);
  const shares = Math.floor(maxDollarRisk / riskPerShare);
  const actualDollarRisk = shares * riskPerShare;
  const notionalValue = shares * entryPrice;

  return {
    shares,
    dollarRisk: actualDollarRisk,
    notionalValue,
  };
}
