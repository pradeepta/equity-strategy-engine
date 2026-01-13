/**
 * Backtest: Run strategy against historical NFLX data
 * Uses free Yahoo Finance data
 */

import * as fs from 'fs';
import * as https from 'https';
import { StrategyCompiler } from './compiler/compile';
import { createStandardRegistry } from './features/registry';
import { StrategyEngine } from './runtime/engine';
import { AlpacaRestAdapter } from './broker/alpacaRest';
import { Bar } from './spec/types';

// ============================================================================
// Yahoo Finance Data Fetcher
// ============================================================================

interface YahooBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number;
}

async function fetchNFLXHistoricalData(days: number = 60): Promise<YahooBar[]> {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const past = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    const url =
      `https://query1.finance.yahoo.com/v7/finance/download/NFLX?` +
      `period1=${past}&period2=${now}&interval=1d&events=history&includeAdjustedClose=true`;

    console.log(`\nFetching NFLX historical data (${days} days)...`);
    console.log(`URL: ${url}\n`);

    https
      .get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const lines = data.split('\n');
            const bars: YahooBar[] = [];

            // Skip header
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;

              const parts = line.split(',');
              if (parts.length < 6) continue;

              // Skip invalid data
              if (parts[1] === 'null' || parts[4] === 'null') continue;

              bars.push({
                date: parts[0],
                open: parseFloat(parts[1]),
                high: parseFloat(parts[2]),
                low: parseFloat(parts[3]),
                close: parseFloat(parts[4]),
                volume: parseInt(parts[6], 10),
                adjClose: parseFloat(parts[5]),
              });
            }

            if (bars.length === 0) {
              console.log('⚠️  No data from Yahoo Finance. Using mock data instead.\n');
              resolve(generateMockNFLXData());
            } else {
              console.log(`✓ Fetched ${bars.length} bars\n`);
              resolve(bars);
            }
          } catch (e) {
            console.log('⚠️  Parse error. Using mock data instead.\n');
            resolve(generateMockNFLXData());
          }
        });
      })
      .on('error', (err) => {
        console.error('Fetch error:', err.message);
        console.log('\n⚠️  Yahoo Finance unavailable. Using mock data instead.\n');
        resolve(generateMockNFLXData());
      });
  });
}

// ============================================================================
// Mock Data (fallback if Yahoo Finance is unavailable)
// ============================================================================

function generateMockNFLXData(): YahooBar[] {
  console.log('Using mock NFLX data for demonstration\n');

  // Simulate 60 days of NFLX data with realistic movement
  const bars: YahooBar[] = [];
  let price = 350; // Approximate current NFLX price

  for (let i = 0; i < 60; i++) {
    const change = (Math.random() - 0.5) * 5; // ±2.5% daily
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * 0.02);
    const low = Math.min(open, close) * (1 - Math.random() * 0.02);
    const volume = 40000000 + Math.random() * 20000000;

    const now = Date.now();
    const barTime = new Date(now - (60 - i) * 24 * 60 * 60 * 1000);
    const dateStr = barTime.toISOString().split('T')[0];

    bars.push({
      date: dateStr,
      open,
      high,
      low,
      close,
      volume: Math.floor(volume),
      adjClose: close,
    });

    price = close;
  }

  return bars.reverse(); // Oldest first
}

// ============================================================================
// Convert to Bar format
// ============================================================================

function convertToBarStream(yahooData: YahooBar[]): Bar[] {
  let timestamp = Math.floor(new Date(yahooData[0].date).getTime() / 1000) * 1000;

  return yahooData.map((y) => {
    const bar: Bar = {
      timestamp,
      open: y.open,
      high: y.high,
      low: y.low,
      close: y.close,
      volume: y.volume,
    };
    timestamp += 24 * 60 * 60 * 1000; // Next day
    return bar;
  });
}

// ============================================================================
// Backtest Engine
// ============================================================================

interface BacktestResult {
  symbol: string;
  strategy: string;
  barsProcessed: number;
  ordersPlaced: number;
  finalState: string;
  stateTransitions: Array<{
    bar: number;
    from: string;
    to: string;
    action: string;
  }>;
  priceAtArm: number | null;
  priceAtTrigger: number | null;
  priceAtExit: number | null;
  maxDrawdown: number;
  logs: Array<{
    bar: number;
    close: number;
    state: string;
    event: string;
  }>;
}

