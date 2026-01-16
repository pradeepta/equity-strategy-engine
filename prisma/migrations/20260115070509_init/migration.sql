-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'TRADER', 'VIEWER');

-- CreateEnum
CREATE TYPE "StrategyStatus" AS ENUM ('DRAFT', 'PENDING', 'ACTIVE', 'CLOSED', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "VersionChangeType" AS ENUM ('CREATED', 'MANUAL_EDIT', 'AUTO_SWAP', 'ROLLBACK', 'IMPORTED');

-- CreateEnum
CREATE TYPE "ExecutionEventType" AS ENUM ('ACTIVATED', 'DEACTIVATED', 'SWAP', 'BAR_PROCESSED', 'ERROR', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "EvaluationRecommendation" AS ENUM ('KEEP', 'SWAP', 'CLOSE');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TradeType" AS ENUM ('FULL_EXIT', 'PARTIAL_EXIT', 'STOP_LOSS', 'TARGET_HIT');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'TRADER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "broker" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPaper" BOOLEAN NOT NULL DEFAULT true,
    "maxConcurrentStrategies" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsed" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "yamlContent" TEXT NOT NULL,
    "status" "StrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "riskPerTrade" DOUBLE PRECISION,
    "entryTimeoutBars" INTEGER,
    "rthOnly" BOOLEAN,
    "activatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_versions" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "yamlContent" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "description" TEXT,
    "changeReason" TEXT,
    "changedBy" TEXT,
    "changeType" "VersionChangeType" NOT NULL,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "compilationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_executions" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "eventType" "ExecutionEventType" NOT NULL,
    "currentState" TEXT,
    "barsProcessed" INTEGER,
    "openOrderCount" INTEGER,
    "oldVersionId" TEXT,
    "newVersionId" TEXT,
    "swapReason" TEXT,
    "currentPrice" DOUBLE PRECISION,
    "currentVolume" BIGINT,
    "barTimestamp" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_evaluations" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "portfolioValue" DOUBLE PRECISION,
    "unrealizedPnL" DOUBLE PRECISION,
    "realizedPnL" DOUBLE PRECISION,
    "currentBar" JSONB,
    "recentBars" JSONB,
    "recommendation" "EvaluationRecommendation" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "suggestedYaml" TEXT,
    "suggestedName" TEXT,
    "suggestedReasoning" TEXT,
    "actionTaken" BOOLEAN NOT NULL DEFAULT false,
    "actionResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "brokerOrderId" TEXT,
    "planId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "qty" INTEGER NOT NULL,
    "type" "OrderType" NOT NULL,
    "limitPrice" DOUBLE PRECISION,
    "stopPrice" DOUBLE PRECISION,
    "parentOrderId" TEXT,
    "isParent" BOOLEAN NOT NULL DEFAULT false,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "filledQty" INTEGER NOT NULL DEFAULT 0,
    "avgFillPrice" DOUBLE PRECISION,
    "submittedAt" TIMESTAMP(3),
    "filledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "commission" DOUBLE PRECISION,
    "filledAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "entryOrderId" TEXT NOT NULL,
    "entryQty" INTEGER NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "entryTime" TIMESTAMP(3) NOT NULL,
    "exitOrderId" TEXT,
    "exitQty" INTEGER,
    "exitPrice" DOUBLE PRECISION,
    "exitTime" TIMESTAMP(3),
    "realizedPnL" DOUBLE PRECISION,
    "commission" DOUBLE PRECISION,
    "netPnL" DOUBLE PRECISION,
    "tradeType" "TradeType",
    "isWin" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logs" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "component" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE INDEX "accounts_isActive_idx" ON "accounts"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_userId_broker_accountId_key" ON "accounts"("userId", "broker", "accountId");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE INDEX "api_keys_isActive_idx" ON "api_keys"("isActive");

-- CreateIndex
CREATE INDEX "strategies_userId_status_idx" ON "strategies"("userId", "status");

-- CreateIndex
CREATE INDEX "strategies_symbol_idx" ON "strategies"("symbol");

-- CreateIndex
CREATE INDEX "strategies_status_idx" ON "strategies"("status");

-- CreateIndex
CREATE INDEX "strategies_userId_accountId_idx" ON "strategies"("userId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "strategies_userId_symbol_status_deletedAt_key" ON "strategies"("userId", "symbol", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "strategy_versions_strategyId_idx" ON "strategy_versions"("strategyId");

-- CreateIndex
CREATE INDEX "strategy_versions_createdAt_idx" ON "strategy_versions"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_versions_strategyId_versionNumber_key" ON "strategy_versions"("strategyId", "versionNumber");

-- CreateIndex
CREATE INDEX "strategy_executions_strategyId_idx" ON "strategy_executions"("strategyId");

-- CreateIndex
CREATE INDEX "strategy_executions_eventType_idx" ON "strategy_executions"("eventType");

-- CreateIndex
CREATE INDEX "strategy_executions_createdAt_idx" ON "strategy_executions"("createdAt");

-- CreateIndex
CREATE INDEX "strategy_evaluations_strategyId_idx" ON "strategy_evaluations"("strategyId");

-- CreateIndex
CREATE INDEX "strategy_evaluations_recommendation_idx" ON "strategy_evaluations"("recommendation");

-- CreateIndex
CREATE INDEX "strategy_evaluations_createdAt_idx" ON "strategy_evaluations"("createdAt");

-- CreateIndex
CREATE INDEX "orders_strategyId_idx" ON "orders"("strategyId");

-- CreateIndex
CREATE INDEX "orders_brokerOrderId_idx" ON "orders"("brokerOrderId");

-- CreateIndex
CREATE INDEX "orders_symbol_idx" ON "orders"("symbol");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE INDEX "orders_createdAt_idx" ON "orders"("createdAt");

-- CreateIndex
CREATE INDEX "fills_orderId_idx" ON "fills"("orderId");

-- CreateIndex
CREATE INDEX "fills_filledAt_idx" ON "fills"("filledAt");

-- CreateIndex
CREATE UNIQUE INDEX "trades_entryOrderId_key" ON "trades"("entryOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "trades_exitOrderId_key" ON "trades"("exitOrderId");

-- CreateIndex
CREATE INDEX "trades_strategyId_idx" ON "trades"("strategyId");

-- CreateIndex
CREATE INDEX "trades_symbol_idx" ON "trades"("symbol");

-- CreateIndex
CREATE INDEX "trades_entryTime_idx" ON "trades"("entryTime");

-- CreateIndex
CREATE INDEX "trades_exitTime_idx" ON "trades"("exitTime");

-- CreateIndex
CREATE INDEX "system_logs_level_idx" ON "system_logs"("level");

-- CreateIndex
CREATE INDEX "system_logs_component_idx" ON "system_logs"("component");

-- CreateIndex
CREATE INDEX "system_logs_createdAt_idx" ON "system_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_executions" ADD CONSTRAINT "strategy_executions_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_parentOrderId_fkey" FOREIGN KEY ("parentOrderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
