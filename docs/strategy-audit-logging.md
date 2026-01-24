# Strategy Audit Logging Implementation

## Overview

Complete audit trail for all strategy lifecycle events, providing visibility into strategy changes, status transitions, and automated swap decisions.

## Database Schema

### StrategyAuditLog Model

Location: [prisma/schema.prisma](../prisma/schema.prisma:566-595)

```prisma
model StrategyAuditLog {
  id              String            @id @default(cuid())
  strategyId      String
  eventType       StrategyEventType
  oldStatus       StrategyStatus?
  newStatus       StrategyStatus?
  changedBy       String?           // userId or 'system' or 'evaluator'
  changeReason    String?           @db.Text
  metadata        Json?             // Additional context (e.g., swap details, evaluation results)
  createdAt       DateTime          @default(now())

  @@index([strategyId, createdAt])
  @@index([eventType])
  @@index([changedBy])
  @@map("strategy_audit_log")
}
```

### Event Types

```prisma
enum StrategyEventType {
  CREATED          // Strategy initially created
  ACTIVATED        // Strategy activated by orchestrator
  CLOSED           // Strategy closed (manual or automated)
  ARCHIVED         // Strategy archived (invalid/deprecated)
  FAILED           // Compilation/validation failed
  YAML_UPDATED     // Strategy YAML content changed
  ROLLED_BACK      // Rolled back to previous version
  SWAPPED_IN       // Strategy swapped in (became active)
  SWAPPED_OUT      // Strategy swapped out (became closed)
  DELETED          // Strategy soft deleted
  STATUS_CHANGED   // Generic status change
}
```

## Repository Methods

### Creating Audit Log Entries

**Location:** [database/repositories/StrategyRepository.ts](../database/repositories/StrategyRepository.ts:14-29)

```typescript
async createAuditLog(params: {
  strategyId: string;
  eventType: StrategyEventType;
  oldStatus?: StrategyStatus;
  newStatus?: StrategyStatus;
  changedBy?: string;
  changeReason?: string;
  metadata?: Record<string, unknown>;
}): Promise<void>
```

### Querying Audit Logs

```typescript
// Get audit log for specific strategy
async getAuditLog(strategyId: string, limit: number = 100)

// Get all audit logs (admin/debugging)
async getAllAuditLogs(limit: number = 100)
```

## Audit Trail for Each Operation

### 1. Strategy Creation

**Method:** `createWithVersion()`
**Location:** [StrategyRepository.ts:55-112](../database/repositories/StrategyRepository.ts:55-112)

**Audit Entry:**
```typescript
{
  eventType: 'CREATED',
  newStatus: 'DRAFT',
  changedBy: userId,
  changeReason: 'Initial version',
  metadata: {
    symbol: 'AAPL',
    name: 'AAPL RSI Strategy',
    timeframe: '5m'
  }
}
```

**Example Output:**
```
[2026-01-18 10:30:00] user123 CREATED strategy (DRAFT)
  Reason: Initial version
  Symbol: AAPL, Name: AAPL RSI Strategy, Timeframe: 5m
```

### 2. Strategy Activation

**Method:** `activate()`
**Location:** [StrategyRepository.ts:228-255](../database/repositories/StrategyRepository.ts:228-255)

**Audit Entry:**
```typescript
{
  eventType: 'ACTIVATED',
  oldStatus: 'PENDING',
  newStatus: 'ACTIVE',
  changedBy: 'system',
  changeReason: 'Strategy activated by orchestrator'
}
```

**Example Output:**
```
[2026-01-18 10:31:00] system ACTIVATED strategy (PENDING → ACTIVE)
  Reason: Strategy activated by orchestrator
```

### 3. Strategy Closure

**Method:** `close()`
**Location:** [StrategyRepository.ts:260-288](../database/repositories/StrategyRepository.ts:260-288)

**Audit Entry:**
```typescript
{
  eventType: 'CLOSED',
  oldStatus: 'ACTIVE',
  newStatus: 'CLOSED',
  changedBy: 'evaluator',
  changeReason: 'Underperforming: -5% vs benchmark -2%'
}
```

