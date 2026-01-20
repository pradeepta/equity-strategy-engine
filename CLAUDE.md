# Claude Code Developer Guide

This guide helps Claude Code sessions understand the codebase structure, conventions, and best practices for this Trading Strategy DSL System.

## Project Overview

**Stocks Trading System** is a production-ready algorithmic trading platform that enables users to:
- Define trading strategies in YAML DSL
- Compile strategies to type-safe intermediate representation (IR)
- Execute multiple strategies concurrently against live market data
- Integrate with Interactive Brokers (TWS) and Alpaca brokers
- Enable AI-powered strategy evaluation and hot-swapping
- Track orders, fills, and performance with PostgreSQL persistence

**Architecture:** Multi-tier system with compilation layer, runtime engine, broker adapters, and database persistence.

---

## Key File Locations

### Core Entry Points
- [live-multi.ts](live-multi.ts) - **Main orchestrator** for multi-strategy live trading (START HERE)
- [live.ts](live.ts) - Single strategy runner (simpler, legacy)
- [mcp-server.ts](mcp-server.ts) - MCP server exposing trading tools to AI
- [portfolio-api-server.ts](portfolio-api-server.ts) - HTTP API for web dashboard

### Live Trading System
- [live/LiveTradingOrchestrator.ts](live/LiveTradingOrchestrator.ts) - Main orchestrator coordinating all services
- [live/MultiStrategyManager.ts](live/MultiStrategyManager.ts) - Manages N concurrent strategy instances
- [live/StrategyLifecycleManager.ts](live/StrategyLifecycleManager.ts) - Strategy evaluation and swapping logic
- [live/DatabasePoller.ts](live/DatabasePoller.ts) - Polls DB for new PENDING strategies
- [live/StrategyInstance.ts](live/StrategyInstance.ts) - Single strategy runtime wrapper

### Compilation & Runtime
- [compiler/compile.ts](compiler/compile.ts) - **YAML → IR compiler** (critical path)
- [runtime/engine.ts](runtime/engine.ts) - **FSM-based strategy execution engine** (critical path)
- [features/registry.ts](features/registry.ts) - 30+ technical indicators
- [spec/types.ts](spec/types.ts) - Core type definitions
- [spec/schema.ts](spec/schema.ts) - YAML validation schema

### Broker Integration
- [broker/broker.ts](broker/broker.ts) - Abstract broker adapter interface
- [broker/twsAdapter.ts](broker/twsAdapter.ts) - Interactive Brokers TWS implementation
- [broker/twsMarketData.ts](broker/twsMarketData.ts) - Market bar fetching
- [broker/twsPortfolio.ts](broker/twsPortfolio.ts) - Portfolio snapshot
- [broker/alpacaRest.ts](broker/alpacaRest.ts) - Alpaca broker implementation

### Database Layer
- [database/RepositoryFactory.ts](database/RepositoryFactory.ts) - DI container for repositories
- [database/repositories/StrategyRepository.ts](database/repositories/StrategyRepository.ts) - Strategy CRUD
- [database/repositories/OrderRepository.ts](database/repositories/OrderRepository.ts) - Order management
- [database/repositories/ExecutionHistoryRepository.ts](database/repositories/ExecutionHistoryRepository.ts) - Event logging
- [prisma/schema.prisma](prisma/schema.prisma) - Database schema

### Infrastructure Services
- [live/locking/DistributedLockService.ts](live/locking/DistributedLockService.ts) - PostgreSQL advisory locks
- [live/queue/OperationQueueService.ts](live/queue/OperationQueueService.ts) - Async operation queue with retry
- [live/reconciliation/BrokerReconciliationService.ts](live/reconciliation/BrokerReconciliationService.ts) - Broker state sync
- [live/alerts/OrderAlertService.ts](live/alerts/OrderAlertService.ts) - Order event notifications
- [logging/logger.ts](logging/logger.ts) - Winston + Prisma logging

### AI Integration
- [evaluation/StrategyEvaluatorClient.ts](evaluation/StrategyEvaluatorClient.ts) - Strategy evaluation client (WebSocket-based)
- [ai-gateway-live/src/index.ts](ai-gateway-live/src/index.ts) - ACP Gateway WebSocket server for AI agents
- [ai-gateway-live/src/config.ts](ai-gateway-live/src/config.ts) - Agent persona prompts and configuration
- [broker/twsSectorData.ts](broker/twsSectorData.ts) - TWS sector/industry classification client

### CLI Tools
- [cli/add-strategy.ts](cli/add-strategy.ts) - Add strategy from YAML file
- [cli/list-strategies.ts](cli/list-strategies.ts) - List strategies by status/user
- [cli/close-strategy.ts](cli/close-strategy.ts) - Close active strategy
- [cli/rollback-strategy.ts](cli/rollback-strategy.ts) - Revert to previous version
- [cli/export-strategy.ts](cli/export-strategy.ts) - Export strategy to YAML

### Web Dashboard
- [web-client/app/page.tsx](web-client/app/page.tsx) - Next.js dashboard homepage (1143 lines)
- [web-client/app/components/LogsViewer.tsx](web-client/app/components/LogsViewer.tsx) - System logs viewer
- [web-client/app/components/AuditLogsViewer.tsx](web-client/app/components/AuditLogsViewer.tsx) - Order audit trail
- [web-client/src/lib/acpClient.ts](web-client/src/lib/acpClient.ts) - WebSocket client for ACP agent
- [web-client/app/globals.css](web-client/app/globals.css) - Custom styling system

