-- CreateTable
CREATE TABLE "market_bars" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_bars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_bars_symbol_timeframe_timestamp_idx" ON "market_bars"("symbol", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "market_bars_symbol_timeframe_timestamp_key" ON "market_bars"("symbol", "timeframe", "timestamp");
