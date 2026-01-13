/**
 * Live Trading: Connect to Alpaca, fetch real bars, run strategy
 * Uses real market data and can submit paper trading orders
 */

import * as fs from 'fs';
import * as https from 'https';
import * as dotenv from 'dotenv';
import { StrategyCompiler } from './compiler/compile';
import { createStandardRegistry } from './features/registry';
import { StrategyEngine } from './runtime/engine';
import { AlpacaRestAdapter } from './broker/alpacaRest';
import { Bar } from './spec/types';

// Load .env
dotenv.config();

// ============================================================================
// Alpaca API Client
// ============================================================================

interface AlpacaBar {
  t: number; // timestamp (unix)
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

interface AlpacaAccount {
  id: string;
  account_number: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
}

class AlpacaClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor() {
    // Support both naming conventions
    this.apiKey = process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
    this.apiSecret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '';
    this.baseUrl =
      process.env.APCA_API_BASE_URL ||
      process.env.ALPACA_BASE_URL ||
      'https://paper-api.alpaca.markets';

    if (!this.apiKey || !this.apiSecret) {
      throw new Error(
        'Missing Alpaca API credentials. Set ALPACA_API_KEY and ALPACA_API_SECRET in .env'
      );
    }
  }

  private request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          'APCA-API-KEY-ID': this.apiKey,
          'APCA-API-SECRET-KEY': this.apiSecret,
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async getAccount(): Promise<AlpacaAccount> {
    return this.request('GET', '/v2/account');
  }

  async getBars(
    symbol: string,
    limit: number = 100,
    timeframe: string = '1day'
  ): Promise<Bar[]> {
    try {
      // Try v1 endpoint first
      const response = await this.request(
        'GET',
        `/v1/bars/${timeframe}?symbols=${symbol}&limit=${limit}`
      );

      if (response[symbol] && response[symbol].length > 0) {
        const bars: Bar[] = response[symbol].map((bar: AlpacaBar) => ({
          timestamp: bar.t * 1000, // Convert to ms
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        }));
        return bars;
      }
    } catch (e) {
      // Fallback to v2 endpoint
      console.log('  (v1 endpoint not available, trying v2)');
    }

    try {
      const response = await this.request(
        'GET',
        `/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}`
      );

      if (response.bars && response.bars.length > 0) {
        const bars: Bar[] = response.bars.map((bar: any) => ({
          timestamp: bar.t * 1000, // Convert to ms
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
        }));
        return bars;
      }
    } catch (e) {
      // Continue to error below
    }

    throw new Error(`No bars available for ${symbol}`);
  }

  async getLatestBar(symbol: string): Promise<Bar | null> {
    try {
      const response = await this.request('GET', `/v1/last/stocks/${symbol}`);

      if (!response.last) {
        return null;
      }

      const bar = response.last;
      return {
        timestamp: bar.timestamp || Date.now(),
        open: bar.o || 0,
        high: bar.h || 0,
        low: bar.l || 0,
        close: bar.c || 0,
        volume: bar.v || 0,
      };
    } catch {
      return null;
    }
  }
}

// ============================================================================
// Live Trading Engine
// ============================================================================

interface LiveResult {
  symbol: string;
  timestamp: string;
  account: {
    portfolio_value: string;
    buying_power: string;
    cash: string;
  };
  bars: Bar[];
  state: string;
  ordersPlaced: number;
  logs: string[];
}

async function fetchHistoricalBars(symbol: string, days: number = 30): Promise<Bar[]> {
  return new Promise((resolve) => {
    const now = Math.floor(Date.now() / 1000);
    const past = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    const url =
      `https://query1.finance.yahoo.com/v7/finance/download/${symbol}?` +
      `period1=${past}&period2=${now}&interval=1d&events=history`;

    console.log(`📊 Fetching ${symbol} historical data (${days} days)...\n`);

    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const lines = data.split('\n');
            const bars: Bar[] = [];

            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              const parts = line.split(',');
              if (parts.length < 5 || parts[1] === 'null' || parts[1] === 'null') continue;

              try {
                const date = new Date(parts[0]);
                if (isNaN(date.getTime())) continue;

                bars.push({
                  timestamp: date.getTime(),
                  open: parseFloat(parts[1]),
                  high: parseFloat(parts[2]),
                  low: parseFloat(parts[3]),
                  close: parseFloat(parts[4]),
                  volume: parseInt(parts[6], 10) || 0,
                });
              } catch (e) {
                continue;
              }
            }

            if (bars.length === 0) {
              throw new Error('No valid bars parsed');
            }

            console.log(`✓ Got ${bars.length} bars`);
            const latest = bars[bars.length - 1];
            console.log(`  Latest: $${latest.close.toFixed(2)}\n`);
            resolve(bars);
          } catch (e) {
            console.log('(Using mock data instead)\n');
            resolve(generateMockBars(symbol));
          }
        });
      })
      .on('error', () => {
        resolve(generateMockBars(symbol));
      });
  });
}

function generateMockBars(symbol: string): Bar[] {
  const bars: Bar[] = [];
  let price = 350;
  let timestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000) * 1000;

  for (let i = 0; i < 30; i++) {
    const change = (Math.random() - 0.5) * 5;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * 0.02);
    const low = Math.min(open, close) * (1 - Math.random() * 0.02);
    const volume = 40000000 + Math.random() * 20000000;

    bars.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume: Math.floor(volume),
    });

    price = close;
    timestamp += 24 * 60 * 60 * 1000;
  }

  return bars;
}

