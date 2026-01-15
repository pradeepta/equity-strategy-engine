# Database Setup Guide

This guide explains how to set up and use the PostgreSQL database-backed strategy management system.

## Prerequisites

- PostgreSQL installed and running locally
- Node.js and npm installed
- Environment variables configured in `.env`

## Initial Setup

### 1. Create PostgreSQL Database

```bash
# Connect to PostgreSQL
psql postgres

# Create database
CREATE DATABASE trading_db;

# Exit psql
\q
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and update the database configuration:

```bash
cp .env.example .env
```

Update the following variables in `.env`:

```env
# Database connection string
DATABASE_URL="postgresql://your_username@localhost:5432/trading_db?schema=public"

# User ID for strategy management
USER_ID=your-user-id
```

### 3. Run Prisma Migrations

```bash
# Install dependencies
npm install

# Run database migrations
npx prisma migrate dev

# Generate Prisma client
npx prisma generate
```

### 4. Build the Project

```bash
npm run build
```

## Strategy Management

### Adding a New Strategy

Create a strategy from a YAML file:

```bash
npm run strategy:add -- --user=user123 --file=./aapl-momentum.yaml
```

Optional: Specify an account ID:

```bash
npm run strategy:add -- --user=user123 --file=./aapl-momentum.yaml --account=DU9999999
```

### Listing Strategies

List all strategies for a user:

```bash
npm run strategy:list -- --user=user123
```

Filter by status:

```bash
npm run strategy:list -- --user=user123 --status=ACTIVE
npm run strategy:list -- --user=user123 --status=CLOSED
```

Available statuses:
- `DRAFT` - Created but not activated
- `PENDING` - Ready to be loaded by orchestrator
- `ACTIVE` - Currently running
- `CLOSED` - Stopped
- `ARCHIVED` - Invalid/deprecated
- `FAILED` - Compilation error

### Closing a Strategy

Close an active strategy:

```bash
npm run strategy:close -- --id=clfx123 --reason="Market conditions unfavorable"
```

### Rolling Back to a Previous Version

View version history and rollback:

```bash
npm run strategy:rollback -- --id=clfx123 --version=3
```

This will show the version history before performing the rollback.

### Exporting a Strategy

Export current version:

```bash
npm run strategy:export -- --id=clfx123 --output=./backup.yaml
```

Export specific version:

```bash
npm run strategy:export -- --id=clfx123 --output=./backup-v3.yaml --version=3
```

## Running the Orchestrator

### Start Multi-Strategy Trading

The orchestrator will automatically load all `ACTIVE` strategies from the database:

```bash
npm run live:multi
```

### How It Works

1. **Startup**: Orchestrator queries database for all `ACTIVE` strategies for your `USER_ID`
2. **Loading**: Each strategy is loaded from its YAML content stored in the database
3. **Polling**: Database poller checks every 30 seconds for new `PENDING` strategies
4. **Auto-activation**: New strategies are automatically loaded and marked `ACTIVE`
5. **Hot-swapping**: Strategy evaluator can swap strategies by creating new versions

### Strategy Lifecycle

```
DRAFT → PENDING → ACTIVE → CLOSED
                     ↓
                 ARCHIVED (if invalid)
                     ↓
                 FAILED (if compilation error)
```

## Database Schema Overview

### Core Tables

- **strategies** - Main strategy metadata
- **strategy_versions** - Version history with YAML content
- **strategy_executions** - Lifecycle events (activated, swapped, closed)
- **strategy_evaluations** - Evaluator recommendations
- **orders** - Order tracking
- **fills** - Fill records
- **users** - Multi-tenant support

### Version Control

Every time a strategy is updated, a new version is created:
- Initial creation: Version 1
- Manual edits: Version 2, 3, ...
- Auto-swaps: New versions with `changeType: AUTO_SWAP`
- Rollbacks: New version copying content from previous version

## Advanced Usage

### Viewing Database Data

Use Prisma Studio for a GUI interface:

```bash
npx prisma studio
```

This opens a web interface at `http://localhost:5555` where you can browse all tables.

### Raw Database Queries

Connect to the database:

```bash
psql trading_db
```

Example queries:

```sql
-- List all active strategies
SELECT id, symbol, name, status, activated_at
FROM "Strategy"
WHERE status = 'ACTIVE' AND deleted_at IS NULL;

-- View strategy version history
SELECT sv.version_number, sv.name, sv.change_type, sv.created_at
FROM "StrategyVersion" sv
WHERE sv.strategy_id = 'your-strategy-id'
ORDER BY sv.version_number DESC;

-- Get recent evaluations
SELECT recommendation, confidence, reason, created_at
FROM "StrategyEvaluation"
WHERE strategy_id = 'your-strategy-id'
ORDER BY created_at DESC
LIMIT 10;
```

### Database Backup

Backup the database:

```bash
pg_dump trading_db > backup.sql
```

Restore from backup:

```bash
psql trading_db < backup.sql
```

## Troubleshooting

### Connection Issues

If you see "Can't reach database server":

1. Check PostgreSQL is running:
   ```bash
   pg_isready
   ```

2. Verify connection string in `.env`:
   ```env
   DATABASE_URL="postgresql://username@localhost:5432/trading_db?schema=public"
   ```

3. Check PostgreSQL logs:
   ```bash
   tail -f /usr/local/var/log/postgres.log  # macOS Homebrew
   ```

### Migration Issues

If migrations fail, reset the database:

```bash
# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Run migrations again
npx prisma migrate dev
```

### Strategy Not Loading

Check strategy status:

```bash
npm run strategy:list -- --user=your-user-id
```

If status is `FAILED`, check error logs. If status is `DRAFT`, change to `PENDING`:

```sql
UPDATE "Strategy" SET status = 'PENDING' WHERE id = 'your-strategy-id';
```

## Differences from Filesystem-Based System

### Before (Filesystem)

- Strategies stored in `./strategies/live/` directory
- FilesystemWatcher polls directory every 30s
- No version history
- No centralized tracking
- Manual file management

### After (Database)

- Strategies stored in PostgreSQL
- DatabasePoller queries `status=PENDING` every 30s
- Full version history with rollback
- Centralized execution tracking
- CLI-based management

## Next Steps

1. Create your first strategy YAML file
2. Add it to the database using `strategy:add`
3. Start the orchestrator with `live:multi`
4. Monitor logs for strategy execution
5. Use CLI commands to manage strategies

For more information, see the main [README.md](README.md).
