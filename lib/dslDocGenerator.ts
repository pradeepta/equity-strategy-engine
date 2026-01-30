/**
 * DSL Documentation Generator
 * Dynamically generates DSL schema documentation from the feature registry
 */

import { FeatureRegistry, createStandardRegistry } from '../features/registry';

export interface DSLDocumentation {
  schemaFormat: string;
  availableFeatures: {
    builtins: string[];
    indicators: string[];
    microstructure: string[];
  };
  expressionSyntax: string;
  criticalRules: string[];
  exampleStrategy: string;
}

/**
 * Generate comprehensive DSL documentation from the feature registry
 */
export function generateDSLDocumentation(): DSLDocumentation {
  const registry = createStandardRegistry();
  const allFeatures = registry.getAllFeatures();

  // Categorize features by type
  const builtins: string[] = [];
  const indicators: string[] = [];
  const microstructure: string[] = [];

  for (const [name, descriptor] of allFeatures) {
    switch (descriptor.type) {
      case 'builtin':
        builtins.push(name);
        break;
      case 'indicator':
        indicators.push(name);
        break;
      case 'microstructure':
        microstructure.push(name);
        break;
    }
  }

  return {
    schemaFormat: SCHEMA_FORMAT,
    availableFeatures: {
      builtins: builtins.sort(),
      indicators: indicators.sort(),
      microstructure: microstructure.sort(),
    },
    expressionSyntax: EXPRESSION_SYNTAX,
    criticalRules: CRITICAL_RULES,
    exampleStrategy: EXAMPLE_STRATEGY,
  };
}

/**
 * Generate LLM-friendly system prompt for strategy conversion
 */
export function generateConversionSystemPrompt(): string {
  const docs = generateDSLDocumentation();

  return `
You are a trading strategy converter. Convert TradeCheck analysis JSON to valid YAML strategies.

=== YAML STRATEGY FORMAT ===

${docs.schemaFormat}

=== AVAILABLE FEATURES ===

Builtins (type: builtin):
${docs.availableFeatures.builtins.join(', ')}

Indicators (type: indicator):
${docs.availableFeatures.indicators.join(', ')}

Microstructure (type: microstructure):
${docs.availableFeatures.microstructure.join(', ')}

IMPORTANT: When declaring features in YAML, you MUST specify the correct type for each feature based on the above categorization.

=== EXPRESSION SYNTAX ===

${docs.expressionSyntax}

=== CRITICAL RULES ===

${docs.criticalRules.map((rule, i) => `${i + 1}. ${rule}`).join('\n')}

=== EXAMPLE VALID STRATEGY ===

${docs.exampleStrategy}

=== YOUR TASK ===

Given a TradeCheck analysis JSON:
1. Map setup_type to side (long→buy, short→sell)
2. Infer features from patterns and key_levels
3. For each feature, assign the correct type (builtin/indicator/microstructure) based on the categorization above
4. Create logical arm/trigger/invalidate rules based on the analysis
5. Calculate proper entry zone (±0.5% around entry for flexibility)
6. Calculate qty: floor(maxRiskPerTrade / abs(entry - stop))
7. Ensure all validation rules pass
8. Add meaningful description explaining the setup

Output ONLY valid YAML, no explanations or markdown code fences.
`;
}

// ============================================================================
// Static Documentation Sections
// ============================================================================

