# Logging System Implementation - Complete

## ✅ What Was Implemented

A complete **Winston + PostgreSQL logging system** with web-based log viewer has been successfully implemented for your trading system.

---

## 📦 Components Created

### 1. **Backend Logging Infrastructure**

#### `/logging/PrismaTransport.ts`
- Custom Winston transport that writes logs to PostgreSQL via Prisma
- Non-blocking async writes (won't slow down your code)
- Automatically maps Winston log levels to Prisma LogLevel enum
- Error handling with fallback to console if DB fails

#### `/logging/logger.ts`
- **LoggerFactory**: Singleton pattern for managing loggers across components
- **Logger class**: Wrapper around Winston with convenience methods
- Features:
  - Multiple transports (Console + PostgreSQL)
  - Component-based loggers (each component gets its own logger)
  - Convenience methods: `logStrategy()`, `logOrder()` for contextual logging
  - Stack trace capture for errors
  - Metadata support

### 2. **Database Schema**

#### Updated `prisma/schema.prisma` - SystemLog model
Enhanced with new fields:
- `strategyId` - Link logs to strategies
- `orderId` - Link logs to orders
- `stackTrace` - Capture full error stack traces
- `errorCode` - Error classification
- Additional indexes for performance

**Migration applied**: `20260117211323_add_log_fields`

### 3. **API Endpoints**

#### Updated `portfolio-api-server.ts`
New endpoints added:
- `GET /api/logs` - Query system logs with filters
  - Query params: `limit`, `level`, `component`, `strategyId`, `since`
- `GET /api/logs/stats` - Get log statistics
  - Returns: counts by level, top components, recent errors

### 4. **Web Dashboard Components**

#### `/web-client/app/components/LogsViewer.tsx`
Complete React component for viewing **system logs**:
- Real-time log viewer with auto-refresh (every 5 seconds)
- Filtering by level (ERROR, WARN, INFO, DEBUG), component, search query
- Statistics dashboard showing log counts, errors, warnings
- Top components by log count
- Recent errors table
- Click any log to see full details in modal
- Detailed modal with metadata, stack traces, related entities

#### `/web-client/app/components/AuditLogsViewer.tsx`
Complete React component for viewing **order audit logs**:
- Real-time audit trail viewer with auto-refresh
- Filtering by event type, symbol, strategy
- Summary statistics (total events, submitted, filled, errors)
- Event breakdown by type with percentages
- Click any audit log to see full details in modal
- Displays order IDs, broker IDs, status changes, error messages

#### Updated `web-client/app/page.tsx`
Added **4 navigation tabs**:
1. **Chat** - Existing chat interface
2. **Dashboard** - Portfolio metrics, positions, strategies, recent trades
3. **Audit Logs** - Order audit trail (moved from Dashboard)
4. **System Logs** - Winston/PostgreSQL logs

---

## 📚 Documentation & Examples

### `/logging/README.md`
Complete usage guide including:
- Setup instructions
- Code examples
- API endpoint documentation
- Log levels explanation
- Architecture diagram
- Cleanup recommendations

### `/live-with-logging.example.ts`
Reference implementation showing:
- How to initialize Prisma + Logger
- Integration patterns for live trading
- Order and strategy logging examples
- Graceful shutdown handling
- Error handler setup

### `/test-logging.ts`
Test script to verify the logging system:
- Creates sample logs at all levels
- Tests order and strategy logging
- Queries logs from database
- Displays statistics
- Run with: `ts-node test-logging.ts`

---

## 🚀 How to Use

### 1. Start the Portfolio API Server
```bash
npm run portfolio:api:dev
```

### 2. Start the Web Client
```bash
cd web-client
npm run dev
```

### 3. Open the Dashboard
Navigate to http://localhost:3000 and click through the tabs:
- **Dashboard**: Portfolio overview
- **Audit Logs**: Order activity and events
- **System Logs**: Application logs

### 4. Integrate into Your Live Server

Add to the top of your `live.ts` (or any file):

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { LoggerFactory } from './logging/logger';

// Initialize Prisma (once per file)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Initialize logger factory (once per app)
LoggerFactory.setPrisma(prisma);

// Get logger for this component
const logger = LoggerFactory.getLogger('live-server');

// Use it throughout your code
logger.info('Live server started', { symbol: 'AAPL', timeframe: '1h' });
logger.warn('Connection slow', { latency: 500 });
logger.error('Failed to fetch bars', error, { symbol: 'AAPL' });
logger.debug('Bar processed', { price: 150.25, volume: 1000000 });

// With strategy context
logger.logStrategy('info', 'Strategy activated', strategyId, { symbol: 'AAPL' });

// With order context
logger.logOrder('error', 'Order failed', orderId, { reason: 'Insufficient funds' });
```

### 5. Test the Logging System
```bash
ts-node test-logging.ts
```

This will create sample logs and verify they're stored correctly.

---

## 🎯 Features

### System Logs Tab
- ✅ Real-time log streaming (5s refresh)
- ✅ Filter by level (ERROR, WARN, INFO, DEBUG)
- ✅ Filter by component
- ✅ Full-text search
- ✅ Statistics dashboard
- ✅ Top components by log count
- ✅ Recent errors table
- ✅ Click-to-expand log details
- ✅ Stack trace viewer
- ✅ Metadata display
- ✅ Related entity links (strategy/order IDs)

### Audit Logs Tab
- ✅ Real-time audit trail (5s refresh)
- ✅ Filter by event type
- ✅ Filter by symbol
- ✅ Filter by strategy
- ✅ Summary statistics
- ✅ Event breakdown with percentages
- ✅ Click-to-expand log details
- ✅ Order and broker ID display
- ✅ Status change tracking
- ✅ Error message display

### Dashboard Tab (Cleaned Up)
- ✅ Portfolio summary (P&L, positions, strategies, orders)
- ✅ Current positions table
- ✅ Strategy performance (moved audit logs out)
- ✅ Recent trades
- ✅ Modals for detailed views

---

## 📊 Log Levels

| Level | Use Case | Example |
|-------|----------|---------|
| **ERROR** | Critical errors | Failed API calls, order rejections, exceptions |
| **WARN** | Warning conditions | High latency, degraded performance, approaching limits |
| **INFO** | Important events | Server start/stop, strategy activation, orders placed |
| **DEBUG** | Detailed debugging | Bar processing, state changes, calculations |

Set log level via environment variable:
```bash
LOG_LEVEL=debug npm run live:dev
```

---

## 🗄️ Database Tables

### `system_logs` (Enhanced)
Stores all application logs:
- `id`, `level`, `component`, `message`, `metadata`
- `strategyId`, `orderId` (links to related entities)
- `stackTrace`, `errorCode` (error details)
- `createdAt`
- Indexes on: level, component, createdAt, strategyId

### `order_audit_log` (Existing)
Stores order activity:
- Event types: SUBMITTED, FILLED, CANCELLED, REJECTED, etc.
- Status changes, quantities, prices
- Error messages and metadata

---

## 🔧 Next Steps

### Optional Enhancements:

1. **Add Log Retention Policy**
   ```typescript
   // Delete logs older than 7 days
   await prisma.systemLog.deleteMany({
     where: { createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
   });
   ```

2. **Add Log Export**
   - Add "Export CSV" button to download logs
   - Add "Export JSON" for analysis

3. **Add Real-time WebSocket Updates**
   - Push new logs to dashboard instantly
   - No polling needed

4. **Add Log Alerts**
   - Email/Slack notifications for ERROR logs
   - Threshold alerts (e.g., >10 errors in 5 minutes)

5. **Add Search Persistence**
   - Save filter preferences in localStorage
   - Remember last search/filter settings

6. **Add Log Visualization**
   - Charts showing error rates over time
   - Component activity heatmap

---

## 📁 File Structure

```
stocks/
├── logging/
│   ├── PrismaTransport.ts      # Custom Winston transport
│   ├── logger.ts                # Logger factory and wrapper
│   └── README.md                # Usage guide
├── prisma/
│   ├── schema.prisma            # Enhanced with log fields
│   └── migrations/
│       └── 20260117211323_add_log_fields/
├── portfolio-api-server.ts      # Added log API endpoints
├── live-with-logging.example.ts # Integration example
├── test-logging.ts              # Test script
└── web-client/
    └── app/
        ├── page.tsx             # Added tabs
        └── components/
            ├── LogsViewer.tsx       # System logs component
            └── AuditLogsViewer.tsx  # Audit logs component
```

---

## ✨ Summary

You now have a **production-ready logging system** that:
- ✅ Captures every log from your live server
- ✅ Stores logs persistently in PostgreSQL
- ✅ Displays logs on a beautiful web dashboard
- ✅ Provides real-time updates and filtering
- ✅ Separates order audit logs from system logs
- ✅ Includes detailed views with metadata and stack traces

**Start using it today** by integrating the logger into your `live.ts` file!
