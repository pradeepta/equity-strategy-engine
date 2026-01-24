# AI Agent Deterministic Strategy Workflow

## Quick Start

When a user asks to create a trading strategy, use this decision tree:

```
User requests strategy
         │
         ├─ User specifies exact setup/indicators?
         │  └─ YES → Use manual workflow (existing)
         │
         └─ NO → Use deterministic workflow ⭐ (RECOMMENDED)
            └─ Call: propose_deterministic_strategy()
```

## Deterministic Workflow (Recommended)

### Step 1: Call Deterministic Generator

```typescript
const proposal = await propose_deterministic_strategy({
  symbol: "AAPL",
  maxRiskPerTrade: 100,
  rrTarget: 3.0,              // Optional, default: 3.0
  maxEntryDistancePct: 3.0,   // Optional, default: 3.0
  timeframe: "5m",            // Optional, default: "5m"
  limit: 100,                 // Optional, default: 100
});
```

**What it does internally:**
1. Fetches market data (`get_market_data`)
2. Computes metrics (ATR, trend, range)
3. Generates ~30 candidates from 7 families
4. Enforces 5 hard gates on each
5. Scores and ranks survivors
6. Returns best + top 5 alternatives

**Output:**
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
      "entryDistancePct": 1.5,
      "params": { "lookback": 20, "bufferAtr": 0.05, ... }
    },
    "yaml": "meta:\n  name: \"Breakout Range High Long (20b)\"\n  ...",
    "candidatesTop5": [ ... ],
    "metrics": {
      "atr": 0.5,
      "trend20": 2.3,
      "trend40": 1.8,
      "rangeHigh20": 102.5,
      "rangeLow20": 98.0,
      "currentPrice": 100.0,
      "ema20": 99.5
    }
  },
  "message": "Successfully generated 25 candidate strategies..."
}
```

### Step 2: Review with User

Present the results in a clear format:

```
I've generated a deterministic strategy for AAPL using quantitative analysis:

📊 **Market Context**
- Current Price: $100.00
- 20-bar Trend: +2.3% (Bullish)
- ATR (volatility): $0.50
- 20-bar Range: $98.00 - $102.50

✅ **Best Strategy: Breakout Range High Long (20b)**
- Entry Zone: $101.50 - $102.00 (1.5% away)
- Stop: $99.50
- Target: $109.50
- Quantity: 40 shares
- Risk: $100 (worst-case)
- R:R: 3.0:1 (worst-case)

📈 **Logic**
- Momentum breakout above recent 20-bar high
- Arm: close > ema20 && rsi > 50
- Trigger: close > $101.50
- Invalidate: close < $99.50

🔄 **Alternatives** (if you prefer different approach):
1. Range Bounce Long (20b) - Mean reversion near support
2. HOD Breakout Long - Intraday momentum
3. Range Midline Reclaim Long (40b) - Structure reclaim
...

Would you like me to deploy this strategy or adjust parameters?
```

### Step 3: Validate Before Deploy

```typescript
// Validate YAML syntax
const validation = await validate_strategy({
  yaml_content: proposal.result.yaml
});

if (!validation.valid) {
  return `Validation failed: ${validation.error}`;
}

// Compile to ensure no runtime errors
const compilation = await compile_strategy({
  yaml_content: proposal.result.yaml
});

if (!compilation.success) {
  return `Compilation failed: ${compilation.error}`;
}
```

### Step 4: Deploy

```typescript
const deployment = await deploy_strategy({
  yaml_content: proposal.result.yaml
});

