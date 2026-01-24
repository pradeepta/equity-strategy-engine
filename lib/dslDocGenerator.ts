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
    entryZone:           # Entry price zone [min, max]
      - number
      - number
    qty: number          # Quantity (positive number)
    stopPrice: number    # Stop loss price
    targets:             # Array of profit targets
      - price: number
        ratioOfPosition: number  # Ratio of position (0-1, must sum to 1.0)

execution:               # Optional execution settings
  entryTimeoutBars: number     # Bars to wait before timeout (default: 10)
  rthOnly: boolean             # Regular trading hours only (default: false)

risk:
  maxRiskPerTrade: number      # Maximum risk per trade (positive number)
`;

const EXPRESSION_SYNTAX = `
Operators: <, >, <=, >=, ==, !=, &&, ||, !
Arithmetic: +, -, *, /
Array indexing: feature[1] (previous bar), feature[2] (2 bars ago)

Examples:
- "rsi < 30" (oversold)
- "close > vwap && volume_zscore > 1.0" (price above VWAP with volume)
- "close < ema50 * 0.96" (4% below EMA)
- "macd_histogram > 0 && macd_histogram[1] <= 0" (bullish crossover)
`;

const CRITICAL_RULES = [
  'ALL features used in expressions MUST be declared in features section',
  'Each feature MUST have a type field (builtin, indicator, or microstructure)',
  'Feature names are case-sensitive (rsi ≠ RSI)',
  'Entry zones for BUY: should be BELOW expected current price (wait for pullback)',
  'Entry zones for SELL: should be ABOVE expected current price (wait for bounce)',
  'Stop loss for BUY: BELOW entry',
  'Stop loss for SELL: ABOVE entry',
  'Target ratios MUST sum to exactly 1.0',
  'Calculate qty: floor(maxRiskPerTrade / abs(entry - stopLoss))',
];

const EXAMPLE_STRATEGY = `
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
`;
