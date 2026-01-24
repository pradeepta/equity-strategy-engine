-- CreateEnum
CREATE TYPE "StrategyEventType" AS ENUM ('CREATED', 'ACTIVATED', 'CLOSED', 'ARCHIVED', 'FAILED', 'YAML_UPDATED', 'ROLLED_BACK', 'SWAPPED_IN', 'SWAPPED_OUT', 'DELETED', 'STATUS_CHANGED');

-- CreateTable
CREATE TABLE "strategy_audit_log" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "eventType" "StrategyEventType" NOT NULL,
    "oldStatus" "StrategyStatus",
    "newStatus" "StrategyStatus",
    "changedBy" TEXT,
    "changeReason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "strategy_audit_log_strategyId_createdAt_idx" ON "strategy_audit_log"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "strategy_audit_log_eventType_idx" ON "strategy_audit_log"("eventType");

-- CreateIndex
CREATE INDEX "strategy_audit_log_changedBy_idx" ON "strategy_audit_log"("changedBy");
