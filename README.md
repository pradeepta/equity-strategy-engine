# Algorithmic Trading System

A production-ready algorithmic trading system with database-backed strategy management, multi-strategy orchestration, and live trading support for **Interactive Brokers (TWS)**.

**Key Features:**
- Define strategies in YAML, compile to type-safe TypeScript
- Database-backed strategy storage with PostgreSQL + Prisma
- Multi-strategy orchestration with automatic bar polling
- Real-time strategy evaluation and hot-swapping
- Full bracket order support (entry + take profit + stop loss)
- MCP Server for AI-assisted strategy development

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   PostgreSQL Database                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Strategies  │  │ Executions   │  │   Orders     │       │
│  │ - Active    │  │ - Swaps      │  │ - Fills      │       │
│  │ - Versions  │  │ - Evaluations│  │ - Status     │       │
│  └─────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
                           ↕
┌─────────────────────────────────────────────────────────────┐
│           Live Trading Orchestrator                          │
│  ┌─────────────────┐  ┌──────────────────────────┐         │
│  │ Database Poller │→│ Multi-Strategy Manager    │         │
│  │ (polls for new  │  │ - Manages N strategies    │         │
│  │  strategies)    │  │ - Fetches bars per symbol │         │
│  └─────────────────┘  │ - Processes concurrently  │         │
│                        └──────────────────────────┘         │
│  ┌──────────────────────────────────────────────┐          │
│  │ Strategy Lifecycle Manager                    │          │
│  │ - Evaluation (every N bars)                   │          │
│  │ - Hot-swap (cancel old → load new → process) │          │
│  │ - Version tracking                            │          │
│  └──────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
                           ↕
┌─────────────────────────────────────────────────────────────┐
│                  Broker Adapters                             │
│  ┌──────────────────┐                                       │
│  │   TWS Adapter    │                                       │
│  │ - Market Data    │                                       │
│  │ - Bracket Orders │                                       │
│  │ - Portfolio Sync │                                       │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## Features

### 🗄️ Database-Backed Strategy Management
- **PostgreSQL + Prisma**: All strategies, executions, and orders stored in database
- **Version History**: Every strategy change creates a new version with rollback support
- **Execution Tracking**: Complete audit trail of swaps, evaluations, and decisions
- **Multi-User Support**: Isolate strategies by user ID

### 🎯 Multi-Strategy Orchestration
- **Concurrent Strategies**: Run up to N strategies simultaneously (configurable, default: 10)
- **Multiple Strategies Per Symbol**: Run multiple strategies on the same symbol (e.g., NVDA-RSI + NVDA-MACD + NVDA-BB)
- **Per-Symbol Timeframes**: Mix 1m, 5m, 1h, 1d strategies in same instance
- **Smart Polling**: Sleep interval adapts to shortest strategy timeframe
- **Hot-Swapping**: Replace individual strategies without affecting others on same symbol

### ⚙️ Live Trading Engine
- **FSM-Based Runtime**: Finite State Machine manages complete trade lifecycle
- **Bracket Orders**: Entry + multiple take-profit targets + stop loss
- **Order Cancellation**: Properly tracked order IDs with TWS mapping
- **Position Management**: Automated entry/exit with risk controls

### 🔄 Strategy Evaluation & Swapping
- **Periodic Evaluation**: Strategies evaluated every N bars (configurable)
- **AI-Powered Decisions**: Integration with strategy evaluator (WebSocket/HTTP)
- **Automatic Replacement**: Swap to new strategy when recommended
- **Immediate Processing**: New strategy processes latest bar right after swap

### 🔌 Broker Support
- **Interactive Brokers (TWS)**: Full support via TWS API
  - Market data streaming
  - Bracket order submission
  - Portfolio synchronization
  - Order status tracking

## Quick Start

### Prerequisites

1. **PostgreSQL** (required for database-backed storage)
2. **Node.js 18+** and npm
3. **TWS/IB Gateway** account

### Installation

```bash
# Clone and install
git clone <repo>
cd stocks
npm install  # Automatically sets up Python venv for TWS bridge
npm run build

# Setup database
createdb trading_db
npx prisma migrate dev --name init
```

**Note:** The `npm install` postinstall hook automatically:
- Generates Prisma client
- Creates Python virtual environment in `tws-bridge-server/venv`
- Installs Python dependencies from `tws-bridge-server/requirements.txt`

If you need to manually setup the TWS bridge later:
```bash
npm run setup:tws
```

### Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Database
DATABASE_URL="postgresql://username@localhost:5432/trading_db?schema=public"
USER_ID=your-user-id

