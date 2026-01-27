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
// IBKR always returns timestamps in Eastern Time, regardless of server location
const MARKET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function isAlignedToPeriod(d: Date, periodSeconds: number): boolean {
  const ms = d.getTime();
  return Math.floor(ms / 1000) % periodSeconds === 0;
}

function toISO(d: Date): string {
  return d.toISOString();
}

function getMarketTzParts(d: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = MARKET_FORMATTER.formatToParts(d);
  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)!.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function getMarketTzOffsetMs(utcDate: Date): number {
  const parts = getMarketTzParts(utcDate);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - utcDate.getTime();
}

function marketTzTimeToUtcDate(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date {
  const utcGuess = new Date(Date.UTC(year, monthIndex, day, hour, minute, second));
  const offsetMs = getMarketTzOffsetMs(utcGuess);
  return new Date(utcGuess.getTime() - offsetMs);
}

function parseIbkrDate(dateStr: string): Date | null {
  // Handle both formats:
  // 1. ISO 8601 from Python bridge: "2026-01-26T14:55:00+00:00" (already UTC)
  // 2. Legacy IBKR format: "20251202" or "20251202  10:30:00" (Eastern Time)

  // Check if it's ISO 8601 format (contains 'T' or '-')
  if (dateStr.includes('T') || dateStr.includes('-')) {
    // ISO format from Python bridge - already in UTC
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
    logger.warn(`Failed to parse ISO date: ${dateStr}`);
    return null;
  }

  // Legacy IBKR format: "20251202" or "20251202  10:30:00"
  // CRITICAL: IBKR timestamps are in exchange-local time (configurable).
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

      // Convert exchange-local time to UTC, respecting DST
      return marketTzTimeToUtcDate(year, month, day, hours, minutes, seconds);
    } else {
      return marketTzTimeToUtcDate(year, month, day);
    }
  } else {
    // Date only: "20251202"
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    return marketTzTimeToUtcDate(year, month, day);
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

  // CRITICAL FIX: If fetching after market close, anchor to market close time
  // Market hours: 9:30 AM - 4:00 PM local exchange time (configurable).
  // This ensures we fetch the LAST N hours of trading data, not N hours backward from "now"
  const now = new Date();

  // Get current time in market timezone using Intl.DateTimeFormat
  const marketParts = getMarketTzParts(now);
  const marketYear = marketParts.year;
  const marketMonthIndex = marketParts.month - 1;
  const marketDay = marketParts.day;
  const marketHour = marketParts.hour;
  const marketMinute = marketParts.minute;

  // Market close: 4:00 PM local exchange time (handle DST via timezone conversion)
  const marketCloseHour = 16;

  // If current time is after market close, anchor windowEnd to market close
  if (
    (marketHour > marketCloseHour ||
      (marketHour === marketCloseHour && marketMinute >= 0)) &&
    !start
  ) {
    // Create market close time: 4:00 PM market time today (DST-aware)
    windowEnd = marketTzTimeToUtcDate(
      marketYear,
      marketMonthIndex,
      marketDay,
      marketCloseHour,
      0,
      0
    );
    logger.debug(
      `Current time (${String(marketHour).padStart(2, "0")}:${String(marketMinute).padStart(2, "0")} EST) is at/after market close. Anchoring windowEnd to ${windowEnd.toISOString()} (4:00 PM EST)`
    );
  }

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

    logger.info("🔍 Cache lookup attempt", {
      symbol,
      period,
      attempt,
      limit,
      windowStart: toISO(windowStart),
      windowEnd: toISO(windowEnd),
    });

    // 1) Read from cache
    // CRITICAL: When limit is specified, query ALL bars up to windowEnd (not just within window)
    // This ensures we see bars inserted in previous loop iterations
    const cacheQueryStart = limit
      ? new Date(windowEnd.getTime() - 365 * 24 * 60 * 60 * 1000) // 1 year back
      : windowStart;

    const cachedRows = await readBarsFromDb(pool, {
      symbol,
      period,
      what,
      session,
      start: cacheQueryStart,
      end: windowEnd,
    });

    const cachedBars = rowsToBars(cachedRows);

    // Check if cache is stale relative to windowEnd (avoid returning old bars)
    const lastBarTimeMs = cachedBars.length
      ? new Date(cachedBars[cachedBars.length - 1].t).getTime()
      : null;
    const staleThresholdMs = Math.floor(periodSec * 1000 * 1.5);
    const isStale =
      lastBarTimeMs != null &&
      windowEnd.getTime() - lastBarTimeMs > staleThresholdMs;

    // Check if we have enough bars and they're not stale
    const enough = limit ? cachedBars.length >= limit && !isStale : !isStale;

    logger.info("📊 Cache decision", {
      symbol,
      period,
      cachedCount: cachedBars.length,
      requestedLimit: limit,
      isStale,
      enough,
      decision: enough ? "USE_CACHE" : "FETCH_MORE",
      reason: !enough && limit && cachedBars.length < limit ? `Need ${limit} bars, only have ${cachedBars.length}` :
              !enough && isStale ? `Cache is stale (${Math.floor((windowEnd.getTime() - lastBarTimeMs!) / 1000)}s old, threshold ${Math.floor(staleThresholdMs / 1000)}s)` : "OK",
    });

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
        isStale,
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
