-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('SWAP_STRATEGY', 'CANCEL_ORDERS', 'SUBMIT_ORDERS', 'EVALUATE_STRATEGY', 'CLOSE_STRATEGY', 'RECONCILE_ORDERS');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderEventType" AS ENUM ('SUBMITTED', 'CANCELLED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'RECONCILED', 'ORPHANED', 'MISSING');

-- AlterTable
ALTER TABLE "strategy_executions" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "initiatedBy" TEXT,
ADD COLUMN     "operationId" TEXT;

-- CreateTable
CREATE TABLE "operation_queue" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "operationType" "OperationType" NOT NULL,
    "targetSymbol" TEXT,
    "strategyId" TEXT,
    "status" "OperationStatus" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "operation_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_audit_log" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "brokerOrderId" TEXT,
    "strategyId" TEXT NOT NULL,
    "eventType" "OrderEventType" NOT NULL,
    "oldStatus" "OrderStatus",
    "newStatus" "OrderStatus",
    "quantity" DOUBLE PRECISION,
    "price" DOUBLE PRECISION,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operation_queue_operationId_key" ON "operation_queue"("operationId");

-- CreateIndex
CREATE INDEX "operation_queue_status_priority_createdAt_idx" ON "operation_queue"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "operation_queue_operationId_idx" ON "operation_queue"("operationId");

-- CreateIndex
CREATE INDEX "operation_queue_targetSymbol_status_idx" ON "operation_queue"("targetSymbol", "status");

-- CreateIndex
CREATE INDEX "order_audit_log_orderId_createdAt_idx" ON "order_audit_log"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_audit_log_brokerOrderId_createdAt_idx" ON "order_audit_log"("brokerOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_audit_log_strategyId_createdAt_idx" ON "order_audit_log"("strategyId", "createdAt");

-- CreateIndex
CREATE INDEX "order_audit_log_eventType_idx" ON "order_audit_log"("eventType");

-- CreateIndex
CREATE INDEX "strategy_executions_operationId_idx" ON "strategy_executions"("operationId");
