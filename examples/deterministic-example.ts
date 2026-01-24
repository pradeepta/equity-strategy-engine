#!/usr/bin/env tsx

/**
 * Example: Using Deterministic Strategy Generator
 *
 * This demonstrates how to generate trading strategies using pure math
 * instead of subjective analysis.
 */

import { proposeBestStrategy } from '../src/strategy/generate';
import type { Bar, Constraints } from '../src/strategy/metrics';

// Mock market data generator (replace with real data fetcher in production)
function generateMockBars(count: number, startPrice: number, trend: number): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    price += trend + (Math.random() - 0.5) * 0.3; // Add some noise
    const volatility = Math.abs(Math.sin(i * 0.1)) * 0.5;

    bars.push({
      timestamp: Date.now() - (count - i) * 300000, // 5-minute bars
      open: price - 0.1,
      high: price + volatility,
      low: price - volatility,
      close: price,
      volume: 10000 + Math.random() * 5000,
    });
  }

  return bars;
}

async function main() {
  console.log('='.repeat(80));
  console.log('Deterministic Strategy Generator - Example');
  console.log('='.repeat(80));
  console.log();

  // Example 1: Bullish trending market
  console.log('📈 Example 1: Bullish Trend (AAPL simulation)');
  console.log('-'.repeat(80));

  const bullishBars = generateMockBars(100, 100, 0.1); // Uptrend

  const constraints: Constraints = {
    maxRiskPerTrade: 100,
    rrTarget: 3.0,
    maxEntryDistancePct: 3.0,
    entryTimeoutBars: 10,
    rthOnly: true,
  };

  const result1 = proposeBestStrategy(bullishBars, 'AAPL', '5m', constraints);

  if (result1.error) {
    console.error('❌ Error:', result1.error);
    return;
  }

  console.log('Market Metrics:');
  console.log(`  ATR: $${result1.metrics.atr.toFixed(2)}`);
  console.log(`  20-bar Trend: ${result1.metrics.trend20.toFixed(2)}%`);
  console.log(`  Current Price: $${result1.metrics.currentPrice.toFixed(2)}`);
  console.log(`  Range (20b): $${result1.metrics.rangeLow20.toFixed(2)} - $${result1.metrics.rangeHigh20.toFixed(2)}`);
  console.log();

  console.log('✅ Best Strategy:', result1.best!.name);
  console.log(`  Family: ${result1.best!.family}`);
  console.log(`  Side: ${result1.best!.side.toUpperCase()}`);
  console.log(`  Entry Zone: $${result1.best!.entryLow} - $${result1.best!.entryHigh}`);
  console.log(`  Stop: $${result1.best!.stop}`);
  console.log(`  Target: $${result1.best!.target}`);
  console.log(`  Quantity: ${result1.best!.qty} shares`);
  console.log(`  R:R (worst-case): ${result1.best!.rrWorst}:1`);
  console.log(`  Dollar Risk (worst-case): $${result1.best!.dollarRiskWorst}`);
  console.log(`  Entry Distance: ${result1.best!.entryDistancePct}%`);
  console.log();

  console.log('📋 Top 5 Alternatives:');
  result1.candidatesTop5.slice(0, 5).forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.name} (${c.side}) - R:R ${c.rrWorst}:1, ${c.entryDistancePct}% away`);
  });
  console.log();

  // Example 2: Sideways market
  console.log('📊 Example 2: Sideways Market (TSLA simulation)');
  console.log('-'.repeat(80));

  const sidewaysBars = generateMockBars(100, 200, 0.01); // Minimal trend

  const result2 = proposeBestStrategy(sidewaysBars, 'TSLA', '5m', constraints);

  if (result2.error) {
    console.error('❌ Error:', result2.error);
    return;
  }

  console.log('Market Metrics:');
  console.log(`  ATR: $${result2.metrics.atr.toFixed(2)}`);
  console.log(`  20-bar Trend: ${result2.metrics.trend20.toFixed(2)}%`);
  console.log(`  Current Price: $${result2.metrics.currentPrice.toFixed(2)}`);
  console.log();

  console.log('✅ Best Strategy:', result2.best!.name);
  console.log(`  Family: ${result2.best!.family}`);
  console.log(`  Side: ${result2.best!.side.toUpperCase()}`);
  console.log(`  Entry Zone: $${result2.best!.entryLow} - $${result2.best!.entryHigh}`);
  console.log(`  R:R (worst-case): ${result2.best!.rrWorst}:1`);
  console.log();

  // Example 3: High volatility with relaxed parameters
  console.log('⚠️  Example 3: High Volatility - Relaxed Parameters');
  console.log('-'.repeat(80));

  const volatileBars = generateMockBars(100, 150, 0.3); // High volatility

  const relaxedConstraints: Constraints = {
    maxRiskPerTrade: 150,
    rrTarget: 2.0,              // Lower R:R target
    maxEntryDistancePct: 5.0,   // Allow farther entries
    entryTimeoutBars: 15,
    rthOnly: true,
  };

  const result3 = proposeBestStrategy(volatileBars, 'NVDA', '5m', relaxedConstraints);

  if (result3.error) {
    console.error('❌ Error:', result3.error);
    console.log('💡 Tip: Try relaxing parameters or waiting for better market conditions');
    return;
  }

  console.log('Market Metrics:');
  console.log(`  ATR: $${result3.metrics.atr.toFixed(2)} (high volatility!)`);
  console.log(`  20-bar Trend: ${result3.metrics.trend20.toFixed(2)}%`);
  console.log();

  console.log('✅ Best Strategy:', result3.best!.name);
  console.log(`  Entry Distance: ${result3.best!.entryDistancePct}% (wider due to volatility)`);
  console.log(`  R:R: ${result3.best!.rrWorst}:1 (lower target due to relaxed constraints)`);
  console.log();

  // Example 4: Show YAML output
  console.log('📄 Example 4: YAML Output (for deployment)');
  console.log('-'.repeat(80));
  console.log(result1.yaml);
  console.log();

  console.log('='.repeat(80));
  console.log('✅ All examples completed successfully!');
  console.log();
  console.log('Next Steps:');
  console.log('  1. Validate YAML: validate_strategy({ yaml_content })');
  console.log('  2. Compile YAML: compile_strategy({ yaml_content })');
  console.log('  3. Deploy: deploy_strategy({ yaml_content })');
  console.log('='.repeat(80));
}

main().catch(console.error);
