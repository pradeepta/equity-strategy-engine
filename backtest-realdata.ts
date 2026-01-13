/**
 * Backtest with Real Market Data from Yahoo Finance
 * Tests all 4 optimized v2 strategies on actual historical data
 */

import * as https from 'https';

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Fetch real market data from Yahoo Finance
function fetchYahooData(symbol: string, days: number = 90): Promise<Bar[]> {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const past = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    const url =
      `https://query1.finance.yahoo.com/v7/finance/download/${symbol}?` +
      `period1=${past}&period2=${now}&interval=1d&events=history&includeAdjustedClose=true`;

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
              if (parts.length < 5 || parts[1] === 'null') continue;

              try {
                const date = new Date(parts[0]);
                if (isNaN(date.getTime())) continue;

                bars.push({
                  date: parts[0],
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

            resolve(bars);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

// Calculate EMA
function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];

  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  // Start with SMA
  let sum = 0;
  for (let i = 0; i < Math.min(period, closes.length); i++) {
    sum += closes[i];
  }

  if (closes.length >= period) {
    ema[period - 1] = sum / period;
  }

  // Calculate EMA
  for (let i = period; i < closes.length; i++) {
    const val = (closes[i] - ema[i - 1]) * multiplier + ema[i - 1];
    ema[i] = val;
  }

  return ema;
}

// Backtest strategy
function backTestRealData(symbol: string, bars: Bar[], strategy: any) {
  const closes = bars.map(b => b.close);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);

  let entryPrice = 0;
  let trades = 0;
  let wins = 0;
  let totalProfit = 0;
  let inTrade = false;

  for (let i = 50; i < bars.length; i++) {
    const bar = bars[i];
    const close = bar.close;
    const high = bar.high;
    const low = bar.low;

    // Simple entry logic based on strategy
    if (!inTrade) {
      // Check if price is in entry zone and EMAs aligned
      if (
        close >= strategy.entryZone[0] &&
        close <= strategy.entryZone[1] &&
        ema20[i] > ema50[i]
      ) {
        entryPrice = close;
        inTrade = true;
      }
    } else {
      // Check exit conditions
      let tradeProfit = 0;
      let shouldExit = false;

      // Check if hit target 1 (50% position)
      if (high >= strategy.target1) {
        tradeProfit = (strategy.target1 - entryPrice) * (strategy.qty / 2);
        wins++;
        shouldExit = true;
      }
      // Check if hit target 2 (remaining 50%)
      else if (high >= strategy.target2) {
        tradeProfit = (strategy.target2 - entryPrice) * (strategy.qty / 2);
        wins++;
        shouldExit = true;
      }
      // Check if hit stop loss
      else if (low <= strategy.stopPrice) {
        tradeProfit = (strategy.stopPrice - entryPrice) * strategy.qty;
        shouldExit = true;
      }
      // Exit after 5 bars if no target/stop
      else if (i - 50 > 5) {
        tradeProfit = (close - entryPrice) * strategy.qty;
        shouldExit = true;
      }

      if (shouldExit) {
        trades++;
        totalProfit += tradeProfit;
        inTrade = false;
      }
    }
  }

  return {
    trades,
    wins,
    totalProfit: parseFloat(totalProfit.toFixed(2)),
    winRate: trades > 0 ? ((wins / trades) * 100).toFixed(1) : '0.0',
  };
}

// Main backtest function
async function main() {
  console.log('\n╔' + '═'.repeat(70) + '╗');
  console.log('║' + ' REAL DATA BACKTEST: All 4 Optimized v2 Strategies '.padEnd(72) + '║');
  console.log('╚' + '═'.repeat(70) + '╝\n');

  const strategies = [
    {
      name: 'NFLX-Adaptive',
      symbol: 'NFLX',
      entryZone: [345, 355],
      target1: 360,
      target2: 370,
      stopPrice: 335,
      qty: 10,
    },
    {
      name: 'AAPL-Momentum',
      symbol: 'AAPL',
      entryZone: [190, 200],
      target1: 204,
      target2: 210,
      stopPrice: 185,
      qty: 10,
    },
    {
      name: 'TSLA-Volatile',
      symbol: 'TSLA',
      entryZone: [240, 250],
      target1: 262.5,
      target2: 283,
      stopPrice: 233,
      qty: 10,
    },
    {
      name: 'SPY-ETF',
      symbol: 'SPY',
      entryZone: [560, 570],
      target1: 577.5,
      target2: 595,
      stopPrice: 553,
      qty: 10,
    },
  ];

  let totalCapital = 0;
  let totalProfit = 0;
  let totalTrades = 0;

  for (const strategy of strategies) {
    console.log(`\n📊 Backtesting ${strategy.name} (${strategy.symbol})...`);

    try {
      const bars = await fetchYahooData(strategy.symbol, 90);
      console.log(`✓ Fetched ${bars.length} days of real data\n`);

      const result = backTestRealData(strategy.symbol, bars, strategy);
      const capital = strategy.entryZone[0] * strategy.qty;
      const roi = ((result.totalProfit / capital) * 100).toFixed(2);

      console.log(`   Trades Executed: ${result.trades}`);
      console.log(`   Winning Trades: ${result.wins}`);
      console.log(`   Win Rate: ${result.winRate}%`);
      console.log(`   Capital Deployed: $${capital.toFixed(2)}`);
      console.log(`   Total P&L: ${result.totalProfit >= 0 ? '✓' : '✗'} $${result.totalProfit.toFixed(2)}`);
      console.log(`   ROI: ${result.totalProfit >= 0 ? '✓' : '✗'} ${roi}%`);

      totalCapital += capital;
      totalProfit += result.totalProfit;
      totalTrades += result.trades;
    } catch (e) {
      const err = e as Error;
      console.log(`   ❌ Error: ${err.message}`);
      console.log(`   (Network issue or symbol not available)\n`);
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(72));
  console.log('REAL DATA BACKTEST SUMMARY');
  console.log('═'.repeat(72) + '\n');

  if (totalTrades > 0) {
    console.log(`Total Capital Deployed: $${totalCapital.toFixed(2)}`);
    console.log(`Total P&L (90-day period): ${totalProfit >= 0 ? '✓' : '✗'} $${totalProfit.toFixed(2)}`);
    console.log(`Total Trades: ${totalTrades}`);
    console.log(`Overall ROI: ${((totalProfit / totalCapital) * 100).toFixed(2)}%`);
    console.log(`Average Trade P&L: $${(totalProfit / totalTrades).toFixed(2)}`);

    // Annualization
    const periodsPerYear = 365 / 90;
    const annualProfit = totalProfit * periodsPerYear;
    const annualROI = ((totalProfit / totalCapital) * 100) * periodsPerYear;

    console.log('\n' + '═'.repeat(72));
    console.log('ANNUALIZED PROJECTIONS');
    console.log('═'.repeat(72) + '\n');

    console.log(`90-Day Profit: $${totalProfit.toFixed(2)}`);
    console.log(`Projected Annual Profit: $${annualProfit.toFixed(2)}`);
    console.log(`Projected Annual ROI: ${annualROI.toFixed(2)}%`);
    console.log(`Starting Capital: $10,000`);
    console.log(`Projected Year-End: $${(10000 + annualProfit).toFixed(2)}`);
  } else {
    console.log('⚠️  No trades executed - likely network issues with Yahoo Finance');
    console.log('    This can happen due to API rate limiting or network restrictions');
  }

  console.log('\n' + '═'.repeat(72) + '\n');
}

main().catch((e) => {
  console.error('Fatal error:', (e as Error).message);
  process.exit(1);
});
