/**
 * Market Data Types
 * New bar caching system with explicit session and data type parameters
 */

import { BarSizeSetting, WhatToShow } from "@stoqey/ib";

export type Period = "5m" | "15m" | "1h" | "1d";
export type Session = "rth" | "all";
export type What = "trades" | "midpoint" | "bid" | "ask";

export interface GetBarsParams {
  symbol: string;
  period: Period;
  limit?: number;
  start?: string; // ISO datetime
  end?: string;   // ISO datetime or "now"
  session?: Session;
  what?: What;
  tz?: string;    // informational; storage is UTC TIMESTAMPTZ
}

export interface Bar {
  t: string; // ISO bar start
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  wap?: number | null;
  tradeCount?: number | null;
}

export interface GetBarsResult {
  meta: {
    symbol: string;
    period: Period;
    session: Session;
    what: What;
    start: string;
    end: string;
    count: number;
    source: Array<"cache" | "ibkr">;
    partial_last_bar: boolean;
  };
  bars: Bar[];
}

export const PERIOD_SECONDS: Record<Period, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "1d": 24 * 60 * 60,
};

export const IBKR_BAR_SIZE: Record<Period, BarSizeSetting> = {
  "5m": BarSizeSetting.MINUTES_FIVE,
  "15m": BarSizeSetting.MINUTES_FIFTEEN,
  "1h": BarSizeSetting.HOURS_ONE,
  "1d": BarSizeSetting.DAYS_ONE,
};

export const IBKR_WHAT: Record<What, WhatToShow> = {
  trades: WhatToShow.TRADES,
  midpoint: WhatToShow.MIDPOINT,
  bid: WhatToShow.BID,
  ask: WhatToShow.ASK,
};

export interface DbRow {
  barstart: string; // timestamptz
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  wap: number | null;
  trade_count: number | null;
}

export interface IbkrConfig {
  host: string;
  port: number;
  clientId: number;
}

export interface IbkrBar {
  date: string;  // with formatDate=2 => epoch seconds as string
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  wap?: number;
  barCount?: number;
}
