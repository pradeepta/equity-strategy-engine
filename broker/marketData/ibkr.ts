/**
 * IBKR Historical Data Fetcher
 * Fetches bars from Interactive Brokers TWS/Gateway
 */

import type { IbkrConfig, Period, Session, What, IbkrBar } from "./types";
import { IBKR_BAR_SIZE, IBKR_WHAT } from "./types";
import { LoggerFactory } from "../../logging/logger";
import { IBApi, Contract, SecType } from "@stoqey/ib";

const logger = LoggerFactory.getLogger("IBKR-Fetcher");

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
  // For better reliability, convert to days for longer durations
  const days = Math.ceil(seconds / (24 * 60 * 60));

  if (days >= 1) {
    return `${days} D`;
  } else {
    // For sub-day durations, use seconds
    return `${Math.max(1, Math.floor(seconds))} S`;
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
}): Promise<IbkrBar[]> {
  const {
    ibkr,
    symbol,
    period,
    what,
    session,
    windowEnd,
    durationSeconds,
  } = params;

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
      const contract: Contract = {
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
      const endDateTime = ibkrEndDateTime(windowEnd);

      // formatDate=1 => yyyymmdd{space}{space}hh:mm:ss format
      const formatDate = 1;
      const keepUpToDate = false;

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
        keepUpToDate
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

        // Check for end marker - this signals completion
        if (date.startsWith("finished")) {
          clearTimeout(timeout);
          cleanup();
          logger.info("Historical data complete", {
            symbol,
            period,
            barCount: bars.length,
          });
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

    ib.connect();
  });
}
