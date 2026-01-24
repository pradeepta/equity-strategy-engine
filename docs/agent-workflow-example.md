# BlackRock Advisor Agent - Strategy Deployment Workflow

This document shows the expected workflow when the BlackRock advisor agent helps deploy a new trading strategy.

## Scenario: User asks to deploy an AAPL strategy

**User:** "I want to deploy a mean reversion strategy for AAPL using RSI and Bollinger Bands"

### Step 1: Gather Live Context

The agent should **automatically** call these MCP tools:

```typescript
// 1. Get real-time portfolio snapshot from TWS
const livePortfolio = await get_live_portfolio_snapshot()

// Response:
{
  success: true,
  snapshot: {
    timestamp: 1705522800000,
    accountId: "U1234567",
    totalValue: 125000,
    cash: 25000,
    buyingPower: 100000,
    unrealizedPnL: 2500,
    realizedPnL: 5000,
    positions: [
      {
        symbol: "GOOGL",
        quantity: 50,
        avgCost: 140,
        currentPrice: 145,
        unrealizedPnL: 250,
        marketValue: 7250
      },
      {
        symbol: "MSFT",
        quantity: 100,
        avgCost: 370,
        currentPrice: 375,
        unrealizedPnL: 500,
        marketValue: 37500
      }
    ]
  }
}

// 2. Get recent market data for AAPL
const marketData = await get_market_data({
  symbol: "AAPL",
  timeframe: "5m",
  limit: 100
})

// Response:
{
  success: true,
  symbol: "AAPL",
  timeframe: "5m",
  bars: [ /* 100 bars */ ],
  count: 100,
  latestPrice: 175.50
}

// 3. Check for active strategy conflicts
const activeStrategies = await get_active_strategies()

// Response:
{
  success: true,
  strategies: [
    { id: 1, symbol: "GOOGL", timeframe: "5m", status: "ACTIVE" },
    { id: 2, symbol: "MSFT", timeframe: "1h", status: "ACTIVE" }
  ],
  count: 2
}

// 4. [Optional] Get historical performance
const dbPortfolio = await get_portfolio_overview()
```

### Step 2: Analyze & Recommend

The agent should analyze the gathered data:

**Analysis:**
- ✅ **No AAPL strategy conflict** - Safe to deploy
- ✅ **Sufficient buying power** - $100k available for new positions
- ⚠️ **Portfolio concentration** - Currently heavy in tech (GOOGL + MSFT = $44,750 / 36% of portfolio)
- 📊 **Market conditions** - AAPL showing consolidation pattern in recent bars
- 💰 **Position sizing** - Recommend max $10-15k position (~10% of total value)

**Recommendation:**
```
I'll help you deploy an AAPL mean reversion strategy using RSI and Bollinger Bands.

Current Portfolio Context:
- Account Value: $125,000
- Available Cash: $25,000
- Buying Power: $100,000
- Active Strategies: GOOGL (5m), MSFT (1h)

Market Analysis:
- AAPL latest price: $175.50
- Recent bars show consolidation with decreased volatility
- Good conditions for mean reversion strategy

Position Sizing:
- Recommending 75 shares (~$13,162) = 10.5% of portfolio
- With 2% stop loss = $263 max risk per trade
```

### Step 3: Create Strategy

```typescript
// Get DSL schema first (ALWAYS)
const schema = await get_dsl_schema({ section: 'full' })

// Create YAML strategy based on context
const yamlContent = `
meta:
  name: "AAPL RSI+BB Mean Reversion"
  symbol: "AAPL"
  timeframe: "5m"
  description: "Buy oversold conditions near lower BB, sell at upper BB"

features:
  - name: rsi
  - name: bb_upper
  - name: bb_middle
  - name: bb_lower
  - name: close

rules:
  arm: "rsi < 35 && close < bb_lower"
  trigger: "close > bb_lower"
  invalidate:
    when_any:
      - "rsi > 65"
      - "close > bb_upper"

orderPlans:
  - name: "mean_reversion_entry"
    side: buy
    entryZone: [173, 176]
    qty: 75
    stopPrice: 172
    targets:
      - price: 178
        ratioOfPosition: 0.5
      - price: 180
        ratioOfPosition: 0.5

risk:
  maxRiskPerTrade: 300
`
```

### Step 4: Validate & Test

```typescript
// Validate YAML
const validation = await validate_strategy({ yaml_content: yamlContent })

// Backtest with recent data
const backtest = await backtest_strategy({
  yaml_content: yamlContent,
  historical_data: marketData.bars
})

// Analyze results
const analysis = await analyze_strategy_performance({
  backtest_results: backtest
})
```

**Results:**
```
Validation: ✅ Strategy is valid
Backtest Results:
- Total signals: 8
- Bars processed: 100
- Strategy behavior: Appropriate entry/exit signals
```

### Step 5: Deploy

```typescript
const deployment = await deploy_strategy({ yaml_content: yamlContent })

// Response:
{
  success: true,
  message: "Strategy deployed successfully",
  strategy: {
    id: 3,
    name: "AAPL RSI+BB Mean Reversion",
    symbol: "AAPL",
    timeframe: "5m",
    status: "PENDING"
  },
  instructions: "Strategy is PENDING and will be picked up by the orchestrator automatically."
}
```

**Agent Response:**
```
✅ Strategy Deployed Successfully

Strategy Details:
- Name: AAPL RSI+BB Mean Reversion
- Symbol: AAPL
- Timeframe: 5m
- Position Size: 75 shares (~$13,162)
- Stop Loss: $172 (2% risk = $263 max loss)
- Take Profit: $178 (50%), $180 (50%)
- Status: PENDING → Will activate automatically

Risk Summary:
- Max risk per trade: $300
- Position as % of portfolio: 10.5%
- Diversification: Now 3 active strategies (GOOGL, MSFT, AAPL)

The orchestrator will pick up this strategy and activate it automatically.
Monitor the web dashboard for execution updates.
```

---

## Key Principles

1. **Context-First**: Always gather live portfolio and market data before recommending strategies
2. **Risk-Aware**: Position sizing based on account value and buying power
3. **Data-Driven**: Use backtesting results to validate strategy logic
4. **Transparent**: Explain decisions with clear risk/reward analysis
5. **Automated**: Leverage orchestrator for deployment - no manual intervention needed

This workflow mirrors the automated swap evaluation system, ensuring AI-assisted deployments have the same rigor as automated decisions.
