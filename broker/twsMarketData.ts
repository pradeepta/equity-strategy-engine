/**
 * TWS Market Data Client
 * Fetches historical bar data from Interactive Brokers TWS
 */

import { Bar } from "../spec/types";
import { getTimeframeMs } from "../utils/marketHours";
import * as path from "path";
import { Logger } from "../logging/logger";

const IB = require("ib");

const defaultLogDir = process.env.MCP_LOG_DIR || process.env.LOG_DIR || path.resolve(__dirname, "..");
const logFilePath = process.env.MCP_LOG_FILE_PATH || path.join(defaultLogDir, "mcp-server.log");

const twsLogger = new Logger({
  component: "TWS-MarketData",
  enableConsole: true,
  enableDatabase: false,
  enableFile: true,
  logFilePath,
  logLevel: process.env.LOG_LEVEL || "debug",
});

export class TwsMarketDataClient {
  private host: string;
  private port: number;
  private clientId: number;

  constructor(
    host: string = "127.0.0.1",
    port: number = 7497,
    clientId: number = 2
  ) {
    this.host = host;
    this.port = port;
    this.clientId = clientId; // Use different client ID from trading client
  }

  /**
   * Fetch historical bars from TWS
   */
  async getHistoricalBars(
    symbol: string,
    days: number = 30,
    timeframe: string = "1day"
  ): Promise<Bar[]> {
    const maxAttempts = 3;
    const baseDelayMs = 1000;
    const timeoutMs = 60000;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Generate unique client ID for this connection to prevent collisions
      // Base client ID + random offset (0-999) ensures concurrent connections don't conflict
      const connectionClientId = this.clientId + Math.floor(Math.random() * 1000);

      const client = new IB({
        clientId: connectionClientId,
        host: this.host,
        port: this.port,
      });

      const bars: Bar[] = [];
      let connected = false;
      let lastError: { code?: number; reqId?: number; message?: string } | null = null;
      let firstBarTimestamp: number | null = null;
      let lastBarTimestamp: number | null = null;
      let lastProgressLog = 0;
      let acceptedPartial = false;

      try {
        // Wait for connection
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(
              new Error("Connection timeout. Make sure TWS/IB Gateway is running.")
            );
          }, 10000);

          client.on("connected", () => {
            twsLogger.info("Connected to TWS for market data", {
              host: this.host,
              port: this.port,
              clientId: connectionClientId,
              baseClientId: this.clientId,
              attempt,
            });
            connected = true;
            clearTimeout(timeout);
            resolve();
          });

          client.on("error", (err: Error, code: number, reqId: number) => {
            lastError = { code, reqId, message: err?.message };
            // Filter out informational messages (codes 2104, 2106, 2107, 2108, 2158)
            const infoMessages = [2104, 2106, 2107, 2108, 2158];
            const infoText = err?.message?.toLowerCase?.() || "";
            const isInfoText =
              infoText.includes("market data farm connection is ok") ||
              infoText.includes("hmds data farm connection is ok") ||
              infoText.includes("sec-def data farm connection is ok");
            if (!infoMessages.includes(code) && !isInfoText) {
              if (code === 2176) {
                twsLogger.warn("TWS warning", { code, reqId, attempt });
              } else {
                twsLogger.error("TWS error", err, { code, reqId, attempt });
              }
            } else {
              twsLogger.debug("TWS info message", {
                code,
                reqId,
                message: err.message,
                attempt,
              });
            }
            if (!connected && code === 502) {
              clearTimeout(timeout);
              reject(
                new Error(`Cannot connect to TWS at ${this.host}:${this.port}`)
              );
            }
          });

