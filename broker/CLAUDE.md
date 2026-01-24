# Broker Adapters — Local Rules

## Overview
Broker adapter implementations providing uniform interface to Interactive Brokers TWS and Alpaca. Isolates broker-specific logic from trading engine.

## Purpose
- Abstract broker differences behind common interface
- Handle order submission, cancellation, status tracking
- Fetch market data and portfolio snapshots
- Manage broker connections and authentication

## Stack
- **Language:** TypeScript 5.3.3
- **TWS:** `ib` npm package (0.2.9) for Interactive Brokers API
- **Alpaca:** REST API client
- **Pattern:** Strategy pattern with abstract base class

## Key Files
- `broker.ts` - **Abstract base class** and common types
  - `BaseBrokerAdapter` abstract class
  - Order constraints enforcement
  - Split bracket order expansion
- `twsAdapter.ts` - Interactive Brokers TWS implementation (37063 lines)
  - Connection management
  - Order submission and tracking
  - Error handling and retries
- `twsMarketData.ts` - TWS market data fetching
  - Historical bars
  - Real-time quotes
- `twsPortfolio.ts` - TWS portfolio snapshots
  - Account summary
  - Position tracking
  - Unrealized P&L
- `twsSectorData.ts` - TWS sector analysis
  - Sector classification
  - Relative performance
- `alpacaRest.ts` - Alpaca broker implementation
  - REST API client
  - Order management
  - Market data

## Architecture

### Adapter Interface
```typescript
abstract class BaseBrokerAdapter {
  // Order Management
  abstract submitOrderPlan(plan: OrderPlan, env: RuntimeEnv): Promise<Order[]>
  abstract cancelOpenEntries(symbol: string, orders: Order[], env: RuntimeEnv): Promise<CancellationResult>
  abstract getOrderStatus(brokerId: string): Promise<OrderStatus>

  // Market Data
  abstract fetchBars(symbol: string, timeframe: string, count: number): Promise<Bar[]>
  abstract getCurrentPrice(symbol: string): Promise<number>

  // Portfolio
  abstract getPortfolioSnapshot(): Promise<PortfolioSnapshot>
  abstract getPositions(): Promise<Position[]>
}
```

### Order Flow
```
StrategyEngine
  ↓
OrderPlan (high-level intent)
  ↓
BaseBrokerAdapter.submitOrderPlan()
  ├─ enforceOrderConstraints() (max quantity, notional)
  ├─ expandSplitBracket() (if entry split across orders)
  └─ Adapter-specific submission (TWS/Alpaca)
  ↓
Broker API
  ↓
Order[] (with broker IDs)
  ↓
OrderRepository.create() (persist to DB)
```

### Order Constraints
Applied before submission:
- **Max quantity per order:** Prevent fat-finger errors
- **Max notional exposure:** Limit $ risk per symbol
- **Symbol validation:** Ensure valid ticker
- **Account validation:** Verify sufficient buying power

## Conventions

### TWS-Specific
- **Connection:** Maintain persistent connection to TWS gateway
- **Client ID:** Use unique client ID per session (from env)
- **Order IDs:** Auto-increment from TWS initial order ID
- **Reconnection:** Handle disconnects with exponential backoff
- **Error codes:** Map TWS error codes to domain errors

### Alpaca-Specific
- **Authentication:** API key/secret in headers
- **Rate limits:** Respect 200 req/min limit
- **Paper trading:** Use paper URL for testing
- **Webhooks:** Optional real-time order updates

### Error Handling
- **Retries:** Use exponential backoff for transient errors
- **Logging:** Log all broker interactions with metadata
- **Graceful degradation:** Continue on non-critical errors
- **Order tracking:** Always persist order before submission

Example:
```typescript
try {
  const order = await broker.submitOrder(plan)
  await orderRepo.create(order)
  logger.info('[TWS] Order submitted', { brokerId: order.brokerId })
} catch (error) {
  logger.error('[TWS] Order submission failed', { error, plan })
  throw new BrokerError('Submission failed', { cause: error })
}
```

### Order ID Management
- **Broker ID:** Unique ID from broker (string)
- **Internal ID:** Database primary key (number)
- **Mapping:** Store both for reconciliation

### Price Precision
- **TWS:** Uses floating-point prices
- **Alpaca:** Uses decimal prices (string)
- **Rounding:** Round to 2 decimal places for stocks

## Development Workflow

### Testing TWS Connection
```bash
# Ensure TWS/IB Gateway is running
npm run test:tws

# Check connection in code
const adapter = new TWSAdapter()
await adapter.connect()
const positions = await adapter.getPositions()
console.log('Connected, positions:', positions)
```

