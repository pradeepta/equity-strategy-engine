# Live Trading Setup

> **Complete Guide to Deploying Strategies on Alpaca**

This document provides step-by-step instructions for deploying your trading strategies to live or paper trading on Alpaca.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Alpaca Account Setup](#alpaca-account-setup)
3. [Environment Configuration](#environment-configuration)
4. [Deployment Options](#deployment-options)
5. [Risk Management](#risk-management)
6. [Monitoring](#monitoring)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### System Requirements

- Node.js >= 16.x
- TypeScript >= 4.5
- Active Alpaca account (paper or live)
- Stable internet connection

### Required Knowledge

- Basic understanding of trading strategies
- Familiarity with command line
- Risk management principles

---

## Alpaca Account Setup

### Step 1: Create Alpaca Account

1. Visit [Alpaca](https://alpaca.markets/)
2. Sign up for an account
3. Complete identity verification (for live trading)

### Step 2: Get API Keys

**Paper Trading** (recommended for testing):
1. Log into Alpaca dashboard
2. Navigate to "Paper Trading" section
3. Generate API keys:
   - API Key ID
   - Secret Key
4. Save keys securely

**Live Trading**:
1. Complete account funding
2. Navigate to "Live Trading" section
3. Generate live API keys
4. **⚠️ WARNING**: Live keys trade real money!

### Step 3: Account Settings

Configure these settings in Alpaca dashboard:

- **Market Hours**: Enable/disable extended hours trading
- **Trade Confirmations**: Email notifications
- **Risk Settings**: Set account-level risk limits
- **Data Subscription**: Ensure real-time data access

---

## Environment Configuration

### Step 1: Create Environment File

Create `.env` file in project root:

```bash
# Alpaca API Configuration
ALPACA_API_KEY=your_api_key_here
ALPACA_SECRET_KEY=your_secret_key_here
ALPACA_BASE_URL=https://paper-api.alpaca.markets  # Paper trading
# ALPACA_BASE_URL=https://api.alpaca.markets      # Live trading

# Trading Configuration
TRADING_MODE=paper                # paper | live
DRY_RUN=true                      # true = log only, false = execute
SYMBOL=AAPL                       # Primary trading symbol
STRATEGY_PATH=./strategies/aapl-momentum.yaml

# Risk Settings
MAX_POSITION_SIZE=10000           # Maximum $ per position
MAX_DAILY_LOSS=500                # Stop trading after $500 loss
MAX_OPEN_POSITIONS=3              # Maximum concurrent positions

# Logging
LOG_LEVEL=info                    # debug | info | warn | error
LOG_FILE=./logs/trading.log
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Build Project

```bash
npm run build
```

### Step 4: Verify Configuration

Test API connection:

```bash
npm run test-alpaca
```

Expected output:
```
✓ Connected to Alpaca API
✓ Account Status: ACTIVE
✓ Buying Power: $100,000.00
✓ API Key Valid
```

---

## Deployment Options

### Option 1: Paper Trading (Recommended First)

**Description**: Trade with fake money on real market data

**Steps**:

1. Set environment to paper:
```bash
TRADING_MODE=paper
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

2. Start live trading engine:
```bash
npm run live -- --strategy ./strategies/aapl-momentum.yaml
```

3. Monitor output:
```
[INFO] Starting strategy: AAPL Momentum
[INFO] Compiled strategy successfully
[INFO] Connected to Alpaca WebSocket
[INFO] Subscribed to AAPL bars
[INFO] Engine running...
```

**Benefits**:
- No financial risk
- Real market data
- Test strategy behavior
- Validate order execution

---

### Option 2: Dry Run Mode

**Description**: Log orders without executing them

**Steps**:

1. Enable dry run:
```bash
DRY_RUN=true
```

2. Run strategy:
```bash
npm run live -- --strategy ./strategies/spy-etf.yaml --dry-run
```

3. Check logs:
```
[DRY RUN] Would submit order:
  Symbol: SPY
  Side: buy
  Qty: 10
  Entry: $500.50
  Stop: $498.00
  Target: $504.00
```

**Benefits**:
- See exact orders before execution
- Debug strategy logic
- No accidental trades
- Perfect for development

---

### Option 3: Live Trading

**⚠️ CAUTION**: Trades real money!

**Prerequisites**:
- Tested strategy in paper trading
- Validated risk management
- Funded Alpaca account
- Monitoring system ready

**Steps**:

1. Set environment to live:
```bash
TRADING_MODE=live
ALPACA_BASE_URL=https://api.alpaca.markets
DRY_RUN=false
```

2. Start with small position sizes:
```bash
MAX_POSITION_SIZE=1000  # Start small!
```

3. Run strategy:
```bash
npm run live -- --strategy ./strategies/aapl-momentum.yaml --live
```

4. Confirm prompt:
```
⚠️  LIVE TRADING MODE - REAL MONEY AT RISK
Strategy: AAPL Momentum
Max Position: $1,000
Type 'yes' to continue:
```

5. Monitor carefully (see [Monitoring](#monitoring))

---

### Option 4: Multiple Strategies

Run multiple strategies simultaneously:

**Terminal 1**:
```bash
npm run live -- --strategy ./strategies/aapl-momentum.yaml
```

**Terminal 2**:
```bash
npm run live -- --strategy ./strategies/spy-etf.yaml
```

**Terminal 3**:
```bash
npm run live -- --strategy ./strategies/tsla-volatile.yaml
```

**Portfolio Manager** (optional):
```bash
npm run portfolio-manager
```

---

## Risk Management

### Position Sizing

**Fixed Dollar Amount**:
```yaml
orderPlans:
  - name: primary_bracket
    qty: 10  # Fixed quantity
```

**Risk-Based Sizing**:
```yaml
risk:
  maxRiskPerTrade: 100  # Max $100 risk per trade
  
# Engine calculates:
# qty = maxRiskPerTrade / (entryPrice - stopPrice)
```

**Portfolio Percentage**:
```typescript
// In code:
const accountEquity = 100000;
const riskPercent = 0.01; // 1%
const maxRisk = accountEquity * riskPercent; // $1,000
```

---

### Stop Loss Management

**Fixed Stop**:
```yaml
orderPlans:
  - stopPrice: 148.00  # Hard stop at $148
```

**ATR-Based Stop**:
```yaml
features:
  - name: atr
    type: indicator
    params:
      period: 14

# In rules:
# stopPrice = entryPrice - (atr * 2)
```

**Trailing Stop**:
```yaml
orderPlans:
  - trailingStopPercent: 0.02  # 2% trailing stop
```

---

### Account-Level Limits

Set these in `.env`:

```bash
# Daily Loss Limit
MAX_DAILY_LOSS=500
# Stops all trading after -$500 for the day

# Max Concurrent Positions
MAX_OPEN_POSITIONS=3
# Limits portfolio diversification

# Max Position Size
MAX_POSITION_SIZE=10000
# No single position > $10k

# Max Leverage
MAX_LEVERAGE=1.0
# 1.0 = no leverage (cash only)
```

---

### Time-Based Filters

```yaml
execution:
  rthOnly: true  # Regular trading hours only (9:30 AM - 4:00 PM ET)
  
  # Or custom schedule:
  schedule:
    start: "09:45"  # Wait for market open stabilization
    end: "15:45"    # Avoid close volatility
    days: ["MON", "TUE", "WED", "THU", "FRI"]
```

---

## Monitoring

### Real-Time Dashboard

Start monitoring dashboard:

```bash
npm run dashboard
```

Access at: `http://localhost:3000`

**Features**:
- Live P&L
- Open positions
- Recent trades
- Strategy status
- Account metrics

---

### Log Files

**Location**: `./logs/trading.log`

**Format**:
```
[2026-01-13 09:30:15] [INFO] Bar received: AAPL $150.25
[2026-01-13 09:30:15] [DEBUG] Features: rsi=65, vwap=150.20
[2026-01-13 09:30:15] [INFO] State transition: ARMED → PLACED
[2026-01-13 09:30:15] [INFO] Order submitted: Buy 10 AAPL @ $150.25
[2026-01-13 09:30:18] [INFO] Order filled: Buy 10 AAPL @ $150.23
[2026-01-13 09:35:20] [INFO] Target hit: Sell 5 AAPL @ $152.00 (+$8.85)
```

**Monitoring Commands**:
```bash
# Tail live logs
tail -f logs/trading.log

# Filter errors only
tail -f logs/trading.log | grep ERROR

# Monitor specific symbol
tail -f logs/trading.log | grep AAPL
```

---

### Email Alerts

Configure email notifications:

```bash
# In .env
EMAIL_ALERTS=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
ALERT_EMAIL=your_email@gmail.com
```

**Alert Triggers**:
- Position opened
- Position closed
- Stop loss hit
- Daily loss limit reached
- System errors

---

### Performance Metrics

View performance:

```bash
npm run performance -- --symbol AAPL --days 30
```

**Output**:
```
Strategy Performance Report - AAPL (Last 30 Days)
================================================

Total Trades:        45
Winning Trades:      28 (62%)
Losing Trades:       17 (38%)

Avg Win:            $45.20
Avg Loss:          -$25.30
Profit Factor:      1.79

Total P&L:         $567.50
Max Drawdown:      -$125.00
Sharpe Ratio:       1.45

Best Trade:        +$125.00
Worst Trade:       -$75.00
```

---

## Troubleshooting

### Common Issues

#### 1. API Connection Failed

**Error**:
```
Error: Failed to connect to Alpaca API
```

**Solutions**:
- Check API keys are correct
- Verify BASE_URL (paper vs live)
- Check internet connection
- Verify Alpaca account status

---

#### 2. Insufficient Buying Power

**Error**:
```
Error: Insufficient buying power for order
```

**Solutions**:
- Reduce position size
- Close existing positions
- Check account equity
- Adjust `MAX_POSITION_SIZE`

---

#### 3. Order Rejected

**Error**:
```
Error: Order rejected - outside market hours
```

**Solutions**:
- Check if market is open
- Enable extended hours if needed
- Verify `rthOnly` setting
- Check symbol tradability

---

#### 4. Strategy Not Triggering

**Symptoms**:
- Strategy stays in IDLE state
- No orders placed

**Debug Steps**:

1. Check feature computation:
```bash
npm run debug-features -- --strategy ./strategies/aapl-momentum.yaml
```

2. Verify conditions:
```yaml
# Add logging to rules
rules:
  arm: "rsi < 30"  # Log: "ARM condition: false (rsi=45)"
```

3. Check market data:
```bash
# Verify bars are received
tail -f logs/trading.log | grep "Bar received"
```

---

#### 5. Unexpected Exit

**Symptoms**:
- Position exits prematurely
- Invalidate condition triggered unexpectedly

**Debug Steps**:

1. Review invalidate rules:
```yaml
invalidate:
  when_any:
    - "rsi > 70"  # Check if this triggered
    - "close < ema20"
```

2. Check logs for state transitions
3. Verify feature calculations

---

### Emergency Stop

**Stop all trading immediately**:

```bash
# Press Ctrl+C in terminal
^C

# Or from another terminal:
pkill -f "npm run live"

# Cancel all open orders:
npm run cancel-all
```

---

### Support Resources

- **Alpaca Documentation**: https://alpaca.markets/docs/
- **Alpaca Support**: support@alpaca.markets
- **Project Issues**: [GitHub Issues](link)
- **Community Discord**: [Discord Link](link)

---

## Best Practices

### Pre-Launch Checklist

- [ ] Strategy tested in backtest
- [ ] Positive expectancy verified
- [ ] Paper trading completed (2+ weeks)
- [ ] Risk limits configured
- [ ] Stop losses validated
- [ ] Monitoring setup
- [ ] Emergency procedures documented
- [ ] Small position sizes initially
- [ ] Exit plan defined

---

### Daily Operations

**Market Open** (9:30 AM ET):
1. Check system health
2. Review open positions
3. Verify strategy configs
4. Monitor first hour closely

**During Session**:
1. Check dashboard hourly
2. Review logs for errors
3. Monitor P&L vs expectations
4. Adjust if needed

**Market Close** (4:00 PM ET):
1. Review day's trades
2. Calculate P&L
3. Check for errors/issues
4. Plan adjustments

**Weekly Review**:
1. Analyze performance metrics
2. Review win rate
3. Adjust strategies if needed
4. Update risk parameters

---

### Risk Management Rules

1. **Never Risk More Than 1% Per Trade**
   ```
   $100k account = max $1,000 risk per trade
   ```

2. **Cut Losses Quickly**
   - Use stop losses on every trade
   - Don't move stops against you

3. **Let Winners Run**
   - Use trailing stops
   - Scale out at targets

4. **Daily Loss Limit**
   - Stop trading after max daily loss
   - Come back next day with clear mind

5. **Position Sizing**
   - Start small
   - Increase size only with proven profitability
   - Never go "all in"

---

## Deployment Architectures

### Single Server

```
┌─────────────────┐
│  Trading Server │
│                 │
│  ┌───────────┐ │
│  │ Strategy 1│ │
│  └───────────┘ │
│  ┌───────────┐ │
│  │ Strategy 2│ │
│  └───────────┘ │
│  ┌───────────┐ │
│  │ Strategy 3│ │
│  └───────────┘ │
└────────┬────────┘
         │
    ┌────▼────┐
    │  Alpaca │
    └─────────┘
```

**Best For**: Small portfolios, testing

---

### Multi-Server (Production)

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Server 1     │  │ Server 2     │  │ Server 3     │
│ (Momentum)   │  │ (Mean Rev)   │  │ (Breakout)   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                    ┌────▼────┐
                    │  Alpaca │
                    └─────────┘
```

**Best For**: Large portfolios, redundancy

---

## Related Documentation

- [Architecture](ARCHITECTURE.md) - System design
- [Strategy Capabilities](STRATEGY_CAPABILITIES.md) - Available indicators
- [Complete Strategy Suite](COMPLETE_STRATEGY_SUITE.md) - Pre-built strategies
- [Quick Start](QUICKSTART.md) - Getting started

---

**Last Updated**: January 13, 2026

**⚠️ DISCLAIMER**: Trading involves substantial risk of loss. This software is provided for educational purposes. Past performance does not guarantee future results. Always start with paper trading.