          client.connect();
        });

        // Request historical data with unique request ID to prevent collisions
        // Generate random ID between 1-999999 to avoid conflicts with concurrent requests
        const reqId = Math.floor(Math.random() * 999999) + 1;
        const contract = {
          symbol,
          secType: "STK",
          exchange: "SMART",
          currency: "USD",
        };

        // Convert timeframe to IB format
        const barSize = this.convertTimeframeToIB(timeframe);
        const duration = `${days} D`;
        const endDateTime = ""; // Empty string means current time

        // Set up data handlers
        client.on(
          "historicalData",
          (
            id: number,
            date: string,
            open: number,
            high: number,
            low: number,
            close: number,
            volume: number
          ) => {
            // Skip the "finished-" marker or invalid bars
            if (
              id !== reqId ||
              date.startsWith("finished") ||
              open < 0 ||
              close < 0
            ) {
              return;
            }

            // Parse date - TWS returns format like "20251202" or "20251202  10:30:00"
            let timestamp: number;

            if (date.includes(" ")) {
              // Has time component: "20251202  10:30:00"
              const [dateStr, timeStr] = date.split(/\s+/);
              const year = parseInt(dateStr.substring(0, 4));
              const month = parseInt(dateStr.substring(4, 6)) - 1; // JS months are 0-indexed
              const day = parseInt(dateStr.substring(6, 8));

              if (timeStr) {
                const [hours, minutes, seconds] = timeStr
                  .split(":")
                  .map((s) => parseInt(s));
                timestamp = new Date(
                  year,
                  month,
                  day,
                  hours,
                  minutes,
                  seconds
                ).getTime();
              } else {
                timestamp = new Date(year, month, day).getTime();
              }
            } else {
              // Date only: "20251202"
              const year = parseInt(date.substring(0, 4));
              const month = parseInt(date.substring(4, 6)) - 1; // JS months are 0-indexed
              const day = parseInt(date.substring(6, 8));
              timestamp = new Date(year, month, day).getTime();
            }

            bars.push({
              timestamp,
              open,
              high,
              low,
              close,
              volume,
            });

            if (!firstBarTimestamp) {
              firstBarTimestamp = timestamp;
              twsLogger.debug("Historical data first bar", {
                symbol,
                timeframe,
                reqId,
                attempt,
                timestamp,
                date,
                open,
                high,
                low,
                close,
                volume,
              });
            }

            lastBarTimestamp = timestamp;
            const now = Date.now();
            if (now - lastProgressLog > 5000) {
              lastProgressLog = now;
              twsLogger.info("Historical data download progress", {
                symbol,
                timeframe,
                reqId,
                attempt,
                barsCount: bars.length,
                lastBarTimestamp,
              });
            }
          }
        );

        // Request the data
        twsLogger.info("Historical data download started", {
          symbol,
          timeframe,
          days,
          host: this.host,
          port: this.port,
          clientId: connectionClientId,
          baseClientId: this.clientId,
          reqId,
          attempt,
        });
        client.reqHistoricalData(
          reqId,
          contract,
          endDateTime,
          duration,
          barSize,
          "TRADES", // whatToShow: TRADES, MIDPOINT, BID, ASK
          0, // useRTH: 0 = include extended/overnight hours, 1 = regular trading hours only
          1, // formatDate: 1 = yyyymmdd{space}{space}hh:mm:dd
          false // keepUpToDate: false for historical data only
        );

        // Wait for historicalDataEnd signal (proper IB protocol)
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            const now = Date.now();
            const canAcceptPartial = bars.length > 0;
            twsLogger.warn("Historical data timeout reached", {
              barsCount: bars.length,
              symbol,
              timeframe,
              days,
              reqId,
              attempt,
              timeoutMs,
              firstBarTimestamp,
              lastBarTimestamp,
              lastError,
              canAcceptPartial,
            });
            if (canAcceptPartial) {
              acceptedPartial = true;
              resolve();
              return;
            }
            reject(new Error(`Historical data timeout for ${symbol} (${timeframe}, ${days}d)`));
          }, timeoutMs);

          client.once("historicalDataEnd", (id: number) => {
            if (id === reqId) {
              clearTimeout(timeout);
              twsLogger.info("Historical data download complete", {
                barsCount: bars.length,
                symbol,
                timeframe,
                days,
                reqId,
                attempt,
                firstBarTimestamp,
                lastBarTimestamp,
                lastError,
              });
              resolve();
            }
          });
        });

        twsLogger.info("Historical data download finished", {
          barsCount: bars.length,
          symbol,
          timeframe,
          days,
          reqId,
          attempt,
          firstBarTimestamp,
          lastBarTimestamp,
          lastError,
          acceptedPartial,
        });

        // Sort by timestamp
        bars.sort((a, b) => a.timestamp - b.timestamp);

        return bars;
      } catch (error: any) {
        twsLogger.warn("Historical data attempt failed", {
          symbol,
          timeframe,
          days,
          attempt,
          maxAttempts,
          message: error?.message,
        });
        if (attempt === maxAttempts) {
          throw error;
        }
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } finally {
        try {
          client.disconnect();
        } catch {
          // ignore disconnect errors
        }
      }
    }

    throw new Error(`Historical data failed after ${maxAttempts} attempts`);
  }

  /**
   * Get latest bar (real-time)
   */
  async getLatestBar(symbol: string): Promise<Bar | null> {
    // Get just 1 day of 1-minute bars and return the latest
    const bars = await this.getHistoricalBars(symbol, 1, "1 min");
    return bars.length > 0 ? bars[bars.length - 1] : null;
  }

  /**
   * Convert strategy timeframe to IB bar size format
   */
  private convertTimeframeToIB(timeframe: string): string {
    const mapping: Record<string, string> = {
      "1m": "1 min",
      "5m": "5 mins",
      "15m": "15 mins",
      "30m": "30 mins",
      "1h": "1 hour",
      "1d": "1 day",
      "1day": "1 day",
    };

    return mapping[timeframe.toLowerCase()] || "1 day";
  }
}
