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
import { TwsAdapter } from './broker/twsAdapter';
import { BaseBrokerAdapter } from './broker/broker';
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
  private dataUrl: string;

  constructor() {
    // Support both naming conventions
    this.apiKey = process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
    this.apiSecret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '';
    this.baseUrl =
      process.env.APCA_API_BASE_URL ||
      process.env.ALPACA_BASE_URL ||
      'https://paper-api.alpaca.markets';
    // v2 Data API endpoint (same for paper and live)
    this.dataUrl = 'https://data.alpaca.markets';

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
    // Use v2 Data API endpoint with correct URL
    const url = new URL(`${this.dataUrl}/v2/stocks/${symbol}/bars`);
    url.searchParams.set('timeframe', timeframe);
    url.searchParams.set('limit', limit.toString());

    // Add date range for better results (last 30 days)
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    url.searchParams.set('start', start.toISOString().split('T')[0]);
    url.searchParams.set('end', end.toISOString().split('T')[0]);

    const options: https.RequestOptions = {
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'APCA-API-KEY-ID': this.apiKey,
        'APCA-API-SECRET-KEY': this.apiSecret,
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const response = JSON.parse(data);

            if (response.bars && response.bars.length > 0) {
              const bars: Bar[] = response.bars.map((bar: any) => ({
                timestamp: new Date(bar.t).getTime(),
                open: bar.o,
                high: bar.h,
                low: bar.l,
                close: bar.c,
                volume: bar.v,
              }));
              resolve(bars);
            } else {
              reject(new Error(`No bars available for ${symbol} (${response.message || 'no data returned'})`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
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
// Calculate Optimal Check Interval
// ============================================================================

function calculateOptimalCheckInterval(timeframeStr: string): number {
  // Parse timeframe string (e.g., "1h", "15m", "1d", "5m")
  const match = timeframeStr.match(/^(\d+)([hmd])$/i);

  if (!match) {
    // Default to 1 minute if can't parse
    return 60000;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  let barDurationMs = 0;

  if (unit === 'm') {
    // Minutes
    barDurationMs = value * 60 * 1000;
  } else if (unit === 'h') {
    // Hours
    barDurationMs = value * 60 * 60 * 1000;
  } else if (unit === 'd') {
    // Days
    barDurationMs = value * 24 * 60 * 60 * 1000;
  }

  // Check at 1/3 of bar interval (so we catch new bars quickly)
  const checkInterval = Math.max(
    barDurationMs / 3,
    5000  // Minimum 5 seconds
  );

  return Math.round(checkInterval);
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

async function fetchHistoricalBars(
  symbol: string,
  alpaca: AlpacaClient,
  days: number = 30,
  timeframe: string = '1day'
): Promise<Bar[]> {
  try {
    console.log(`📊 Fetching ${symbol} historical data from Alpaca (${days} days, ${timeframe})...\n`);

    // Convert strategy timeframe to Alpaca v2 API format
    // v2 API uses: 1Min, 5Min, 15Min, 1Hour, 1Day
    let alpacaTimeframe = timeframe;
    if (timeframe === '1m') alpacaTimeframe = '1Min';
    if (timeframe === '5m') alpacaTimeframe = '5Min';
    if (timeframe === '15m') alpacaTimeframe = '15Min';
    if (timeframe === '1h') alpacaTimeframe = '1Hour';
    if (timeframe === '1d') alpacaTimeframe = '1Day';

    // Use Alpaca API for historical bars
    const bars = await alpaca.getBars(symbol, Math.max(days * 2, 100), alpacaTimeframe);

    if (bars.length === 0) {
      throw new Error('No bars returned from Alpaca');
    }

    console.log(`✓ Got ${bars.length} bars from Alpaca`);
    const latest = bars[bars.length - 1];
    console.log(`  Latest: $${latest.close.toFixed(2)}\n`);

    return bars;
  } catch (e) {
    console.error(`❌ Failed to fetch from Alpaca: ${(e as Error).message}`);
    throw e;
  }
}

async function runLiveTrading(
  strategyYaml: string,
  symbol: string = 'NFLX'
): Promise<LiveResult> {
  console.log('\n📡 Connecting for market data...\n');

  const alpaca = new AlpacaClient();
  const account = await alpaca.getAccount();

  console.log(`✓ Connected to account: ${account.account_number}`);
  console.log(`  Portfolio: $${parseFloat(account.portfolio_value).toFixed(2)}`);
  console.log(`  Cash: $${parseFloat(account.cash).toFixed(2)}`);
  console.log(`  Buying Power: $${parseFloat(account.buying_power).toFixed(2)}\n`);

  // Compile strategy FIRST to get timeframe
  const compiler = new StrategyCompiler(createStandardRegistry());
  const registry = createStandardRegistry();
  const ir = compiler.compileFromYAML(strategyYaml);

  // Extract timeframe from strategy
  const timeframeStr = ir.timeframe || '1d';

  // Fetch initial historical bars with correct timeframe
  const initialBars = await fetchHistoricalBars(symbol, alpaca, 30, timeframeStr);

  if (initialBars.length === 0) {
    throw new Error(`No bars available for ${symbol}`);
  }

  console.log(`✓ Loaded ${initialBars.length} historical bars`);
  const latest = initialBars[initialBars.length - 1];
  const date = new Date(latest.timestamp).toISOString();
  console.log(`  Latest: ${date} @ $${latest.close.toFixed(2)}\n`);

  const enableLive = process.env.LIVE === 'true';

  // Broker selection: TWS (default) or Alpaca
  const brokerType = process.env.BROKER || 'tws';
  let adapter: BaseBrokerAdapter;

  if (brokerType.toLowerCase() === 'alpaca') {
    console.log('📊 Using Alpaca broker\n');
    const baseUrl = process.env.APCA_API_BASE_URL || process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
    const apiKey = process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
    const apiSecret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '';
    adapter = new AlpacaRestAdapter(baseUrl, apiKey, apiSecret);
  } else {
    console.log('📊 Using TWS (Interactive Brokers) broker\n');
    const twsHost = process.env.TWS_HOST || '127.0.0.1';
    const twsPort = parseInt(process.env.TWS_PORT || '7497'); // 7497 = paper trading, 7496 = live
    const twsClientId = parseInt(process.env.TWS_CLIENT_ID || '0');
    adapter = new TwsAdapter(twsHost, twsPort, twsClientId);
  }

  const baseUrl = process.env.APCA_API_BASE_URL || process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
  const apiKey = process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY || '';
  const apiSecret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '';

  // Calculate optimal check interval based on timeframe
  const checkIntervalMs = calculateOptimalCheckInterval(timeframeStr);
  const checkIntervalSec = Math.round(checkIntervalMs / 1000);

  console.log('═'.repeat(60));
  console.log('RUNNING LIVE TRADING LOOP');
  console.log('═'.repeat(60) + '\n');

  console.log(`⏰ Market hours: 9:30 AM - 4:00 PM ET`);
  console.log(`📍 Current time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}`);
  console.log(`📊 Strategy timeframe: ${timeframeStr}`);
  console.log(`🔄 Checking for new bars every ${checkIntervalSec} seconds...\n`);

  // Create engine
  const engine = new StrategyEngine(ir, registry, adapter, {
    dryRun: !enableLive,
    baseUrl,
    apiKey,
    apiSecret,
  });

  // Initialize with historical data
  for (const bar of initialBars) {
    await engine.processBar(bar);
  }

  // Trading loop
  const logs: string[] = [];
  const allBars = [...initialBars];
  let lastBarTimestamp = initialBars[initialBars.length - 1].timestamp;
  const startTime = Date.now();
  const maxDuration = 7 * 60 * 60 * 1000; // 7 hours (safe margin beyond market hours)

  console.log(`✅ Starting live trading loop at ${new Date().toLocaleTimeString()}\n`);

  // Continuous loop
  while (Date.now() - startTime < maxDuration) {
    // Check if market is closed (after 4 PM ET)
    const now = new Date();
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();

    if (hours >= 16) {
      // 4:00 PM or later - close everything and exit
      console.log('\n⏰ Market closing (4:00 PM ET)...');
      const finalState = engine.getState();

      if (finalState.currentState !== 'IDLE' && finalState.currentState !== 'EXITED') {
        console.log('🔴 Closing all positions at market close...');
        // Force exit by processing invalidation
        const lastBar = allBars[allBars.length - 1];
        const closeBar: Bar = {
          timestamp: Date.now(),
          open: lastBar.close,
          high: lastBar.close,
          low: lastBar.close,
          close: lastBar.close,
          volume: 0,
        };
        await engine.processBar(closeBar);
      }

      return {
        symbol,
        timestamp: new Date().toISOString(),
        account: {
          portfolio_value: account.portfolio_value,
          buying_power: account.buying_power,
          cash: account.cash,
        },
        bars: allBars.slice(-5),
        state: engine.getState().currentState,
        ordersPlaced: engine.getState().openOrders.length,
        logs,
      };
    }

    // Fetch latest bar
    try {
      const newBars = await fetchHistoricalBars(symbol, alpaca, 2, timeframeStr);

      if (newBars.length > 0) {
        const latestBar = newBars[newBars.length - 1];

        // Process only new bars
        if (latestBar.timestamp > lastBarTimestamp) {
          lastBarTimestamp = latestBar.timestamp;
          allBars.push(latestBar);

          // Process the new bar
          await engine.processBar(latestBar);
          const state = engine.getState();
          const stateStr = state.currentState;
          const timeStr = new Date(latestBar.timestamp).toLocaleTimeString();

          const log = `[${timeStr}] [${stateStr}] $${latestBar.close.toFixed(2)} V:${(latestBar.volume / 1e6).toFixed(1)}M`;
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
      }
    } catch (e) {
      // Silently continue on network errors
      console.log(`  (connection check, retrying...)`);
    }

    // Check at optimal interval based on timeframe
    await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
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
    bars: allBars.slice(-5),
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
  const brokerType = (process.env.BROKER || 'tws').toUpperCase();

  console.log('\n╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('║' + `LIVE TRADING: ${symbol}`.padEnd(58) + '║');
  console.log('║' + `Broker: ${brokerType}`.padEnd(58) + '║');
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
