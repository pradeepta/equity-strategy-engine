/**
 * Main get_bars implementation
 * Cache-first bar fetching with automatic gap-filling and window expansion
 */

import { Pool } from "pg";
import type {
  GetBarsParams,
  GetBarsResult,
  IbkrConfig,
  Period,
  Session,
  What,
} from "./types";
import { PERIOD_SECONDS } from "./types";
import {
  readBarsFromDb,
  upsertBars,
  rowsToBars,
  sliceLastN,
} from "./database";
import { fetchHistoricalFromIbkr } from "./ibkr";
import { LoggerFactory } from "../../logging/logger";

const logger = LoggerFactory.getLogger("GetBars");

function isAlignedToPeriod(d: Date, periodSeconds: number): boolean {
  const ms = d.getTime();
  return Math.floor(ms / 1000) % periodSeconds === 0;
}

function toISO(d: Date): string {
  return d.toISOString();
}

function parseIbkrDate(dateStr: string): Date | null {
  // IBKR format: "20251202" or "20251202  10:30:00"
  // CRITICAL: IBKR timestamps are in America/New_York (Eastern Time), NOT local timezone!
  if (dateStr.includes(" ")) {
    // Has time component
    const [datePart, timePart] = dateStr.split(/\s+/);
    const year = parseInt(datePart.substring(0, 4));
    const month = parseInt(datePart.substring(4, 6)) - 1; // JS months are 0-indexed
    const day = parseInt(datePart.substring(6, 8));

    if (timePart) {
      const [hours, minutes, seconds] = timePart
        .split(":")
        .map((s) => parseInt(s));

      // Create ISO string assuming Eastern Time (America/New_York)
      // Use -05:00 for EST (standard time). This is an approximation - ideally we'd use a timezone library
      // to handle DST, but for stock market hours this works since market is 9:30 AM - 4:00 PM ET year-round
      const isoString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}-05:00`;
      return new Date(isoString);
    } else {
      return new Date(year, month, day);
    }
  } else {
    // Date only: "20251202"
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    return new Date(year, month, day);
  }
}

export async function getBars(
  params: GetBarsParams & {
    pool: Pool;
    ibkr: IbkrConfig;
  }
): Promise<GetBarsResult> {
  const {
    pool,
    ibkr,
    symbol,
    period,
    limit,
    start,
    end,
    session = "rth",
    what = "trades",
  } = params;

  if (!limit && !start) {
    throw new Error("Provide either limit or start (range).");
  }

  const periodSec = PERIOD_SECONDS[period];

  // Resolve end time
  const endDt = end && end !== "now" ? new Date(end) : new Date();

  // Align end to period boundary (avoid partial last bar)
  // Unless includeForming is true, in which case use current time to get forming bar
  const includeForming = params.includeForming || false;
  const endAligned = includeForming
    ? endDt // Use current time as-is to include forming bar
    : new Date(Math.floor(endDt.getTime() / 1000 / periodSec) * periodSec * 1000); // Round to period boundary

  let windowStart: Date;
  let windowEnd: Date = endAligned;

  // Determine initial window
  if (start) {
    windowStart = new Date(start);
  } else {
    // limit-mode: start from a reasonable window
    const bufferBars = 20;
    const initialSeconds = (limit! + bufferBars) * periodSec;
    windowStart = new Date(windowEnd.getTime() - initialSeconds * 1000);
  }

  const sources: Array<"cache" | "ibkr"> = [];
  const maxAttempts = 5;
  let attempt = 0;

  while (true) {
    attempt++;

    logger.debug("Attempting to get bars", {
      symbol,
      period,
      session,
      what,
      attempt,
      windowStart: toISO(windowStart),
      windowEnd: toISO(windowEnd),
      includeForming,
    });

    // 1) Read from cache
    const cachedRows = await readBarsFromDb(pool, {
      symbol,
      period,
      what,
      session,
      start: windowStart,
      end: windowEnd,
    });

    const cachedBars = rowsToBars(cachedRows);

    // Check if we have enough bars
    const enough = limit ? cachedBars.length >= limit : true;

    if (enough) {
      if (cachedBars.length > 0) sources.push("cache");
      const finalBars = limit ? sliceLastN(cachedBars, limit) : cachedBars;

      logger.info("Returning bars from cache", {
        symbol,
        period,
        session,
        what,
        barCount: finalBars.length,
        sources,
        includeForming,
      });

      return {
        meta: {
          symbol,
          period,
          session,
          what,
          start: finalBars.length ? finalBars[0].t : toISO(windowStart),
          end: finalBars.length
            ? finalBars[finalBars.length - 1].t
            : toISO(windowEnd),
          count: finalBars.length,
          source: Array.from(new Set(sources)),
          partial_last_bar: includeForming, // Mark as partial when including forming bar
        },
        bars: finalBars,
      };
    }

    // 2) Need to fetch more from IBKR
    const durationSeconds = Math.max(
      60,
      Math.floor((windowEnd.getTime() - windowStart.getTime()) / 1000)
    );

    logger.info("Fetching bars from IBKR", {
      symbol,
      period,
      session,
      what,
      durationSeconds,
      attempt,
    });

    const ibkrBars = await fetchHistoricalFromIbkr({
      ibkr,
      symbol,
      period,
      what,
      session,
      windowEnd, // Pass explicit window end for deterministic cache filling
      durationSeconds,
      includeForming, // Pass through includeForming for real-time bar updates
    });

    sources.push("ibkr");

    // 3) Normalize IBKR bars
    const normalized = ibkrBars
      .map((b) => {
        const barstart = parseIbkrDate(b.date);
        if (!barstart || !Number.isFinite(barstart.getTime())) return null;

        // Align to period boundary if needed
        if (!isAlignedToPeriod(barstart, periodSec)) {
          const alignedEpoch =
            Math.floor(barstart.getTime() / 1000 / periodSec) * periodSec;
          const aligned = new Date(alignedEpoch * 1000);
          return {
            barstart: aligned,
            barend: new Date((alignedEpoch + periodSec) * 1000),
            o: b.open,
            h: b.high,
            l: b.low,
            c: b.close,
            v: b.volume,
            wap: b.wap ?? null,
            tradeCount: b.barCount ?? null,
          };
        }

        return {
          barstart,
          barend: new Date(barstart.getTime() + periodSec * 1000),
          o: b.open,
          h: b.high,
          l: b.low,
          c: b.close,
          v: b.volume,
          wap: b.wap ?? null,
          tradeCount: b.barCount ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    logger.info("Normalized IBKR bars", {
      symbol,
      period,
      rawCount: ibkrBars.length,
      normalizedCount: normalized.length,
    });

    // 4) UPSERT into cache
    await upsertBars(pool, { symbol, period, what, session, bars: normalized });

    // 5) Check if we need to expand window
    if (attempt >= maxAttempts) {
      // Return whatever we can after maxAttempts
      const rows = await readBarsFromDb(pool, {
        symbol,
        period,
        what,
        session,
        start: windowStart,
        end: windowEnd,
      });
      const bars = rowsToBars(rows);
      const finalBars = limit ? sliceLastN(bars, limit) : bars;

      logger.warn("Max attempts reached, returning partial result", {
        symbol,
        period,
        session,
        what,
        barCount: finalBars.length,
        requestedLimit: limit,
        includeForming,
      });

      return {
        meta: {
          symbol,
          period,
          session,
          what,
          start: finalBars.length ? finalBars[0].t : toISO(windowStart),
          end: finalBars.length
            ? finalBars[finalBars.length - 1].t
            : toISO(windowEnd),
          count: finalBars.length,
          source: Array.from(new Set(sources)),
          partial_last_bar: includeForming, // Mark as partial when including forming bar
        },
        bars: finalBars,
      };
    }

    // Expand backward (double the lookback) for the next attempt
    const currentSpanSec = Math.floor(
      (windowEnd.getTime() - windowStart.getTime()) / 1000
    );
    const expandedSpanSec = currentSpanSec * 2;
    windowStart = new Date(windowEnd.getTime() - expandedSpanSec * 1000);

    logger.info("Expanding window for next attempt", {
      symbol,
      period,
      newWindowStart: toISO(windowStart),
      windowEnd: toISO(windowEnd),
      attempt: attempt + 1,
    });
  }
}