---

## Architectural Patterns

### 1. Service Layer Pattern
Each major subsystem is encapsulated as a service class:
- **Orchestrator** coordinates all services
- **Managers** handle lifecycle and multi-instance coordination
- **Repositories** abstract database operations
- **Adapters** provide uniform broker interface

### 2. Repository Pattern
Database access is abstracted through repositories:
```typescript
class StrategyRepository {
  async create(data: StrategyCreateInput): Promise<Strategy>
  async createWithVersion(data: StrategyCreateInput): Promise<Strategy>  // Recommended
  async findById(id: number): Promise<Strategy | null>
  async findByStatus(status: StrategyStatus): Promise<Strategy[]>
  async activate(strategyId: string): Promise<Strategy>  // PENDING/DRAFT → ACTIVE
  async close(strategyId: string, reason?: string): Promise<Strategy>  // ACTIVE → CLOSED
  async reopen(strategyId: string, reason?: string): Promise<Strategy>  // CLOSED → PENDING (NEW)
  async markFailed(strategyId: string, error: string): Promise<Strategy>
  async updateYaml(strategyId: string, yamlContent: string, changeReason: string): Promise<Strategy>
  async rollbackToVersion(strategyId: string, versionNumber: number): Promise<Strategy>
  async getVersionHistory(strategyId: string): Promise<StrategyVersion[]>
  async getAuditLog(strategyId: string, limit?: number): Promise<StrategyAuditLog[]>
}
```

**Key Methods**:
- `reopen()` - Transitions CLOSED → PENDING, clears closedAt/closeReason, creates audit log. Orchestrator automatically picks up and activates.
- All lifecycle methods create audit log entries for traceability
- `createWithVersion()` creates initial version record (recommended over plain `create()`)
- Version history enables rollback to previous YAML configurations

### 3. Strategy Pattern (Broker Adapters)
Broker-specific logic is isolated in adapter implementations:
```typescript
abstract class BaseBrokerAdapter {
  abstract submitOrderPlan(plan: OrderPlan, env: RuntimeEnv): Order[]
  abstract cancelOpenEntries(symbol: string, orders: Order[], env: RuntimeEnv): CancellationResult
}
```

### 4. Finite State Machine (Runtime Engine)
Strategies execute as state machines with transitions:
```typescript
interface CompiledIR {
  states: Record<string, CompiledState>
  initialState: string
}

interface CompiledState {
  transitions: CompiledTransition[]
}
```

### 5. Observer Pattern (Market Data Distribution)
MultiStrategyManager distributes bars to interested strategy instances:
```typescript
class MultiStrategyManager {
  async processBar(symbol: string, bar: Bar) {
    const instance = this.instances.get(symbol)
    if (instance) await instance.processBar(bar)
  }
}
```

---

## Coding Conventions

### TypeScript Style
- **Strict typing:** All functions have explicit return types
- **No `any`:** Use `unknown` or proper types
- **Async/await:** Preferred over raw promises
- **Error handling:** Always wrap broker/DB calls in try-catch
- **Null safety:** Use `| null` and explicit null checks

### Naming Conventions
- **Classes:** PascalCase (e.g., `StrategyInstance`, `OrderRepository`)
- **Functions:** camelCase (e.g., `processBar`, `submitOrderPlan`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `MAX_CONCURRENT_STRATEGIES`)
- **Interfaces:** PascalCase with `I` prefix optional (e.g., `RuntimeEnv`, `IOrderRepository`)
- **Types:** PascalCase (e.g., `CompiledIR`, `StrategyStatus`)

### File Organization
- **One class per file** for services/managers
- **Related types grouped** in `types.ts` files
- **Index files** export public API only

### Import Order
1. Node.js built-ins
2. External dependencies
3. Internal imports (absolute paths preferred)
4. Type imports

Example:
```typescript
import * as fs from 'fs'
import { PrismaClient } from '@prisma/client'
import { StrategyCompiler } from './compiler/compile'
import type { CompiledIR, RuntimeEnv } from './spec/types'
```

### Error Handling
- **Custom error classes** for domain errors (e.g., `CompilationError`)
- **Preserve stack traces:** Always log original error
- **Graceful degradation:** Log and continue where possible
- **Fail-fast:** Throw on unrecoverable errors

### Logging
- Use centralized `logger` from [logging/logger.ts](logging/logger.ts)
- **Component tagging:** `logger.info('[ComponentName] Message')`
- **Structured metadata:** Pass objects as second parameter
- **Levels:** error, warn, info, debug

Example:
```typescript
logger.info('[MultiStrategyManager] Loading strategy', {
  strategyId,
  symbol,
  timeframe: ir.timeframe
})
```

---

## Data Flow Patterns

### Strategy Lifecycle Flow
```
YAML File
  ↓ (StrategyCompiler)
CompiledIR
  ↓ (StrategyInstance.initialize)
StrategyEngine
  ↓ (processBar)
Feature Computation → Transition Evaluation → Order Submission
  ↓ (BrokerAdapter)
Broker Order Placement
  ↓ (OrderRepository)
Database Persistence
```

