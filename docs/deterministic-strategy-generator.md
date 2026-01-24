# Deterministic Strategy Generator

## Overview

The Deterministic Strategy Generator is a systematic, math-based approach to creating trading strategies that eliminates subjective "vibe trading" in favor of quantitative analysis and hard risk gates.

## Architecture

### Core Components

1. **[src/strategy/metrics.ts](../src/strategy/metrics.ts)** - Market metrics computation
   - ATR (Average True Range)
   - Trend analysis (20/40 bar lookbacks)
   - Range identification
   - HOD/LOD detection
   - EMA calculation

2. **[src/strategy/families.ts](../src/strategy/families.ts)** - Strategy templates
   - Breakout Range High/Low (Long/Short)
   - Range Bounce (Long/Short)
   - Range Midline Reclaim
   - HOD Breakout / LOD Breakdown

3. **[src/strategy/finalizers.ts](../src/strategy/finalizers.ts)** - Risk gate enforcement
   - Worst-case fill math
   - Position sizing
   - R:R validation
   - Entry distance validation

4. **[src/strategy/scoring.ts](../src/strategy/scoring.ts)** - Deterministic ranking
   - Entry distance scoring
   - R:R scoring
   - Regime alignment scoring

5. **[src/strategy/yaml.ts](../src/strategy/yaml.ts)** - DSL rendering
   - Family-specific arm/trigger rules
   - Feature declaration
   - Order plan generation

6. **[src/strategy/generate.ts](../src/strategy/generate.ts)** - Main orchestrator
   - Candidate generation
   - Best strategy selection
   - Top-N ranking

7. **[src/strategy/mcp-integration.ts](../src/strategy/mcp-integration.ts)** - MCP bridge
   - AI agent interface
   - Input validation
   - Error handling

## Hard Gates (Enforced Before Deployment)

All candidate strategies must pass these gates:

### Gate A: Stop on Correct Side
- **Long**: `riskWorstPerShare = entryHigh - stop > 0`
- **Short**: `riskWorstPerShare = stop - entryLow > 0`

### Gate B: R:R Meets Target
- **Long**: `rrWorst = (target - entryHigh) / (entryHigh - stop) >= rrTarget`
- **Short**: `rrWorst = (entryLow - target) / (stop - entryLow) >= rrTarget`

### Gate C: Dollar Risk Within Limit
- `dollarRiskWorst = qty * riskWorstPerShare <= maxRiskPerTrade`

### Gate D: Target Beyond Worst Fill
- **Long**: `target > entryHigh` (profit direction)
- **Short**: `target < entryLow` (profit direction)

### Gate E: Entry Distance Sanity
- `|entryMid - currentPrice| / currentPrice * 100 <= maxEntryDistancePct`
- Default: 3% for 5m timeframe

## Strategy Families

### 1. Breakout Range High Long
- Entry: Above recent range high
- Logic: Momentum continuation after breakout
- Best for: Bullish trend (trend20 > +1%)

### 2. Range Bounce Long
- Entry: Near range low, bounce expected
- Logic: Mean reversion from oversold
- Best for: Sideways market (|trend20| <= 1%)

### 3. Range Midline Reclaim Long
- Entry: Above range midpoint after reclaim
- Logic: Structure reclaim, trend continuation
- Best for: Bullish trend with consolidation

### 4. HOD Breakout Long
- Entry: Above high of day
- Logic: Intraday momentum breakout
- Best for: Strong bullish momentum

### 5. LOD Breakdown Short
- Entry: Below low of day
- Logic: Intraday momentum breakdown
- Best for: Strong bearish momentum

### 6. Breakout Range Low Short
- Entry: Below recent range low
- Logic: Bearish breakdown
- Best for: Bearish trend (trend20 < -1%)

### 7. Range Bounce Short
- Entry: Near range high, rejection expected
- Logic: Mean reversion from overbought
- Best for: Sideways market (|trend20| <= 1%)

## Parameter Grids

The generator explores bounded parameter spaces:

```typescript
buffers: [0.05, 0.10]      // Entry zone buffer in ATR multiples
widths: [0.05]             // Entry zone width in ATR multiples
stops: [1.0, 1.25]         // Stop distance in ATR multiples
lookbacks: [20, 40]        // Range calculation periods
```

This produces ~30 candidates total (fast generation, <1s).

