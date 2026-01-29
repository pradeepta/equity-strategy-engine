-- AlterEnum
ALTER TYPE "ExecutionEventType" ADD VALUE 'FORCE_ENTRY';

-- AlterEnum
ALTER TYPE "StrategyEventType" ADD VALUE 'FORCE_DEPLOYED';

-- AlterTable
ALTER TABLE "strategies" ADD COLUMN     "runtimeState" TEXT;