### Strategy Swap Flow
```
StrategyLifecycleManager.evaluateStrategy()
  ↓ (Every N bars)
StrategyEvaluatorClient.evaluate()
  ↓ (AI recommendation)
If swap recommended:
  ↓
DistributedLockService.acquireLock(symbol)
  ↓
MultiStrategyManager.cancelOrders(symbol)
  ↓
StrategyRepository.create(newStrategyYAML)
  ↓
MultiStrategyManager.swapStrategyById(oldId, newId)
  ↓
DistributedLockService.releaseLock(symbol)
```

### Order Execution Flow
```
StrategyEngine.executeAction()
  ↓
BrokerAdapter.submitOrderPlan()
  ├─ enforceOrderConstraints()
  ├─ expandSplitBracket() [if needed]
  └─ Submit to broker (TWS/Alpaca)
  ↓
OrderRepository.create() [persist to DB]
  ↓
[Monitor status updates from broker]
  ↓
OrderRepository.updateStatus()
  ↓
OrderAlertService.notify()
```

---

## Common Development Tasks

### Adding a New Technical Indicator

1. **Implement compute function** in [features/indicators.ts](features/indicators.ts):
```typescript
export function computeVWAP(args: any[], bars: Bar[]): number {
  // Implementation
}
```

2. **Register in FeatureRegistry** in [features/registry.ts](features/registry.ts):
```typescript
registry.registerFeature({
  name: 'VWAP',
  computeFn: computeVWAP,
  requiredArgs: [],
  optionalArgs: [],
  description: 'Volume Weighted Average Price'
})
```

3. **Add type definition** in [spec/types.ts](spec/types.ts) if needed

4. **Update YAML schema** in [spec/schema.ts](spec/schema.ts) if adding new syntax

### Adding a New Broker Adapter

1. **Create adapter class** extending `BaseBrokerAdapter`:
```typescript
// broker/myBrokerAdapter.ts
export class MyBrokerAdapter extends BaseBrokerAdapter {
  async submitOrderPlan(plan: OrderPlan, env: RuntimeEnv): Promise<Order[]> {
    // Implementation
  }
  // ... other methods
}
```

2. **Update broker selection** in [live/LiveTradingOrchestrator.ts](live/LiveTradingOrchestrator.ts):
```typescript
if (process.env.BROKER === 'mybroker') {
  adapter = new MyBrokerAdapter()
}
```

3. **Add environment variables** to `.env`

### Adding a New CLI Tool

1. **Create script** in [cli/](cli/) directory:
```typescript
// cli/my-tool.ts
import { RepositoryFactory } from '../database/RepositoryFactory'

async function main() {
  const factory = new RepositoryFactory(/* ... */)
  // Implementation
}

main().catch(console.error)
```

2. **Add npm script** to [package.json](package.json):
```json
{
  "scripts": {
    "tool:my": "tsx cli/my-tool.ts"
  }
}
```

### Modifying the Database Schema

1. **Update Prisma schema** in [prisma/schema.prisma](prisma/schema.prisma):
```prisma
model MyNewTable {
  id        Int      @id @default(autoincrement())
  createdAt DateTime @default(now())
  // ... fields
}
```

2. **Generate migration**:
```bash
npx prisma migrate dev --name add_my_new_table
```

3. **Update repository** in [database/repositories/](database/repositories/)

4. **Regenerate Prisma client**:
```bash
npx prisma generate
```

### Adding a New MCP Tool

1. **Add tool definition** to TOOLS array in [mcp-server.ts](mcp-server.ts):
```typescript
{
  name: 'my_tool',
  description: 'Tool description',
  inputSchema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'Parameter description' }
    },
    required: ['param1']
  }
}
```

2. **Implement tool handler**:
```typescript
async function handleMyTool(args: any) {
  // Implementation
  return { success: true, result: 'data' }
}
```

3. **Wire up handler** in switch statement:
```typescript
case 'my_tool':
  result = await handleMyTool(args);
  break;
```

4. **Test with MCP Inspector**:
```bash
npm run mcp:dev
```

---

## Testing Strategy

### Unit Tests
- **Location:** Co-located with source files or in `__tests__/` directories
- **Framework:** Jest
- **Naming:** `*.test.ts` or `*.spec.ts`
- **Run:** `npm test`

### Integration Tests
- Test full strategy compilation and execution
- Use stub broker adapter for determinism
- Mock external dependencies (DB, broker)

### Manual Testing
- **Dry run mode:** `ALLOW_LIVE_ORDERS=false npm run live:multi`
- **Paper trading:** Use TWS paper account (port 7497)
- **Backtesting:** `npm run backtest -- --strategy=./strategies/my-strategy.yaml`

---

## Debugging Tips

### Viewing Logs
- **Console:** Colored output during runtime
- **Database:** Query `system_logs` table for audit trail
```sql
SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 100;
```

### Strategy Compilation Errors
- Check YAML syntax with online validator
- Enable verbose logging in [compiler/compile.ts](compiler/compile.ts)
- Validate feature names against [features/registry.ts](features/registry.ts)

### Order Submission Issues
- Check broker connection: `logger` output shows connection status
- Verify order constraints in [broker/broker.ts](broker/broker.ts:92-119)
- Review `orders` table for rejection reasons