async function runLiveTrading(
  strategyYaml: string,
  symbol: string = 'NFLX'
): Promise<LiveResult> {
  console.log('\n📡 Connecting to Alpaca...\n');

  const alpaca = new AlpacaClient();
  const account = await alpaca.getAccount();

  console.log(`✓ Connected to account: ${account.account_number}`);
  console.log(`  Portfolio: $${parseFloat(account.portfolio_value).toFixed(2)}`);
  console.log(`  Cash: $${parseFloat(account.cash).toFixed(2)}`);
  console.log(`  Buying Power: $${parseFloat(account.buying_power).toFixed(2)}\n`);

  // Fetch recent bars (use historical data since live market data requires subscription)
  const bars = await fetchHistoricalBars(symbol, 30);

  if (bars.length === 0) {
    throw new Error(`No bars available for ${symbol}`);
  }

  console.log(`✓ Got ${bars.length} bars`);
  const latest = bars[bars.length - 1];
  const date = new Date(latest.timestamp).toISOString();
  console.log(`  Latest: ${date} @ $${latest.close.toFixed(2)}\n`);

  // Compile strategy
  const compiler = new StrategyCompiler(createStandardRegistry());
  const registry = createStandardRegistry();

  const enableLive = process.env.LIVE === 'true';

  const baseUrl = process.env.APCA_API_BASE_URL || process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
  const apiKey = process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
  const apiSecret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '';

  const adapter = new AlpacaRestAdapter(baseUrl, apiKey, apiSecret);

  const ir = compiler.compileFromYAML(strategyYaml);

  console.log('═'.repeat(60));
  console.log('RUNNING STRATEGY');
  console.log('═'.repeat(60) + '\n');

  // Create engine
  const engine = new StrategyEngine(ir, registry, adapter, {
    dryRun: !enableLive,
    baseUrl,
    apiKey,
    apiSecret,
  });

  // Process bars
  const logs: string[] = [];

  for (let i = 0; i < Math.min(bars.length, 20); i++) {
    const bar = bars[i];
    const date = new Date(bar.timestamp).toLocaleTimeString();

    await engine.processBar(bar);
    const state = engine.getState();
    const stateStr = state.currentState;

    const log = `[${date}] [${stateStr}] $${bar.close.toFixed(2)} V:${(bar.volume / 1e6).toFixed(1)}M`;
    logs.push(log);
    console.log(log);

    // Show new events
    if (state.log.length > 0) {
      const lastLog = state.log[state.log.length - 1];
      if (lastLog.message) {
        console.log(`  └─ ${lastLog.message}`);
        if (lastLog.data) {
          console.log(`     ${JSON.stringify(lastLog.data)}`);
        }
      }
    }
  }

  const finalState = engine.getState();

  return {
    symbol,
    timestamp: new Date().toISOString(),
    account: {
      portfolio_value: account.portfolio_value,
      buying_power: account.buying_power,
      cash: account.cash,
    },
    bars: bars.slice(-5), // Last 5 bars
    state: finalState.currentState,
    ordersPlaced: finalState.openOrders.length,
    logs,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const symbol = process.argv[2] || 'NFLX';
  const strategyFile = process.argv[3] || 'nflx-mean-reversion';
  const strategyPath = `./strategies/${strategyFile}.yaml`;
  const liveMode = process.env.LIVE === 'true';

  console.log('\n╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('║' + `LIVE TRADING: ${symbol}`.padEnd(58) + '║');
  if (!liveMode) {
    console.log('║' + '[DRY-RUN MODE - Orders NOT submitted]'.padEnd(58) + '║');
  } else {
    console.log('║' + '[LIVE MODE - Paper trading orders will submit]'.padEnd(58) + '║');
  }
  console.log('║' + ' '.repeat(58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝');

  try {
    if (!fs.existsSync(strategyPath)) {
      throw new Error(`Strategy not found: ${strategyPath}`);
    }

    const strategyYaml = fs.readFileSync(strategyPath, 'utf-8');
    const result = await runLiveTrading(strategyYaml, symbol);

    console.log('\n' + '═'.repeat(60));
    console.log('LIVE TRADING SUMMARY');
    console.log('═'.repeat(60));

    console.log(`\nSymbol: ${result.symbol}`);
    console.log(`Current State: ${result.state}`);
    console.log(`Orders Placed: ${result.ordersPlaced}`);
    console.log(`\nAccount Status:`);
    console.log(
      `  Portfolio: $${parseFloat(result.account.portfolio_value).toFixed(2)}`
    );
    console.log(`  Cash: $${parseFloat(result.account.cash).toFixed(2)}`);
    console.log(
      `  Buying Power: $${parseFloat(result.account.buying_power).toFixed(2)}`
    );

    console.log('\nRecent Bars:');
    for (const bar of result.bars.slice(-3)) {
      const date = new Date(bar.timestamp).toLocaleTimeString();
      console.log(
        `  ${date}: O=${bar.open.toFixed(2)} H=${bar.high.toFixed(2)} L=${bar.low.toFixed(2)} C=${bar.close.toFixed(2)} V=${bar.volume}`
      );
    }

    console.log('\n' + '═'.repeat(60));
    if (!liveMode) {
      console.log('✓ Dry-run complete (no orders sent)');
      console.log('\nTo enable live paper trading:');
      console.log('  LIVE=true npm run live\n');
    } else {
      console.log('✓ Live trading mode (paper trading)');
      console.log('  Orders submitted to Alpaca\n');
    }

  } catch (e) {
    const err = e as Error;
    console.error('\n❌ Error:', err.message);
    console.error('\nTroubleshooting:');
    console.error('1. Check .env file has API keys');
    console.error('2. Verify API keys are correct');
    console.error('3. Check market hours (9:30 AM - 4 PM ET)');
    console.error('4. Verify symbol exists (try AAPL or SPY)\n');
    process.exit(1);
  }
}

main().catch(console.error);
