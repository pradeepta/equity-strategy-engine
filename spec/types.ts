/**
 * Core types for the Trading Strategy DSL
 */

// ============================================================================
// Bar Data
// ============================================================================
export interface Bar {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ============================================================================
// Feature System
// ============================================================================
export type FeatureValue = number | boolean;

export interface FeatureDescriptor {
  name: string;
  type: 'builtin' | 'indicator' | 'microstructure';
  /** For builtins: 'open' | 'high' | 'low' | 'close' | 'volume' | 'price' */
  builtinName?: string;
  /** For indicators/microstructure: calculation function */
  compute?: (ctx: FeatureComputeContext) => FeatureValue;
  /** Dependencies: other features needed to compute this one */
  dependencies?: string[];
}

export interface FeatureComputeContext {
  bar: Bar;
  history: Bar[];
  features: Map<string, FeatureValue>;
  now: number;
}

// ============================================================================
// Expression AST & Evaluation
// ============================================================================
export type Operator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '&&'
  | '||'
  | '!';

export interface ExprNode {
  type: 'binary' | 'unary' | 'call' | 'literal' | 'identifier';
  operator?: Operator;
  left?: ExprNode;
  right?: ExprNode;
  argument?: ExprNode;
  callee?: string;
  arguments?: ExprNode[];
  value?: number | boolean | string;
  name?: string;
}

export interface EvaluationContext {
  features: Map<string, FeatureValue>;
  builtins: Map<string, FeatureValue>;
  functions: Map<string, (args: FeatureValue[]) => FeatureValue>;
}

// ============================================================================
// Orders & Execution
// ============================================================================
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type OrderStatus =
  | 'pending'
  | 'submitted'
  | 'filled'
  | 'partially_filled'
  | 'cancelled'
  | 'rejected';

export interface Order {
  id: string;
  planId: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  status: OrderStatus;
  filledQty?: number;
}

export interface OrderPlan {
  id: string;
  name: string;
  symbol: string;
  side: OrderSide;
  targetEntryPrice: number;
  /** Entry zone: [min, max] */
  entryZone: [number, number];
  /** Qty for full position */
  qty: number;
  /** Stop loss price (hardstop) */
  stopPrice: number;
  /** Bracket targets: each {price, qty} represents a partial exit (% of position) */
  brackets: Array<{ price: number; ratioOfPosition: number }>;
  /** For split bracket: emit N orders, each with qty=qty*ratio */
  type: 'single' | 'split_bracket';
}

// ============================================================================
// State Machine
// ============================================================================
export type StrategyState =
  | 'IDLE'
  | 'ARMED'
  | 'PLACED'
  | 'MANAGING'
  | 'EXITED';

export interface StateTransition {
  from: StrategyState;
  to: StrategyState;
  when: ExprNode; // Condition to trigger transition
  actions: Action[];
}

export type ActionType =
  | 'start_timer'
  | 'submit_order_plan'
  | 'cancel_entries'
  | 'log'
  | 'noop';

export interface Action {
  type: ActionType;
  planId?: string; // For submit_order_plan
  barCount?: number; // For start_timer
  message?: string; // For log
}

// ============================================================================
// Compiled IR
// ============================================================================
export interface CompiledIR {
  symbol: string;
  timeframe: string;
  initialState: StrategyState;

  // Feature computation plan (topologically sorted)
  featurePlan: FeatureDescriptor[];

  // State transitions
  transitions: StateTransition[];

  // Order templates
  orderPlans: OrderPlan[];

  // Execution config
  execution: {
    entryTimeoutBars: number;
    rthOnly: boolean;
  };

  // Risk config
  risk: {
    maxRiskPerTrade: number;
  };

  // For debugging: source DSL
  dslSource?: string;
}

// ============================================================================
// Runtime State
// ============================================================================
export interface StrategyRuntimeState {
  symbol: string;
  currentState: StrategyState;
  barCount: number;
  currentBar: Bar | null;
  features: Map<string, FeatureValue>;
  openOrders: Order[];
  timers: Map<string, number>; // timerName -> barCountRemaining
  log: RuntimeLog[];
}

export interface RuntimeLog {
  timestamp: number;
  barNum: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// Broker Adapter
// ============================================================================

/**
 * Result of order cancellation operation
 * Tracks which orders were successfully cancelled and which failed
 */
export interface CancellationResult {
  /** Order IDs that were successfully cancelled */
  succeeded: string[];
  /** Orders that failed to cancel with error reasons */
  failed: Array<{
    orderId: string;
    reason: string;
  }>;
}

export interface BrokerAdapter {
  submitOrderPlan(plan: OrderPlan, env: BrokerEnvironment): Promise<Order[]>;
  submitMarketOrder(
    symbol: string,
    qty: number,
    side: OrderSide,
    env: BrokerEnvironment
  ): Promise<Order>;
  cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<CancellationResult>;
  getOpenOrders(symbol: string, env: BrokerEnvironment): Promise<Order[]>;
}

export interface BrokerEnvironment {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  accountId?: string;
  dryRun?: boolean;
  mcpClient?: unknown; // For MCP adapter
  allowLiveOrders?: boolean;
  allowCancelEntries?: boolean;
  maxOrdersPerSymbol?: number;
  maxOrderQty?: number;
  maxNotionalPerSymbol?: number;
  dailyLossLimit?: number;
  currentDailyPnL?: number;
}