# TWS Configuration (default)
BROKER=tws
TWS_HOST=127.0.0.1
TWS_PORT=7497  # 7497 = paper, 7496 = live
TWS_CLIENT_ID=0

# Multi-Strategy Settings
MAX_CONCURRENT_STRATEGIES=10
STRATEGY_WATCH_INTERVAL_MS=30000
STRATEGY_EVAL_ENABLED=true
STRATEGY_EVAL_WS_ENDPOINT=ws://localhost:8080/evaluate
```

### TWS Setup

1. **Download TWS** or IB Gateway from [Interactive Brokers](https://www.interactivebrokers.com/en/trading/tws.php)

2. **Enable API Access**:
   - Open TWS
   - Go to **Edit → Global Configuration → API → Settings**
   - Check **"Enable ActiveX and Socket Clients"**
   - Set **Socket port** to `7497` (paper) or `7496` (live)
   - Add `127.0.0.1` to **Trusted IP Addresses**
   - Uncheck **"Read-Only API"** (to allow order submission)

3. **Login to Paper Trading Account**
   - Use your paper trading credentials
   - Verify portfolio shows up in TWS

## Usage

### 1. Add a Strategy to Database

Create a YAML strategy file (e.g., `my-strategy.yaml`):

```yaml
meta:
  name: "AAPL Momentum"
  symbol: AAPL
  timeframe: 1d
  description: "Simple momentum strategy for Apple"

features:
  - name: ema20
    type: indicator
  - name: ema50
    type: indicator
  - name: volume_zscore
    type: indicator

rules:
  arm: "close > ema50"
  trigger: "close > ema20 && volume_zscore > 1.0"
  invalidate:
    when_any:
      - "close < ema50 * 0.96"

orderPlans:
  - name: aapl_long
    side: buy
    entryZone: [190.00, 200.00]
    qty: 10
    stopPrice: 185.00
    targets:
      - price: 204.00
        ratioOfPosition: 0.5
      - price: 210.00
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 5
  rthOnly: false

risk:
  maxRiskPerTrade: 350
```

Add to database:

```bash
npm run strategy:add -- --user=your-user-id --file=./my-strategy.yaml
```

### 2. Run Multi-Strategy Orchestrator

**Dry Run (no orders submitted):**
```bash
npm run live:multi
```

**Live Paper Trading:**
```bash
LIVE=true npm run live:multi
```

The orchestrator will:
1. ✅ Connect to database and verify health
2. ✅ Connect to TWS for market data and portfolio
3. ✅ Load all active strategies for your user
4. ✅ Start polling for new strategies every 30s
5. ✅ Fetch bars based on each strategy's timeframe
6. ✅ Process bars and place orders when conditions match
7. ✅ Evaluate strategies periodically and swap if recommended

### 3. Manage Strategies

**List active strategies:**
```bash
npm run strategy:list -- --user=your-user-id --status=ACTIVE
```

**Close a strategy:**
```bash
npm run strategy:close -- --id=<strategy-id> --reason="Not profitable"
```

**Rollback to previous version:**
```bash
npm run strategy:rollback -- --id=<strategy-id> --version=2
```

**Export strategy to YAML:**
```bash
npm run strategy:export -- --id=<strategy-id> --output=./backup.yaml
```

## Practical Example: Verify Order on IBKR

### Step 1: Prepare TWS

1. Open TWS and login to paper trading
2. Verify API is enabled (port 7497)
3. Check portfolio value in Account window

### Step 2: Create Test Strategy

Create `test-spy.yaml`:

```yaml
meta:
  name: "SPY Test Order"
  symbol: SPY
  timeframe: 1m
  description: "Quick test to verify TWS order submission"

features:
  - name: ema20
    type: indicator
  - name: ema50
    type: indicator
  - name: volume_zscore
    type: indicator

rules:
  arm: "close > ema50"
  trigger: "close > ema20 && volume_zscore > 0.1"
  invalidate:
    when_any:
      - "close < ema50 * 0.95"

orderPlans:
  - name: spy_test
    side: buy
    entryZone: [450.00, 480.00]  # Adjust to current SPY price ±$5
    qty: 1                        # Just 1 share for testing
    stopPrice: 445.00             # Stop $5 below entry
    targets:
      - price: 485.00             # Target $5 above entry
        ratioOfPosition: 1.0

execution:
  entryTimeoutBars: 2
  rthOnly: false

risk:
  maxRiskPerTrade: 50
```

### Step 3: Add Strategy

```bash
npm run strategy:add -- --user=test-user --file=./test-spy.yaml
```

Output:
```
✓ Strategy activated: cmkf5abc123...
```

### Step 4: Run Orchestrator

```bash
# Dry run first (verify logic without orders)
npm run live:multi

