# Database Layer — Local Rules

## Overview
Repository pattern implementation for database access using Prisma ORM. Abstracts PostgreSQL operations behind clean interfaces.

## Purpose
- Provide type-safe database access
- Centralize query logic
- Enable dependency injection
- Support transactions and complex queries
- Track all trading operations

## Stack
- **ORM:** Prisma 7.2.0
- **Database:** PostgreSQL
- **Pattern:** Repository pattern with factory
- **Language:** TypeScript 5.3.3

## Key Files
- `RepositoryFactory.ts` - **DI container** for repositories
  - Creates and manages repository instances
  - Provides Prisma client access
  - Enables transaction support
- `/repositories/` - Repository implementations
  - `StrategyRepository.ts` - Strategy CRUD and versioning
  - `OrderRepository.ts` - Order management and tracking
  - `ExecutionHistoryRepository.ts` - Strategy swap events
  - `SystemLogRepository.ts` - Application logging
  - `TradeRepository.ts` - P&L tracking
  - `FillRepository.ts` - Order fills
  - `UserRepository.ts` - User management
  - `AccountRepository.ts` - Broker account management

## Schema Overview (`prisma/schema.prisma`)

### Core Models
- **User** - Multi-tenant user accounts
- **Account** - Broker accounts (TWS/Alpaca)
- **Strategy** - Active strategies with YAML content
- **StrategyVersion** - Version history for rollback
- **StrategyExecution** - Swap and evaluation audit trail
- **StrategyEvaluation** - AI evaluation results
- **Order** - Order tracking with broker IDs
- **Fill** - Execution fills
- **Trade** - P&L tracking
- **SystemLog** - Application logs
- **OperationQueue** - Idempotent operation queue
- **OrderAuditLog** - Order event audit

### Key Enums
- **StrategyStatus:** `PENDING`, `ACTIVE`, `CLOSED`, `SWAPPED`
- **OrderStatus:** `PENDING`, `SUBMITTED`, `FILLED`, `CANCELLED`, `REJECTED`, `PARTIAL_FILL`
- **OrderType:** `MARKET`, `LIMIT`, `STOP`, `STOP_LIMIT`, `BRACKET`
- **LogLevel:** `ERROR`, `WARN`, `INFO`, `DEBUG`

## Architecture

### Repository Pattern
```typescript
// Repository interface
interface IStrategyRepository {
  create(data: StrategyCreateInput): Promise<Strategy>
  findById(id: number): Promise<Strategy | null>
  findByStatus(status: StrategyStatus): Promise<Strategy[]>
  update(id: number, data: StrategyUpdateInput): Promise<Strategy>
}

// Implementation
class StrategyRepository implements IStrategyRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: StrategyCreateInput): Promise<Strategy> {
    return this.prisma.strategy.create({ data })
  }
  // ... other methods
}
```

### Factory Pattern
```typescript
class RepositoryFactory {
  constructor(private prisma: PrismaClient) {}

  getStrategyRepository(): StrategyRepository {
    return new StrategyRepository(this.prisma)
  }

  getOrderRepository(): OrderRepository {
    return new OrderRepository(this.prisma)
  }

  // ... other repositories
}
```

### Transaction Support
```typescript
async function swapStrategy(
  oldId: number,
  newId: number,
  factory: RepositoryFactory
): Promise<void> {
  await factory.transaction(async (txFactory) => {
    const strategyRepo = txFactory.getStrategyRepository()
    await strategyRepo.update(oldId, { status: 'SWAPPED' })
    await strategyRepo.update(newId, { status: 'ACTIVE' })
  })
}
```

## Conventions

### Query Patterns
- **Select specific fields:** Use `select` to limit returned data
- **Include relations:** Use `include` for eager loading
- **Filter conditions:** Use `where` for filtering
- **Ordering:** Use `orderBy` for sorting
- **Pagination:** Use `skip` and `take` for pagination

Example:
```typescript
const strategies = await prisma.strategy.findMany({
  where: { status: 'ACTIVE', userId },
  select: { id: true, name: true, symbol: true },
  orderBy: { createdAt: 'desc' },
  take: 10
})
```

### Error Handling
- **Catch Prisma errors:** Wrap database calls in try-catch
- **Check for null:** Handle `findFirst` returning null
- **Unique constraints:** Handle duplicate key errors
- **Foreign keys:** Handle cascade delete errors

Example:
```typescript
try {
  const strategy = await repo.findById(id)
  if (!strategy) {
    throw new NotFoundError(`Strategy ${id} not found`)
  }
  return strategy
} catch (error) {
  if (error instanceof PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      throw new UniqueConstraintError('Strategy name already exists')
    }
  }
  throw error
}
```

### Repository Naming
- **Methods:** camelCase verbs (`create`, `findById`, `updateStatus`)
- **Filters:** Descriptive suffixes (`findByStatus`, `findActiveBySymbol`)
- **Bulk operations:** Prefix with `bulk` (`bulkCreate`, `bulkUpdate`)
- **Counts:** Prefix with `count` (`countActive`, `countByUser`)

### Transaction Guidelines
- **Use for multi-step operations:** Ensure atomicity
- **Keep transactions short:** Minimize lock duration
- **Handle rollback:** Let Prisma auto-rollback on error
- **Avoid nested transactions:** Use single transaction boundary

## Development Workflow

### Running Migrations
```bash
# Create new migration
npx prisma migrate dev --name add_new_column

# Apply migrations (production)
npx prisma migrate deploy

# Reset database (dev only)
npx prisma migrate reset
```