### Database Connection Issues
- Verify `DATABASE_URL` in `.env`
- Check PostgreSQL is running: `pg_isready`
- Review connection pool settings in [database/RepositoryFactory.ts](database/RepositoryFactory.ts)

### Strategy Not Loading
- Check `strategies` table for status (should be `PENDING`)
- Review [live/DatabasePoller.ts](live/DatabasePoller.ts) logs
- Verify `USER_ID` matches strategy owner

---

## Performance Considerations

### Compilation Performance
- **Caching:** Compiled IR is stored in database to avoid recompilation
- **Validation:** Schema validation happens once at compile time
- **Feature plan:** Topological sort ensures efficient feature computation

### Runtime Performance
- **Bar processing:** Single-threaded per strategy, parallelized across strategies
- **Feature computation:** Only computes features used in current state
- **Database queries:** Use connection pooling (default: 10 connections)

### Database Optimization
- **Indexes:** Prisma auto-generates indexes on foreign keys
- **Query optimization:** Use `select` to limit returned fields
- **Transactions:** Use for multi-step operations requiring atomicity

### Memory Management
- **Bar history:** Limited to last N bars (configurable)
- **Strategy instances:** One per active strategy (not per bar)
- **Connection pooling:** Limits concurrent DB connections

---

## Security Considerations

### Order Safety
- **Kill switch:** `ALLOW_LIVE_ORDERS=false` disables all order submission
- **Order constraints:** Max quantity, max notional exposure per symbol
- **Daily loss limits:** Tracked per strategy and globally

### Credential Management
- **Environment variables:** Never commit `.env` to git
- **Broker credentials:** Stored in environment, not in code
- **Database credentials:** Use connection string with restricted user

### Distributed Locking
- **PostgreSQL advisory locks:** Prevent concurrent strategy swaps on same symbol
- **Timeout handling:** Locks expire after configurable timeout
- **Fairness:** FIFO queuing ensures fair access

### Audit Logging
- **All operations logged:** Orders, swaps, reconciliations
- **Immutable logs:** `system_logs` table preserves history
- **Traceability:** Component tagging enables correlation

---

## Configuration Reference

### Environment Variables

**Required:**
- `DATABASE_URL` - PostgreSQL connection string
- `USER_ID` - User ID for strategy management

**Broker (TWS):**
- `BROKER=tws` (default)
- `TWS_HOST=127.0.0.1` (default)
- `TWS_PORT=7497` (paper) or `7496` (live)
- `TWS_CLIENT_ID=1` (default)

**Broker (Alpaca):**
- `BROKER=alpaca`
- `ALPACA_API_KEY` - API key
- `ALPACA_API_SECRET` - API secret
- `ALPACA_BASE_URL` - Paper or live URL

**Strategy Settings:**
- `MAX_CONCURRENT_STRATEGIES=5` (default)
- `STRATEGY_WATCH_INTERVAL_MS=5000` (default: 5 seconds)
- `STRATEGY_EVAL_ENABLED=false` (default: disabled)
- `STRATEGY_EVAL_WS_ENDPOINT` - Evaluator WebSocket URL

**Safety Controls:**
- `ALLOW_LIVE_ORDERS=false` (default: dry-run mode)
- `ALLOW_CANCEL_ENTRIES=true` (default)
- `ALLOW_CROSS_SYMBOL_SWAP=false` (default: prevent symbol changes)

**API Server:**
- `PORTFOLIO_API_PORT=3002` (default)

---

## Troubleshooting Common Issues

### Issue: Strategy not loading from database
**Solution:**
1. Check strategy status: `npm run strategy:list`
2. Ensure status is `PENDING` or `ACTIVE`
3. Verify `USER_ID` matches strategy owner
4. Check [live/DatabasePoller.ts](live/DatabasePoller.ts) logs

### Issue: Orders not submitting
**Solution:**
1. Verify `ALLOW_LIVE_ORDERS=true` in `.env`
2. Check broker connection in logs
3. Review order constraints in [broker/broker.ts](broker/broker.ts)
4. Inspect `orders` table for rejection reasons

### Issue: Compilation errors
**Solution:**
1. Validate YAML syntax with online validator
2. Check feature names against [features/registry.ts](features/registry.ts)
3. Review expression syntax in [compiler/expr.ts](compiler/expr.ts)
4. Enable debug logging in [compiler/compile.ts](compiler/compile.ts)

### Issue: Database connection errors
**Solution:**
1. Verify PostgreSQL is running: `pg_isready`
2. Check `DATABASE_URL` format in `.env`
3. Ensure database exists: `createdb stocks_trading`
4. Run migrations: `npx prisma migrate deploy`

### Issue: Strategy swap not happening
**Solution:**
1. Verify `STRATEGY_EVAL_ENABLED=true`
2. Check evaluation interval has elapsed
3. Review [evaluation/StrategyEvaluatorClient.ts](evaluation/StrategyEvaluatorClient.ts) logs
4. Ensure distributed lock is available

---

## Resources

### Documentation
- [README.md](README.md) - Project overview
- [AGENT.md](AGENT.md) - Detailed service architecture
- [logging/README.md](logging/README.md) - Logging system guide

### Example Strategies
- [strategies/live/](strategies/live/) - Active strategies
- [strategies/variations/](strategies/variations/) - Strategy templates
- [strategies/archive/](strategies/archive/) - Historical strategies