## Scoring Algorithm

Deterministic scoring without subjective analysis:

1. **Entry Distance** (0-50 points)
   - Closer to current price = higher score
   - 0% distance = 50 points, 3% = 0 points

2. **R:R Score** (0-25 points)
   - Higher R:R = higher score (up to 6:1)
   - Capped to avoid unrealistic targets

3. **Regime Alignment** (0-25 points)
   - Breakout families prefer trend > +1% (bullish)
   - Range families prefer |trend| <= 1% (sideways)
   - Short families prefer trend < -1% (bearish)

**Total**: 0-100 points per candidate

## MCP Tool Usage

### Tool: `propose_deterministic_strategy`

**Required Parameters:**
- `symbol` - Trading symbol (e.g., "AAPL")
- `maxRiskPerTrade` - Max dollar risk (e.g., 100)

**Optional Parameters:**
- `timeframe` - Bar period (default: "5m")
- `limit` - Number of bars to analyze (default: 100, min: 50)
- `rrTarget` - Target risk:reward ratio (default: 3.0)
- `maxEntryDistancePct` - Max entry distance % (default: 3.0)
- `entryTimeoutBars` - Entry timeout (default: 10)
- `rthOnly` - Regular hours only (default: true)

**Returns:**
```json
{
  "success": true,
  "result": {
    "best": {
      "name": "Breakout Range High Long (20b)",
      "family": "breakout_range_high",
      "side": "buy",
      "entryLow": 101.5,
      "entryHigh": 102.0,
      "stop": 99.5,
      "target": 109.5,
      "qty": 40,
      "rrWorst": 3.0,
      "dollarRiskWorst": 100,
      "entryDistancePct": 1.5
    },
    "yaml": "meta:\n  name: ...",
    "candidatesTop5": [...],
    "metrics": {
      "atr": 0.5,
      "trend20": 2.3,
      "currentPrice": 100.0,
      ...
    }
  },
  "message": "Successfully generated 25 candidates..."
}
```

## AI Agent Workflow

### Old Workflow (Subjective)
1. User: "Create strategy for AAPL"
2. Agent: Analyzes bars, forms opinion about trend
3. Agent: Crafts YAML based on subjective interpretation
4. Agent: Guesses reasonable entry/stop/target levels
5. Result: Inconsistent quality, hidden assumptions

### New Workflow (Deterministic)
1. User: "Create strategy for AAPL with $100 risk"
2. Agent: Calls `propose_deterministic_strategy(symbol="AAPL", maxRiskPerTrade=100)`
3. Generator: Computes metrics → generates 30 candidates → enforces gates → ranks
4. Agent: Receives best strategy with YAML + alternatives
5. Agent: Validates with `validate_strategy()` and `compile_strategy()`
6. Agent: Deploys with `deploy_strategy()`
7. Result: Math-driven, reproducible, gate-enforced

## Integration with Chat Agent

Update [ai-gateway-live/src/config.ts](../ai-gateway-live/src/config.ts) prompt:

```typescript
export const PERSONA_PROMPTS: Record<string, string> = {
  blackrock_advisor: [
    "You are BlackRock's tactical stock advisor.",
    "",
    "## Strategy Creation Workflow",
    "",
    "### Option 1: Deterministic Generation (RECOMMENDED)",
    "Use this for systematic, math-based strategies:",
    "",
    "1. Call propose_deterministic_strategy({ symbol, maxRiskPerTrade })",
    "2. Review returned candidates (best + top 5 alternatives)",
    "3. Validate: validate_strategy({ yaml_content })",
    "4. Compile: compile_strategy({ yaml_content })",
    "5. Deploy: deploy_strategy({ yaml_content })",
    "",
    "Benefits:",
    "- No subjective analysis needed",
    "- All strategies pass hard risk gates",
    "- Deterministic (same inputs = same output)",
    "- Fast (<1s generation time)",
    "- Multiple alternatives ranked by score",
    "",
    "### Option 2: Manual Creation",
    "Use this only when deterministic approach doesn't fit:",
    "- Complex multi-symbol strategies",
    "- Custom indicator combinations not in families",
    "- User explicitly requests manual design",
    "",
    "[... existing manual workflow ...]",
  ].join("\n"),
};
```

## Testing

