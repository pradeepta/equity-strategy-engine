/*
  Warnings:

  - The primary key for the `bars` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "bars" DROP CONSTRAINT "bars_pkey",
ALTER COLUMN "barstart" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "barend" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "ingested_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "bars_pkey" PRIMARY KEY ("symbol", "period", "what", "session", "barstart");

-- CreateTable
CREATE TABLE "strategy_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategy_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analyses" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ticker" VARCHAR(10) NOT NULL,
    "analysisDate" DATE NOT NULL,
    "dateRangeStart" DATE NOT NULL,
    "dateRangeEnd" DATE NOT NULL,
    "setupType" VARCHAR(20) NOT NULL,
    "entryPrice" DECIMAL(10,2),
    "stopLoss" DECIMAL(10,2),
    "targets" JSONB,
    "invalidationLevel" DECIMAL(10,2),
    "invalidationCondition" TEXT,
    "rrRatio" DECIMAL(5,2),
    "quality" VARCHAR(10),
    "confidence" INTEGER,
    "reasoning" TEXT,
    "counterArgument" TEXT,
    "patterns" JSONB,
    "marketRegime" JSONB,
    "keyLevels" JSONB,
    "fullResponse" JSONB,
    "rawChartPath" TEXT,
    "annotatedChartPath" TEXT,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_outcomes" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" VARCHAR(20) NOT NULL,
    "actualEntry" DECIMAL(10,2),
    "actualExit" DECIMAL(10,2),
    "actualRr" DECIMAL(5,2),
    "notes" TEXT,

    CONSTRAINT "trade_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "strategy_templates_name_idx" ON "strategy_templates"("name");

-- CreateIndex
CREATE INDEX "analyses_ticker_idx" ON "analyses"("ticker");

-- CreateIndex
CREATE INDEX "analyses_createdAt_idx" ON "analyses"("createdAt");

-- CreateIndex
CREATE INDEX "analyses_setupType_idx" ON "analyses"("setupType");

-- CreateIndex
CREATE INDEX "analyses_strategyId_idx" ON "analyses"("strategyId");

-- CreateIndex
CREATE INDEX "trade_outcomes_analysisId_idx" ON "trade_outcomes"("analysisId");

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "strategy_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_outcomes" ADD CONSTRAINT "trade_outcomes_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "bars_lookup_idx" RENAME TO "bars_symbol_period_what_session_barstart_idx";