async function runBacktest(
  strategyYaml: string,
  bars: Bar[]
): Promise<BacktestResult> {
  const compiler = new StrategyCompiler(createStandardRegistry());
  const registry = createStandardRegistry();
  const adapter = new AlpacaRestAdapter();

  // Compile
  const ir = compiler.compileFromYAML(strategyYaml);

  // Create engine
  const engine = new StrategyEngine(ir, registry, adapter, {
    dryRun: true,
  });

  // Track events
  const transitions: BacktestResult['stateTransitions'] = [];
  const logs: BacktestResult['logs'] = [];
  let priceAtArm: number | null = null;
  let priceAtTrigger: number | null = null;
  let priceAtExit: number | null = null;

  // Process bars
  console.log(`Processing ${bars.length} bars...\n`);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prevState = engine.getState().currentState;

    await engine.processBar(bar);

    const state = engine.getState();
    const currState = state.currentState;

    // Track transitions
    if (prevState !== currState) {
      transitions.push({
        bar: i + 1,
        from: prevState,
        to: currState,
        action: state.log[state.log.length - 1]?.message || 'transition',
      });

      // Track prices at key events
      if (currState === 'ARMED' && !priceAtArm) {
        priceAtArm = bar.close;
      }
      if (currState === 'PLACED' && !priceAtTrigger) {
        priceAtTrigger = bar.close;
      }
      if (currState === 'EXITED' && !priceAtExit) {
        priceAtExit = bar.close;
      }
    }

    // Track logs
    logs.push({
      bar: i + 1,
      close: bar.close,
      state: currState,
      event: state.log[state.log.length - 1]?.message || '',
    });
  }

  const finalState = engine.getState();

  // Calculate max drawdown (simplistic)
  let maxDrawdown = 0;
  let peak = bars[0].close;
  for (const bar of bars) {
    peak = Math.max(peak, bar.close);
    const drawdown = ((peak - bar.close) / peak) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return {
    symbol: ir.symbol,
    strategy: 'Fade VWAP Reclaim',
    barsProcessed: bars.length,
    ordersPlaced: finalState.openOrders.length,
    finalState: finalState.currentState,
    stateTransitions: transitions,
    priceAtArm,
    priceAtTrigger,
    priceAtExit,
    maxDrawdown,
    logs,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Get strategy from command line or use default
  const strategyFile = process.argv[2] || 'nflx-mean-reversion';
  const strategyPath = `./strategies/${strategyFile}.yaml`;

  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('║' + `BACKTEST: ${strategyFile}`.padEnd(58) + '║');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝\n');

  try {
    // Load strategy
    if (!fs.existsSync(strategyPath)) {
      throw new Error(`Strategy file not found: ${strategyPath}`);
    }

    const strategyYaml = fs.readFileSync(strategyPath, 'utf-8');

    // Fetch data
    const yahooData = await fetchNFLXHistoricalData(60);
    const bars = convertToBarStream(yahooData);

    if (bars.length === 0) {
      throw new Error('No bars fetched');
    }

    const dateStart = yahooData[0]?.date || 'N/A';
    const dateEnd = yahooData[yahooData.length - 1]?.date || 'N/A';
    console.log(`Date range: ${dateStart} to ${dateEnd}`);
    console.log(`Price range: $${Math.min(...bars.map((b) => b.low)).toFixed(2)} - $${Math.max(...bars.map((b) => b.high)).toFixed(2)}\n`);

    // Run backtest
    const result = await runBacktest(strategyYaml, bars);

    // Print results
    console.log('═'.repeat(60));
    console.log('BACKTEST RESULTS');
    console.log('═'.repeat(60) + '\n');

    console.log(`Strategy: ${result.strategy}`);
    console.log(`Symbol: ${result.symbol}`);
    console.log(`Bars Processed: ${result.barsProcessed}`);
    console.log(`Final State: ${result.finalState}\n`);

    console.log('State Transitions:');
    if (result.stateTransitions.length === 0) {
      console.log('  (No transitions)');
    } else {
      for (const t of result.stateTransitions) {
        console.log(
          `  Bar ${t.bar}: ${t.from} → ${t.to} (${t.action})`
        );
      }
    }

    console.log('\nKey Prices:');
    if (result.priceAtArm) {
      console.log(`  At ARM: $${result.priceAtArm.toFixed(2)}`);
    }
    if (result.priceAtTrigger) {
      console.log(`  At TRIGGER: $${result.priceAtTrigger.toFixed(2)}`);
      if (result.priceAtArm) {
        const move = ((result.priceAtTrigger - result.priceAtArm) / result.priceAtArm) * 100;
        console.log(`    (${move > 0 ? '+' : ''}${move.toFixed(2)}% from arm)`);
      }
    }
    if (result.priceAtExit) {
      console.log(`  At EXIT: $${result.priceAtExit.toFixed(2)}`);
    }

    console.log(`\nMax Drawdown: ${result.maxDrawdown.toFixed(2)}%`);
    console.log(`Orders Placed: ${result.ordersPlaced}`);

    // Recent events
    console.log('\nRecent Events (last 10 bars):');
    for (const log of result.logs.slice(-10)) {
      if (log.event) {
        console.log(
          `  Bar ${log.bar} @ $${log.close.toFixed(2)}: ${log.state} - ${log.event}`
        );
      }
    }

    console.log('\n' + '═'.repeat(60) + '\n');

    // Summary
    if (result.stateTransitions.length === 0) {
      console.log('📊 No arm/trigger during this period.');
      console.log('💡 Strategy stayed in IDLE state.');
      console.log('   Try adjusting arm/trigger conditions or longer backtest window.\n');
    } else if (result.finalState === 'PLACED' || result.finalState === 'MANAGING') {
      console.log('✅ Strategy armed and triggered!');
      console.log('   Orders would have been submitted to Alpaca.\n');
    } else {
      console.log('⚠️  Strategy exited before bar 60.');
      console.log('   Check invalidate conditions.\n');
    }

    console.log('Next Steps:');
    console.log('1. Try different symbols: modify backtest.ts');
    console.log('2. Adjust strategy: edit strategies/fade-vwap-reclaim.yaml');
    console.log('3. Paper trade: Set up Alpaca API keys and run live\n');

  } catch (e) {
    const err = e as Error;
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main().catch(console.error);