### Unit Tests
- [src/strategy/__tests__/finalizers.test.ts](../src/strategy/__tests__/finalizers.test.ts)
  - Hard gate validation
  - Edge cases (stop on wrong side, target unreachable)

### Integration Tests
- [src/strategy/__tests__/generate.test.ts](../src/strategy/__tests__/generate.test.ts)
  - Bullish/bearish/sideways scenarios
  - Determinism check
  - Golden test (fixed bars → expected output)

### Running Tests
```bash
npm test -- src/strategy/__tests__
```

## Example Usage

### Python-style MCP Call (from AI agent)
```python
# Get market data
market = get_market_data(symbol="NVDA", timeframe="5m", limit=100)

# Generate deterministic strategy
proposal = propose_deterministic_strategy(
    symbol="NVDA",
    maxRiskPerTrade=100,
    rrTarget=3.0,
    maxEntryDistancePct=3.0
)

# Review results
print(f"Best: {proposal.result.best.name}")
print(f"R:R: {proposal.result.best.rrWorst}:1")
print(f"Risk: ${proposal.result.best.dollarRiskWorst}")
print(f"Distance: {proposal.result.best.entryDistancePct}%")
print(f"\nAlternatives: {len(proposal.result.candidatesTop5)}")

# Deploy if acceptable
deploy_strategy(yaml_content=proposal.result.yaml)
```

### TypeScript Direct Call
```typescript
import { proposeBestStrategy } from './src/strategy';

const bars = await fetchMarketData('AAPL', '5m', 100);

const result = proposeBestStrategy(bars, 'AAPL', '5m', {
  maxRiskPerTrade: 100,
  rrTarget: 3.0,
  maxEntryDistancePct: 3.0,
  entryTimeoutBars: 10,
  rthOnly: true,
});

console.log(result.best);
console.log(result.yaml);
```

## Advantages Over Manual Creation

| Aspect | Manual (Old) | Deterministic (New) |
|--------|--------------|---------------------|
| **Consistency** | Varies by prompt | Identical for same inputs |
| **Speed** | 10-30s (LLM reasoning) | <1s (pure math) |
| **Risk Gates** | Sometimes missed | Always enforced |
| **R:R Accuracy** | Approximated | Computed (worst-fill) |
| **Alternatives** | None | Top 5 ranked |
| **Auditability** | Hard to trace | Full param logs |
| **Tool Calls** | 5-8 (exploration) | 1-2 (propose + validate) |
| **Cost** | High (LLM tokens) | Low (compute only) |

## Limitations & Future Work

### Current Limitations
- Fixed families (7 types)
- No multi-symbol strategies
- No correlation analysis
- Limited to standard indicators
- 5m timeframe optimized (3% distance gate)

### Future Enhancements
1. **Dynamic Families**: Generate families on-the-fly based on metrics
2. **Multi-Timeframe**: Auto-adjust gates for 1m, 15m, 1h, 1d
3. **Correlation Aware**: Reject strategies on correlated symbols
4. **Volatility Regime**: Adjust ATR multiples based on VIX/HV
5. **Walk-Forward**: Optimize param grids based on recent performance
6. **Ensemble**: Deploy multiple families on same symbol
7. **Custom Indicators**: Allow user-defined feature combinations

## Troubleshooting

### Error: "Insufficient bars"
- Need >= 50 bars for metrics computation
- Increase `limit` parameter (default 100)

### Error: "No valid candidates generated"
- All candidates failed hard gates
- Try relaxing `maxEntryDistancePct` (e.g., 5% instead of 3%)
- Try lowering `rrTarget` (e.g., 2:1 instead of 3:1)
- Check if market is too volatile (high ATR)

### Issue: Best strategy too far from price
- Entry distance scored but not rejected if < maxEntryDistancePct
- Adjust `maxEntryDistancePct` to be more restrictive
- Check if trend is strong (may need larger distance)

### Issue: All strategies are same family
- Regime is strongly directional
- Use scoring to pick alternatives (candidatesTop5)
- Consider manual creation for different approach

## References

- [CLAUDE.md](../CLAUDE.md) - Main developer guide
- [mcp-server.ts](../mcp-server.ts) - MCP tool definitions
- [ai-gateway-live/src/config.ts](../ai-gateway-live/src/config.ts) - Agent prompts
- [src/strategy/](../src/strategy/) - Implementation files
