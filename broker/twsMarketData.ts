/**
 * TWS Market Data Client
 * Fetches historical bar data from Interactive Brokers TWS
 */

import { Bar } from "../spec/types";

const IB = require("ib");

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
    const client = new IB({
      clientId: this.clientId,
      host: this.host,
      port: this.port,
    });

    const bars: Bar[] = [];
    let connected = false;

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error("Connection timeout. Make sure TWS/IB Gateway is running.")
        );
      }, 10000);

      client.on("connected", () => {
        console.log(
          `✓ Connected to TWS for market data at ${this.host}:${this.port}`
        );
        connected = true;
        clearTimeout(timeout);
        resolve();
      });

      client.on("error", (err: Error, code: number, reqId: number) => {
        // Filter out informational messages (codes 2104, 2106, 2107, 2108, 2158)
        const infoMessages = [2104, 2106, 2107, 2108, 2158];
        const infoText = err?.message?.toLowerCase?.() || "";
        const isInfoText =
          infoText.includes("market data farm connection is ok") ||
          infoText.includes("hmds data farm connection is ok") ||
          infoText.includes("sec-def data farm connection is ok");
        if (!infoMessages.includes(code) && !isInfoText) {
          console.error(
            `TWS Error [${code}]: ${err.message} (reqId: ${reqId})`
          );
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

    // Request historical data
    const reqId = 1;
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

        // console.log(`Received bar: ${date} - O:${open} H:${high} L:${low} C:${close} V:${volume}`);

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
      }
    );

    // Request the data
    console.log(
      `Requesting ${days} days of ${timeframe} bars for ${symbol}...`
    );
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
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`Timeout reached, using ${bars.length} bars`);
        resolve();
      }, 30000); // 30s timeout for large requests

      client.once("historicalDataEnd", (id: number) => {
        if (id === reqId) {
          clearTimeout(timeout);
          console.log(
            `Data collection complete (${bars.length} bars received)`
          );
          resolve();
        }
      });
    });

    // Disconnect
    client.disconnect();
    console.log(`✓ Received ${bars.length} bars from TWS`);

    // Sort by timestamp
    bars.sort((a, b) => a.timestamp - b.timestamp);

    return bars;
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