// Strategy status: PENDING → orchestrator picks up → ACTIVE
```

## When to Use Manual Workflow Instead

Use manual workflow if:

1. **User specifies exact indicators**
   - "Use MACD histogram and Stochastic"
   - "I want EMA50/200 crossover"

2. **Multi-symbol coordination**
   - "Trade both SPY and QQQ based on correlation"
   - Deterministic generator is single-symbol only

3. **Custom timeframe combinations**
   - "Use 1h trend for bias, 5m for entry"
   - Deterministic generator uses single timeframe

4. **Complex entry logic**
   - "Enter only if volume > 2x average AND RSI divergence"
   - Deterministic families use simpler arm/trigger patterns

5. **User explicitly requests manual design**
   - "I want you to design this yourself"

## Comparison Table

| Scenario | Workflow | Reason |
|----------|----------|--------|
| "Create AAPL strategy with $100 risk" | Deterministic ⭐ | No specific requirements, let math decide |
| "Create mean reversion for TSLA" | Deterministic ⭐ | Deterministic has range bounce family |
| "Use RSI < 30 and MACD bullish crossover" | Manual | Specific indicator combo requested |
| "Create strategy that hedges SPY position" | Manual | Multi-symbol coordination |
| "Design a scalping strategy" | Deterministic ⭐ | HOD breakout family fits scalping |
| "Use your judgment for NVDA" | Deterministic ⭐ | Delegate to math instead of subjective |

## Agent Prompt Update

Add this section to `blackrock_advisor` persona in [ai-gateway-live/src/config.ts](../../ai-gateway-live/src/config.ts):

```typescript
export const PERSONA_PROMPTS: Record<string, string> = {
  blackrock_advisor: [
    "You are BlackRock's tactical stock advisor.",
    "",
    "## Strategy Creation: Choose Your Approach",
    "",
    "### RECOMMENDED: Deterministic Generator",
    "Use `propose_deterministic_strategy()` when:",
    "- User wants a strategy but doesn't specify exact indicators",
    "- You want math-driven, gate-enforced strategies",
    "- User asks for 'your recommendation' or 'best setup'",
    "",
    "**Workflow:**",
    "1. Call propose_deterministic_strategy({ symbol, maxRiskPerTrade })",
    "2. Present best strategy + alternatives to user",
    "3. Validate + compile YAML",
    "4. Deploy if user approves",
    "",
    "**Benefits:**",
    "- <1s generation (no LLM reasoning needed)",
    "- All strategies pass 5 hard gates (risk, R:R, stops, targets, distance)",
    "- Deterministic (same inputs → same output)",
    "- Returns top 5 alternatives ranked by score",
    "- Minimal tool calls (1 propose + 1 validate + 1 compile + 1 deploy = 4 total)",
    "",
    "**Example:**",
    "User: 'Create a strategy for AAPL with $100 risk'",
    "You: Call propose_deterministic_strategy({ symbol: 'AAPL', maxRiskPerTrade: 100 })",
    "     Review result.best and present to user",
    "     If approved, validate → compile → deploy",
    "",
    "### Manual Creation",
    "Use existing workflow ONLY when:",
    "- User specifies exact indicators (e.g., 'Use MACD and Stochastic')",
    "- Multi-symbol strategies",
    "- Complex entry logic beyond standard families",
    "- User explicitly requests manual design",
    "",
    "[... existing manual workflow sections ...]",
  ].join("\n"),
};
```

## Error Handling

### Error: "No valid candidates generated"

**Cause:** All 30 candidates failed hard gates

**Solution:**
```typescript
// Try relaxed parameters
const proposal = await propose_deterministic_strategy({
  symbol: "AAPL",
  maxRiskPerTrade: 100,
  rrTarget: 2.0,              // Lowered from 3.0
  maxEntryDistancePct: 5.0,   // Increased from 3.0
});

// If still fails, inform user:
"The current market conditions don't allow for safe entry setups
within normal risk parameters. Consider:
- Waiting for better entry opportunities
- Using a wider entry distance (current volatility is high)
- Accepting lower R:R ratio (2:1 instead of 3:1)"
```

### Error: "Insufficient bars"

**Cause:** Need >= 50 bars for metrics computation

**Solution:**
```typescript
const proposal = await propose_deterministic_strategy({
  symbol: "AAPL",
  limit: 100,  // Ensure at least 100 bars
  maxRiskPerTrade: 100,
});
```

## Benefits for AI Agents

### Old Workflow Pain Points
- Agent must reason about entry/stop/target levels (subjective)
- Must manually compute R:R ratios (error-prone)
- Must check multiple risk gates individually
- Must explore parameter space with many tool calls
- Inconsistent quality across sessions

### New Workflow Advantages
- Zero subjective reasoning needed
- Math handles all risk gates automatically
- Single tool call returns validated candidates
- Consistent quality (deterministic)
- Faster (1s vs 30s)
- Cheaper (1 tool call vs 8+)

## Migration Path

### Phase 1: Soft Launch (Week 1)
- Keep existing manual workflow as default
- Add deterministic as "Option 2" in prompt
- Agent chooses based on scenario

### Phase 2: Flip Default (Week 2)
- Make deterministic the RECOMMENDED approach
- Manual becomes "Option 2"
- Monitor swap rates and user feedback

### Phase 3: Deprecate Manual (Week 4)
- Use deterministic for 95% of cases
- Reserve manual for special cases only
- Update all documentation

## Testing Checklist

Before deploying to production:

- [ ] Unit tests pass (`npm test -- src/strategy/__tests__`)
- [ ] MCP tool returns valid JSON
- [ ] Agent can call tool successfully
- [ ] YAML validates with `validate_strategy()`
- [ ] YAML compiles with `compile_strategy()`
- [ ] Deployed strategies become ACTIVE
- [ ] Hard gates are actually enforced (no invalid strategies slip through)
- [ ] Alternative strategies are ranked correctly
- [ ] Error messages are clear and actionable

## Monitoring & Metrics

Track these metrics post-deployment:

1. **Adoption Rate**: % of strategies using deterministic vs manual
2. **Success Rate**: % of proposals that deploy successfully
3. **Hard Gate Failures**: Which gates fail most often (tune params)
4. **User Satisfaction**: Do users prefer deterministic or manual?
5. **Swap Rate**: Do deterministic strategies get swapped less often?
6. **Tool Call Efficiency**: Avg tool calls per deployment (target: <5)

## FAQ

**Q: Can I combine deterministic + manual?**
A: Yes! Use deterministic to generate baseline, then manually tweak YAML.

**Q: What if user wants specific R:R like 5:1?**
A: Pass `rrTarget: 5.0` to generator. May filter out more candidates.

**Q: Can I deploy multiple candidates at once?**
A: Yes! Deploy best + top 2 alternatives on same symbol (now supported).

**Q: What if no candidates pass gates?**
A: Inform user market conditions don't support safe entries right now.

**Q: How do I debug a failed generation?**
A: Check `proposal.result.metrics` to see computed values (ATR, trend, range).

**Q: Can I override a specific parameter?**
A: Not directly. But you can edit the returned YAML before deploying.
