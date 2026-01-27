/**
 * IBKR Historical Data Fetcher
 * Fetches bars from Interactive Brokers TWS/Gateway
 * Supports both direct TWS connection and Python bridge server
 */

import type { IbkrConfig, Period, Session, What, IbkrBar } from "./types";
import { IBKR_BAR_SIZE, IBKR_WHAT } from "./types";
import { LoggerFactory } from "../../logging/logger";
import { IBApi, Contract, SecType } from "@stoqey/ib";
import axios from "axios";

const logger = LoggerFactory.getLogger("IBKR-Fetcher");

// Python TWS Bridge configuration
const PYTHON_TWS_ENABLED = process.env.PYTHON_TWS_ENABLED === "true";
const PYTHON_TWS_URL = process.env.PYTHON_TWS_URL || "http://localhost:3003";
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

/**
 * Format Date to IBKR endDateTime format
 * @param d Date to format
 * @returns String in format "YYYYMMDD HH:MM:SS UTC"
 */
function ibkrEndDateTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  const SS = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd} ${HH}:${MM}:${SS} UTC`;
}

function durationStr(seconds: number): string {
  // IBKR accepts duration in various formats: S (seconds), D (days), W (weeks), M (months), Y (years)
  // CRITICAL: IBKR "D" means TRADING days (6.5 hours), not calendar days (24 hours)
  // Market hours: 9:30 AM - 4:00 PM EST = 6.5 hours = 23400 seconds per trading day

  const TRADING_DAY_SECONDS = 6.5 * 60 * 60; // 23400 seconds
  const tradingDays = seconds / TRADING_DAY_SECONDS;

  if (tradingDays < 1) {
    // Less than 1 trading day: use seconds
    return `${Math.max(1, Math.floor(seconds))} S`;
  } else {
    // 1+ trading days: round UP to ensure we get enough data
    return `${Math.ceil(tradingDays)} D`;
  }
}

function formatMarketDateTime(d: Date): string {
  const parts = MARKET_FORMATTER.formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const HH = get("hour");
  const MM = get("minute");
  const SS = get("second");
  return `${yyyy}${mm}${dd} ${HH}:${MM}:${SS}`;
}

/**
 * Fetch bars from Python TWS Bridge Server
 * Uses HTTP API to communicate with Python server that maintains persistent TWS connection
 */
async function fetchFromPythonBridge(params: {
  symbol: string;
  period: Period;
  what: What;
  session: Session;
  windowEnd: Date;
  durationSeconds: number;
  includeForming?: boolean;
}): Promise<IbkrBar[]> {
  const { symbol, period, what, session, windowEnd, durationSeconds, includeForming = false } = params;

  const duration = durationStr(durationSeconds);

  // Format end datetime for Python bridge (empty string = now, or exchange-local timestamp)
  let endDateTime = "";
  const now = new Date();
  const timeDiffMs = Math.abs(now.getTime() - windowEnd.getTime());

  // If windowEnd is not "now" (>5 seconds difference), format it
  if (timeDiffMs > 5000) {
    // Python TWS API expects format: "YYYYMMDD HH:MM:SS" in exchange local time
    endDateTime = formatMarketDateTime(windowEnd);
  }

  logger.info("Fetching bars from Python TWS Bridge", {
    symbol,
    period,
    duration,
    what,
    session,
    includeForming,
    endDateTime: endDateTime || "now",
    url: PYTHON_TWS_URL,
  });

  try {
    const response = await axios.post(
      `${PYTHON_TWS_URL}/api/v1/bars`,
      {
        symbol,
        period,
        duration,
        what: what.toUpperCase(),
        session,
        include_forming: includeForming,
        end_datetime: endDateTime,
      },
      {
        timeout: 60000, // 60s timeout
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || "Unknown error from Python bridge");
    }

    // Convert Python bridge response to IbkrBar format
    const bars: IbkrBar[] = response.data.bars.map((bar: any) => ({
      date: bar.date,
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume),
      wap: bar.wap != null ? Number(bar.wap) : undefined,
      barCount: bar.count != null ? Number(bar.count) : undefined,
    }));

    logger.info("Received bars from Python TWS Bridge", {
      symbol,
      period,
      barCount: bars.length,
    });

    return bars;
  } catch (error: any) {
    if (error.response) {
      // HTTP error response from server
      logger.error("Python TWS Bridge HTTP error", error.response.data, {
        status: error.response.status,
        symbol,
        period,
      });
      throw new Error(
        `Python TWS Bridge error: ${error.response.data.error || error.response.statusText}`
      );
    } else if (error.request) {
      // No response received
      logger.error("Python TWS Bridge connection failed", error, {
        symbol,
        period,
        url: PYTHON_TWS_URL,
      });
      throw new Error(
        `Failed to connect to Python TWS Bridge at ${PYTHON_TWS_URL}: ${error.message}`
      );
    } else {
      // Other error
      logger.error("Python TWS Bridge request error", error, { symbol, period });
      throw error;
    }
  }
}

export async function fetchHistoricalFromIbkr(params: {
  ibkr: IbkrConfig;
  symbol: string;
  period: Period;
  what: What;
  session: Session;
  windowEnd: Date; // Explicit end time for deterministic cache filling
  durationSeconds: number;
  includeForming?: boolean; // DEPRECATED: TWS keepUpToDate is unreliable, ignored
}): Promise<IbkrBar[]> {
  const {
    ibkr,
    symbol,
    period,
    what,
    session,
    windowEnd,
    durationSeconds,
    includeForming = false, // IGNORED: TWS API keepUpToDate is unreliable
  } = params;

  // Route to Python TWS Bridge if enabled
  if (PYTHON_TWS_ENABLED) {
    logger.info("Using Python TWS Bridge for bar fetching", {
      symbol,
      period,
      pythonTwsUrl: PYTHON_TWS_URL,
    });

    return fetchFromPythonBridge({
      symbol,
      period,
      what,
      session,
      windowEnd,
      durationSeconds,
      includeForming,
    });
  }

  // NOTE: includeForming parameter is now ignored due to TWS API limitations
  // The keepUpToDate feature is known to be unreliable across all IB API implementations
  // See: https://github.com/erdewit/ib_insync/discussions/685
  // See: https://github.com/erdewit/ib_insync/issues/333
  // Alternative: Orchestrator will poll more frequently (every 10s) instead of streaming
  if (includeForming) {
    logger.warn("includeForming parameter ignored - TWS keepUpToDate is unreliable", {
      symbol,
      period,
      recommendation: "Use frequent polling instead (ORCHESTRATOR_LOOP_INTERVAL_MS=10000)",
    });
  }

  return new Promise((resolve, reject) => {
    // Generate unique client ID and request ID
    const connectionClientId =
      ibkr.clientId + Math.floor(Math.random() * 1000);
    const reqId = Math.floor(Math.random() * 999999) + 1;

    const ib = new IBApi({
      clientId: connectionClientId,
      host: ibkr.host,
      port: ibkr.port,
    });

    const bars: IbkrBar[] = [];
    let connected = false;

    const cleanup = () => {
      try {
        ib.disconnect();
      } catch {}
    };

    const timeout = setTimeout(() => {
      logger.warn("Historical data timeout", {
        symbol,
        reqId,
        receivedBars: bars.length,
        period,
        session,
        what,
      });
      cleanup();
      reject(
        new Error(
          `Historical data timeout for ${symbol} (received ${bars.length} bars)`
        )
      );
    }, 120000); // 120s timeout

    // Type assertion to work around overly restrictive EventEmitter typing
    const ibEmitter = ib as any;

    ibEmitter.on("error", (err: Error, code: number, reqIdReceived: number) => {
      // Filter out informational messages
      const infoMessages = [2104, 2106, 2107, 2108, 2158];
      if (!infoMessages.includes(code) && code !== 2176) {
        logger.error("IBKR error", err, { code, reqId: reqIdReceived, symbol });
        if (!connected && code === 502) {
          clearTimeout(timeout);
          cleanup();
          reject(
            new Error(`Cannot connect to TWS at ${ibkr.host}:${ibkr.port}`)
          );
        }
      }
    });

    ibEmitter.once("connected", () => {
      connected = true;

      // VIX is an index, not a stock - requires special handling
      const isVIX = symbol.toUpperCase() === "VIX";

      const contract: Contract = isVIX
        ? {
            symbol: "VIX",
            secType: SecType.IND,
            exchange: "CBOE",
            currency: "USD",
          }
        : {
            symbol,
            secType: SecType.STK,
            exchange: "SMART",
            currency: "USD",
          };

      // Get bar size and what to show from mappings
      const barSize = IBKR_BAR_SIZE[period];
      const whatToShow = IBKR_WHAT[what];

      const useRTH = session === "rth" ? 1 : 0;
      const duration = durationStr(durationSeconds);

      // Format end date time using windowEnd
      // Always use explicit endDateTime (current time if windowEnd is now)
      const endDateTime = ibkrEndDateTime(windowEnd);

      // formatDate=1 => yyyymmdd{space}{space}hh:mm:ss format
      const formatDate = 1;

      // NOTE: keepUpToDate is ALWAYS false due to TWS API unreliability
      // The historicalDataUpdate event streaming is broken in TWS API
      // Use frequent polling instead (ORCHESTRATOR_LOOP_INTERVAL_MS=10000)

      logger.info("Requesting historical data from IBKR", {
        symbol,
        period,
        clientId: connectionClientId,
        reqId,
        contract,
        endDateTime,
        duration,
        barSize,
        whatToShow,
        useRTH,
      });

      ib.reqHistoricalData(
        reqId,
        contract,
        endDateTime,
        duration,
        barSize,
        whatToShow,
        useRTH,
        formatDate,
        false // keepUpToDate always false
      );
    });

    let receivedBars = 0;

    ibEmitter.on(
      "historicalData",
      (
        id: number,
        date: string,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
        wap: number,
        barCount: number
      ) => {
        // Check if this is for our request
        if (id !== reqId) {
          return;
        }

        // Check for end marker - this signals completion of historical data
        if (date.startsWith("finished")) {
          logger.info("Historical data complete", {
            symbol,
            period,
            barCount: bars.length,
          });

          // Resolve immediately with completed bars
          clearTimeout(timeout);
          cleanup();
          resolve(bars);
          return;
        }

        if (open < 0 || close < 0) {
          logger.warn("Received invalid bar data", {
            symbol,
            reqId,
            date,
            open,
            close,
          });
          return;
        }

        receivedBars++;
        if (receivedBars === 1 || receivedBars % 10 === 0) {
          logger.debug("Receiving historical bars", {
            symbol,
            reqId,
            count: receivedBars,
            date,
            close,
          });
        }

        bars.push({
          date,
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: Number(volume),
          wap: wap != null ? Number(wap) : undefined,
          barCount: barCount != null ? Number(barCount) : undefined,
        });
      }
    );

    // NOTE: historicalDataUpdate event handler removed
    // TWS keepUpToDate feature is unreliable and doesn't work consistently
    // Use frequent polling instead (ORCHESTRATOR_LOOP_INTERVAL_MS=10000)

    ib.connect();
  });
}
