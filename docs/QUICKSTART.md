# Quick Start Guide

> **Get Up and Running in 15 Minutes**

This guide will help you set up the trading system, run your first backtest, and understand the basics.

---

## Table of Contents

1. [Installation](#installation)
2. [Your First Strategy](#your-first-strategy)
3. [Running a Backtest](#running-a-backtest)
4. [Understanding Results](#understanding-results)
5. [Next Steps](#next-steps)

---

## Installation

### Prerequisites

- Node.js >= 16.x ([Download](https://nodejs.org/))
- Git ([Download](https://git-scm.com/))
- Text editor (VS Code recommended)

### Step 1: Clone Repository

```bash
git clone https://github.com/yourusername/stocks.git
cd stocks
```

### Step 2: Install Dependencies

```bash
npm install
```

This installs all required packages including TypeScript, Zod, and trading libraries.

### Step 3: Build Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### Step 4: Verify Installation

```bash
npm run verify
```

Expected output:
```
✓ TypeScript compiled successfully
✓ All 148 strategies validated
✓ Feature registry loaded
✓ System ready
```

---

## Your First Strategy

### Option 1: Use Pre-Built Strategy

We have 148 pre-built strategies ready to use. Let's start with a simple one:

**File**: `strategies/rsi-mean-reversion.yaml`

```yaml
meta:
  name: "RSI Mean Reversion"
  symbol: "AAPL"
  timeframe: "5m"
  description: "Buy oversold, sell overbought"

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
    entryZone: [149.00, 151.00]
    qty: 10
    stopPrice: 147.00
    targets:
      - price: 153.00
        ratioOfPosition: 0.5
      - price: 155.00
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 10
  rthOnly: true

risk:
  maxRiskPerTrade: 100
```

### Option 2: Create Your Own

Create a new file: `strategies/my-first-strategy.yaml`

```yaml
meta:
  name: "My First Strategy"
  symbol: "SPY"
  timeframe: "5m"
  description: "VWAP reclaim strategy"

# Define indicators we need
features:
  - name: vwap
    type: indicator
  - name: ema20
    type: indicator
    params:
      period: 20

# Trading rules
rules:
  # Setup condition - price below VWAP but above EMA
  arm: "close < vwap && close > ema20"
  
  # Entry trigger - price reclaims VWAP
  trigger: "close > vwap"
  
  # Exit condition - price drops below EMA
  invalidate:
    when_any:
      - "close < ema20"

# Order configuration
orderPlans:
  - name: primary_bracket
    side: buy
    entryZone: [500.00, 501.00]  # SPY price range
    qty: 10                       # 10 shares
    stopPrice: 499.00             # Stop loss
    targets:
      - price: 503.00             # First target
        ratioOfPosition: 0.5      # Exit 50% here
      - price: 505.00             # Second target
        ratioOfPosition: 0.5      # Exit remaining 50%

# Execution settings
execution:
  entryTimeoutBars: 5   # Cancel if not filled in 5 bars
  rthOnly: true         # Only trade during market hours

# Risk management
risk:
  maxRiskPerTrade: 50   # Maximum $50 risk per trade
```

---

## Running a Backtest

### Step 1: Compile Strategy

```bash
npm run compile -- --strategy ./strategies/my-first-strategy.yaml
```

Expected output:
```
✓ Strategy parsed successfully
✓ Features validated: vwap, ema20
✓ Rules compiled to IR
✓ Order plans validated
✓ Strategy ready for execution
```

### Step 2: Run Backtest

```bash
npm run backtest -- --strategy ./strategies/my-first-strategy.yaml --days 30
```

**Options**:
- `--strategy`: Path to strategy file
- `--days`: Number of days to backtest (default: 30)
- `--start`: Start date (YYYY-MM-DD)
- `--end`: End date (YYYY-MM-DD)

### Step 3: View Results

Output will show:

```
╔══════════════════════════════════════════════════════════════╗
║              BACKTEST RESULTS - My First Strategy             ║
╚══════════════════════════════════════════════════════════════╝

Symbol:              SPY
Timeframe:           5m
Period:              2025-12-14 to 2026-01-13 (30 days)
Total Bars:          2,340

┌────────────────────────────────────────────────────────────┐
│ PERFORMANCE METRICS                                        │
├────────────────────────────────────────────────────────────┤
│ Total Trades:         23                                   │
│ Winning Trades:       15 (65.2%)                          │
│ Losing Trades:        8 (34.8%)                           │
│                                                            │
│ Total P&L:           $287.50                              │
│ Avg Win:             $32.40                               │
│ Avg Loss:           -$18.20                               │
│ Largest Win:         $58.00                               │
│ Largest Loss:       -$35.00                               │
│                                                            │
│ Win Rate:            65.2%                                │
│ Profit Factor:       1.92                                 │
│ Sharpe Ratio:        1.35                                 │
│ Max Drawdown:       -$85.00                               │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ TRADE BREAKDOWN                                            │
├────────────────────────────────────────────────────────────┤
│ #  │ Entry Date  │ Entry  │ Exit   │ P&L     │ Return    │
├────┼─────────────┼────────┼────────┼─────────┼───────────┤
│ 1  │ 2025-12-14  │ 500.25 │ 503.10 │ +$28.50 │ +5.7%    │
│ 2  │ 2025-12-15  │ 499.80 │ 499.00 │ -$8.00  │ -1.6%    │
│ 3  │ 2025-12-15  │ 500.50 │ 505.20 │ +$47.00 │ +9.4%    │
│ ...│             │        │        │         │           │
└────┴─────────────┴────────┴────────┴─────────┴───────────┘

✓ Backtest completed successfully
```

---

## Understanding Results

### Key Metrics Explained

#### Total P&L
Total profit or loss for the period.
- **Good**: Positive and consistent
- **Warning**: Negative or highly volatile

#### Win Rate
Percentage of winning trades.
- **Good**: > 50%
- **Excellent**: > 60%
- **Warning**: < 45%

#### Profit Factor
Ratio of total wins to total losses.
- **Good**: > 1.5
- **Excellent**: > 2.0
- **Warning**: < 1.2

#### Sharpe Ratio
Risk-adjusted return measure.
- **Good**: > 1.0
- **Excellent**: > 1.5
- **Warning**: < 0.5

#### Max Drawdown
Largest peak-to-trough decline.
- **Good**: < 10% of capital
- **Acceptable**: 10-20%
- **Warning**: > 20%

### Trade Analysis

Look for:
1. **Consistent Winners**: Multiple small wins
2. **Controlled Losses**: Stop losses working
3. **Good Risk/Reward**: Avg Win > Avg Loss
4. **No Outliers**: No single trade dominates P&L

---

## Next Steps

### 1. Try More Strategies

Explore the 148 pre-built strategies:

```bash
# List all available strategies
ls strategies/variations/

# Try a Bollinger Band strategy
npm run backtest -- --strategy ./strategies/variations/bb_1_aapl_v1.yaml

# Try a MACD strategy
npm run backtest -- --strategy ./strategies/variations/macd_2_msft_v3.yaml
```

### 2. Optimize Parameters

Modify strategy parameters:

```yaml
features:
  - name: rsi
    type: indicator
    params:
      period: 10  # Try different periods: 10, 14, 21
```

Run backtests with each variation and compare results.

### 3. Add More Indicators

Enhance your strategy:

```yaml
features:
  - name: rsi
    type: indicator
    params:
      period: 14
  - name: bb
    type: indicator
    params:
      period: 20
      stdDev: 2
  - name: vwap
    type: indicator

rules:
  # Combine multiple indicators
  arm: "rsi < 30 && close < bb_lower"
  trigger: "rsi > 35 && close > bb_lower && close > vwap"
```

### 4. Test Different Symbols

```yaml
meta:
  symbol: "TSLA"  # Try: AAPL, MSFT, GOOGL, NVDA, AMZN
```

Different stocks behave differently - test your strategy on multiple symbols.

### 5. Adjust Risk Parameters

```yaml
risk:
  maxRiskPerTrade: 100  # Start small, increase gradually

orderPlans:
  - qty: 10  # Adjust position size
    stopPrice: 147.00  # Tighter or wider stops
```

### 6. Paper Trading

Once you're happy with backtest results:

```bash
# Set up paper trading
cp .env.example .env
# Edit .env with your Alpaca paper trading API keys

# Start paper trading
npm run live -- --strategy ./strategies/my-first-strategy.yaml --paper
```

See [Live Trading Setup](LIVE_TRADING_SETUP.md) for details.

---

## Common Patterns

### Pattern 1: RSI Mean Reversion

```yaml
features:
  - name: rsi
    type: indicator
    params:
      period: 14

rules:
  arm: "rsi < 30"      # Oversold
  trigger: "rsi > 35"  # Bounce confirmation
```

**Best For**: Range-bound stocks, choppy markets

---

### Pattern 2: Bollinger Band Bounce

```yaml
features:
  - name: bb
    type: indicator
    params:
      period: 20
      stdDev: 2

rules:
  arm: "close < bb_lower"       # At lower band
  trigger: "close > bb_lower"   # Bounce off band
```

**Best For**: Mean reversion, volatility trading

---

### Pattern 3: MACD Momentum

```yaml
features:
  - name: macd
    type: indicator
    params:
      fastPeriod: 12
      slowPeriod: 26
      signalPeriod: 9

rules:
  arm: "macd > 0"               # Above zero line
  trigger: "macd > macd_signal" # Bullish crossover
```

**Best For**: Trending markets, momentum trading

---

### Pattern 4: VWAP Reclaim

```yaml
features:
  - name: vwap
    type: indicator
  - name: ema20
    type: indicator
    params:
      period: 20

rules:
  arm: "close < vwap && close > ema20"
  trigger: "close > vwap"
```

**Best For**: Intraday trading, institutional flow

---

## Troubleshooting

### Issue: Strategy Won't Compile

**Error**: `Unknown identifier: rsi`

**Solution**: Make sure indicator is declared in `features`:
```yaml
features:
  - name: rsi
    type: indicator
    params:
      period: 14
```

---

### Issue: No Trades Generated

**Problem**: Backtest runs but shows 0 trades

**Solutions**:
1. Check if conditions are too strict
2. Verify symbol and date range have data
3. Add debug logging:
```bash
npm run backtest -- --strategy ./strategies/my-strategy.yaml --debug
```

---

### Issue: All Trades Losing

**Problem**: Strategy loses money consistently

**Solutions**:
1. Check if stop loss is too tight
2. Verify entry/exit logic makes sense
3. Try different parameters
4. Test on different time periods
5. Consider reversing the logic (sometimes strategies work better inverted)

---

## Learning Resources

### Documentation

- [Architecture](ARCHITECTURE.md) - Deep dive into system design
- [Strategy Capabilities](STRATEGY_CAPABILITIES.md) - All available indicators
- [Complete Strategy Suite](COMPLETE_STRATEGY_SUITE.md) - 148 pre-built strategies
- [Live Trading Setup](LIVE_TRADING_SETUP.md) - Deploy to production

### Example Strategies

Explore these for inspiration:

- `strategies/rsi-mean-reversion.yaml` - Basic RSI
- `strategies/bb-bounce.yaml` - Bollinger Bands
- `strategies/macd-momentum.yaml` - MACD crossover
- `strategies/fade-vwap-reclaim.yaml` - Advanced VWAP
- `strategies/nflx-adaptive.yaml` - Multi-indicator hybrid

---

## Quick Reference

### Commands

```bash
# Build project
npm run build

# Verify all strategies
npm run verify

# Compile single strategy
npm run compile -- --strategy ./strategies/my-strategy.yaml

# Backtest
npm run backtest -- --strategy ./strategies/my-strategy.yaml --days 30

# Paper trading
npm run live -- --strategy ./strategies/my-strategy.yaml --paper

# View available strategies
ls strategies/variations/
```

### Strategy Template

```yaml
meta:
  name: "Strategy Name"
  symbol: "SYMBOL"
  timeframe: "5m"

features:
  - name: indicator_name
    type: indicator
    params:
      period: 14

rules:
  arm: "condition"
  trigger: "condition"
  invalidate:
    when_any:
      - "condition"

orderPlans:
  - name: primary_bracket
    side: buy
    entryZone: [min, max]
    qty: number
    stopPrice: price
    targets:
      - price: target
        ratioOfPosition: ratio

execution:
  entryTimeoutBars: 10
  rthOnly: true

risk:
  maxRiskPerTrade: amount
```

---

## Next Steps

✅ **You're ready to start trading!**

1. ✓ Installation complete
2. ✓ First strategy created
3. ✓ Backtest successful
4. ⏭️ Optimize and improve
5. ⏭️ Paper trading
6. ⏭️ Live trading

**Recommended Path**:
1. Backtest 5-10 different strategies
2. Find 2-3 that work well
3. Paper trade for 2 weeks minimum
4. Start live with small positions
5. Scale up gradually

**Good luck! 🚀**

---

**Last Updated**: January 13, 2026
