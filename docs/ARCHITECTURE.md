# System Architecture

> **Trading Strategy DSL v1 - Complete System Design**

This document provides a comprehensive overview of the trading system's architecture, from YAML strategy definitions to live order execution.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Layers](#architecture-layers)
3. [Data Flow](#data-flow)
4. [Key Components](#key-components)
5. [State Machine](#state-machine)
6. [Performance Characteristics](#performance-characteristics)

---

## Overview

The trading system is built on a **5-layer architecture** that transforms human-readable YAML strategies into type-safe, production-ready trading code:

```
YAML Strategy → Validated DSL → Compiled IR → Runtime Engine → Broker Execution
```

### Core Design Principles

- **Type Safety**: End-to-end TypeScript with zero runtime type errors
- **Zero-Cost Abstractions**: Compile-time optimizations with no runtime overhead
- **FSM-Based**: Finite State Machine for predictable trade lifecycle management
- **Extensible**: Plugin architecture for indicators and features
- **Safe Evaluation**: No `eval()` - all expressions parsed to AST and safely executed

---

## Architecture Layers

### Layer 0: User Input (YAML DSL)

**Purpose**: Define trading strategies in a simple, declarative format

**Example**:
```yaml
meta:
  name: "RSI Mean Reversion"
  symbol: "AAPL"
  timeframe: "5m"

features:
  - name: rsi
    type: indicator
    params:
      period: 14

rules:
  arm: "rsi < 30"
  trigger: "rsi > 35"
  invalidate:
    when_any:
      - "rsi > 70"

orderPlans:
  - name: primary_bracket
    side: buy
    entryZone: [150.00, 151.00]
    qty: 100
    stopPrice: 148.00
    targets:
      - price: 153.00
        ratioOfPosition: 0.5
      - price: 155.00
        ratioOfPosition: 0.5
```

**Key Features**:
- Declarative syntax (what, not how)
- Human-readable conditions
- Structured risk management
- No code required

---

### Layer 1: Specification (Types & Schemas)

**Purpose**: Define and validate data structures

**Components**:

#### `spec/types.ts`
Core TypeScript type definitions:
- `Bar` - OHLCV data structure
- `FeatureValue` - Computed indicator values
- `ExprNode` - Abstract Syntax Tree for expressions
- `CompiledIR` - Intermediate representation
- `StrategyRuntimeState` - Runtime state container
- `Order`, `OrderPlan` - Order management types
- `BrokerAdapter` - Broker interface

#### `spec/schema.ts`
Zod validation schemas:
- `StrategyDSLSchema` - Validates YAML input
- `FeatureDSLSchema` - Validates feature definitions
- `OrderPlanDSLSchema` - Validates order plans
- Runtime validation with detailed error messages

**Type Safety Flow**:
```
Unknown Input → Zod Validation → Type-Safe StrategyDSL
```

---

### Layer 2: Compiler (DSL → IR)

**Purpose**: Transform validated DSL into executable intermediate representation

**Pipeline**:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ YAML.parse() │→ │ Zod Valid.   │→ │ parseExpr()  │→ │ typeCheck()  │
│              │  │              │  │              │  │              │
│ YAML String  │  │ StrategyDSL  │  │  ExprNode    │  │  Validated   │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
                                                              ↓
                                          ┌──────────────────────────────┐
                                          │ compiler/compile.ts          │
                                          │                              │
                                          │ StrategyCompiler             │
                                          │ • buildFeaturePlan()         │
                                          │ • buildTransitions()         │
                                          │ • buildOrderPlans()          │
                                          └──────────────────────────────┘
```

**Key Operations**:

1. **Feature Plan**: Topologically sort features by dependencies
2. **Expression Parsing**: Convert string conditions to AST using `jsep`
3. **Type Checking**: Verify all identifiers exist in feature set
4. **State Machine**: Build FSM transitions from rules
5. **Order Expansion**: Handle split bracket orders

**Output**: `CompiledIR` ready for runtime execution

---

### Layer 3: Features (Indicator Registry)

**Purpose**: Compute technical indicators and market microstructure features

**Architecture**:

```
FeatureRegistry
    ↓
Topological Sort (DAG)
    ↓
Ordered Computation Plan
```

**Components**:

#### Feature Registry (`features/registry.ts`)
- Plugin architecture for features
- Dependency resolution via DAG
- Type-safe feature registration

#### Indicators (`features/indicators.ts`)
Built-in technical indicators:
- VWAP (Volume Weighted Average Price)
- EMA (Exponential Moving Average)
- RSI (Relative Strength Index)
- Bollinger Bands
- MACD (Moving Average Convergence Divergence)
- Volume Z-Score

#### Microstructure (`features/microstructure.ts`)
Market microstructure features:
- Order Flow Delta
- Absorption Detection
- Volume Profile

**Dependency Example**:
```
close (builtin)
  ↓
ema20 (depends on close)
  ↓
bb_upper (depends on ema20)
```

---

### Layer 4: Runtime (FSM Engine)

**Purpose**: Execute strategies in real-time using Finite State Machine

**Core Component**: `StrategyEngine` (`runtime/engine.ts`)

#### State Machine

```
IDLE → ARMED → PLACED → MANAGING → EXITED
```

**State Descriptions**:

| State | Description | Transitions |
|-------|-------------|-------------|
| `IDLE` | Waiting for setup conditions | → `ARMED` when arm condition met |
| `ARMED` | Ready to trigger | → `PLACED` when trigger condition met |
| `PLACED` | Orders submitted | → `MANAGING` when entry filled |
| `MANAGING` | Active position | → `EXITED` when invalidate or targets hit |
| `EXITED` | Position closed | → `IDLE` (new cycle) |

#### Bar Processing Flow

For each bar:
1. **Compute Features**: Execute feature plan in dependency order
2. **Tick Timers**: Countdown entry timeout, position timers
3. **Evaluate Transitions**: Check conditions for current state
4. **Execute Actions**: Submit orders, cancel orders, log events
5. **Update State**: Transition to new state if conditions met

#### Expression Evaluation (`runtime/eval.ts`)

**Safe Evaluation** - No `eval()` function used:

```
Expression String: "close < vwap && volume > 1000000"
        ↓
    jsep Parse
        ↓
    AST (ExprNode)
        ↓
Safe Traversal with Context
        ↓
    Boolean Result
```

**Supported Operations**:
- Arithmetic: `+`, `-`, `*`, `/`, `%`
- Comparison: `==`, `!=`, `<`, `>`, `<=`, `>=`
- Logical: `&&`, `||`, `!`
- Functions: `in_range()`, `clamp()`, `abs()`, `min()`, `max()`, `round()`

**Evaluation Context**:
- Features map (computed indicators)
- Builtin values (bar data)
- Timer states
- Safe whitelist of functions

#### Timer Management (`runtime/timers.ts`)

**Purpose**: Track bar-based timeouts

**Operations**:
- `startTimer(name, bars)`: Start countdown
- `tick()`: Decrement all timers
- `hasExpired(name)`: Check if timer expired
- `getRemaining(name)`: Get bars remaining

**Example**: Entry timeout
```
Timer: entry_timeout = 10 bars
Bar 1: 10 remaining
Bar 2: 9 remaining
...
Bar 10: 1 remaining
Bar 11: 0 remaining (expired)
```

---

### Layer 5: Broker Adapters

**Purpose**: Execute orders via broker APIs

**Base Interface**: `BrokerAdapter` (`broker/broker.ts`)

```typescript
interface BrokerAdapter {
  submitOrderPlan(plan: OrderPlan): Promise<Order[]>;
  cancelOpenEntries(symbol: string): Promise<void>;
  getOpenOrders(symbol: string): Promise<Order[]>;
}
```

#### Implementations

**1. Alpaca REST Adapter** (`broker/alpacaRest.ts`)
- HTTP REST API integration
- Bracket order support
- Split order expansion
- DRY RUN mode for testing

**2. Alpaca MCP Adapter** (`broker/alpacaMcp.ts`)
- Model Context Protocol integration
- Tool-based order execution
- Remote/delegated execution

#### Order Expansion

**Split Bracket Orders**:
```
OrderPlan: qty=100, targets=[153:50%, 155:50%]
        ↓
Bracket 1: entry 50, TP 153, SL 148
Bracket 2: entry 50, TP 155, SL 148
```

**Alpaca API Format**:
```json
{
  "symbol": "AAPL",
  "qty": 50,
  "side": "buy",
  "type": "limit",
  "limit_price": 150.50,
  "order_class": "bracket",
  "take_profit": {
    "limit_price": 153.00
  },
  "stop_loss": {
    "stop_price": 148.00
  }
}
```

---

## Data Flow

### Complete Pipeline

```
┌─────────────┐
│ YAML File   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Zod Schema  │ Validation
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ StrategyDSL │ Type-safe object
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Compiler    │ Parse + DAG sort + Typecheck
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ CompiledIR  │ Executable IR
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Engine Init │ Create StrategyEngine
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Bar Stream  │ Real-time or backtest data
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Process Bar │ Compute → Evaluate → Execute
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Broker API  │ Submit orders
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Market      │ Order execution
└─────────────┘
```

---

## Key Concepts

### Feature DAG (Dependency Graph)

Features are computed in dependency order:

```
close ─────┐
           ├──→ ema20 ─────┐
           │               ├──→ bb_upper
volume ────┼──→ vwap ──────┤
           │               ├──→ absorption
           └──→ vol_zscore ┘
```

**Topological Sort** ensures:
1. All dependencies computed before dependent features
2. No circular dependencies
3. Optimal computation order

### Expression AST

Conditions are parsed into Abstract Syntax Trees:

```javascript
"close < vwap && volume > 1000000"
    ↓
BinaryExpression(&&)
├── BinaryExpression(<)
│   ├── Identifier(close)
│   └── Identifier(vwap)
└── BinaryExpression(>)
    ├── Identifier(volume)
    └── Literal(1000000)
```

Safe evaluation traverses AST without `eval()`.

### State Transitions

Each transition has:
- **from**: Source state
- **to**: Target state
- **when**: Boolean condition (ExprNode)
- **actions**: Array of actions to execute

Example:
```typescript
{
  from: 'ARMED',
  to: 'PLACED',
  when: parseExpression('close < vwap && volume > 1000000'),
  actions: [
    { type: 'submit_order_plan', planId: 'primary_bracket' },
    { type: 'start_timer', name: 'entry_timeout', barCount: 10 }
  ]
}
```

---

## Performance Characteristics

### Operation Timings

| Operation | Time | Notes |
|-----------|------|-------|
| Compile strategy | < 10ms | One-time on startup |
| Process bar | < 1ms | Per bar (5m intervals) |
| Evaluate condition | < 100μs | Fast path |
| Compute indicator | < 500μs | Depends on complexity |
| Total per bar | < 1ms | Typical flow |

### Memory Profile

- **Feature Cache**: O(n) where n = number of features
- **Bar History**: Configurable window (default: 100 bars)
- **Order State**: O(k) where k = open orders
- **Total**: < 10MB per strategy instance

### Scalability

- **Single Symbol**: < 1ms per bar
- **10 Symbols**: < 10ms per bar (parallel processing)
- **100 Symbols**: < 100ms per bar
- **Strategy Compilation**: O(f log f) where f = features

---

## Example: 10-Bar Execution

```
Bar │ Close │ VWAP  │ State    │ Event
────┼───────┼───────┼──────────┼─────────────────────────────
 1  │ 90.10 │ 90.08 │ IDLE     │
 2  │ 90.22 │ 90.12 │ ARMED    │ ✓ Arm: close > vwap
 3  │ 90.32 │ 90.16 │ ARMED    │ (Waiting for trigger)
 4  │ 90.30 │ 90.20 │ ARMED    │ (Waiting for trigger)
 5  │ 90.20 │ 90.22 │ PLACED   │ ✓ Trigger met, orders sent
 6  │ 90.08 │ 90.20 │ MANAGING │ ✓ Entry filled
 7  │ 90.00 │ 90.18 │ MANAGING │ (Managing position)
 8  │ 89.80 │ 89.13 │ MANAGING │ (Managing position)
 9  │ 89.60 │ 90.08 │ MANAGING │ ✓ First target hit (50%)
10  │ 89.35 │ 90.02 │ EXITED   │ ✓ Second target hit (100%)
```

---

## Related Documentation

- [Strategy Capabilities](STRATEGY_CAPABILITIES.md) - Available indicators and strategy types
- [Complete Strategy Suite](COMPLETE_STRATEGY_SUITE.md) - All 148 pre-built strategies
- [Live Trading Setup](LIVE_TRADING_SETUP.md) - Deployment guide
- [Quick Start](QUICKSTART.md) - Getting started tutorial

---

**Last Updated**: January 13, 2026
