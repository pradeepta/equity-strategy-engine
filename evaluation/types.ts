/**
 * Evaluation Types for Strategy Re-evaluation System
 * Defines request/response protocol for WebSocket evaluation endpoint
 */

import { Bar, StrategyState } from '../spec/types';

/**
 * Portfolio snapshot from TWS for evaluation context
 */
export interface PortfolioSnapshot {
  timestamp: number;
  accountId: string;
  totalValue: number;
  cash: number;
  buyingPower: number;
  unrealizedPnL: number;
  realizedPnL: number;
  positions: Array<{
    symbol: string;
    quantity: number;
    avgCost: number;
    currentPrice: number;
    unrealizedPnL: number;
    marketValue: number;
  }>;
}

/**
 * Request sent to evaluation endpoint for strategy assessment
 */
export interface EvaluationRequest {
  timestamp: number;
  portfolio: PortfolioSnapshot;
  currentStrategy: {
    symbol: string;
    name: string;
    timeframe: string;
    state: string;
    yamlContent: string;
  };
  marketData: {
    symbol: string;
    currentBar: Bar;
    recentBars: Bar[];  // Last 20 bars for context
  };
  performance: {
    barsActive: number;  // Total bars processed (including historical replay)
    barsActiveSinceActivation: number;  // Bars processed after activation timestamp
    ordersPlaced: number;
    currentState: StrategyState;
    activatedAt: Date;  // When strategy was activated (for real-time calculation)
  };
}

/**
 * Response from evaluation endpoint with recommendation
 */
export interface EvaluationResponse {
  timestamp: number;
  symbol: string;
  recommendation: 'keep' | 'swap' | 'close';
  confidence: number;  // 0-1
  reason: string;
  suggestedStrategy?: {
    yamlContent: string;
    name: string;
    reasoning: string;
  };
}
