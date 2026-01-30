/**
 * Visualization Event Types for Real-Time Strategy Monitoring
 *
 * These events are emitted by the strategy engine and streamed to the frontend
 * for real-time visualization of strategy execution.
 */

export interface BarProcessedEvent {
  type: 'bar_processed';
  timestamp: string;
  strategyId: string;
  symbol: string;
  bar: {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  state: string;
  stateBarCount: number;
  positionSize: number;
  openOrderCount: number;
  replayMode: boolean;
}

export interface RuleEvaluationEvent {
  type: 'rule_evaluation';
  timestamp: string;
  strategyId: string;
  symbol: string;
  ruleName: string; // 'arm', 'trigger', 'disarm', 'invalidate', 'rearm'
  expression: string;
  result: boolean;
  features: Record<string, number | boolean>; // Feature values used in expression
  fromState: string;
  toState: string;
}

export interface StateTransitionEvent {
  type: 'state_transition';
  timestamp: string;
  strategyId: string;
  symbol: string;
  fromState: string;
  toState: string;
  reason: string; // Human-readable reason
  triggeredByRule: string;
}

export interface EntryZoneEvent {
  type: 'entry_zone';
  timestamp: string;
  strategyId: string;
  symbol: string;
  side: 'buy' | 'sell';
  zoneMin: number;
  zoneMax: number;
  targetEntryPrice: number;
  currentPrice: number;
  status: 'waiting' | 'active' | 'filled' | 'invalidated';
}

export interface OrderPlanEvent {
  type: 'order_plan';
  timestamp: string;
  strategyId: string;
  symbol: string;
  planId: string;
  side: 'buy' | 'sell';
  qty: number;
  entryZone: [number, number];
  targetEntryPrice: number;
  stopPrice: number;
  targets: Array<{ price: number; ratio: number }>;
  status: 'pending' | 'submitted' | 'filled' | 'cancelled';
}

export interface FeatureComputeEvent {
  type: 'feature_compute';
  timestamp: string;
  strategyId: string;
  symbol: string;
  features: Record<string, number | boolean>;
  indicators: Array<{
    name: string;
    value: number | boolean;
    historicalValues?: number[]; // Last 5 values for trend visualization
  }>;
}

export interface OrderSubmissionEvent {
  type: 'order_submission';
  timestamp: string;
  strategyId: string;
  symbol: string;
  planId: string;
  ordersSubmitted: number;
  orderIds: string[];
  status: 'success' | 'failed';
  error?: string;
}

export interface OrderFillEvent {
  type: 'order_fill';
  timestamp: string;
  strategyId: string;
  symbol: string;
  orderId: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  orderType: 'entry' | 'take_profit' | 'stop_loss';
}

export type VisualizationEvent =
  | BarProcessedEvent
  | RuleEvaluationEvent
  | StateTransitionEvent
  | EntryZoneEvent
  | OrderPlanEvent
  | FeatureComputeEvent
  | OrderSubmissionEvent
  | OrderFillEvent;

/**
 * Snapshot of current strategy state for chart rendering
 */
export interface StrategySnapshot {
  strategyId: string;
  symbol: string;
  timeframe: string;
  state: string;
  stateBarCount: number;
  positionSize: number;
  openOrders: Array<{
    id: string;
    side: 'buy' | 'sell';
    qty: number;
    type: string;
    limitPrice?: number;
    stopPrice?: number;
  }>;
  currentBar: {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null;
  entryZone: {
    side: 'buy' | 'sell';
    min: number;
    max: number;
    target: number;
    status: 'waiting' | 'active' | 'filled';
  } | null;
  stopLoss: number | null;
  targets: Array<{ price: number; ratio: number }>;
  features: Record<string, number | boolean>;
  recentBars: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}