**Example Output:**
```
[2026-01-18 14:00:00] evaluator CLOSED strategy (ACTIVE → CLOSED)
  Reason: Underperforming: -5% vs benchmark -2%
```

### 4. Strategy Archival

**Method:** `archive()`
**Location:** [StrategyRepository.ts:293-321](../database/repositories/StrategyRepository.ts:293-321)

**Audit Entry:**
```typescript
{
  eventType: 'ARCHIVED',
  oldStatus: 'FAILED',
  newStatus: 'ARCHIVED',
  changedBy: 'system',
  changeReason: 'Compilation failed: Unknown indicator "invalid_rsi"'
}
```

### 5. Strategy Failure

**Method:** `markFailed()`
**Location:** [StrategyRepository.ts:326-353](../database/repositories/StrategyRepository.ts:326-353)

**Audit Entry:**
```typescript
{
  eventType: 'FAILED',
  oldStatus: 'PENDING',
  newStatus: 'FAILED',
  changedBy: 'system',
  changeReason: 'Validation error: features.rsi.period must be > 0'
}
```

### 6. YAML Update

**Method:** `updateYaml()`
**Location:** [StrategyRepository.ts:168-223](../database/repositories/StrategyRepository.ts:168-223)

**Audit Entry:**
```typescript
{
  eventType: 'YAML_UPDATED',
  oldStatus: 'ACTIVE',
  newStatus: 'ACTIVE',
  changedBy: 'user123',
  changeReason: 'Updated RSI threshold from 30 to 35',
  metadata: {
    versionNumber: 5,
    changeType: 'MANUAL_EDIT'
  }
}
```

### 7. Version Rollback

**Method:** `rollbackToVersion()`
**Location:** [StrategyRepository.ts:368-433](../database/repositories/StrategyRepository.ts:368-433)

**Audit Entry:**
```typescript
{
  eventType: 'ROLLED_BACK',
  oldStatus: 'ACTIVE',
  newStatus: 'ACTIVE',
  changedBy: 'user123',
  changeReason: 'Rolled back to version 3',
  metadata: {
    targetVersionNumber: 3,
    newVersionNumber: 6
  }
}
```

### 8. Soft Delete

**Method:** `softDelete()`
**Location:** [StrategyRepository.ts:438-462](../database/repositories/StrategyRepository.ts:438-462)

**Audit Entry:**
```typescript
{
  eventType: 'DELETED',
  oldStatus: 'CLOSED',
  newStatus: 'CLOSED',
  changedBy: 'user123',
  changeReason: 'Strategy soft deleted'
}
```

## Automated Strategy Swaps

### Swap-Out Event

When a strategy is swapped out (closed by evaluator):

```typescript
await strategyRepo.close(oldStrategyId, reason, 'evaluator');

// Creates audit entry:
{
  eventType: 'SWAPPED_OUT',  // or 'CLOSED'
  oldStatus: 'ACTIVE',
  newStatus: 'CLOSED',
  changedBy: 'evaluator',
  changeReason: 'Swapped out: Underperforming vs benchmark',
  metadata: {
    swapReason: 'performance',
    newStrategyId: 'clxy...',
    evaluationScore: -0.05
  }
}
```

### Swap-In Event

When a new strategy is swapped in:

```typescript
await strategyRepo.activate(newStrategyId, 'evaluator');

// Creates audit entry:
{
  eventType: 'SWAPPED_IN',  // or 'ACTIVATED'
  oldStatus: 'PENDING',
  newStatus: 'ACTIVE',
  changedBy: 'evaluator',
  changeReason: 'Swapped in: Replacing underperforming strategy',
  metadata: {
    replacedStrategyId: 'clxw...',
    evaluationScore: 0.15
  }
}
```

## Usage Examples

### Query Strategy Audit Trail