# Watch for:
# ✓ Database connection verified
# ✓ Connected to TWS at 127.0.0.1:7497
# 💰 Portfolio Summary (shows your paper account)
# ✓ Loaded SPY Test Order (SPY)
# 🔄 Fetching bars for 1 strategy(ies): SPY
# [Bar 387] [INFO] Order placed
```

### Step 5: Verify in TWS

Once you see `[INFO] Order placed`:

1. **Check Order Status in TWS**:
   - Go to **Trading → Pending Orders**
   - You should see a bracket order for SPY:
     - Entry: BUY 1 SPY @ $X (limit order)
     - Take Profit: SELL 1 SPY @ $X+5 (attached)
     - Stop Loss: SELL 1 SPY @ $X-5 (attached stop)

2. **Check Log Output**:
```
============================================================
TWS ADAPTER: ORDER PLAN SUBMISSION
============================================================
Bracket Order Plan: spy_test
Symbol: SPY, Side: buy
Total Qty: 1, Entry Price: 475.00
Stop Loss: 445.00

Brackets:
  Entry: 1 @ 475.00
    ├─ TP: 1 @ 485.00
    └─ SL: 1 @ 445.00

Submitting bracket 1/1:
Placing parent order 82...
Placing take profit order 83...
Placing stop loss order 84...
← Response: Bracket order submitted successfully
  Parent Order ID: 82
  Order ID mapping: entry_123_abc -> 82
============================================================
```

3. **Watch Order Lifecycle**:
```
Order 82 status: PreSubmitted (filled: 0, remaining: 1, avg: 0)
# Market opens at 9:30 AM ET, order becomes active
Order 82 status: Submitted (filled: 0, remaining: 1, avg: 0)
# If price crosses entry zone
Order 82 status: Filled (filled: 1, remaining: 0, avg: 475.23)
# Take profit and stop loss now active
```

### Step 6: Test Cancellation

The strategy will automatically cancel orders if:
- Invalidation rule triggers (`close < ema50 * 0.95`)
- Entry timeout expires (2 bars = ~2 minutes)
- Strategy gets swapped

Watch logs:
```
TWS: Cancelling 1 orders for SPY
Available order mappings: entry_123_abc->82
Cancelling order 82
✓ Cancelled TWS order 82
Order 82 status: Cancelled (filled: 0, remaining: 1, avg: 0)
```

Verify in TWS:
- Order disappears from Pending Orders
- Shows in Cancelled Orders history

### Step 7: Monitor Strategy Swapping

If evaluation is enabled, watch for:

```
🔍 Evaluating strategy: SPY Test Order for SPY
📊 Evaluation result for SPY:
   Recommendation: swap
   Confidence: 70%
   Reason: Market volatility increased; adjusting entry zone
🔄 Swapping strategy for SPY...

TWS: Cancelling 1 orders for SPY
✓ Cancelled TWS order 82

✅ Created new strategy in database: cmkf5xyz789...
Swapping strategy for SPY...
Fetching latest bar for newly swapped SPY strategy...
✓ Processed 2 bar(s) for newly swapped SPY strategy
[Bar 390] [INFO] Order placed

# New orders submitted with adjusted parameters
Placing parent order 85...
```

## Troubleshooting

### Orders Not Appearing in TWS

**Check 1: TWS API Settings**
```bash
# In TWS: Edit → Global Configuration → API → Settings
# ✓ Enable ActiveX and Socket Clients
# ✓ Socket port = 7497
# ✓ Trusted IPs includes 127.0.0.1
# ✓ Read-Only API is UNCHECKED
```

**Check 2: Connection**
```bash
# Look for in orchestrator logs:
✓ Connected to TWS at 127.0.0.1:7497
Next valid order ID: 82

# If not connected:
# - Restart TWS
# - Check TWS_PORT in .env
# - Check firewall settings
```

**Check 3: Market Hours**
```
Order 82 status: PreSubmitted
Warning: Your order will not be placed at the exchange until 2026-01-15 09:30:00 US/Eastern
```
This is normal outside market hours. Order will become active at market open.

### Orders Get Cancelled Immediately

**Reason 1: Entry Timeout**
```yaml
execution:
  entryTimeoutBars: 2  # Increase to 5+ for slower fills
```

**Reason 2: Invalidation Rule**
```yaml
rules:
  invalidate:
    when_any:
      - "close < ema50 * 0.95"  # Make less strict
```

**Reason 3: Evaluation Enabled**
```bash
# Disable auto-swapping to keep strategy running longer
STRATEGY_EVAL_ENABLED=false npm run live:multi
```

### Database Connection Issues

```bash
# Check database is running
psql -d trading_db -c "SELECT 1"

