-- CreateTable
CREATE TABLE IF NOT EXISTS bars (
  symbol        TEXT NOT NULL,
  period        TEXT NOT NULL,
  what          TEXT NOT NULL,
  session       TEXT NOT NULL,
  barstart      TIMESTAMPTZ NOT NULL,
  barend        TIMESTAMPTZ NOT NULL,
  open          DOUBLE PRECISION NOT NULL,
  high          DOUBLE PRECISION NOT NULL,
  low           DOUBLE PRECISION NOT NULL,
  close         DOUBLE PRECISION NOT NULL,
  volume        DOUBLE PRECISION NOT NULL,
  wap           DOUBLE PRECISION,
  trade_count   INTEGER,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, period, what, session, barstart)
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS bars_lookup_idx
  ON bars (symbol, period, what, session, barstart DESC);