```typescript
const strategyRepo = factory.getStrategyRepo();

// Get full audit history for strategy
const auditLog = await strategyRepo.getAuditLog(strategyId, 100);

auditLog.forEach(entry => {
  console.log(`[${entry.createdAt}] ${entry.changedBy} ${entry.eventType}`);
  console.log(`  ${entry.oldStatus} → ${entry.newStatus}`);
  console.log(`  Reason: ${entry.changeReason}`);
  if (entry.metadata) {
    console.log(`  Metadata:`, entry.metadata);
  }
});
```

**Output:**
```
[2026-01-18 10:30:00] user123 CREATED
  null → DRAFT
  Reason: Initial version
  Metadata: { symbol: 'AAPL', name: 'AAPL RSI Strategy', timeframe: '5m' }

[2026-01-18 10:31:00] system ACTIVATED
  PENDING → ACTIVE
  Reason: Strategy activated by orchestrator

[2026-01-18 14:00:00] evaluator CLOSED
  ACTIVE → CLOSED
  Reason: Underperforming: -5% vs benchmark -2%
```

### Filter Audit Logs by Event Type

```sql
SELECT * FROM strategy_audit_log
WHERE "eventType" IN ('SWAPPED_IN', 'SWAPPED_OUT')
ORDER BY "createdAt" DESC
LIMIT 50;
```

### Analyze Strategy Lifecycle

```sql
-- Count events by type
SELECT "eventType", COUNT(*) as count
FROM strategy_audit_log
GROUP BY "eventType"
ORDER BY count DESC;

-- Average time from creation to activation
SELECT AVG(activated."createdAt" - created."createdAt") as avg_activation_time
FROM strategy_audit_log created
JOIN strategy_audit_log activated
  ON created."strategyId" = activated."strategyId"
WHERE created."eventType" = 'CREATED'
  AND activated."eventType" = 'ACTIVATED';

-- Strategies closed by evaluator
SELECT "strategyId", "changeReason", "createdAt"
FROM strategy_audit_log
WHERE "eventType" = 'CLOSED'
  AND "changedBy" = 'evaluator'
ORDER BY "createdAt" DESC;
```

## Integration with Existing Systems

### MultiStrategyManager Integration

When strategy swaps occur, the MultiStrategyManager should create audit entries:

**Location:** [live/MultiStrategyManager.ts](../live/MultiStrategyManager.ts)

```typescript
// When closing old strategy
await this.strategyRepo.close(
  oldInstance.strategyId,
  `Swapped out: ${reason}`,
  'evaluator'
);

// When activating new strategy
await this.strategyRepo.activate(
  newStrategyId,
  'evaluator'
);
```

### CLI Tools Integration

**close-strategy.ts:**
```typescript
await strategyRepo.close(
  strategyId,
  reason,
  userId // Pass actual userId instead of 'system'
);
```

**rollback-strategy.ts:**
```typescript
await strategyRepo.rollbackToVersion(
  strategyId,
  versionNumber,
  userId
);
```

## API Endpoints

### Get Strategy Audit Log

**Endpoint:** `GET /api/strategies/:id/audit-log`
**Implementation:** Add to [portfolio-api-server.ts](../portfolio-api-server.ts)

```typescript
app.get('/api/strategies/:id/audit-log', async (req, res) => {
  const { id } = req.params;
  const limit = parseInt(req.query.limit as string) || 100;

  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  const auditLog = await strategyRepo.getAuditLog(id, limit);

  res.json({
    success: true,
    strategyId: id,
    auditLog: auditLog.map(entry => ({
      id: entry.id,
      eventType: entry.eventType,
      oldStatus: entry.oldStatus,
      newStatus: entry.newStatus,
      changedBy: entry.changedBy,
      changeReason: entry.changeReason,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    })),
    count: auditLog.length,
  });
});
```

### Get All Audit Logs (Admin)

**Endpoint:** `GET /api/audit-logs/strategies`

```typescript
app.get('/api/audit-logs/strategies', async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const eventType = req.query.eventType as string;

  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  let auditLogs = await strategyRepo.getAllAuditLogs(limit);

  // Filter by event type if provided
  if (eventType) {
    auditLogs = auditLogs.filter(log => log.eventType === eventType);
  }

  res.json({
    success: true,
    auditLogs,
    count: auditLogs.length,
  });
});
```