### Updating Schema
1. Edit `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name descriptive_name`
3. Review generated migration in `prisma/migrations/`
4. Update repository methods if needed
5. Regenerate Prisma client: `npx prisma generate`

### Adding a New Repository
1. Create file in `database/repositories/`:
   ```typescript
   // MyRepository.ts
   export class MyRepository {
     constructor(private prisma: PrismaClient) {}

     async findAll(): Promise<MyModel[]> {
       return this.prisma.myModel.findMany()
     }
   }
   ```
2. Add factory method in `RepositoryFactory.ts`:
   ```typescript
   getMyRepository(): MyRepository {
     return new MyRepository(this.prisma)
   }
   ```
3. Use in code:
   ```typescript
   const factory = new RepositoryFactory(prisma)
   const myRepo = factory.getMyRepository()
   ```

### Debugging Database Issues

**Connection errors:**
- Verify `DATABASE_URL` in `.env`
- Check PostgreSQL is running: `pg_isready`
- Test connection: `npx prisma db push`

**Query errors:**
- Enable query logging: `log: ['query', 'error', 'warn']` in Prisma client
- Use Prisma Studio: `npx prisma studio`
- Check migration status: `npx prisma migrate status`

**Performance issues:**
- Add indexes to frequently queried columns
- Use `select` to limit returned fields
- Use connection pooling (default: 10 connections)
- Monitor slow queries in PostgreSQL logs

## Common Patterns

### Find with Fallback
```typescript
async function findOrCreate(
  symbol: string,
  defaults: Partial<Strategy>
): Promise<Strategy> {
  let strategy = await repo.findBySymbol(symbol)
  if (!strategy) {
    strategy = await repo.create({ symbol, ...defaults })
  }
  return strategy
}
```

### Bulk Operations
```typescript
async function bulkCreateOrders(
  orders: OrderCreateInput[]
): Promise<Order[]> {
  return prisma.$transaction(
    orders.map(order => prisma.order.create({ data: order }))
  )
}
```

### Complex Queries
```typescript
async function getStrategyPerformance(
  strategyId: number
): Promise<StrategyPerformance> {
  const [strategy, trades, fills] = await prisma.$transaction([
    prisma.strategy.findUnique({ where: { id: strategyId } }),
    prisma.trade.findMany({ where: { strategyId } }),
    prisma.fill.findMany({
      where: { order: { strategyId } },
      include: { order: true }
    })
  ])

  return calculateMetrics(strategy, trades, fills)
}
```

### Soft Deletes
```typescript
// Mark as closed instead of deleting
async function closeStrategy(id: number): Promise<Strategy> {
  return prisma.strategy.update({
    where: { id },
    data: { status: 'CLOSED', closedAt: new Date() }
  })
}

// Filter out closed strategies
async function findActiveStrategies(): Promise<Strategy[]> {
  return prisma.strategy.findMany({
    where: { status: { not: 'CLOSED' } }
  })
}
```

## Safety Rails
- **No raw SQL:** Use Prisma query builder for type safety
- **Validate inputs:** Check constraints before database operations
- **Use transactions:** For operations requiring atomicity
- **Audit logging:** Log all mutations to `SystemLog` table
- **Backup strategy:** Regular database backups in production

## Performance Considerations
- **Connection pooling:** Default 10 connections, configurable
- **Indexes:** Auto-generated on foreign keys, add for frequent queries
- **Query optimization:** Use `select` to limit fields, avoid N+1 queries
- **Batch operations:** Use transactions for bulk inserts/updates
- **Caching:** Cache frequently read, rarely changed data

## Schema Relationships

```
User 1───* Account
User 1───* Strategy
Strategy 1───* StrategyVersion
Strategy 1───* Order
Strategy 1───* Trade
Strategy 1───* StrategyExecution
Order 1───* Fill
Order 1───* OrderAuditLog
```

## Examples

### Strategy CRUD
```typescript
// Create
const strategy = await strategyRepo.create({
  name: 'RSI Strategy',
  symbol: 'AAPL',
  timeframe: '5m',
  yamlContent: '...',
  userId: 1,
  accountId: 1,
  status: 'PENDING'
})

// Read
const active = await strategyRepo.findByStatus('ACTIVE')

// Update
await strategyRepo.update(strategy.id, { status: 'ACTIVE' })

// Close (soft delete)
await strategyRepo.update(strategy.id, {
  status: 'CLOSED',
  closedAt: new Date()
})
```

### Order Tracking
```typescript
// Create order
const order = await orderRepo.create({
  strategyId: 1,
  symbol: 'AAPL',
  side: 'BUY',
  quantity: 100,
  orderType: 'LIMIT',
  limitPrice: 150.00,
  brokerId: 'TWS-12345',
  status: 'SUBMITTED'
})

// Update status on fill
await orderRepo.updateStatus(order.id, 'FILLED')

// Get all orders for strategy
const orders = await orderRepo.findByStrategy(strategyId)
```

### System Logging
```typescript
await systemLogRepo.create({
  level: 'INFO',
  component: 'MultiStrategyManager',
  message: 'Strategy loaded',
  metadata: { strategyId, symbol },
  userId: 1
})
```

---

**Related Files:**
- Root: `/CLAUDE.md` - Full project guide
- Schema: `/prisma/schema.prisma` - Database schema definition
- Live: `/live/LiveTradingOrchestrator.ts` - Main consumer of repositories
- CLI: `/cli/` - Command-line tools using repositories