### External Documentation
- [Prisma Docs](https://www.prisma.io/docs) - Database ORM
- [TWS API](https://interactivebrokers.github.io/tws-api/) - Interactive Brokers API
- [Alpaca API](https://docs.alpaca.markets/) - Alpaca trading API
- [MCP Protocol](https://modelcontextprotocol.io/) - Model Context Protocol

---

## Web Dashboard

### Overview
The web-client is a **Next.js 14** single-page application providing a comprehensive dashboard for the trading system.

**Framework Stack:**
- Next.js 14.2.8 with App Router
- React 18.3.1
- TypeScript 5.3.3
- Custom CSS (no UI framework)
- React Markdown for content rendering

**Port:** 3000 (default Next.js)

### Features

**1. Chat Interface**
- Real-time WebSocket communication with ACP (Agent Control Protocol) agent
- AI advisor powered by Claude (persona: "blackrock_advisor")
- Message streaming with chunk merging
- Image attachment support (drag-and-drop or file picker)
- Auto-scrolling behavior
- Message history management
- Keyboard shortcuts (Enter to send, Shift+Enter for newline)

**2. Portfolio Dashboard**
- Real-time metrics cards: Realized P&L, Open Positions, Active Strategies, Total Orders
- Current positions table with live P&L
- Strategy performance table with filtering
- Recent trades table
- Strategy detail modal with performance metrics
- Close strategy functionality (ACTIVE → CLOSED)
- Reopen strategy functionality (CLOSED → PENDING, orchestrator auto-picks up)
- Notification system
- Auto-refresh every 10 seconds

**3. Audit Logs Viewer**
- Order audit trail with complete event tracking
- Filter by event type, symbol, strategy name
- Summary statistics (submitted, filled, errors)
- Event breakdown by type
- Status change tracking
- Audit log detail modal with full context

**4. System Logs Viewer**
- Application logs with filtering
- Filter by level (ERROR, WARN, INFO, DEBUG), component, search query
- Log statistics dashboard
- Recent errors display
- Top components by log count
- Log detail modal with metadata and stack traces
- Auto-refresh capability

### Directory Structure

```
web-client/
├── app/
│   ├── page.tsx                    # Main dashboard (1143 lines)
│   ├── layout.tsx                  # Root layout
│   ├── globals.css                 # Custom styling (1015 lines)
│   └── components/
│       ├── LogsViewer.tsx          # System logs component
│       └── AuditLogsViewer.tsx     # Order audit component
├── src/
│   └── lib/
│       └── acpClient.ts            # WebSocket client for agent
├── package.json
├── next.config.js
└── tsconfig.json
```

### API Integration

**Portfolio API (HTTP Polling):**
- Base URL: `http://localhost:3002`
- `GET /api/portfolio/overview` - Portfolio data, strategies, trades
- `POST /api/portfolio/strategies/{id}/close` - Close strategy (ACTIVE → CLOSED)
- `POST /api/portfolio/strategies/{id}/reopen` - Reopen strategy (CLOSED → PENDING)
- `GET /api/logs` - System logs with filters
- `GET /api/logs/stats` - Log statistics
- Auto-refresh: 10s for portfolio, 5s for logs

**ACP Agent (WebSocket):**
- URL: `ws://localhost:8787/acp`
- JSON-RPC 2.0 messaging
- Session persistence via localStorage
- Streaming response support
- Automatic reconnection

### Design System

**Color Palette:**
- Background: `#faf8f5` (warm beige)
- Primary: `#f55036` (red-orange)
- Text: `#1a1a1a` (near black)
- Secondary: `#737373` (medium gray)
- Borders: `#ebe6dd` (light warm gray)

**Status Colors:**
- Active/Success: Green
- Closed/Cancelled: Gray
- Pending/Draft: Amber
- Filled/Submitted: Blue
- Error/Rejected: Red

**UI Patterns:**
- Modals with fade-in overlay and slide-up animation
- Responsive tables with hover effects
- Grid-based card layouts
- Custom form controls
- Loading states with typing dots
- Notification banners with auto-dismiss

### Configuration

**Environment Variables:**
```bash
NEXT_PUBLIC_ACP_URL=ws://localhost:8787/acp          # Agent WebSocket
NEXT_PUBLIC_MCP_URL=http://127.0.0.1:3001/mcp       # MCP HTTP endpoint
NEXT_PUBLIC_ACP_CWD=/Users/pradeeptadash/sandbox     # Agent working dir
```

### Running the Dashboard

```bash
# Development mode
cd web-client
npm install
npm run dev

# Production build
npm run build
npm start

# Access at: http://localhost:3000
```

**Prerequisites:**
- Portfolio API server running on port 3002
- ACP Gateway running on port 8787 (optional, for chat)
- MCP server running on port 3001 (optional, for agent tools)

### State Management

**React Hooks Pattern:**
- `useState` for component state
- `useEffect` for data fetching and side effects
- `useRef` for DOM references
- `useMemo` for shared WebSocket client instance
- localStorage for session persistence
- HTTP polling for real-time updates

**Key State Categories:**
- Chat state (messages, input, session ID)
- UI state (active tab, modals, filters)
- Dashboard state (portfolio data, loading, errors)
- Logs state (logs, stats, auto-refresh)

### Common Tasks

**Adding a New Dashboard Section:**
1. Add new tab to `tabs` array in [web-client/app/page.tsx](web-client/app/page.tsx)
2. Implement tab content component
3. Add API integration for data fetching
4. Update state management
5. Add styles to [web-client/app/globals.css](web-client/app/globals.css)

**Adding a New API Endpoint:**
1. Implement endpoint in [portfolio-api-server.ts](portfolio-api-server.ts)
2. Add fetch call in dashboard component
3. Update TypeScript types
4. Handle loading/error states

**Customizing the Design:**
- Edit CSS custom properties in [web-client/app/globals.css](web-client/app/globals.css)
- Update color palette in `:root` selector
- Modify component-specific styles

---

## MCP Tools for AI Agents

The MCP server exposes the following tools for AI agents to interact with the trading system:

### Strategy Development Tools
- **`get_dsl_schema`** - Get DSL schema documentation (ALWAYS use this first when creating strategies)
- **`get_strategy_template`** - Get YAML template for specific strategy types (rsi, macd, bollinger_bands, etc.)
- **`list_strategy_types`** - List all available indicators and strategy types
- **`validate_strategy`** - Validate YAML against schema
- **`compile_strategy`** - Compile YAML to intermediate representation (IR)

### Backtesting & Analysis Tools ⚠️
- **`backtest_strategy`** - Backtest strategy against historical data
  - **WARNING: Not reliable** - Mock broker has limitations (instant fills, no price validation, no order tracking)
  - **Recommendation: Skip backtesting** - Focus on conservative strategy design with proper risk management instead
- **`analyze_strategy_performance`** - Calculate performance metrics from backtest results
  - Only useful if backtest was run, but backtest results are unreliable

### Market Context Tools
- **`get_portfolio_overview`** - Get historical portfolio data from database (P&L, positions, active strategies, recent trades)
  - Data source: Database (historical fills and orders)
  - Returns: realizedPnL, currentPositions (with avgPrice), activeStrategies, recentTrades, orderStats
  - Note: Does NOT include current market prices or unrealized P&L

- **`get_live_portfolio_snapshot`** ⭐ - Get real-time portfolio snapshot from TWS broker
  - **This is the SAME data used by automated strategy swap evaluations**
  - Data source: TWS/IB Gateway (live broker connection)
  - Parameters: force_refresh (default: false, bypasses 30s cache)
  - Returns:
    - Account: totalValue, cash, buyingPower, unrealizedPnL, realizedPnL
    - Positions: symbol, quantity, avgCost, **currentPrice**, unrealizedPnL, marketValue
  - Use this for deployment decisions requiring live portfolio context
  - Requires: TWS/IB Gateway running and connected

- **`get_market_data`** - Get recent OHLCV bars for a symbol
  - Parameters: symbol (required), timeframe (default: "5m"), limit (default: 100)
  - Data source: TWS historical data API
  - Use this to understand current market conditions
  - Returns: bars array with timestamp, OHLCV data, latestPrice

- **`get_active_strategies`** - Get list of currently active strategies
  - Data source: Database
  - Use this to check for conflicts before deploying (avoid duplicate symbols)
  - Returns: strategies array with id, name, symbol, timeframe, status, yamlContent

### Sector Analysis Tools (NEW)
- **`get_sector_info`** - Get sector/industry classification for a symbol
  - Data source: TWS contract details API
  - Parameters: symbol (required)
  - Returns: industry, category, subcategory
  - Use this to understand what sector a stock belongs to
  - Requires: TWS/IB Gateway running

- **`get_sector_peers`** - Get peer stocks in the same sector
  - Data source: TWS contract details + sector mapping
  - Parameters: symbol (required), limit (default: 10)
  - Returns: Array of peer symbols in same sector
  - Use this to find alternative stocks in same industry
  - Requires: TWS/IB Gateway running

- **`get_portfolio_sector_concentration`** ⭐ - Analyze portfolio sector diversification
  - **Use this before deploying new strategies to assess concentration risk**
  - Data source: TWS portfolio + sector classification
  - Parameters: force_refresh (default: false)
  - Returns:
    - sectorExposure: Array of sectors with marketValue, percentage, positions
    - diversificationScore: Number of sectors represented
    - topSector: Largest sector exposure with details
  - Warns if >30% concentration in single sector
  - Requires: TWS/IB Gateway running

### Deployment Tools
- **`deploy_strategy`** - Deploy strategy to live trading system
  - Creates database record with status PENDING
  - Orchestrator automatically picks up and activates
  - User and account loaded from environment variables (USER_ID, TWS_ACCOUNT_ID)

### AI Agent Strategy Deployment Workflow

When an AI agent helps deploy a new strategy, it should follow this workflow:

1. **Gather Context** (SAME as automated swap evaluation):
```typescript
// Get LIVE portfolio snapshot from TWS (real-time data)
const livePortfolio = await get_live_portfolio_snapshot()
// - Account value, cash, buying power
// - Current positions with live prices and unrealized P&L
// - Risk exposure assessment

// Get historical portfolio data from DB (optional, for trends)
const dbPortfolio = await get_portfolio_overview()
// - Recent trades and performance
// - Realized P&L history
// - Strategy performance metrics

// Get market data
const marketData = await get_market_data({ symbol: "AAPL", timeframe: "5m", limit: 100 })
// - Analyze recent price action
// - Check volatility
// - Identify trends

// Check for conflicts
const activeStrategies = await get_active_strategies()
// - Ensure no duplicate symbols (unless user explicitly wants)
// - Review timeframe distribution
```

2. **Create Strategy** (with context-aware decisions):
```typescript
// Use DSL schema first
const schema = await get_dsl_schema({ section: 'full' })

// Consider:
// - Current portfolio exposure (don't over-concentrate)
// - Market conditions (volatility, trend)
// - Active strategy conflicts
// - Risk management (position sizes, stop losses)

// DSL Expression Syntax Features:
// ✅ Array indexing SUPPORTED: Use feature[1] for previous bar, feature[2] for 2 bars ago, etc.
// ✅ Dot notation SUPPORTED: macd.histogram auto-converts to macd_histogram internally
// ✅ Combined syntax: macd.histogram[1] OR macd_histogram[1] (both work)
// ✅ Crossover detection: macd_histogram > 0 && macd_histogram[1] <= 0
// ✅ Momentum comparison: close[0] > close[1] (current > previous)
// ✅ Multi-bar patterns: rsi[0] > rsi[1] && rsi[1] > rsi[2]
// ✅ History limit: 100 bars stored, index 0=current to 99=oldest

// Supported Indicators:
// - Basic: close, open, high, low, volume
// - Moving Averages: ema20, ema50, sma50, sma150, sma200
// - Oscillators: rsi, macd, macd_signal, macd_histogram, stochastic_k, stochastic_d
// - Momentum: macd_histogram_rising, macd_histogram_falling, macd_bullish_crossover, macd_bearish_crossover
// - Momentum: rsi_rising, rsi_falling, price_rising, price_falling, green_bar, red_bar
// - Volatility: bb_upper, bb_middle, bb_lower, atr
// - Volume: volume_sma, volume_ema, volume_zscore, obv
// - Others: vwap, adx, cci, williams_r, hod, lod

// Create strategy YAML
const yamlContent = `
meta:
  name: "AAPL RSI Mean Reversion"
  symbol: "AAPL"
  timeframe: "5m"

features:
  - name: rsi
  - name: ema20

rules:
  arm: "rsi < 30"
  trigger: "close > ema20"
  ...
`
```

3. **Validate**:
```typescript
// Validate syntax and schema compliance
const validation = await validate_strategy({ yaml_content: yamlContent })

// Note: Skip backtesting - the mock broker implementation is unrealistic
// (instant fills, no price validation, no order tracking)
// Instead: Design conservative strategies with proper risk management
```

4. **Deploy**:
```typescript
// Deploy to live system
const deployment = await deploy_strategy({ yaml_content: yamlContent })
// Strategy status: PENDING → orchestrator picks up → ACTIVE
```

**Key Principle:** Just like the automated swap system uses `StrategyEvaluatorClient.evaluate()` with full context (portfolio, market data, performance), AI agents should gather the same context before deployment decisions.

### Agent Persona Configuration

The **BlackRock advisor agent** (`blackrock_advisor` persona) is configured in [ai-gateway-live/src/config.ts](ai-gateway-live/src/config.ts) with the above workflow built into its system prompt. When users interact with this agent in the web dashboard, it will automatically follow the 5-step workflow for strategy deployments.

**See detailed workflow example:** [docs/agent-workflow-example.md](docs/agent-workflow-example.md)

---

## AI Agent Architecture

The system implements a **two-tier AI agent architecture** for adaptive trading strategy management:

### 1. Chat Agent (Strategy Creation)
**Primary Role**: Create high-quality strategies upfront at deployment time

**Location**: [ai-gateway-live/src/config.ts](ai-gateway-live/src/config.ts) - `blackrock_advisor` persona

**Capabilities**:
- **Multi-Bar Trend Analysis**: Analyzes 20+ bars to identify trend direction (bullish/bearish/sideways)
- **Entry Zone Feasibility Validation**: Ensures entry zones align with trend direction
- **Portfolio Context Awareness**: Checks sector concentration, buying power, position conflicts
- **Risk Management**: Position sizing relative to account value, volatility-adjusted stops

**Workflow** (5 steps):
1. **Gather Live Context**: `get_live_portfolio_snapshot()`, `get_portfolio_sector_concentration()`, `get_market_data()`, `get_active_strategies()`
2. **Analyze & Recommend**:
   - **CRITICAL: Multi-Bar Trend Analysis** - Compare current price to 10, 20, 50 bars ago
   - **CRITICAL: Entry Zone Feasibility Check** - Validate alignment with trend:
     - Bullish trend + BUY zone above = ✅ Momentum continuation
     - Bearish trend + BUY zone above = ❌ MISALIGNED (MSFT case study in prompt)
     - Bearish trend + BUY zone below = ✅ Mean reversion
3. **Create Strategy**: Design YAML with proper indicators and risk parameters
4. **Validate**: `validate_strategy()` for syntax compliance
5. **Deploy**: `deploy_strategy()` creates PENDING strategy

**Enhanced Prompt Features** (as of 2026-01):
- Explicit trend analysis requirements (20 bars minimum)
- Entry zone validation decision matrix
- MSFT case study showing wrong momentum breakout example
- Remediation steps for misaligned strategies

**Expected Impact**:
- Catch 70-80% of obvious mistakes upfront (trend misalignment, over-concentration, etc.)
- Reduce evaluator swap rate from ~40% to ~20-30%
- Most swaps should be legitimate mid-session regime changes

### 2. Evaluator Agent (Runtime Monitoring)
**Primary Role**: Monitor and swap/close strategies mid-session that stop working

**Location**: [evaluation/StrategyEvaluatorClient.ts](evaluation/StrategyEvaluatorClient.ts)

**Capabilities**:
- **Runtime Performance Analysis**: Observes actual strategy behavior over hours/days
- **Regime Change Detection**: Identifies when market conditions shift mid-session
- **Execution Pattern Analysis**: Detects repeated order rejections or failed entries
- **Adaptive Swapping**: Proposes replacement strategies based on current conditions

**When Evaluator Triggers** (every N bars, configurable):
1. Strategy has zero orders placed for extended period
2. Win rate declining significantly
3. Stop loss breached repeatedly
4. Market volatility spike changes conditions
5. Entry zone no longer reachable due to trend shift

**Evaluator Advantages Over Chat Agent**:
- Has runtime data (2+ days of actual trading)
- Sees failed execution patterns
- Observes regime changes chat agent couldn't predict
- Can analyze performance metrics unavailable at time=0

**MCP Tool Access**:
- `validate_strategy()` - Verify replacement strategy syntax
- Access to same market data tools as chat agent
- Can propose swaps or closure recommendations

**System Prompt**: [evaluation/StrategyEvaluatorClient.ts:250-540](evaluation/StrategyEvaluatorClient.ts#L250-L540)
- Includes DSL syntax validation guidance
- Entry zone evaluation logic
- Full indicator list
- Instructions to use `validate_strategy()` before recommending changes

### Division of Responsibilities

**Chat Agent**: Prevent mistakes **before** deployment
- Trend analysis at time=0
- Entry zone feasibility validation
- Portfolio risk assessment
- Strategy type selection (momentum vs mean reversion)

**Evaluator Agent**: React to problems **during** execution
- Intraday regime changes (market shifts from bullish to bearish)
- News catalysts (surprise Fed announcements, earnings)
- Failed execution patterns (broker rejections)
- Performance deterioration over time

### Example Scenario: MSFT Strategy

**Before Chat Enhancement**:
1. User: "Create MSFT momentum breakout"
2. Chat: Creates BUY [461, 462] without trend analysis
3. Deploys strategy (price at 459.87, trending down)
4. **2 days later**: Evaluator detects zero orders, recommends mean reversion swap
5. Result: 2 days wasted, evaluator fixes chat mistake

**After Chat Enhancement**:
1. User: "Create MSFT momentum breakout"
2. Chat: Calls `get_market_data()`, analyzes 20 bars
3. Chat: Detects bearish trend (-0.56%), price at 459.87
4. Chat: Sees proposed BUY [461, 462] is above current (misalignment)
5. Chat: **Warns user**, recommends mean reversion BUY [455, 458] instead
6. Deploys better strategy from the start
7. Result: No wasted time, evaluator handles legitimate mid-session changes only

### Configuration Files

**Chat Agent Prompt**: [ai-gateway-live/src/config.ts:32-94](ai-gateway-live/src/config.ts#L32-L94)
- PERSONA_PROMPTS.blackrock_advisor
- 5-step deployment workflow
- Multi-bar trend analysis requirements
- Entry zone feasibility matrix
- MSFT case study

**Evaluator Prompt**: [evaluation/StrategyEvaluatorClient.ts:250-540](evaluation/StrategyEvaluatorClient.ts#L250-L540)
- buildEvaluationPrompt() method
- DSL syntax validation instructions
- Entry zone semantics for BUY/SELL orders
- Full indicator reference

**MCP Server Config**:
- Chat agent: [web-client/src/lib/acpClient.ts:15](web-client/src/lib/acpClient.ts#L15) - `env: []` array format
- Evaluator: [evaluation/StrategyEvaluatorClient.ts:197](evaluation/StrategyEvaluatorClient.ts#L197) - `env: []` array format (fixed 2026-01)

---

## Quick Reference Commands

```bash
# Build
npm run build

# Run multi-strategy orchestrator
npm run live:multi:build

# Add strategy from file
npm run strategy:add -- --user=user123 --file=./strategies/my-strategy.yaml

# List active strategies
npm run strategy:list -- --status=ACTIVE

# Close strategy
npm run strategy:close -- --id=123 --reason="Not profitable"

# Start API server
npm run portfolio:api:dev

# Start MCP server
npm run mcp

# Start web dashboard
cd web-client && npm run dev

# Run all services
npm run dev:all

# Database migrations
npx prisma migrate dev
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate

# Run tests
npm test

# Backtest strategy
npm run backtest -- --strategy=./strategies/my-strategy.yaml
```

---

## Contributing Guidelines

When making changes:
1. **Read existing code** before modifying
2. **Follow conventions** outlined in this guide
3. **Add logging** for important operations
4. **Update types** when adding new features
5. **Test thoroughly** with dry-run mode first
6. **Document changes** in code comments and this guide
7. **Preserve backward compatibility** where possible

---

This guide is maintained to help Claude Code sessions quickly understand and work with this codebase. For detailed architecture documentation, see [AGENT.md](AGENT.md).