## Web Dashboard Integration

### Audit Log Viewer Component

Similar to [AuditLogsViewer.tsx](../web-client/app/components/AuditLogsViewer.tsx) for orders:

**File:** `web-client/app/components/StrategyAuditViewer.tsx`

**Features:**
- Timeline view of strategy lifecycle events
- Filter by event type (Created, Activated, Closed, Swapped, etc.)
- Search by strategy name/symbol
- Event detail modal with full metadata
- Color-coded event types (Created: Blue, Activated: Green, Closed: Red, Swapped: Purple)

### Strategy Detail Modal

Add audit log tab to strategy detail view:

```tsx
<Tabs>
  <Tab label="Overview">...</Tab>
  <Tab label="Performance">...</Tab>
  <Tab label="Orders">...</Tab>
  <Tab label="Audit Log">
    <StrategyAuditTimeline strategyId={strategyId} />
  </Tab>
</Tabs>
```

## Benefits

### 1. Complete Audit Trail
- Every strategy change is logged with timestamp, actor, and reason
- Satisfies compliance and regulatory requirements
- Enables forensic analysis of strategy performance

### 2. Swap Transparency
- Clear visibility into automated swap decisions
- Track evaluator recommendations and actions
- Analyze swap frequency and effectiveness

### 3. User Accountability
- Track which user made which changes
- Distinguish between automated (system/evaluator) and manual (user) changes
- Audit trail for multi-user environments

### 4. Debugging & Analysis
- Identify patterns in strategy failures
- Analyze time-to-activation for new strategies
- Track frequency of manual interventions vs automated swaps

### 5. Operational Insights
- Average strategy lifespan (Created → Closed)
- Most common close reasons
- User with most strategy changes
- Evaluator effectiveness metrics

## Migration

**Migration File:** `prisma/migrations/20260118185309_add_strategy_audit_log/migration.sql`

**Generated:**
- `StrategyEventType` enum with 11 event types
- `strategy_audit_log` table with all fields
- Three indexes for performance:
  - `(strategyId, createdAt)` - Strategy audit history queries
  - `(eventType)` - Filter by event type
  - `(changedBy)` - Filter by user/system/evaluator

**Applied:** 2026-01-18 18:53:09

## Future Enhancements

### 1. Audit Log Retention Policy
Implement automatic archival of old audit logs:
```sql
-- Archive audit logs older than 1 year
CREATE TABLE strategy_audit_log_archive AS
SELECT * FROM strategy_audit_log
WHERE "createdAt" < NOW() - INTERVAL '1 year';

DELETE FROM strategy_audit_log
WHERE "createdAt" < NOW() - INTERVAL '1 year';
```

### 2. Real-Time Audit Notifications
Push audit events to web dashboard via WebSocket:
```typescript
// When audit entry created
io.emit('strategy:audit', {
  strategyId,
  eventType,
  timestamp: new Date(),
  ...auditEntry
});
```

### 3. Audit Log Analytics
Dashboard showing:
- Strategy lifecycle heatmap
- Swap frequency by time of day
- User activity breakdown
- Evaluator decision accuracy

### 4. Audit Log Search
Full-text search on `changeReason`:
```sql
SELECT * FROM strategy_audit_log
WHERE "changeReason" ILIKE '%underperforming%'
ORDER BY "createdAt" DESC;
```

### 5. Compliance Export
Export audit logs for compliance reporting:
```typescript
async exportAuditLog(startDate: Date, endDate: Date): Promise<CSV> {
  // Generate CSV with all audit entries in date range
}
```

## Summary

The strategy audit logging system provides complete visibility into strategy lifecycle events, enabling:

✅ **Compliance** - Full audit trail for regulatory requirements
✅ **Transparency** - Clear visibility into automated swap decisions
✅ **Accountability** - Track user vs system vs evaluator changes
✅ **Debugging** - Analyze strategy failures and performance
✅ **Insights** - Operational metrics and user behavior analysis

All strategy status changes, YAML updates, and lifecycle events are now logged with rich metadata for comprehensive audit trails.
