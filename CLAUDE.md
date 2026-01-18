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
- [evaluation/StrategyEvaluatorClient.ts](evaluation/StrategyEvaluatorClient.ts) - Strategy evaluation client
- [ai-gateway-live/src/index.ts](ai-gateway-live/src/index.ts) - WebSocket server for AI agents

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
  async findById(id: number): Promise<Strategy | null>
  async findByStatus(status: StrategyStatus): Promise<Strategy[]>
  async update(id: number, data: StrategyUpdateInput): Promise<Strategy>
}
```

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

1. **Implement tool handler** in [mcp-server.ts](mcp-server.ts):
```typescript
server.tool('my_tool', 'Tool description', {
  param1: z.string().describe('Parameter description')
}, async (args) => {
  // Implementation
  return { content: [{ type: 'text', text: result }] }
})
```

2. **Test with MCP Inspector**:
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
- Close strategy functionality
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
- `POST /api/portfolio/strategies/{id}/close` - Close strategy
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