### Adding a New Broker
1. Create new adapter file: `broker/myBrokerAdapter.ts`
2. Extend `BaseBrokerAdapter`
3. Implement all abstract methods
4. Add broker selection in `live/LiveTradingOrchestrator.ts`:
   ```typescript
   if (process.env.BROKER === 'mybroker') {
     adapter = new MyBrokerAdapter()
   }
   ```
5. Add environment variables to `.env`
6. Test thoroughly in paper mode

### Adding Order Constraints
1. Update `enforceOrderConstraints()` in `broker.ts`
2. Add validation logic
3. Add test cases
4. Document in CLAUDE.md

### Debugging Broker Issues

**Connection failures:**
- Verify TWS/Gateway is running (port 7497 paper, 7496 live)
- Check `TWS_HOST`, `TWS_PORT`, `TWS_CLIENT_ID` in `.env`
- Review TWS logs for connection errors
- Check firewall/network settings

**Order rejections:**
- Review broker error message
- Check order constraints (quantity, notional)
- Verify account has sufficient buying power
- Check symbol validity
- Review `orders` table for rejection reason

**Market data issues:**
- Verify market data subscriptions active
- Check symbol format (e.g., "AAPL" not "aapl")
- Review timeframe format ("5m", "1h", etc.)
- Check TWS data permissions

## Common Patterns

### Order Submission with Retry
```typescript
async function submitWithRetry(
  plan: OrderPlan,
  maxRetries = 3
): Promise<Order[]> {
  let attempt = 0
  while (attempt < maxRetries) {
    try {
      return await broker.submitOrderPlan(plan, env)
    } catch (error) {
      if (isTransientError(error) && attempt < maxRetries - 1) {
        await sleep(2 ** attempt * 1000) // Exponential backoff
        attempt++
      } else {
        throw error
      }
    }
  }
}
```

### Portfolio Snapshot with Caching
```typescript
let cachedSnapshot: PortfolioSnapshot | null = null
let cacheTime = 0
const CACHE_TTL = 30000 // 30 seconds

async function getPortfolioSnapshot(
  forceRefresh = false
): Promise<PortfolioSnapshot> {
  const now = Date.now()
  if (!forceRefresh && cachedSnapshot && now - cacheTime < CACHE_TTL) {
    return cachedSnapshot
  }

  cachedSnapshot = await broker.getPortfolioSnapshot()
  cacheTime = now
  return cachedSnapshot
}
```

### Order Status Reconciliation
```typescript
async function reconcileOrders(orders: Order[]): Promise<void> {
  for (const order of orders) {
    const brokerStatus = await broker.getOrderStatus(order.brokerId)
    if (brokerStatus !== order.status) {
      await orderRepo.updateStatus(order.id, brokerStatus)
      logger.info('[Reconciliation] Status updated', {
        orderId: order.id,
        oldStatus: order.status,
        newStatus: brokerStatus
      })
    }
  }
}
```

## Safety Rails
- **Kill switch:** `ALLOW_LIVE_ORDERS=false` disables all submissions
- **Order constraints:** Enforced before broker submission
- **Dry-run mode:** Log orders without submitting
- **Account validation:** Verify account before trading
- **Symbol whitelist:** Optional whitelist for allowed symbols

## Performance Considerations
- **Connection pooling:** Maintain persistent connections
- **Batch operations:** Group related operations where possible
- **Caching:** Cache portfolio snapshots (30s TTL)
- **Rate limiting:** Respect broker rate limits
- **Async operations:** Use Promise.all for parallel requests

## TWS-Specific Notes

### Contract Specification
```typescript
const contract: Contract = {
  symbol: 'AAPL',
  secType: 'STK',
  exchange: 'SMART',
  currency: 'USD'
}
```

### Order Types Supported
- **Market:** Immediate execution at best price
- **Limit:** Execution at specified price or better
- **Stop:** Triggered when price reaches stop level
- **Stop-Limit:** Stop with limit price
- **Bracket:** Entry with profit target and stop loss

### Error Code Mapping
Common TWS error codes:
- `200` - No security definition found (invalid symbol)
- `201` - Order rejected (insufficient buying power)
- `202` - Order cancelled
- `399` - Order message (informational)
- `434` - Already connected (duplicate client ID)

## Alpaca-Specific Notes

### Authentication
```typescript
const headers = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET
}
```

### Base URLs
- **Paper:** `https://paper-api.alpaca.markets`
- **Live:** `https://api.alpaca.markets`

### Order Types Supported
- **Market:** Immediate execution
- **Limit:** Execution at limit price or better
- **Stop:** Stop loss order
- **Stop-Limit:** Stop with limit
- **Trailing-Stop:** Dynamic stop based on price movement

---

**Related Files:**
- Root: `/CLAUDE.md` - Full project guide
- Runtime: `/runtime/engine.ts` - Strategy execution engine
- Database: `/database/repositories/OrderRepository.ts` - Order persistence
- Live: `/live/MultiStrategyManager.ts` - Orchestrator using adapters
