import type { Bar } from '../spec/types';

type IbkrSecDefResult = {
  conid: number;
};

type IbkrHistoricalBar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

type IbkrHistoricalResponse = {
  data?: IbkrHistoricalBar[];
};

export type IbkrWebClientOptions = {
  baseUrl?: string;
  allowInsecureTls?: boolean;
  timeoutMs?: number;
};

export class IbkrWebClient {
  private baseUrl: string;
  private allowInsecureTls: boolean;
  private timeoutMs: number;

  constructor(options: IbkrWebClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.IBKR_WEB_BASE_URL || 'https://localhost:5000/v1/api')
      .replace(/\/+$/, '');
    this.allowInsecureTls =
      options.allowInsecureTls ??
      (process.env.IBKR_WEB_ALLOW_INSECURE === 'true');
    this.timeoutMs = options.timeoutMs ?? 30000;

    if (this.allowInsecureTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
  }

  async getHistoricalBars(
    symbol: string,
    options: {
      period?: string;
      barSize?: string;
      outsideRth?: boolean;
    } = {}
  ): Promise<Bar[]> {
    const conid = await this.getConid(symbol);
    const period = options.period ?? '3d';
    const barSize = options.barSize ?? '5min';
    const outsideRth = options.outsideRth ?? true;

    const data = await this.request<IbkrHistoricalResponse>(
      'GET',
      '/iserver/marketdata/history',
      {
        conid,
        period,
        bar: barSize,
        outsideRth,
      }
    );

    return (data.data || []).map((bar) => ({
      timestamp: bar.t,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));
  }

  async getConid(symbol: string): Promise<number> {
    const data = await this.request<IbkrSecDefResult[]>(
      'GET',
      '/iserver/secdef/search',
      { symbol, secType: 'STK' }
    );

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`Symbol not found: ${symbol}`);
    }

    return data[0].conid;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    params?: Record<string, string | number | boolean>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, String(value));
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`IBKR Web API error ${response.status}: ${text}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
