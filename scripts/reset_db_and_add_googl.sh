#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f ".env" ]]; then
  echo "Missing .env in repo root."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source ".env"
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set in .env"
  exit 1
fi

# psql does not accept the Prisma schema query param
PSQL_URL="${DATABASE_URL%%\?schema=*}"

echo "Resetting database tables..."
psql "$PSQL_URL" <<'SQL'
TRUNCATE TABLE
  users,
  accounts,
  api_keys,
  strategies,
  strategy_versions,
  strategy_executions,
  strategy_evaluations,
  orders,
  fills,
  trades,
  system_logs,
  operation_queue,
  order_audit_log
RESTART IDENTITY CASCADE;
SQL

echo "Adding default user..."
psql "$PSQL_URL" <<'SQL'
INSERT INTO users (id, email, name, role, "createdAt", "updatedAt")
VALUES ('default-user', 'default-user@example.com', 'Default User', 'TRADER', NOW(), NOW())
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    name = EXCLUDED.name,
    role = EXCLUDED.role,
    "updatedAt" = NOW();
SQL

echo "Adding GOOGL strategy via CLI..."
npm run strategy:add -- --user=default-user --file=./strategies/live/GOOGL-GOOGL-adjusted-1768438942310.yaml

echo "Done."
