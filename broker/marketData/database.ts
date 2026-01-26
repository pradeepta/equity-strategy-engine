/**
 * Database helpers for bar caching
 * Handles reading from and upserting to the bars table
 */

import { Pool } from "pg";
import type { Period, Session, What, DbRow, Bar } from "./types";

export async function readBarsFromDb(
  pool: Pool,
  args: {
    symbol: string;
    period: Period;
    what: What;
    session: Session;
    start: Date;
    end: Date;
  }
): Promise<DbRow[]> {
  const { symbol, period, what, session, start, end } = args;

  const query = `
    SELECT barstart, open, high, low, close, volume, wap, trade_count
    FROM bars
    WHERE symbol = $1 AND period = $2 AND what = $3 AND session = $4
      AND barstart >= $5 AND barstart < $6
    ORDER BY barstart ASC
  `;

  const res = await pool.query(query, [
    symbol,
    period,
    what,
    session,
    start.toISOString(),
    end.toISOString(),
  ]);

  return res.rows as DbRow[];
}

export async function upsertBars(
  pool: Pool,
  args: {
    symbol: string;
    period: Period;
    what: What;
    session: Session;
    bars: Array<{
      barstart: Date;
      barend: Date;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
      wap?: number | null;
      tradeCount?: number | null;
    }>;
  }
): Promise<void> {
  const { symbol, period, what, session, bars } = args;
  
  // Validate input
  if (!bars || !Array.isArray(bars) || bars.length === 0) {
    return;
  }

  // Filter out any invalid bars and validate required fields
  const validBars = bars.filter((b) => {
    return (
      b &&
      b.barstart instanceof Date &&
      b.barend instanceof Date &&
      Number.isFinite(b.o) &&
      Number.isFinite(b.h) &&
      Number.isFinite(b.l) &&
      Number.isFinite(b.c) &&
      Number.isFinite(b.v)
    );
  });

  if (validBars.length === 0) {
    return;
  }

  // PostgreSQL has a limit of ~65535 parameters per query
  // With 14 parameters per bar, that's ~4680 bars max per batch
  // Use 4000 bars per batch to be safe
  const BATCH_SIZE = 4000;
  const PARAMS_PER_BAR = 14;

  // Process in batches
  for (let batchStart = 0; batchStart < validBars.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, validBars.length);
    const batch = validBars.slice(batchStart, batchEnd);

    const values: any[] = [];
    const chunks: string[] = [];

    batch.forEach((b, i) => {
      const base = i * PARAMS_PER_BAR;
      chunks.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`
      );
      values.push(
        symbol,
        period,
        what,
        session,
        b.barstart.toISOString(),
        b.barend.toISOString(),
        b.o,
        b.h,
        b.l,
        b.c,
        b.v,
        b.wap ?? null,
        b.tradeCount != null ? Math.round(b.tradeCount) : null, // Round to integer for database
        new Date().toISOString()
      );
    });

    // Safety check: ensure values array matches expected parameter count
    const expectedParamCount = batch.length * PARAMS_PER_BAR;
    if (values.length !== expectedParamCount) {
      throw new Error(
        `Parameter count mismatch: expected ${expectedParamCount} parameters, got ${values.length}`
      );
    }

    const query = `
      INSERT INTO bars (
        symbol, period, what, session,
        barstart, barend,
        open, high, low, close, volume,
        wap, trade_count,
        ingested_at
      )
      VALUES ${chunks.join(",")}
      ON CONFLICT (symbol, period, what, session, barstart)
      DO UPDATE SET
        barend = EXCLUDED.barend,
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        wap = EXCLUDED.wap,
        trade_count = EXCLUDED.trade_count,
        ingested_at = EXCLUDED.ingested_at
    `;

    await pool.query(query, values);
  }
}

export function rowsToBars(rows: DbRow[]): Bar[] {
  return rows.map((r) => ({
    t: new Date(r.barstart).toISOString(),
    o: Number(r.open),
    h: Number(r.high),
    l: Number(r.low),
    c: Number(r.close),
    v: Number(r.volume),
    wap: r.wap,
    tradeCount: r.trade_count,
  }));
}

export function sliceLastN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}
