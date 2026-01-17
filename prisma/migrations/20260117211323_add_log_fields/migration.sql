-- AlterTable
ALTER TABLE "system_logs" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "stackTrace" TEXT,
ADD COLUMN     "strategyId" TEXT;

-- CreateIndex
CREATE INDEX "system_logs_strategyId_idx" ON "system_logs"("strategyId");

-- CreateIndex
CREATE INDEX "system_logs_level_createdAt_idx" ON "system_logs"("level", "createdAt");

-- CreateIndex
CREATE INDEX "system_logs_component_createdAt_idx" ON "system_logs"("component", "createdAt");