const SCHEMA_FORMAT = `
meta:
  name: string            # Strategy name
  symbol: string          # Trading symbol (e.g., "AAPL", "GOOGL")
  timeframe: string       # Bar timeframe (e.g., "5m", "15m", "1h", "1d")
  description: string     # Optional description

features:                 # Array of features (indicators, built-ins, microstructure)
  - name: string          # Unique feature name (must match available features)
    type: builtin|indicator|microstructure  # Feature type (REQUIRED)

rules:
  arm: string            # Optional: Expression to arm (enable) the strategy
  trigger: string        # Optional: Expression that triggers order execution
  invalidate:            # Optional: Conditions to invalidate armed state
    when_any:
      - string           # Array of invalidation expressions

orderPlans:              # Array of order plans
  - name: string         # Order plan name
    side: buy|sell       # Order side
    entryZone:           # Entry price zone [min, max] - supports expressions!
      - number | string  # Can be static number OR dynamic expression
      - number | string  # Example: ["vwap - 0.2*atr", "vwap"]
    qty: number          # Quantity (positive number)
    stopPrice: number | string   # Stop loss price - supports expressions!
                                 # Example: "entry - 1.5*atr"
    targets:             # Array of profit targets
      - price: number | string   # Target price - supports expressions!
                                 # Example: "entry + 2.5*atr"
        ratioOfPosition: number  # Ratio of position (0-1, must sum to 1.0)

execution:               # Optional execution settings
  entryTimeoutBars: number     # Bars to wait before timeout (default: 10)
  rthOnly: boolean             # Regular trading hours only (default: false)
  freezeLevelsOn: armed|triggered  # ⭐ NEW: Freeze dynamic levels at event (optional)

risk:
  maxRiskPerTrade: number      # Maximum risk per trade (positive number)
`;

const EXPRESSION_SYNTAX = `
=== RULE EXPRESSIONS (arm, trigger, invalidate) ===

Operators: <, >, <=, >=, ==, !=, &&, ||, !
Arithmetic: +, -, *, /
Array indexing: feature[1] (previous bar), feature[2] (2 bars ago)

Examples:
- "rsi < 30" (oversold)
- "close > vwap && volume_zscore > 1.0" (price above VWAP with volume)
- "close < ema50 * 0.96" (4% below EMA)
- "macd_histogram > 0 && macd_histogram[1] <= 0" (bullish crossover)

=== DYNAMIC LEVEL EXPRESSIONS (entryZone, stopPrice, targets) ===

⭐ NEW: Entry zones, stops, and targets can use EXPRESSIONS that recompute every bar!

Supported Variables:
- Any declared feature: vwap, bb_upper, bb_lower, ema20, atr, etc.
- "entry" variable: Actual entry price (use in stops/targets only)
- Numeric literals: 0.2, 1.5, 2.0, etc.

Arithmetic Operators: +, -, *, /
Functions: min(), max(), abs(), round()

Examples:

**Dynamic Entry Zones:**
- entryZone: ["vwap - 0.2 * atr", "vwap"]           # Zone adapts to VWAP and volatility
- entryZone: ["bb_lower", "bb_middle"]              # Zone between Bollinger Bands
- entryZone: ["ema20 - 0.5 * atr", "ema20"]         # Zone below EMA20
- entryZone: [240.00, "vwap"]                       # Mix: static low, dynamic high

**Dynamic Stops:**
- stopPrice: "entry - 1.5 * atr"                    # Stop scales with ATR (volatility-adjusted)
- stopPrice: "bb_lower"                             # Stop at lower Bollinger Band
- stopPrice: "entry - 2.0"                          # Fixed dollar offset from entry

**Dynamic Targets:**
- targets:
    - price: "entry + 2.5 * atr"                    # Target scales with ATR
      ratioOfPosition: 0.5
    - price: "bb_upper"                             # Target at upper Bollinger Band
      ratioOfPosition: 0.5

**Why Use Dynamic Levels?**
- ✅ Adapts to volatility (ATR-based stops widen in volatile markets)
- ✅ No stale levels (zones follow VWAP/BB/EMA in real-time)
- ✅ Consistent R:R (3*ATR maintains 3:1 ratio as ATR changes)
- ✅ Backward compatible (numeric values still work)

**How It Works:**
- Compilation: Expression parsed once to AST, syntax validated
- Runtime: Expression evaluated every bar using current feature values
- Levels update if changed by >1 cent
- Logs: "Dynamic stop updated: 237.50 → 239.20"

**Freezing Dynamic Levels (freezeLevelsOn):** ⭐ NEW
- Problem: Dynamic levels can drift continuously, causing instability
- Solution: Freeze levels when strategy arms or triggers
- Usage: Add freezeLevelsOn: triggered or freezeLevelsOn: armed to execution block
- Semantics:
  - Before freeze event: Levels recompute every bar (dynamic discovery)
  - After freeze event: Levels locked at current values (static execution)
  - Once frozen, no further recomputation occurs
- Example:
  execution:
    entryTimeoutBars: 10
    rthOnly: true
    freezeLevelsOn: triggered  # Freeze when strategy places orders
- Benefits:
  - ✅ Dynamic discovery: Entry zones adapt until ready to trade
  - ✅ Static execution: Stops/targets don't drift after commitment
  - ✅ Best of both worlds: Adaptive entry detection + stable risk management
`;