# Check DATABASE_URL in .env
DATABASE_URL="postgresql://username@localhost:5432/trading_db?schema=public"

# Re-run migrations
npx prisma migrate reset
npx prisma migrate dev
```

### Strategy Not Loading

```bash
# Check strategy status in database
npm run strategy:list -- --user=your-user-id --status=ACTIVE

# If strategy is FAILED:
npm run strategy:list -- --user=your-user-id --status=FAILED
# Check error message in output

# Fix and reactivate
npm run strategy:close -- --id=<strategy-id>
npm run strategy:add -- --user=your-user-id --file=./fixed-strategy.yaml
```

## Database Schema

### Key Tables

**strategies**
- Stores all strategy versions
- Status: DRAFT | PENDING | ACTIVE | CLOSED | ARCHIVED | FAILED
- Tracks activation/close timestamps
- Stores YAML content as text

**strategy_versions**
- Complete version history
- Change type: CREATED | MANUAL_EDIT | AUTO_SWAP | ROLLBACK
- Stores change reason and author
- Enables rollback to any previous version

**strategy_executions**
- Tracks lifecycle events: ACTIVATED | DEACTIVATED | SWAP | BAR_PROCESSED | ERROR
- Records swap reasons and metadata
- Links old and new versions during swaps

**strategy_evaluations**
- Stores evaluation results
- Recommendation: KEEP | SWAP | CLOSE
- Includes confidence score and reasoning
- Tracks if action was taken

**orders**
- All orders with broker IDs
- Hierarchy: parent orders + child orders (take profit, stop loss)
- Fill tracking with timestamps

See [prisma/schema.prisma](prisma/schema.prisma) for complete schema.

## Performance Tuning

### Polling Interval

```bash
# Check strategies more frequently (trades off CPU vs responsiveness)
STRATEGY_WATCH_INTERVAL_MS=10000  # Check for new strategies every 10s
```

Main loop automatically adjusts based on shortest strategy timeframe:
- 1m strategies → ~66s poll interval (1m + 10% buffer)
- 5m strategies → ~5m 30s poll interval
- Mix of 1m + 1d → Uses shortest (1m)

### Concurrent Strategies

```bash
# Run more strategies in parallel
MAX_CONCURRENT_STRATEGIES=20

# Or limit to reduce resource usage
MAX_CONCURRENT_STRATEGIES=3
```

### Database Connection Pool

```bash
# Increase for high-frequency strategies
DATABASE_POOL_SIZE=20
DATABASE_TIMEOUT_MS=10000
```

## MCP Server Usage

Run as an MCP server for AI-assisted strategy development:

```bash
npm run mcp
```

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "stocks-trading": {
      "command": "node",
      "args": ["/absolute/path/to/stocks/dist/mcp-server.js"]
    }
  }
}
```

Then ask Claude:
- "Create an RSI strategy for TSLA"
- "Backtest this strategy on 60 days of data"
- "What strategy types are available?"

See [MCP_SERVER_GUIDE.md](MCP_SERVER_GUIDE.md) for detailed documentation.

## Project Structure

```
stocks/
├── live/
│   ├── LiveTradingOrchestrator.ts    # Main orchestrator
│   ├── MultiStrategyManager.ts       # Manages N strategies
│   ├── StrategyLifecycleManager.ts   # Evaluation & swapping
│   ├── DatabasePoller.ts             # Polls for new strategies
│   └── StrategyInstance.ts           # Single strategy runtime
├── broker/
│   ├── twsAdapter.ts                 # TWS order submission
│   └── twsMarketData.ts              # TWS bar fetching
├── database/
│   ├── repositories/
│   │   ├── StrategyRepository.ts     # Strategy CRUD
│   │   ├── OrderRepository.ts        # Order tracking
│   │   └── ExecutionHistoryRepository.ts
│   └── RepositoryFactory.ts          # DI container
├── prisma/
│   └── schema.prisma                 # Database schema
├── runtime/
│   └── engine.ts                     # FSM trade engine
├── compiler/
│   └── compiler.ts                   # YAML → IR compiler
└── cli/
    ├── add-strategy.ts               # Add strategy to DB
    ├── list-strategies.ts            # List strategies
    └── close-strategy.ts             # Close strategy
```

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details

## Acknowledgments

- Built with [Prisma](https://www.prisma.io/) for database ORM
- Uses [Interactive Brokers TWS API](https://interactivebrokers.github.io/tws-api/)
- Inspired by production trading systems

## Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/stocks/issues)
- **Documentation**: See `docs/` directory
- **Examples**: See `strategies/` directory for YAML examples
