# Winston + PostgreSQL Logging System

Complete logging system for capturing all logs and displaying them on the web dashboard.

## Features

- **Winston Logger**: Industry-standard logging with multiple transports
- **PostgreSQL Storage**: All logs stored in `system_logs` table via Prisma
- **Web Dashboard**: Real-time log viewer with filtering and search
- **Auto-refresh**: Logs update every 5 seconds
- **Rich Filtering**: By level (ERROR, WARN, INFO, DEBUG), component, search query
- **Detailed View**: Click any log to see full details including stack traces and metadata

## Setup

### 1. Run Prisma Migration

```bash
npm run prisma:generate
npx prisma migrate dev --name add_log_fields
```

### 2. Usage in Your Code

```typescript
import { PrismaClient } from '@prisma/client';
import { LoggerFactory } from './logging/logger';

// Initialize Prisma
const prisma = new PrismaClient();

// Set up logger factory (do this once at app startup)
LoggerFactory.setPrisma(prisma);

// Get a logger for your component
const logger = LoggerFactory.getLogger('live-server');

// Log messages
logger.info('Live server started', { symbol: 'AAPL', timeframe: '1h' });
logger.warn('Connection slow', { latency: 500 });
logger.error('Failed to fetch bars', new Error('Network timeout'), { symbol: 'TSLA' });
logger.debug('Bar processed', { price: 150.25, volume: 1000000 });

// Log with strategy/order context
logger.logStrategy('info', 'Strategy activated', 'strategy-id-123', {
  symbol: 'AAPL',
  timeframe: '1h'
});

logger.logOrder('error', 'Order failed', 'order-id-456', {
  reason: 'Insufficient funds'
});
```

### 3. Integration Example: live.ts

```typescript
import { PrismaClient } from '@prisma/client';
import { LoggerFactory } from './logging/logger';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Initialize at top of file
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Set up logger factory
LoggerFactory.setPrisma(prisma);

// Get logger for live server
const logger = LoggerFactory.getLogger('live-server');

async function runLiveTrading(strategyYaml: string, symbol: string) {
  logger.info('Starting live trading', { symbol, timeframe });

  try {
    // Your existing code...
    const bars = await fetchBars(symbol);
    logger.info('Fetched bars', { symbol, count: bars.length });

    // Process strategy
    engine.processBar(bar);
    logger.debug('Processed bar', {
      symbol,
      price: bar.close,
      state: engine.getState()
    });

  } catch (error) {
    logger.error('Live trading failed', error, { symbol });
    throw error;
  }

  logger.info('Live trading completed', { symbol });
}

// Cleanup on exit
process.on('SIGINT', () => {
  logger.info('Shutting down live server');
  LoggerFactory.closeAll();
  prisma.$disconnect();
  process.exit(0);
});
```

### 4. View Logs on Web Dashboard

1. Start the portfolio API server:
   ```bash
   npm run portfolio:api:dev
   ```

2. Start the web client:
   ```bash
   cd web-client
   npm run dev
   ```

3. Open http://localhost:3000 and click the "Logs" tab

## API Endpoints

The portfolio API server exposes these log endpoints:

- `GET /api/logs` - Get system logs
  - Query params:
    - `limit`: Number of logs to return (default: 100)
    - `level`: Filter by level (ERROR, WARN, INFO, DEBUG)
    - `component`: Filter by component name
    - `strategyId`: Filter by strategy ID
    - `since`: Filter by timestamp (ISO date string)

- `GET /api/logs/stats` - Get log statistics
  - Returns counts by level, top components, and recent errors

## Log Levels

- **ERROR**: Critical errors that need attention
- **WARN**: Warning messages about potential issues
- **INFO**: Important informational messages (default level)
- **DEBUG**: Detailed debugging information

Set log level via environment variable:
```bash
LOG_LEVEL=debug npm run live:dev
```

## Architecture

```
┌─────────────────┐
│   live.ts       │
│   (Your Code)   │─────┐
└─────────────────┘     │
                        │ logger.info()
┌─────────────────┐     │
│ LoggerFactory   │◄────┘
│  (Singleton)    │
└────────┬────────┘
         │
         ├──► Console Transport (stdout)
         │
         └──► PrismaTransport
                   │
                   ▼
         ┌──────────────────┐
         │  PostgreSQL DB   │
         │  system_logs     │
         └────────┬─────────┘
                  │
                  │ HTTP API
                  ▼
         ┌──────────────────┐
         │ Portfolio API    │
         │  /api/logs       │
         └────────┬─────────┘
                  │
                  │ fetch()
                  ▼
         ┌──────────────────┐
         │  Web Dashboard   │
         │  Logs Tab        │
         └──────────────────┘
```

## Benefits

1. **Centralized Logging**: All logs in one place
2. **Persistent Storage**: Logs survive restarts
3. **Easy Debugging**: Search and filter logs by any criteria
4. **Real-time Monitoring**: Watch logs as they happen
5. **Rich Context**: Attach metadata, stack traces, strategy IDs
6. **Performance**: Async logging doesn't block your code

## Cleanup

Logs can grow large over time. Add a cleanup job:

```typescript
// Delete logs older than 7 days
await prisma.systemLog.deleteMany({
  where: {
    createdAt: {
      lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    }
  }
});
```