const CRITICAL_RULES = [
  'ALL features used in expressions MUST be declared in features section (applies to rules AND dynamic levels)',
  'Each feature MUST have a type field (builtin, indicator, or microstructure)',
  'Feature names are case-sensitive (rsi ≠ RSI)',
  'Entry zones for BUY: should be BELOW expected current price (wait for pullback)',
  'Entry zones for SELL: should be ABOVE expected current price (wait for bounce)',
  'Stop loss for BUY: BELOW entry',
  'Stop loss for SELL: ABOVE entry',
  'Target ratios MUST sum to exactly 1.0',
  'Calculate qty: floor(maxRiskPerTrade / abs(entry - stopLoss))',
  '⭐ PREFER dynamic levels (expressions) over static numbers for adaptive strategies',
  'Use "entry - N*atr" for stops (scales with volatility)',
  'Use "entry + N*atr" for targets (maintains consistent R:R)',
  'Dynamic entry zones: "vwap ± 0.2*atr" or "bb_lower" to "bb_middle"',
  'If using ATR in expressions, declare "atr" in features section',
  '⭐ RECOMMENDED: Add "freezeLevelsOn: triggered" to prevent levels from drifting after order placement',
];

const EXAMPLE_STRATEGY = `
=== EXAMPLE 1: Static Levels (Traditional) ===

meta:
  name: "AAPL RSI Mean Reversion"
  symbol: AAPL
  timeframe: 5m
  description: |
    Auto-generated from TradeCheck AI analysis.
    Buys on RSI oversold, exits on RSI recovery.

features:
  - name: rsi
    type: indicator
  - name: vwap
    type: indicator
  - name: ema50
    type: indicator

rules:
  arm: "rsi < 35 && close < vwap"
  trigger: "rsi > 30 && close > open"
  invalidate:
    when_any:
      - "rsi > 70"
      - "close < ema50 * 0.96"

orderPlans:
  - name: aapl_long
    side: buy
    entryZone: [174.50, 175.50]
    qty: 233
    stopPrice: 173.00
    targets:
      - price: 177.00
        ratioOfPosition: 0.5
      - price: 179.00
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 10
  rthOnly: false

risk:
  maxRiskPerTrade: 350

=== EXAMPLE 2: Dynamic Levels (Adaptive) ⭐ RECOMMENDED ===

meta:
  name: "AAPL VWAP Mean Reversion (Dynamic)"
  symbol: AAPL
  timeframe: 5m
  description: |
    Adaptive strategy with dynamic entry zones, stops, and targets.
    All levels scale with ATR (volatility) and follow VWAP.

features:
  - name: close
    type: builtin
  - name: vwap
    type: indicator
  - name: atr
    type: indicator
  - name: rsi
    type: indicator

rules:
  arm: "close < vwap && rsi < 45"
  trigger: "close > vwap"
  invalidate:
    when_any:
      - "rsi < 30"

orderPlans:
  - name: aapl_dynamic
    side: buy
    # Dynamic entry zone: VWAP - 0.2*ATR to VWAP (adapts to volatility)
    entryZone: ["vwap - 0.2 * atr", "vwap"]
    qty: 100
    # Dynamic stop: 1.5 ATR below entry (risk scales with volatility)
    stopPrice: "entry - 1.5 * atr"
    # Dynamic targets: Scale with ATR (consistent R:R as volatility changes)
    targets:
      - price: "entry + 2.5 * atr"  # 2.5:1.5 = 1.67 R:R worst case
        ratioOfPosition: 0.5
      - price: "entry + 4.0 * atr"  # 4.0:1.5 = 2.67 R:R worst case
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 30
  rthOnly: true
  freezeLevelsOn: triggered  # ⭐ Freeze levels when orders placed

risk:
  maxRiskPerTrade: 250
`;
