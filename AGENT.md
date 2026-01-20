# Agent Architecture Guide

This document provides a comprehensive overview of all services, their responsibilities, and interactions within the Trading Strategy DSL System. Use this guide to understand the system architecture at a deep level.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Core Services](#core-services)
3. [Compilation & Runtime](#compilation--runtime)
4. [Broker Integration](#broker-integration)
5. [Database Layer](#database-layer)
6. [Infrastructure Services](#infrastructure-services)
7. [AI Integration](#ai-integration)
8. [API Servers](#api-servers)
9. [Web Dashboard](#9-web-dashboard)
10. [CLI Tools](#cli-tools)
11. [Data Flow Diagrams](#data-flow-diagrams)
12. [Service Dependencies](#service-dependencies)

---

## System Overview

### Purpose

Production-ready algorithmic trading system enabling:

- YAML-based strategy definition with 30+ technical indicators
- Type-safe compilation to intermediate representation (IR)
- Multi-strategy concurrent execution (N strategies simultaneously)
- Live order placement via Interactive Brokers TWS or Alpaca
- AI-powered strategy evaluation and hot-swapping
- Full audit trail with PostgreSQL persistence

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Application Layer                           │
│  ├─ LiveTradingOrchestrator (main entry point)         │
│  ├─ MCP Server (AI integration)                        │
│  ├─ Portfolio API Server (dashboard metrics)           │
│  └─ AI Gateway Live (WebSocket for AI agents)          │
├─────────────────────────────────────────────────────────┤
│              Business Logic Layer                        │
│  ├─ MultiStrategyManager (manages N strategies)        │
│  ├─ StrategyLifecycleManager (evaluation, swapping)    │
│  ├─ DatabasePoller (detects new strategies)            │
│  └─ StrategyInstance (single strategy runtime)         │
├─────────────────────────────────────────────────────────┤
│              Compilation & Runtime                       │
│  ├─ StrategyCompiler (YAML → IR)                       │
│  ├─ StrategyEngine (FSM-based execution)               │
│  ├─ FeatureRegistry (30+ technical indicators)         │
│  └─ StrategyEvaluatorClient (evaluation service)       │
├─────────────────────────────────────────────────────────┤
│              Infrastructure Services                     │
│  ├─ Broker Adapters (TWS, Alpaca)                      │
│  ├─ Data Fetchers (Market data, Portfolio)             │
│  ├─ DistributedLockService                             │
│  ├─ OperationQueueService (retry logic)                │
│  ├─ BrokerReconciliationService                        │
│  ├─ OrderAlertService                                  │
│  └─ Logger with Winston + Prisma                       │
├─────────────────────────────────────────────────────────┤
│              Data Persistence Layer                      │
│  └─ PostgreSQL with Prisma ORM                          │
│     ├─ Strategies (YAML content, versions, status)     │
│     ├─ Orders (with broker mapping, fills)             │
│     ├─ Executions (lifecycle events)                   │
│     ├─ Evaluations (AI recommendations)                │
│     └─ System Logs (audit trail)                       │
└─────────────────────────────────────────────────────────┘
```

---

## Core Services

### 1. LiveTradingOrchestrator

**File:** [live/LiveTradingOrchestrator.ts](live/LiveTradingOrchestrator.ts)

**Purpose:** Main entry point coordinating all trading system components.

**Responsibilities:**

- Initialize database connection and repositories
- Connect to broker (TWS or Alpaca based on env config)
- Fetch and display initial portfolio snapshot
- Start strategy database poller
- Execute main event loop for strategy processing
- Coordinate MultiStrategyManager with StrategyLifecycleManager
- Periodic broker reconciliation (every 5 minutes)
- Graceful shutdown with order cancellation

**Key Methods:**

```typescript
async start(): Promise<void>
  // Initialize all services, connect to broker, start main loop

async stop(): Promise<void>
  // Cancel all orders, stop polling, close connections

private async mainLoop(): Promise<void>
  // Core processing loop:
  // 1. Sleep based on shortest strategy timeframe
  // 2. Fetch latest bars from broker for active symbols
  // 3. Process bars through MultiStrategyManager
  // 4. Handle strategy swaps via StrategyLifecycleManager

private async reconcileWithBroker(): Promise<void>
  // Periodic consistency check with broker
```

**Dependencies:**

- RepositoryFactory (database access)
- BaseBrokerAdapter (order submission)
- MultiStrategyManager (strategy coordination)
- StrategyLifecycleManager (evaluation/swapping)
- DatabasePoller (strategy loading)
- BrokerReconciliationService (state sync)

**Configuration:**

- `MAX_CONCURRENT_STRATEGIES` - Max strategies running simultaneously
- `STRATEGY_EVAL_ENABLED` - Enable AI evaluation
- `ALLOW_LIVE_ORDERS` - Global kill switch

**Startup Flow:**

```
1. Load environment variables
2. Create RepositoryFactory with DB connection
3. Initialize broker adapter (TWS/Alpaca)
4. Create MultiStrategyManager
5. Create StrategyLifecycleManager
6. Fetch portfolio snapshot
7. Start DatabasePoller
8. Enter mainLoop()
```

---

### 2. MultiStrategyManager

**File:** [live/MultiStrategyManager.ts](live/MultiStrategyManager.ts)

**Purpose:** Manages multiple strategy instances running concurrently.

**Responsibilities:**

- Load strategies from database by ID
- Create and maintain StrategyInstance for each active strategy
- Create dedicated TwsMarketDataClient per symbol
- Distribute market bars to appropriate strategy instances
- Handle strategy removal and swapping
- Track active instances by symbol

**Key Methods:**

```typescript
async loadStrategy(strategyId: number): Promise<void>
  // 1. Fetch strategy YAML from database
  // 2. Compile to IR
  // 3. Create StrategyInstance
  // 4. Create TwsMarketDataClient for symbol
  // 5. Store in instances map

async removeStrategy(symbol: string): Promise<void>
  // 1. Stop market data client
  // 2. Cancel all open orders
  // 3. Remove from instances map

async swapStrategyById(oldStrategyId: number, newStrategyId: number): Promise<void>
  // 1. Find old instance by ID
  // 2. Remove old strategy
  // 3. Load new strategy with same symbol

async processBar(symbol: string, bar: Bar): Promise<void>
  // Distribute bar to strategy instance for processing

getActiveSymbols(): string[]
  // Return list of symbols with active strategies

getActiveStrategies(): StrategyInstance[]
  // Return all strategy instances
```

**Data Structures:**

```typescript
private instances: Map<string, StrategyInstance>
  // symbol → instance

private marketDataClients: Map<string, TwsMarketDataClient>
  // symbol → data client
```

**Strategy Instance Lifecycle:**

```
LOAD → COMPILE → INITIALIZE → ACTIVE → REMOVE
  ↑                                       ↓
  └──────────── SWAP ←──────────────────┘
```

---

### 3. StrategyLifecycleManager

**File:** [live/StrategyLifecycleManager.ts](live/StrategyLifecycleManager.ts)

**Purpose:** Orchestrate strategy evaluation and replacement.

**Responsibilities:**

- Evaluate strategy appropriateness at regular intervals (every N bars)
- Call StrategyEvaluatorClient for AI-powered recommendations
- Cancel open orders from old strategy before swap
- Create new strategy version in database
- Trigger MultiStrategyManager to swap strategies
- Log all swaps to execution history

**Key Methods:**

```typescript
async evaluateStrategy(instance: StrategyInstance): Promise<void>
  // 1. Check if evaluation interval reached
  // 2. Collect state, metrics, portfolio snapshot
  // 3. Call StrategyEvaluatorClient.evaluate()
  // 4. If recommendation is "swap", initiate swap

private async handleSwap(instance: StrategyInstance, newStrategyYAML: string): Promise<void>
  // 1. Acquire distributed lock for symbol
  // 2. Cancel all open orders for symbol
  // 3. Create new strategy version in database
  // 4. Call MultiStrategyManager.swapStrategyById()
  // 5. Process latest bar with new strategy
  // 6. Release distributed lock
  // 7. Log swap event

private async cancelOrders(symbol: string): Promise<void>
  // Cancel all open orders for given symbol
```

**Evaluation Flow:**

```
Every N bars:
  ↓
Collect context (state, metrics, portfolio)
  ↓
StrategyEvaluatorClient.evaluate()
  ↓
If recommendation == "swap":
  ↓
DistributedLockService.acquireLock(symbol)
  ↓
Cancel open orders
  ↓
Create new strategy version in DB
  ↓
MultiStrategyManager.swapStrategyById()
  ↓
Process latest bar with new strategy
  ↓
DistributedLockService.releaseLock(symbol)
```

**Configuration:**

- `STRATEGY_EVAL_ENABLED` - Enable evaluation
- `STRATEGY_EVAL_INTERVAL_BARS` - Bars between evaluations
- `STRATEGY_EVAL_WS_ENDPOINT` - Evaluator service endpoint

---

### 4. DatabasePoller

**File:** [live/DatabasePoller.ts](live/DatabasePoller.ts)

**Purpose:** Detect new/pending strategies from database.

**Responsibilities:**

- Poll database at regular intervals
- Query for strategies with status `PENDING`
- Trigger loading of new strategies via MultiStrategyManager
- Track known strategy IDs to avoid re-processing
- Handle errors and retry

**Key Methods:**

```typescript
start(): void
  // Start polling loop

stop(): void
  // Stop polling

private async detectNewStrategies(): Promise<void>
  // 1. Query DB for PENDING strategies
  // 2. Filter out already-known strategies
  // 3. For each new strategy:
  //    - Call MultiStrategyManager.loadStrategy()
  //    - Update status to ACTIVE
  //    - Add to knownStrategies set
```

**Polling Logic:**

```typescript
while (isRunning) {
  const pending = await strategyRepo.findByStatus('PENDING')
  const newStrategies = pending.filter(s => !knownStrategies.has(s.id))

  for (const strategy of newStrategies) {
    await multiStrategyManager.loadStrategy(strategy.id)
    await strategyRepo.updateStatus(strategy.id, 'ACTIVE')
    knownStrategies.add(strategy.id)
  }

  await sleep(STRATEGY_WATCH_INTERVAL_MS)
}
```

**Configuration:**

- `STRATEGY_WATCH_INTERVAL_MS` - Poll interval (default: 5000ms)

---

### 5. StrategyInstance

**File:** [live/StrategyInstance.ts](live/StrategyInstance.ts)

**Purpose:** Encapsulate single strategy runtime.

**Responsibilities:**

- Compile YAML to IR on initialization
- Manage StrategyEngine lifecycle
- Track bar history for evaluation
- Process bars through engine
- Provide state and performance metrics
- Handle order cancellation

**Key Methods:**

```typescript
async initialize(): Promise<void>
  // 1. Compile YAML using StrategyCompiler
  // 2. Create StrategyEngine with IR
  // 3. Initialize runtime state

async processBar(bar: Bar): Promise<void>
  // 1. Add bar to history
  // 2. Increment bar counter
  // 3. Call engine.processBar()

getState(): RuntimeState
  // Return current engine state

getPerformanceMetrics(): PerformanceMetrics
  // Calculate P&L, Sharpe ratio, drawdown, etc.

async cancelOrders(orderIds: number[]): Promise<void>
  // Request order cancellation via adapter
```

**Data Structures:**

```typescript
class StrategyInstance {
  private strategyId: number
  private symbol: string
  private yamlContent: string
  private compiledIR: CompiledIR | null
  private engine: StrategyEngine | null
  private barHistory: Bar[]
  private barCounter: number
}
```

**Lifecycle:**

```
CREATE → INITIALIZE (compile) → ACTIVE (process bars) → CANCEL → DESTROY
```

---

## Compilation & Runtime

### 6. StrategyCompiler

**File:** [compiler/compile.ts](compiler/compile.ts)

**Purpose:** Convert YAML DSL to type-safe intermediate representation (IR).

**Compilation Stages:**

1. **Parse YAML** to JavaScript object
2. **Validate schema** against [spec/schema.ts](spec/schema.ts)
3. **Validate feature registry** - ensure all features exist
4. **Parse expressions** - convert string expressions to AST
5. **Type-check expressions** - validate types in conditions
6. **Build feature computation plan** - topological sort for dependencies
7. **Build state transitions** - construct FSM
8. **Build order plans** - compile order specifications
9. **Generate IR** - final intermediate representation

**Key Classes:**

```typescript
class StrategyCompiler {
  compileFromYAML(yamlContent: string): CompiledIR
    // Main entry point

  private validateSchema(obj: any): void
    // Validate against YAML schema

  private validateFeatureRegistry(strategy: StrategyDSL): void
    // Ensure all features exist in registry

  private buildFeaturePlan(features: Record<string, FeatureDef>): ComputationPlan
    // Topological sort of feature dependencies

  private buildTransitions(states: Record<string, StateDef>): Record<string, CompiledState>
    // Build FSM transitions

  private buildOrderPlans(strategy: StrategyDSL): Record<string, OrderPlan>
    // Compile order specifications
}

class CompilationError extends Error {
  constructor(message: string, location?: string)
}
```

**Example YAML:**

```yaml
strategy:
  name: "EMA Crossover"
  symbol: "SPY"
  timeframe: "1m"

features:
  ema_fast:
    type: EMA
    args: [close, 9]
  ema_slow:
    type: EMA
    args: [close, 21]

states:
  initial: FLAT

  FLAT:
    transitions:
      - to: LONG
        condition: "ema_fast > ema_slow"
        actions:
          - place_order: long_entry

  LONG:
    transitions:
      - to: FLAT
        condition: "ema_fast < ema_slow"
        actions:
          - cancel_entry: long_entry

orders:
  long_entry:
    side: BUY
    qty: 100
    take_profit_pct: 1.0
    stop_loss_pct: 0.5
```

**Generated IR Structure:**

```typescript
interface CompiledIR {
  strategyName: string
  symbol: string
  timeframe: Timeframe
  features: Record<string, CompiledFeature>
  featurePlan: ComputationPlan
  states: Record<string, CompiledState>
  initialState: string
  orders: Record<string, OrderPlan>
}
```

**Error Handling:**

- Throws `CompilationError` with descriptive messages
- Preserves location information for debugging
- Validates all expressions before runtime

---

### 7. StrategyEngine

**File:** [runtime/engine.ts](runtime/engine.ts)

**Purpose:** Execute strategy as finite state machine (FSM).

**Responsibilities:**

- Maintain runtime state (current state, bar count, features)
- Compute features for each bar
- Evaluate state transitions based on conditions
- Execute actions (place orders, cancel orders)
- Track order fulfillment and state updates

**Key Methods:**

```typescript
processBar(bar: Bar): Promise<void>
  // 1. Update bar history
  // 2. Compute all features
  // 3. Evaluate transitions from current state
  // 4. If transition triggered:
  //    - Execute actions
  //    - Update current state

private computeFeatures(bar: Bar): void
  // Execute feature computation plan in topological order

private evaluateTransitions(): Promise<void>
  // For each transition from current state:
  //   1. Evaluate condition expression
  //   2. If true, execute actions and transition

private executeAction(action: Action): Promise<void>
  // Handle: place_order, cancel_entry, cancel_exit
```

**Runtime State:**

```typescript
interface RuntimeEnv {
  state: {
    currentState: string
    barCount: number
    features: Record<string, number>
    orders: Record<string, Order[]>
  }
  adapter: BaseBrokerAdapter
  logger: Logger
}
```

**Feature Computation:**

- Features are computed in dependency order (topological sort)
- Only features used in current state are recomputed (optimization)
- Builtin features: open, high, low, close, volume, price
- Custom features: EMA, RSI, BB, MACD, SMA, ATR, etc.

**Transition Evaluation:**

```typescript
for (const transition of currentState.transitions) {
  const conditionMet = evaluateExpression(transition.condition, env)

  if (conditionMet) {
    for (const action of transition.actions) {
      await executeAction(action, env)
    }

    env.state.currentState = transition.to
    break  // Only one transition per bar
  }
}
```

---

### 8. FeatureRegistry

**File:** [features/registry.ts](features/registry.ts)

**Purpose:** Central registry of technical indicators and features.

**Available Features (30+):**

**Price Features:**

- `open`, `high`, `low`, `close`, `volume`, `price`

**Moving Averages:**

- `SMA` - Simple Moving Average
- `EMA` - Exponential Moving Average
- `WMA` - Weighted Moving Average
- `DEMA` - Double Exponential Moving Average
- `TEMA` - Triple Exponential Moving Average
- `VWAP` - Volume Weighted Average Price

**Momentum Indicators:**

- `RSI` - Relative Strength Index
- `MACD` - Moving Average Convergence Divergence
- `Stochastic` - Stochastic Oscillator
- `ROC` - Rate of Change
- `MOM` - Momentum

**Volatility Indicators:**

- `ATR` - Average True Range
- `BB` - Bollinger Bands (upper, middle, lower)
- `Keltner` - Keltner Channels
- `DonchianChannel` - Donchian Channels

**Volume Indicators:**

- `OBV` - On Balance Volume
- `AD` - Accumulation/Distribution
- `CMF` - Chaikin Money Flow
- `VROC` - Volume Rate of Change

**Microstructure:**

- `Delta` - Bid-ask delta
- `Absorption` - Volume absorption

**Statistical:**

- `StandardDeviation` - Standard deviation of price
- `Variance` - Price variance
- `ZScore` - Z-score normalization

**Registration Pattern:**

```typescript
interface FeatureDefinition {
  name: string
  computeFn: (args: any[], bars: Bar[]) => number
  requiredArgs: number
  optionalArgs: number
  description: string
}

class FeatureRegistry {
  private features: Map<string, FeatureDefinition> = new Map()

  registerFeature(def: FeatureDefinition): void
    // Add feature to registry

  getFeature(name: string): FeatureDefinition | undefined
    // Retrieve feature definition

  hasFeature(name: string): boolean
    // Check if feature exists
}
```

**Example Feature Implementation:**

```typescript
function computeEMA(args: any[], bars: Bar[]): number {
  const [source, period] = args
  const values = bars.map(b => b[source])

  const multiplier = 2 / (period + 1)
  let ema = values[0]

  for (let i = 1; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema
  }

  return ema
}

registry.registerFeature({
  name: 'EMA',
  computeFn: computeEMA,
  requiredArgs: 2,  // source, period
  optionalArgs: 0,
  description: 'Exponential Moving Average'
})
```

---

## Broker Integration

### 9. BaseBrokerAdapter (Abstract)

**File:** [broker/broker.ts](broker/broker.ts)

**Purpose:** Define uniform interface for all broker implementations.

**Abstract Methods:**

```typescript
abstract class BaseBrokerAdapter {
  abstract submitOrderPlan(plan: OrderPlan, env: RuntimeEnv): Promise<Order[]>
    // Submit bracket order (entry + TP + SL)

  abstract submitMarketOrder(symbol: string, qty: number, side: OrderSide, env: RuntimeEnv): Promise<Order>
    // Submit single market order

  abstract cancelOpenEntries(symbol: string, orders: Order[], env: RuntimeEnv): Promise<CancellationResult>
    // Cancel open orders by symbol

  abstract getOpenOrders(symbol: string, env: RuntimeEnv): Promise<Order[]>
    // Fetch open orders from broker

  abstract connect(): Promise<void>
    // Establish broker connection

  abstract disconnect(): Promise<void>
    // Close broker connection
}
```

**Safety Methods:**

```typescript
protected enforceOrderConstraints(plan: OrderPlan, env: RuntimeEnv): void
  // Check:
  // - Max order quantity
  // - Max notional exposure per symbol
  // - Daily loss limits
  // - Position limits
  // Throws error if violated

protected expandSplitBracket(plan: OrderPlan): Order[]
  // Split bracket order into:
  // 1. Parent (entry)
  // 2. Take profit (TP)
  // 3. Stop loss (SL)
```

**Order Constraints:**

```typescript
const constraints = {
  maxOrderQuantity: 1000,
  maxNotionalPerSymbol: 100000,
  maxDailyLoss: 5000,
  maxPositionSize: 10000
}
```

---

### 10. TwsAdapter (Interactive Brokers)

**File:** [broker/twsAdapter.ts](broker/twsAdapter.ts)

**Purpose:** Connect to TWS/IB Gateway for paper/live trading.

**Capabilities:**

- Socket connection to TWS at 127.0.0.1:7497 (paper) or 7496 (live)
- Bracket order submission (entry + take-profit + stop-loss)
- Order status tracking via callbacks
- Order cancellation with internal-to-broker ID mapping
- Rejection and error handling

**Key Methods:**

```typescript
async connect(): Promise<void>
  // 1. Create socket connection
  // 2. Request next valid order ID
  // 3. Subscribe to order status updates

async submitOrderPlan(plan: OrderPlan, env: RuntimeEnv): Promise<Order[]>
  // 1. Enforce constraints
  // 2. Get next valid order ID from TWS
  // 3. Create parent order (entry)
  // 4. Create TP order (child)
  // 5. Create SL order (child)
  // 6. Submit to TWS
  // 7. Persist to database with ID mapping

async cancelOpenEntries(symbol: string, orders: Order[], env: RuntimeEnv): Promise<CancellationResult>
  // 1. Filter orders by symbol
  // 2. Get broker order IDs
  // 3. Send cancel request to TWS
  // 4. Update database status

private handleOrderStatus(orderId: number, status: string): void
  // Callback from TWS:
  // - Submitted → update DB
  // - Filled → record fill, update P&L
  // - Cancelled → update status
  // - Rejected → log reason
```

**Order Flow:**

```
1. Receive OrderPlan from StrategyEngine
2. enforceOrderConstraints()
3. Get next valid order ID from TWS
4. Create parent order:
   - Order type: MKT or LMT
   - Action: BUY or SELL
   - Quantity: from plan
5. Create TP order:
   - Order type: LMT
   - Action: opposite of parent
   - Limit price: entry + (TP% * entry)
   - ParentId: parent order ID
6. Create SL order:
   - Order type: STP
   - Action: opposite of parent
   - Stop price: entry - (SL% * entry)
   - ParentId: parent order ID
7. Submit all orders to TWS
8. Store in database with mapping:
   - internal_order_id → broker_order_id
```

**Status Tracking:**

```typescript
TWS Status → Internal Status
  Submitted → OPEN
  PreSubmitted → OPEN
  Filled → FILLED
  Cancelled → CANCELLED
  Inactive → REJECTED
```

**Configuration:**

- `TWS_HOST` - TWS host (default: 127.0.0.1)
- `TWS_PORT` - TWS port (7497 paper, 7496 live)
- `TWS_CLIENT_ID` - Client ID (default: 1)

---

### 11. TwsMarketDataClient

**File:** [broker/twsMarketData.ts](broker/twsMarketData.ts)

**Purpose:** Fetch real-time bars from TWS.

**Key Methods:**

```typescript
async fetchLatestBar(symbol: string, timeframe: Timeframe): Promise<Bar | null>
  // 1. Request real-time bars from TWS
  // 2. Wait for bar callback
  // 3. Return bar data

private handleBarUpdate(reqId: number, bar: TwsBar): void
  // Callback from TWS with bar data
```

**Bar Structure:**

```typescript
interface Bar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}
```

**Timeframe Support:**

- `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`

---

### 12. TwsPortfolioClient

**File:** [broker/twsPortfolio.ts](broker/twsPortfolio.ts)

**Purpose:** Fetch portfolio snapshot from TWS.

**Key Methods:**

```typescript
async fetchPortfolio(): Promise<PortfolioSnapshot>
  // 1. Request account summary
  // 2. Request positions
  // 3. Calculate P&L, exposure, cash
  // 4. Return snapshot
```

**Portfolio Structure:**

```typescript
interface PortfolioSnapshot {
  accountValue: number
  cashBalance: number
  positions: Position[]
  totalPnL: number
  totalExposure: number
}

interface Position {
  symbol: string
  quantity: number
  avgCost: number
  currentPrice: number
  unrealizedPnL: number
  realizedPnL: number
}
```

---

## Database Layer

### 13. RepositoryFactory

**File:** [database/RepositoryFactory.ts](database/RepositoryFactory.ts)

**Purpose:** Dependency injection container for repositories.

**Pattern:** Singleton + Factory

**Provided Repositories:**

- `StrategyRepository` - Strategy CRUD and versioning
- `OrderRepository` - Order management and fills
- `ExecutionHistoryRepository` - Lifecycle event logging
- `SystemLogRepository` - Audit logging

**Key Methods:**

```typescript
class RepositoryFactory {
  constructor(databaseUrl: string, poolSize?: number)

  getStrategyRepository(): StrategyRepository
  getOrderRepository(): OrderRepository
  getExecutionHistoryRepository(): ExecutionHistoryRepository
  getSystemLogRepository(): SystemLogRepository

  getPrismaClient(): PrismaClient
  async disconnect(): Promise<void>
}
```

**Connection Management:**

```typescript
const factory = new RepositoryFactory(process.env.DATABASE_URL, 10)
const strategyRepo = factory.getStrategyRepository()
const orderRepo = factory.getOrderRepository()

// Use repositories...

await factory.disconnect()
```

---

### 14. StrategyRepository

**File:** [database/repositories/StrategyRepository.ts](database/repositories/StrategyRepository.ts)

**Purpose:** Manage strategy persistence and versioning.

**Key Methods:**

```typescript
async create(data: StrategyCreateInput): Promise<Strategy>
  // Create new strategy with status PENDING

async findById(id: number): Promise<Strategy | null>
  // Fetch strategy by ID

async findByStatus(status: StrategyStatus): Promise<Strategy[]>
  // Find all strategies with given status

async findByUser(userId: string): Promise<Strategy[]>
  // Find all strategies for user

async update(id: number, data: StrategyUpdateInput): Promise<Strategy>
  // Update strategy (creates new version)

async updateStatus(id: number, status: StrategyStatus): Promise<Strategy>
  // Update strategy status

async createVersion(strategyId: number, yamlContent: string, changeReason: string): Promise<StrategyVersion>
  // Create new version with change tracking

async getVersionHistory(strategyId: number): Promise<StrategyVersion[]>
  // Fetch all versions for strategy

async rollbackToVersion(strategyId: number, versionNumber: number): Promise<Strategy>
  // Restore previous version
```

**Strategy Statuses:**

```typescript
enum StrategyStatus {
  PENDING = 'PENDING',    // Waiting to be loaded
  ACTIVE = 'ACTIVE',      // Currently running
  PAUSED = 'PAUSED',      // Temporarily stopped
  CLOSED = 'CLOSED',      // Permanently stopped
  ERROR = 'ERROR'         // Compilation or runtime error
}
```

---

### 15. OrderRepository

**File:** [database/repositories/OrderRepository.ts](database/repositories/OrderRepository.ts)

**Purpose:** Manage order persistence and broker ID mapping.

**Key Methods:**

```typescript
async create(data: OrderCreateInput): Promise<Order>
  // Create order with broker ID mapping

async findById(id: number): Promise<Order | null>
  // Fetch order by internal ID

async findByBrokerId(brokerId: string): Promise<Order | null>
  // Fetch order by broker ID

async findBySymbol(symbol: string, status?: OrderStatus): Promise<Order[]>
  // Find orders for symbol, optionally filtered by status

async findByStrategy(strategyId: number): Promise<Order[]>
  // Find all orders for strategy

async updateStatus(id: number, status: OrderStatus, fillInfo?: FillInfo): Promise<Order>
  // Update order status, record fill if provided

async recordFill(orderId: number, fill: FillInfo): Promise<OrderFill>
  // Record partial or full fill
```

**Order Statuses:**

```typescript
enum OrderStatus {
  PENDING = 'PENDING',      // Not yet submitted
  OPEN = 'OPEN',            // Submitted to broker
  FILLED = 'FILLED',        // Completely filled
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  CANCELLED = 'CANCELLED',  // User cancelled
  REJECTED = 'REJECTED',    // Broker rejected
  EXPIRED = 'EXPIRED'       // Time-based expiration
}
```

---

### 16. ExecutionHistoryRepository

**File:** [database/repositories/ExecutionHistoryRepository.ts](database/repositories/ExecutionHistoryRepository.ts)

**Purpose:** Log strategy lifecycle events for audit trail.

**Key Methods:**

```typescript
async logEvent(event: ExecutionEventInput): Promise<ExecutionEvent>
  // Log event with metadata

async getEventsByStrategy(strategyId: number): Promise<ExecutionEvent[]>
  // Fetch all events for strategy

async getEventsByType(eventType: ExecutionEventType): Promise<ExecutionEvent[]>
  // Fetch events by type
```

**Event Types:**

```typescript
enum ExecutionEventType {
  STRATEGY_ACTIVATED = 'STRATEGY_ACTIVATED',
  STRATEGY_PAUSED = 'STRATEGY_PAUSED',
  STRATEGY_CLOSED = 'STRATEGY_CLOSED',
  STRATEGY_SWAP = 'STRATEGY_SWAP',
  STRATEGY_EVALUATION = 'STRATEGY_EVALUATION',
  ORDER_SUBMITTED = 'ORDER_SUBMITTED',
  ORDER_FILLED = 'ORDER_FILLED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_REJECTED = 'ORDER_REJECTED',
  RECONCILIATION = 'RECONCILIATION',
  ERROR = 'ERROR'
}
```

---

### 17. Database Schema (Prisma)

**File:** [prisma/schema.prisma](prisma/schema.prisma)

**Key Tables:**

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `users` | User management | id, email, created_at |
| `accounts` | Broker accounts | id, user_id, broker, credentials |
| `strategies` | Strategy definitions | id, user_id, symbol, yaml_content, status |
| `strategy_versions` | Version history | id, strategy_id, version_number, yaml_content, change_reason |
| `strategy_executions` | Lifecycle events | id, strategy_id, event_type, metadata, timestamp |
| `strategy_evaluations` | AI evaluations | id, strategy_id, recommendation, reasoning, metrics |
| `orders` | Order records | id, strategy_id, symbol, side, qty, status, broker_order_id |
| `order_fills` | Fill records | id, order_id, filled_qty, fill_price, timestamp |
| `operation_queue` | Async operations | id, operation_type, payload, status, retry_count |
| `system_logs` | Audit logs | id, level, message, component, metadata, timestamp |

**Relationships:**

```
users 1─────N accounts
users 1─────N strategies
strategies 1─────N strategy_versions
strategies 1─────N strategy_executions
strategies 1─────N strategy_evaluations
strategies 1─────N orders
orders 1─────N order_fills
```

---

## Infrastructure Services

### 18. DistributedLockService

**File:** [live/locking/DistributedLockService.ts](live/locking/DistributedLockService.ts)

**Purpose:** Prevent concurrent strategy swaps on same symbol using PostgreSQL advisory locks.

**Key Methods:**

```typescript
async acquireLock(key: string, timeoutMs: number = 30000): Promise<boolean>
  // Try to acquire lock with timeout
  // Returns true if acquired, false if timeout

async releaseLock(key: string): Promise<void>
  // Release previously acquired lock

async withLock<T>(key: string, callback: () => Promise<T>): Promise<T>
  // Execute callback with lock held, auto-release after
```

**Implementation:**

```typescript
async acquireLock(key: string, timeoutMs: number): Promise<boolean> {
  const lockId = this.hashKey(key)  // Convert string to integer

  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    const result = await this.prisma.$queryRaw`
      SELECT pg_try_advisory_lock(${lockId}) as acquired
    `

    if (result[0].acquired) {
      return true
    }

    await sleep(100)  // Wait 100ms before retry
  }

  return false  // Timeout
}

async releaseLock(key: string): Promise<void> {
  const lockId = this.hashKey(key)

  await this.prisma.$queryRaw`
    SELECT pg_advisory_unlock(${lockId})
  `
}
```

**Usage Example:**

```typescript
const lockService = new DistributedLockService(prisma)

// Manual lock/unlock
const acquired = await lockService.acquireLock('SPY', 30000)
if (acquired) {
  try {
    // Perform swap
  } finally {
    await lockService.releaseLock('SPY')
  }
}

// Or use withLock for automatic cleanup
await lockService.withLock('SPY', async () => {
  // Perform swap
})
```

**Properties:**

- **FIFO fairness** - First request gets lock first
- **Timeout support** - Prevents indefinite waiting
- **Automatic cleanup** - Locks released on connection close

---

### 19. OperationQueueService

**File:** [live/queue/OperationQueueService.ts](live/queue/OperationQueueService.ts)

**Purpose:** Queue operations with retry logic and idempotency.

**Key Methods:**

```typescript
async enqueue(operation: OperationInput): Promise<Operation>
  // Add operation to queue with idempotency key

async processQueue(): Promise<void>
  // Process all PENDING operations

async processOperation(operationId: number): Promise<void>
  // Execute single operation with retry logic

async getStatus(operationId: number): Promise<OperationStatus>
  // Check operation status
```

**Operation Structure:**

```typescript
interface Operation {
  id: number
  operationId: string  // Idempotency key
  operationType: string
  payload: any
  status: OperationStatus
  retryCount: number
  maxRetries: number
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

enum OperationStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED'
}
```

**Retry Logic:**

```typescript
async processOperation(operationId: number): Promise<void> {
  const operation = await this.operationRepo.findById(operationId)

  if (operation.status !== 'PENDING') return

  await this.operationRepo.updateStatus(operationId, 'PROCESSING')

  try {
    await this.executeOperation(operation)
    await this.operationRepo.updateStatus(operationId, 'COMPLETED')
  } catch (error) {
    if (operation.retryCount < operation.maxRetries) {
      await this.operationRepo.incrementRetry(operationId, error.message)
      await this.operationRepo.updateStatus(operationId, 'PENDING')
    } else {
      await this.operationRepo.updateStatus(operationId, 'FAILED')
    }
  }
}
```

**Idempotency:**

- Operations have unique `operationId`
- Duplicate submissions return existing operation
- Prevents duplicate processing

---

### 20. BrokerReconciliationService

**File:** [live/reconciliation/BrokerReconciliationService.ts](live/reconciliation/BrokerReconciliationService.ts)

**Purpose:** Detect and fix state mismatches between database and broker.

**Key Methods:**

```typescript
async reconcile(symbol?: string): Promise<ReconciliationReport>
  // Compare DB orders with broker orders
  // Fix discrepancies
  // Return report

private async detectOrphanedOrders(symbol: string): Promise<Order[]>
  // Find orders at broker but not in DB

private async detectMissingOrders(symbol: string): Promise<Order[]>
  // Find orders in DB but not at broker

private async detectStatusMismatches(symbol: string): Promise<Order[]>
  // Find orders with status mismatch

private async cancelOrphanedOrder(order: Order): Promise<void>
  // Cancel orphaned order at broker

private async updateMissingOrder(order: Order): Promise<void>
  // Update DB to reflect broker reality
```

**Reconciliation Flow:**

```
1. Fetch open orders from broker
2. Fetch open orders from database
3. Compare order sets:

   Orphaned orders (at broker, not in DB):
   - Auto-cancel at broker
   - Log event

   Missing orders (in DB, not at broker):
   - Update DB status to CANCELLED or FILLED
   - Log event

   Status mismatches:
   - Update DB to match broker
   - Log event

4. Generate reconciliation report
5. Log report to execution history
```

**Report Structure:**

```typescript
interface ReconciliationReport {
  timestamp: Date
  symbol: string | null
  orphanedOrders: number
  missingOrders: number
  statusMismatches: number
  actionsTaken: ReconciliationAction[]
}

interface ReconciliationAction {
  action: 'CANCEL' | 'UPDATE_STATUS' | 'NO_ACTION'
  orderId: number
  reason: string
}
```

**Trigger:**

- Periodic (every 5 minutes in LiveTradingOrchestrator)
- On-demand via API
- After strategy swap

---

### 21. OrderAlertService

**File:** [live/alerts/OrderAlertService.ts](live/alerts/OrderAlertService.ts)

**Purpose:** Notify about order events.

**Key Methods:**

```typescript
notifyOrderFilled(order: Order, fill: OrderFill): void
  // Alert on order fill

notifyOrderRejected(order: Order, reason: string): void
  // Alert on rejection

notifyOrderCancelled(order: Order): void
  // Alert on cancellation

notifyReconciliation(report: ReconciliationReport): void
  // Alert on reconciliation events
```

**Alert Channels:**

- Console logging
- Database logging
- Email (configurable)
- Slack/Discord webhook (configurable)
- SMS (configurable)

**Configuration:**

```typescript
interface AlertConfig {
  enableConsole: boolean
  enableDatabase: boolean
  enableEmail: boolean
  emailRecipients: string[]
  enableWebhook: boolean
  webhookUrl: string
}
```

---

### 22. Logger Service

**File:** [logging/logger.ts](logging/logger.ts)

**Purpose:** Centralized logging with multiple transports.

**Features:**

- **Console transport** - Colored output for development
- **Prisma transport** - Database logging for audit trail
- **Component tagging** - Track which component logged
- **Structured metadata** - Attach context to logs
- **Multiple levels** - error, warn, info, debug

**Usage:**

```typescript
import { logger } from './logging/logger'

logger.info('[ComponentName] Message', { metadata: 'value' })
logger.error('[ComponentName] Error occurred', { error: err.message, stack: err.stack })
logger.debug('[ComponentName] Debug info', { state: 'details' })
```

**Configuration:**

```typescript
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new PrismaTransport({
      prisma: prismaClient,
      level: 'info'
    })
  ]
})
```

**Prisma Transport:**

- Logs to `system_logs` table
- Preserves structure for querying
- Immutable audit trail

---

## AI Integration

### 23. StrategyEvaluatorClient

**File:** [evaluation/StrategyEvaluatorClient.ts](evaluation/StrategyEvaluatorClient.ts)

**Purpose:** Request AI-powered strategy evaluations.

**Modes:**

1. **Stub mode** (default) - Returns deterministic recommendations for testing
2. **WebSocket mode** - Connects to remote evaluation service

**Key Methods:**

```typescript
async evaluate(request: EvaluationRequest): Promise<EvaluationResponse>
  // Request strategy evaluation
  // Returns recommendation and reasoning

async connect(): Promise<void>
  // Connect to evaluation service (WebSocket mode)

async disconnect(): Promise<void>
  // Disconnect from service
```

**Evaluation Request:**

```typescript
interface EvaluationRequest {
  strategyId: number
  symbol: string
  currentStrategy: {
    yaml: string
    state: RuntimeState
    metrics: PerformanceMetrics
  }
  portfolio: PortfolioSnapshot
  barHistory: Bar[]
  context: {
    timeInMarket: number  // minutes
    barsProcessed: number
    lastSwapTime: number | null
  }
}
```

**Evaluation Response:**

```typescript
interface EvaluationResponse {
  recommendation: 'keep' | 'swap'
  reasoning: string
  confidence: number  // 0-1
  suggestedStrategy?: string  // YAML if swap recommended
  metrics: {
    performanceScore: number
    riskScore: number
    adaptabilityScore: number
  }
}
```

**Stub Mode Behavior:**

- Returns `keep` for strategies with positive P&L
- Returns `swap` for strategies with > 5% drawdown
- Provides mock reasoning

**WebSocket Mode:**

- Connects to remote AI service
- Sends JSON-RPC requests
- Receives recommendations from AI agent

**Configuration:**

- `STRATEGY_EVAL_ENABLED` - Enable evaluations
- `STRATEGY_EVAL_WS_ENDPOINT` - WebSocket URL for remote service

---

### 24. AI Gateway Live

**Directory:** [ai-gateway-live/](ai-gateway-live/)

**Purpose:** WebSocket server for live AI agent sessions.

**Components:**

- `src/index.ts` - Main server entry point
- `src/wsHandler.ts` - WebSocket connection handler
- `src/agentHandler.ts` - Agent spawning and communication
- `src/sessionManager.ts` - Session state management
- `src/config.ts` - Configuration

**Features:**

- **Session management** - Create, restore, disconnect sessions
- **Reconnection support** - Resume sessions after disconnect
- **MCP integration** - Exposes trading tools to AI agents
- **JSON-RPC messaging** - Standard protocol
- **Agent spawning** - Launch AI agents on demand

**WebSocket Protocol:**

```json
// Client → Server: Create session
{
  "type": "create_session",
  "payload": {
    "userId": "user123",
    "strategyId": 456
  }
}

// Server → Client: Session created
{
  "type": "session_created",
  "payload": {
    "sessionId": "sess_abc123",
    "status": "active"
  }
}

// Client → Server: Send message to agent
{
  "type": "message",
  "payload": {
    "sessionId": "sess_abc123",
    "content": "Evaluate current strategy"
  }
}

// Server → Client: Agent response
{
  "type": "agent_response",
  "payload": {
    "sessionId": "sess_abc123",
    "content": "Strategy evaluation complete..."
  }
}
```

**Port:** 8080 (configurable)

---

## API Servers

### 25. Portfolio API Server

**File:** [portfolio-api-server.ts](portfolio-api-server.ts)

**Purpose:** HTTP API for web dashboard.

**Endpoints:**

**GET /portfolio**

- Fetch portfolio P&L breakdown
- Returns: `PortfolioSnapshot`

**GET /strategies**

- List active strategies with metrics
- Query params: `status`, `userId`
- Returns: `Strategy[]`

**GET /orders**

- List recent orders
- Query params: `symbol`, `status`, `strategyId`, `limit`
- Returns: `Order[]`

**GET /performance**

- Get performance metrics
- Query params: `strategyId`, `timeframe`
- Returns: `PerformanceMetrics`

**GET /logs**

- Fetch system logs
- Query params: `level`, `component`, `limit`, `offset`
- Returns: `SystemLog[]`

**Implementation:**

```typescript
import express from 'express'
import { RepositoryFactory } from './database/RepositoryFactory'

const app = express()
const factory = new RepositoryFactory(process.env.DATABASE_URL)

app.get('/portfolio', async (req, res) => {
  const snapshot = await portfolioClient.fetchPortfolio()
  res.json(snapshot)
})

app.get('/strategies', async (req, res) => {
  const { status, userId } = req.query
  const repo = factory.getStrategyRepository()

  let strategies = userId
    ? await repo.findByUser(userId)
    : await repo.findAll()

  if (status) {
    strategies = strategies.filter(s => s.status === status)
  }

  res.json(strategies)
})

app.listen(process.env.PORTFOLIO_API_PORT || 3002)
```

**Port:** 3002 (configurable via `PORTFOLIO_API_PORT`)

**CORS:** Enabled for web dashboard

---

### 26. MCP Server (HTTP/SSE)

**File:** [mcp-server-http.ts](mcp-server-http.ts)

**Purpose:** HTTP/SSE transport for MCP tools (alternative to stdio).

**Endpoints:**

**POST /mcp**

- Execute MCP tool
- Body: JSON-RPC request
- Returns: JSON-RPC response

**GET /mcp/sse**

- Server-Sent Events stream for tool outputs
- Returns: SSE stream

**Available MCP Tools:**

- `compile_strategy` - Compile YAML to IR
- `validate_strategy` - Validate YAML schema
- `backtest_strategy` - Run strategy against historical data
- `get_available_features` - List available indicators
- `add_strategy_to_db` - Save strategy to database
- `get_dsl_schema` - Get YAML schema documentation
- `list_strategies` - List strategies by status
- `close_strategy` - Close active strategy

**Usage Example:**

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "compile_strategy",
    "params": {
      "yaml": "strategy:\n  name: Test\n  ..."
    },
    "id": 1
  }'
```

**Port:** 3001 (configurable)

---

## 9. Web Dashboard

### Overview

The web-client is a Next.js 14 single-page application serving as the primary user interface for the trading system.

**File:** [web-client/app/page.tsx](web-client/app/page.tsx)

**Purpose:** Unified dashboard providing:

- Real-time portfolio monitoring and strategy management
- AI-powered advisor chat interface
- Comprehensive audit trail and system logging
- Strategy performance analytics

**Technology Stack:**

- **Framework:** Next.js 14.2.8 with App Router
- **UI Library:** React 18.3.1
- **Language:** TypeScript 5.3.3
- **Styling:** Custom CSS (1015 lines, no framework)
- **Markdown:** React Markdown 9.0.1

**Port:** 3000 (default Next.js)

---

### Architecture

**Component Structure:**

```
HomePage (app/page.tsx - 1143 lines)
  ├── Tab Navigation System
  │   ├── Chat Tab
  │   ├── Dashboard Tab
  │   ├── Audit Logs Tab
  │   └── System Logs Tab
  │
  ├── WebSocket Client (AcpClient)
  │   └── Real-time agent communication
  │
  └── HTTP Polling (Portfolio API)
      └── Dashboard data updates
```

**Service Integration:**

```
Web Client
  ├─ Portfolio API Server (HTTP)
  │   ├─ GET /api/portfolio/overview
  │   ├─ POST /api/portfolio/strategies/:id/close
  │   ├─ GET /api/logs
  │   └─ GET /api/logs/stats
  │
  ├─ ACP Gateway (WebSocket)
  │   ├─ Session management
  │   ├─ Message streaming
  │   └─ JSON-RPC 2.0 protocol
  │
  └─ MCP Server (HTTP)
      └─ Tool invocation for agent
```

---

### Core Components

#### 1. Main Dashboard Component

**File:** [web-client/app/page.tsx](web-client/app/page.tsx)

**State Management:**

```typescript
// Chat state
const [messages, setMessages] = useState<Message[]>([])
const [input, setInput] = useState('')
const [status, setStatus] = useState<'idle' | 'thinking' | 'error'>('idle')
const [sessionId, setSessionId] = useState<string | null>(null)
const [attachedImages, setAttachedImages] = useState<File[]>([])

// UI state
const [activeTab, setActiveTab] = useState('chat')
const [showScrollButton, setShowScrollButton] = useState(false)
const [isDragging, setIsDragging] = useState(false)

// Dashboard state
const [portfolioData, setPortfolioData] = useState(null)
const [loading, setLoading] = useState(true)
const [error, setError] = useState(null)
const [notification, setNotification] = useState(null)
const [selectedStrategy, setSelectedStrategy] = useState(null)
const [showModal, setShowModal] = useState(false)

// Filter state
const [symbolFilter, setSymbolFilter] = useState('')
const [statusFilter, setStatusFilter] = useState('all')
```

**Tab System:**

```typescript
const tabs = [
  { id: 'chat', name: 'Chat', icon: '💬' },
  { id: 'dashboard', name: 'Dashboard', icon: '📊' },
  { id: 'audit', name: 'Audit Logs', icon: '📋' },
  { id: 'logs', name: 'System Logs', icon: '🔍' }
]
```

**Data Fetching Pattern:**

```typescript
// Portfolio data (10s polling)
useEffect(() => {
  const fetchData = async () => {
    const response = await fetch('http://localhost:3002/api/portfolio/overview')
    const data = await response.json()
    setPortfolioData(data)
  }

  fetchData()
  const interval = setInterval(fetchData, 10000)
  return () => clearInterval(interval)
}, [])
```

---

#### 2. Chat Interface

**Purpose:** Real-time conversation with AI advisor (Claude via ACP protocol)

**Key Features:**

- Message streaming with chunk merging
- Image attachment via drag-and-drop or file picker
- Auto-scrolling with manual override
- Session persistence via localStorage
- Markdown rendering for responses
- Keyboard shortcuts

**Message Flow:**

```
User Input
  ↓
AcpClient.sendMessage()
  ↓
WebSocket → ACP Gateway (port 8787)
  ↓
Claude Agent Processing
  ↓
Streaming Response (chunks)
  ↓
Message State Update
  ↓
UI Render (React Markdown)
```

**Implementation Details:**

```typescript
const handleSend = async () => {
  if (!input.trim() && attachedImages.length === 0) return

  const userMessage = {
    role: 'user',
    content: input,
    images: attachedImages
  }

  setMessages(prev => [...prev, userMessage])
  setInput('')
  setAttachedImages([])
  setStatus('thinking')

  try {
    const sessionIdToUse = sessionId || await acpClient.createSession()
    setSessionId(sessionIdToUse)

    await acpClient.sendMessage(sessionIdToUse, input, attachedImages, (chunk) => {
      // Handle streaming chunks
      setMessages(prev => {
        const lastMessage = prev[prev.length - 1]
        if (lastMessage.role === 'assistant' && lastMessage.streaming) {
          return [...prev.slice(0, -1), {
            ...lastMessage,
            content: lastMessage.content + chunk
          }]
        } else {
          return [...prev, {
            role: 'assistant',
            content: chunk,
            streaming: true
          }]
        }
      })
    })

    setStatus('idle')
  } catch (error) {
    setStatus('error')
    setNotification({ type: 'error', message: error.message })
  }
}
```

---

#### 3. Portfolio Dashboard

**Purpose:** Real-time trading metrics and strategy management

**Sections:**

**A. Summary Cards:**

```typescript
<div className="metrics-grid">
  <MetricCard
    title="Realized P&L"
    value={formatCurrency(portfolioData.realizedPnL)}
    trend={portfolioData.realizedPnL >= 0 ? 'up' : 'down'}
  />
  <MetricCard
    title="Open Positions"
    value={portfolioData.positions.length}
  />
  <MetricCard
    title="Active Strategies"
    value={portfolioData.strategies.filter(s => s.status === 'ACTIVE').length}
  />
  <MetricCard
    title="Total Orders"
    value={portfolioData.totalOrders}
  />
</div>
```

**B. Current Positions Table:**

- Symbol, quantity, average cost, current price, P&L, P&L %
- Live updates every 10 seconds
- Sortable columns
- Color-coded P&L (green/red)

**C. Strategy Performance Table:**

- Strategy name, symbol, status, P&L, Sharpe ratio, max drawdown
- Filterable by symbol and status
- Clickable rows open detail modal
- Close strategy action

**D. Recent Trades Table:**

- Timestamp, symbol, side, quantity, price, P&L
- Last 20 trades displayed
- Scrollable container

**E. Strategy Detail Modal:**

```typescript
<Modal show={showModal} onClose={() => setShowModal(false)}>
  <StrategyDetails strategy={selectedStrategy}>
    <MetricsSection>
      - Total P&L
      - Win Rate
      - Sharpe Ratio
      - Max Drawdown
      - Total Trades
      - Average Trade Duration
    </MetricsSection>

    <PerformanceChart>
      - Equity curve
      - Drawdown chart
    </PerformanceChart>

    <OrdersTable>
      - Order history for this strategy
    </OrdersTable>

    <Actions>
      <Button onClick={handleCloseStrategy}>Close Strategy</Button>
    </Actions>
  </StrategyDetails>
</Modal>
```

**Close Strategy Flow:**

```
User clicks "Close Strategy"
  ↓
POST /api/portfolio/strategies/:id/close
  ↓
Portfolio API Server
  ↓
Cancel all open orders
  ↓
Update strategy status to CLOSED
  ↓
Response to web client
  ↓
Show success notification
  ↓
Refresh portfolio data
```

---

#### 4. Audit Logs Viewer

**File:** [web-client/app/components/AuditLogsViewer.tsx](web-client/app/components/AuditLogsViewer.tsx)

**Purpose:** Order audit trail with complete event tracking

**Features:**

- Event filtering (type, symbol, strategy)
- Summary statistics dashboard
- Event breakdown by type
- Detail modal with full context
- Real-time updates

**Event Types:**

```typescript
enum AuditEventType {
  ORDER_SUBMITTED = 'ORDER_SUBMITTED',
  ORDER_FILLED = 'ORDER_FILLED',
  ORDER_PARTIALLY_FILLED = 'ORDER_PARTIALLY_FILLED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_REJECTED = 'ORDER_REJECTED',
  STRATEGY_SWAP = 'STRATEGY_SWAP',
  RECONCILIATION = 'RECONCILIATION'
}
```

**Data Structure:**

```typescript
interface AuditLog {
  id: number
  timestamp: Date
  eventType: AuditEventType
  strategyId: number
  strategyName: string
  symbol: string
  orderId?: number
  details: {
    side?: 'BUY' | 'SELL'
    quantity?: number
    price?: number
    status?: string
    reason?: string
    metadata?: any
  }
}
```

**Statistics Dashboard:**

```typescript
<div className="audit-stats">
  <StatCard label="Total Events" value={auditLogs.length} />
  <StatCard label="Orders Submitted" value={countByType('ORDER_SUBMITTED')} />
  <StatCard label="Orders Filled" value={countByType('ORDER_FILLED')} />
  <StatCard label="Errors" value={countByType('ORDER_REJECTED')} color="red" />
</div>

<EventBreakdown>
  {eventTypes.map(type => (
    <BarChart
      label={type}
      value={countByType(type)}
      percentage={countByType(type) / auditLogs.length * 100}
    />
  ))}
</EventBreakdown>
```

---

#### 5. System Logs Viewer

**File:** [web-client/app/components/LogsViewer.tsx](web-client/app/components/LogsViewer.tsx)

**Purpose:** Application logs with filtering and search

**Features:**

- Multi-level filtering (ERROR, WARN, INFO, DEBUG)
- Component filtering
- Full-text search
- Log statistics
- Recent errors display
- Top components by log count
- Detail modal with metadata and stack traces
- Auto-refresh toggle

**Data Structure:**

```typescript
interface SystemLog {
  id: number
  timestamp: Date
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  message: string
  component: string
  metadata?: any
  stack?: string
}
```

**Filter Implementation:**

```typescript
const filteredLogs = logs.filter(log => {
  // Level filter
  if (levelFilter !== 'all' && log.level !== levelFilter) return false

  // Component filter
  if (componentFilter && log.component !== componentFilter) return false

  // Search filter
  if (searchQuery && !log.message.toLowerCase().includes(searchQuery.toLowerCase())) {
    return false
  }

  return true
})
```

**Statistics Display:**

```typescript
<div className="log-stats">
  <StatCard label="Total Logs" value={logs.length} />
  <StatCard label="Errors" value={errorCount} color="red" />
  <StatCard label="Warnings" value={warnCount} color="amber" />
  <StatCard label="Info" value={infoCount} color="blue" />
  <StatCard label="Debug" value={debugCount} color="gray" />
</div>

<RecentErrors>
  {logs.filter(l => l.level === 'ERROR').slice(0, 5).map(log => (
    <ErrorCard log={log} onClick={() => openDetailModal(log)} />
  ))}
</RecentErrors>

<TopComponents>
  {getTopComponents(10).map(({ component, count }) => (
    <ComponentCard component={component} count={count} />
  ))}
</TopComponents>
```

---

#### 6. ACP Client

**File:** [web-client/src/lib/acpClient.ts](web-client/src/lib/acpClient.ts)

**Purpose:** WebSocket client for Agent Control Protocol communication

**Responsibilities:**

- Establish WebSocket connection to ACP Gateway
- Manage session lifecycle
- Send messages with optional image attachments
- Handle streaming responses
- Persist session ID in localStorage
- Auto-reconnection on disconnect

**Key Methods:**

```typescript
class AcpClient {
  private ws: WebSocket | null = null
  private readonly url: string
  private readonly persona: string

  async createSession(): Promise<string>
    // Create new session with ACP Gateway
    // Returns session ID

  async sendMessage(
    sessionId: string,
    message: string,
    images: File[],
    onChunk: (chunk: string) => void
  ): Promise<void>
    // Send message to agent
    // Handle streaming response via callback

  private connect(): Promise<WebSocket>
    // Establish WebSocket connection
    // Handle connection lifecycle

  private handleMessage(event: MessageEvent): void
    // Parse JSON-RPC messages
    // Route to appropriate handler

  disconnect(): void
    // Close WebSocket connection
}
```

**Session Management:**

```typescript
// Create session
const sessionId = await acpClient.createSession()
localStorage.setItem('acp_session_id', sessionId)

// Restore session
const savedSessionId = localStorage.getItem('acp_session_id')
if (savedSessionId) {
  // Attempt to resume existing session
  await acpClient.sendMessage(savedSessionId, 'ping', [], () => {})
}
```

**Message Protocol (JSON-RPC 2.0):**

```typescript
// Client → Server: Create session
{
  "jsonrpc": "2.0",
  "method": "create_session",
  "params": {
    "persona": "blackrock_advisor",
    "mcpUrl": "http://127.0.0.1:3001/mcp",
    "cwd": "/Users/atulpurohit/workspace/personal/sandbox/"
  },
  "id": 1
}

// Server → Client: Session created
{
  "jsonrpc": "2.0",
  "result": {
    "sessionId": "sess_abc123",
    "gatewaySessionId": "gw_xyz789"
  },
  "id": 1
}

// Client → Server: Send message
{
  "jsonrpc": "2.0",
  "method": "send_message",
  "params": {
    "sessionId": "sess_abc123",
    "content": "What's the current portfolio status?",
    "images": []  // Base64-encoded images if any
  },
  "id": 2
}

// Server → Client: Streaming response
{
  "jsonrpc": "2.0",
  "method": "stream_chunk",
  "params": {
    "sessionId": "sess_abc123",
    "chunk": "The current portfolio has..."
  }
}

// Server → Client: Stream complete
{
  "jsonrpc": "2.0",
  "result": {
    "complete": true
  },
  "id": 2
}
```

---

### Design System

#### Color Palette

**File:** [web-client/app/globals.css](web-client/app/globals.css)

```css
:root {
  /* Primary colors */
  --background: #faf8f5;       /* Warm beige */
  --primary: #f55036;          /* Red-orange */
  --text: #1a1a1a;            /* Near black */
  --text-secondary: #737373;   /* Medium gray */
  --border: #ebe6dd;          /* Light warm gray */

  /* Status colors */
  --success: #10b981;         /* Green */
  --warning: #f59e0b;         /* Amber */
  --error: #ef4444;           /* Red */
  --info: #3b82f6;            /* Blue */
  --neutral: #6b7280;         /* Gray */

  /* Spacing */
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --spacing-xl: 2rem;

  /* Typography */
  --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.125rem;
  --font-size-xl: 1.25rem;
  --font-size-2xl: 1.5rem;

  /* Borders */
  --border-radius: 8px;
  --border-width: 1px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);
}
```

#### Component Patterns

**Status Badge:**

```css
.badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}

.badge-active { background: #d1fae5; color: #065f46; }
.badge-closed { background: #e5e7eb; color: #374151; }
.badge-pending { background: #fef3c7; color: #92400e; }
.badge-error { background: #fee2e2; color: #991b1b; }
```

**Modal:**

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s ease-out;
}

.modal-content {
  background: var(--background);
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-lg);
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
  animation: slideUp 0.3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
```

**Table:**

```css
.table-container {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--border-radius);
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  background: #f9fafb;
  padding: 0.75rem 1rem;
  text-align: left;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}

td {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
}

tr:hover {
  background: #f9fafb;
  cursor: pointer;
}
```

---

### Configuration

**Environment Variables:**

```bash
# ACP Gateway WebSocket
NEXT_PUBLIC_ACP_URL=ws://localhost:8787/acp

# MCP Server HTTP endpoint
NEXT_PUBLIC_MCP_URL=http://127.0.0.1:3001/mcp

# Agent working directory
NEXT_PUBLIC_ACP_CWD=/Users/pradeeptadash/sandbox

# Database (not used in web-client code, but present)
DATABASE_URL=postgresql://pradeeptadash@localhost:5432/trading_db
```

**Next.js Configuration:**

```javascript
// next.config.js
module.exports = {
  reactStrictMode: true,
  // No other custom configuration
}
```

---

### Deployment

**Development:**

```bash
cd web-client
npm install
npm run dev
# Access at http://localhost:3000
```

**Production:**

```bash
npm run build
npm start
# Runs on port 3000
```

**Prerequisites:**

- Node.js 18+ (for Next.js 14)
- Portfolio API Server running on port 3002
- ACP Gateway running on port 8787 (optional, for chat)
- MCP Server running on port 3001 (optional, for agent tools)

**Environment Setup:**

1. Copy `.env.example` to `.env`
2. Update environment variables
3. Run `npm install`
4. Run `npm run dev`

---

### Performance Characteristics

**Initial Load:**

- Bundle size: ~500KB (gzipped)
- First contentful paint: <1s
- Time to interactive: <2s

**Runtime Performance:**

- React rendering: 60 FPS
- Dashboard refresh: 10s interval (configurable)
- Logs refresh: 5s interval (configurable)
- WebSocket latency: <50ms

**Optimization Techniques:**

- React.memo for expensive components
- useCallback for event handlers
- useMemo for computed values
- Lazy loading for modals
- Debounced search inputs
- Throttled scroll handlers

---

## CLI Tools

All CLI tools are located in [cli/](cli/) directory.

### 27. add-strategy.ts

**Purpose:** Add new strategy to database from YAML file.

**Usage:**

```bash
npm run strategy:add -- --user=user123 --file=./strategies/my-strategy.yaml --account=acc_1
```

**Arguments:**

- `--user` - User ID (required)
- `--file` - Path to YAML file (required)
- `--account` - Account ID (optional)

**Process:**

1. Read YAML file
2. Validate schema
3. Compile to verify syntax
4. Insert into database with status `PENDING`
5. Log success

---

### 28. list-strategies.ts

**Purpose:** List strategies by status, user, or symbol.

**Usage:**

```bash
npm run strategy:list -- --user=user123 --status=ACTIVE
npm run strategy:list -- --symbol=SPY
npm run strategy:list  # List all
```

**Arguments:**

- `--user` - Filter by user ID
- `--status` - Filter by status (PENDING, ACTIVE, PAUSED, CLOSED)
- `--symbol` - Filter by symbol

**Output:**

```
ID  Symbol  Status  Created             Last Modified
123 SPY     ACTIVE  2024-01-15 10:30    2024-01-15 14:22
124 QQQ     PAUSED  2024-01-14 09:15    2024-01-15 11:05
```

---

### 29. close-strategy.ts

**Purpose:** Close active strategy with reason.

**Usage:**

```bash
npm run strategy:close -- --id=123 --reason="Not profitable"
```

**Arguments:**

- `--id` - Strategy ID (required)
- `--reason` - Closure reason (required)

**Process:**

1. Fetch strategy by ID
2. Cancel all open orders
3. Update status to `CLOSED`
4. Log closure event with reason
5. Create final version

---

### 30. rollback-strategy.ts

**Purpose:** Revert strategy to previous version.

**Usage:**

```bash
npm run strategy:rollback -- --id=123 --version=2
```

**Arguments:**

- `--id` - Strategy ID (required)
- `--version` - Version number to restore (required)

**Process:**

1. Fetch strategy by ID
2. Fetch version history
3. Find specified version
4. Create new version with old YAML
5. Update status to `PENDING` to trigger reload

---

### 31. export-strategy.ts

**Purpose:** Export strategy to YAML file.

**Usage:**

```bash
npm run strategy:export -- --id=123 --output=./backup.yaml
```

**Arguments:**

- `--id` - Strategy ID (required)
- `--output` - Output file path (required)

**Process:**

1. Fetch strategy by ID
2. Extract YAML content
3. Write to file
4. Log success

---

## Data Flow Diagrams

### Complete System Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Actions                             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                     CLI Tools / Web UI                           │
│  - Add strategy (YAML file → database)                          │
│  - List strategies                                               │
│  - Close strategy                                                │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                        PostgreSQL Database                       │
│  - strategies (status: PENDING)                                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓ (DatabasePoller detects)
┌─────────────────────────────────────────────────────────────────┐
│                   LiveTradingOrchestrator                        │
│  1. Initialize services                                          │
│  2. Connect to broker (TWS/Alpaca)                              │
│  3. Start DatabasePoller                                         │
│  4. Enter mainLoop()                                             │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                    MultiStrategyManager                          │
│  1. Load strategy from database                                  │
│  2. Compile YAML → IR (StrategyCompiler)                        │
│  3. Create StrategyInstance                                      │
│  4. Create TwsMarketDataClient                                   │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Market Data Flow                            │
│                                                                  │
│  TwsMarketDataClient.fetchLatestBar()                           │
│             ↓                                                    │
│  MultiStrategyManager.processBar()                              │
│             ↓                                                    │
│  StrategyInstance.processBar()                                  │
│             ↓                                                    │
│  StrategyEngine.processBar()                                    │
│      ├─ computeFeatures()                                       │
│      ├─ evaluateTransitions()                                   │
│      └─ executeActions()                                        │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓ (if transition triggered)
┌─────────────────────────────────────────────────────────────────┐
│                      Order Submission Flow                       │
│                                                                  │
│  StrategyEngine → TwsAdapter.submitOrderPlan()                  │
│                       ↓                                          │
│  enforceOrderConstraints() (safety checks)                      │
│                       ↓                                          │
│  expandSplitBracket() (entry + TP + SL)                        │
│                       ↓                                          │
│  Submit to TWS via socket                                        │
│                       ↓                                          │
│  OrderRepository.create() (persist to DB)                       │
│                       ↓                                          │
│  OrderAlertService.notify()                                     │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓ (order status updates)
┌─────────────────────────────────────────────────────────────────┐
│                    Order Status Tracking                         │
│                                                                  │
│  TWS status callback → TwsAdapter.handleOrderStatus()           │
│                            ↓                                     │
│  OrderRepository.updateStatus()                                 │
│                            ↓                                     │
│  OrderAlertService.notify() (filled/rejected/cancelled)         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓ (every N bars)
┌─────────────────────────────────────────────────────────────────┐
│                   Strategy Evaluation Flow                       │
│                                                                  │
│  StrategyLifecycleManager.evaluateStrategy()                    │
│                    ↓                                             │
│  Collect: state, metrics, portfolio, bar history                │
│                    ↓                                             │
│  StrategyEvaluatorClient.evaluate()                             │
│                    ↓                                             │
│  AI recommendation: "keep" or "swap"                             │
│                    ↓                                             │
│  If "swap":                                                      │
│    ├─ DistributedLockService.acquireLock(symbol)               │
│    ├─ Cancel all open orders                                    │
│    ├─ StrategyRepository.createVersion(newYAML)                │
│    ├─ MultiStrategyManager.swapStrategyById()                  │
│    ├─ Process latest bar with new strategy                      │
│    └─ DistributedLockService.releaseLock(symbol)               │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓ (every 5 minutes)
┌─────────────────────────────────────────────────────────────────┐
│                  Broker Reconciliation Flow                      │
│                                                                  │
│  BrokerReconciliationService.reconcile()                        │
│                    ↓                                             │
│  1. Fetch open orders from TWS                                   │
│  2. Fetch open orders from database                              │
│  3. Compare and detect:                                          │
│     - Orphaned orders (at broker, not in DB)                    │
│     - Missing orders (in DB, not at broker)                     │
│     - Status mismatches                                          │
│  4. Fix discrepancies:                                           │
│     - Cancel orphaned orders                                     │
│     - Update DB for missing orders                               │
│     - Sync status mismatches                                     │
│  5. Log reconciliation report                                    │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ↓
┌─────────────────────────────────────────────────────────────────┐
│                       Audit & Logging                            │
│                                                                  │
│  Logger.info/error/warn/debug()                                 │
│           ↓                                                      │
│  Console transport (colored output)                              │
│           ↓                                                      │
│  Prisma transport → system_logs table                           │
│                                                                  │
│  ExecutionHistoryRepository.logEvent()                          │
│           ↓                                                      │
│  strategy_executions table                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Service Dependencies

### Dependency Graph

```
LiveTradingOrchestrator
  ├─ RepositoryFactory
  │   ├─ PrismaClient
  │   ├─ StrategyRepository
  │   ├─ OrderRepository
  │   ├─ ExecutionHistoryRepository
  │   └─ SystemLogRepository
  │
  ├─ BaseBrokerAdapter (TwsAdapter or AlpacaAdapter)
  │   ├─ TwsClient (socket connection)
  │   ├─ OrderRepository
  │   └─ Logger
  │
  ├─ MultiStrategyManager
  │   ├─ StrategyRepository
  │   ├─ StrategyCompiler
  │   ├─ StrategyInstance
  │   │   ├─ StrategyCompiler
  │   │   ├─ StrategyEngine
  │   │   │   ├─ FeatureRegistry
  │   │   │   ├─ ExpressionEvaluator
  │   │   │   └─ BaseBrokerAdapter
  │   │   └─ Logger
  │   ├─ TwsMarketDataClient
  │   └─ Logger
  │
  ├─ StrategyLifecycleManager
  │   ├─ MultiStrategyManager
  │   ├─ StrategyEvaluatorClient
  │   ├─ StrategyRepository
  │   ├─ OrderRepository
  │   ├─ ExecutionHistoryRepository
  │   ├─ DistributedLockService
  │   └─ Logger
  │
  ├─ DatabasePoller
  │   ├─ StrategyRepository
  │   ├─ MultiStrategyManager
  │   └─ Logger
  │
  ├─ BrokerReconciliationService
  │   ├─ BaseBrokerAdapter
  │   ├─ OrderRepository
  │   ├─ ExecutionHistoryRepository
  │   └─ Logger
  │
  └─ OrderAlertService
      ├─ Logger
      └─ SystemLogRepository
```

### Service Initialization Order

1. **RepositoryFactory** - Database connection and repositories
2. **Logger** - Logging infrastructure
3. **BaseBrokerAdapter** - Broker connection
4. **MultiStrategyManager** - Strategy orchestration
5. **StrategyLifecycleManager** - Evaluation and swapping
6. **DatabasePoller** - Strategy loading
7. **BrokerReconciliationService** - State sync
8. **OrderAlertService** - Notifications
9. **LiveTradingOrchestrator** - Main coordinator

---

## Performance Characteristics

### Compilation Performance

- **YAML parsing:** ~1ms per strategy
- **Schema validation:** ~5ms per strategy
- **IR generation:** ~10ms per strategy
- **Feature plan (topological sort):** O(N + E) where N = features, E = dependencies

### Runtime Performance

- **Bar processing:** ~2-5ms per bar per strategy
- **Feature computation:** ~1ms for 10 features
- **Transition evaluation:** ~0.5ms per transition
- **Database queries:** ~5-10ms per query (with indexes)

### Scalability

- **Max concurrent strategies:** Configurable (default: 5)
- **Max bar history:** 1000 bars per strategy
- **Database connection pool:** 10 connections (configurable)
- **Memory per strategy:** ~5-10 MB

---

This comprehensive guide provides all the information needed to understand, maintain, and extend the Trading Strategy DSL System. For quick development reference, see [CLAUDE.md](CLAUDE.md).
