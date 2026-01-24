/**
 * Detailed Backtest with P&L Calculations
 * Tests multiple strategies and calculates profit/loss
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

// Mock realistic market scenarios based on typical price action
function generateRealisticBars(symbol: string, days: number = 60): Bar[] {
  const bars: Bar[] = [];

  // Realistic starting prices by symbol
  const startPrices: Record<string, number> = {
    'NFLX': 350,
    'AAPL': 195,
    'TSLA': 245,
    'SPY': 565
  };

  let price = startPrices[symbol] || 100;
  let timestamp = Date.now() - days * 24 * 60 * 60 * 1000;

  for (let i = 0; i < days; i++) {
    // Simulate realistic daily moves (0.5-2%)
    const dailyVolatility = 0.015;
    const randomWalk = (Math.random() - 0.5) * 2 * dailyVolatility;
    const trend = 0.0005; // Slight uptrend
    const dailyChange = randomWalk + trend;

    const open = price;
    const close = price * (1 + dailyChange);
    const high = Math.max(open, close) * (1 + Math.random() * 0.01);
    const low = Math.min(open, close) * (1 - Math.random() * 0.01);
    const volume = 40000000 + Math.random() * 20000000;

    bars.push({
      date: new Date(timestamp).toISOString().split('T')[0],
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: Math.floor(volume),
    });

    price = close;
    timestamp += 24 * 60 * 60 * 1000;
  }

  return bars;
}

// Calculate strategy performance
interface StrategyResult {
  symbol: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  maxProfit: number;
  maxLoss: number;
  actualProfit: number;
  tradeCount: number;
  winRate: number;
  bars: Bar[];
}

function backTestStrategy(symbol: string, strategyName: string): StrategyResult {
  const bars = generateRealisticBars(symbol, 60);

  // Strategy parameters from optimized v2 strategies
  const strategies: Record<string, any> = {
    'NFLX-Adaptive': {
      entryZone: [345, 355],
      target1: 360,                       // Wider targets
      target2: 370,                       // Was 358
      stopPrice: 335,                     // Wider stop: was 342.5
      qty: 10,
    },
    'AAPL-Momentum': {
      entryZone: [190, 200],
      target1: 204,                       // Same targets
      target2: 210,                       // Was 208
      stopPrice: 185,                     // Wider: was 187
      qty: 10,
    },
    'TSLA-Volatile': {
      entryZone: [240, 250],
      target1: 262.5,                     // Much bigger targets
      target2: 283,                       // Was 262.5
      stopPrice: 233,                     // Much wider: was 235
      qty: 10,
    },
    'SPY-ETF': {
      entryZone: [560, 570],
      target1: 577.5,                     // Slightly bigger
      target2: 595,                       // Was 585
      stopPrice: 553,                     // Wider: was 557
      qty: 10,
    },
  };

  const params = strategies[strategyName];
  if (!params) {
    return {
      symbol,
      strategy: strategyName,
      entryPrice: 0,
      exitPrice: 0,
      maxProfit: 0,
      maxLoss: 0,
      actualProfit: 0,
      tradeCount: 0,
      winRate: 0,
      bars,
    };
  }

  let entryPrice = 0;
  let exitPrice = 0;
  let tradeCount = 0;
  let winCount = 0;
  let totalProfit = 0;
  let maxProfit = 0;
  let maxLoss = 0;

  // Simulate trades
  let inTrade = false;
  let entryBar = -1;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Entry condition: price in entry zone
    if (!inTrade && bar.close >= params.entryZone[0] && bar.close <= params.entryZone[1]) {
      entryPrice = bar.close;
      entryBar = i;
      inTrade = true;
    }

    // Exit condition: reached targets or stops
    if (inTrade) {
      let profit = 0;
      let tradeProfit = 0;

      // Check if hit target 1 (50% position)
      if (bar.high >= params.target1) {
        tradeProfit = (params.target1 - entryPrice) * (params.qty / 2);
        winCount++;
      }
      // Check if hit target 2 (remaining 50%)
      else if (bar.high >= params.target2) {
        tradeProfit = (params.target2 - entryPrice) * (params.qty / 2);
        winCount++;
      }
      // Check if hit stop loss
      else if (bar.low <= params.stopPrice) {
        tradeProfit = (params.stopPrice - entryPrice) * params.qty;
      }
      // Exit at bar close if no target/stop hit after 5 bars
      else if (i - entryBar >= 5) {
        tradeProfit = (bar.close - entryPrice) * params.qty;
      } else {
        continue;
      }

      // Trade completed
      if (tradeProfit !== 0 || i - entryBar >= 5) {
        exitPrice = bar.close;
        tradeCount++;
        totalProfit += tradeProfit;
        maxProfit = Math.max(maxProfit, tradeProfit);
        maxLoss = Math.min(maxLoss, tradeProfit);
        inTrade = false;
      }
    }
  }

  return {
    symbol,
    strategy: strategyName,
    entryPrice,
    exitPrice,
    maxProfit,
    maxLoss,
    actualProfit: parseFloat(totalProfit.toFixed(2)),
    tradeCount,
    winRate: tradeCount > 0 ? (winCount / tradeCount) * 100 : 0,
    bars,
  };
}

async function main() {
  console.log('\n╔' + '═'.repeat(70) + '╗');
  console.log('║' + ' DETAILED BACKTEST: Multi-Strategy Performance Analysis '.padEnd(72) + '║');
  console.log('╚' + '═'.repeat(70) + '╝\n');

  const strategies = [
    { symbol: 'NFLX', name: 'NFLX-Adaptive' },
    { symbol: 'AAPL', name: 'AAPL-Momentum' },
    { symbol: 'TSLA', name: 'TSLA-Volatile' },
    { symbol: 'SPY', name: 'SPY-ETF' },
  ];

  const results: StrategyResult[] = [];
  let totalDeployed = 0;
  let totalProfit = 0;
  let totalTrades = 0;

  for (const strat of strategies) {
    console.log(`\n📊 Backtesting: ${strat.name} (${strat.symbol})\n`);
    const result = backTestStrategy(strat.symbol, strat.name);
    results.push(result);

    // Calculate capital deployed using entry zone midpoint
    const params: any = {
      'NFLX-Adaptive': { entryPrice: 350, qty: 10 },      // Updated: qty 6→10
      'AAPL-Momentum': { entryPrice: 195, qty: 10 },      // Updated: qty 5→10
      'TSLA-Volatile': { entryPrice: 245, qty: 10 },      // Same
      'SPY-ETF': { entryPrice: 565, qty: 10 },            // Same
    };

    const capital = params[strat.name]?.entryPrice * params[strat.name]?.qty || 0;

    console.log(`   Entry Price: $${result.entryPrice.toFixed(2)}`);
    console.log(`   Exit Price: $${result.exitPrice.toFixed(2)}`);
    console.log(`   Capital Deployed: $${capital.toFixed(2)}`);
    console.log(`   Trades Executed: ${result.tradeCount}`);
    console.log(`   Total P&L: ${result.actualProfit >= 0 ? '✓' : '✗'} $${result.actualProfit.toFixed(2)}`);
    console.log(`   Best Trade: +$${result.maxProfit.toFixed(2)}`);
    console.log(`   Worst Trade: -$${Math.abs(result.maxLoss).toFixed(2)}`);
    console.log(`   Win Rate: ${result.winRate.toFixed(1)}%`);
    console.log(`   ROI: ${((result.actualProfit / capital) * 100).toFixed(2)}%`);

    totalDeployed += capital;
    totalProfit += result.actualProfit;
    totalTrades += result.tradeCount;
  }

  // Summary
  console.log('\n' + '═'.repeat(72));
  console.log('PORTFOLIO BACKTEST SUMMARY');
  console.log('═'.repeat(72) + '\n');

  console.log('Results Summary:');
  for (const result of results) {
    const emoji = result.actualProfit >= 0 ? '✓' : '✗';
    console.log(`  ${emoji} ${result.strategy.padEnd(18)} | P&L: $${result.actualProfit.toFixed(2).padStart(8)} | Trades: ${result.tradeCount}`);
  }

  console.log('\n' + '─'.repeat(72));
  console.log(`Total Capital Deployed: $${totalDeployed.toFixed(2)}`);
  console.log(`Total P&L (60-day period): ${totalProfit >= 0 ? '✓' : '✗'} $${totalProfit.toFixed(2)}`);
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Overall ROI: ${((totalProfit / totalDeployed) * 100).toFixed(2)}%`);
  console.log(`Average Trade P&L: $${(totalProfit / Math.max(totalTrades, 1)).toFixed(2)}`);

  // Annualized projections
  const daysInPeriod = 60;
  const daysInYear = 365;
  const periodsPerYear = daysInYear / daysInPeriod;
  const projectedAnnualProfit = totalProfit * periodsPerYear;
  const projectedAnnualROI = ((totalProfit / totalDeployed) * 100) * periodsPerYear;

  console.log('\n' + '═'.repeat(72));
  console.log('ANNUALIZED PROJECTIONS (if performance repeats)');
  console.log('═'.repeat(72) + '\n');

  console.log(`60-Day Profit: $${totalProfit.toFixed(2)}`);
  console.log(`Projected Annual Profit: $${projectedAnnualProfit.toFixed(2)}`);
  console.log(`Projected Annual ROI: ${projectedAnnualROI.toFixed(2)}%`);
  console.log(`Starting Capital: $10,000`);
  console.log(`Projected Year-End Capital: $${(10000 + projectedAnnualProfit).toFixed(2)}`);

  console.log('\n' + '═'.repeat(72));
  console.log('CONSERVATIVE ESTIMATES (assuming 50% of projected returns)');
  console.log('═'.repeat(72) + '\n');

  const conservativeProfit = projectedAnnualProfit * 0.5;
  const conservativeROI = projectedAnnualROI * 0.5;

  console.log(`Conservative Annual Profit: $${conservativeProfit.toFixed(2)}`);
  console.log(`Conservative Annual ROI: ${conservativeROI.toFixed(2)}%`);
  console.log(`Conservative Year-End Capital: $${(10000 + conservativeProfit).toFixed(2)}`);

  console.log('\n' + '═'.repeat(72));
  console.log('KEY INSIGHTS');
  console.log('═'.repeat(72) + '\n');

  const winningStrategies = results.filter(r => r.actualProfit > 0);
  const losingStrategies = results.filter(r => r.actualProfit < 0);

  console.log(`Winning Strategies: ${winningStrategies.length}/${results.length}`);
  for (const r of winningStrategies) {
    console.log(`  ✓ ${r.strategy}: +$${r.actualProfit.toFixed(2)}`);
  }

  if (losingStrategies.length > 0) {
    console.log(`\nLosing Strategies: ${losingStrategies.length}/${results.length}`);
    for (const r of losingStrategies) {
      console.log(`  ✗ ${r.strategy}: -$${Math.abs(r.actualProfit).toFixed(2)}`);
    }
  }

  console.log('\n' + '═'.repeat(72) + '\n');
}

main().catch(console.error);
