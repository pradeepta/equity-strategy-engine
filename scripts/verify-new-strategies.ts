/**
 * Verify new indicator-based strategies compile successfully
 * This demonstrates that RSI, Bollinger Bands, and MACD are working
 */

import * as fs from 'fs';
import { StrategyCompiler } from '../compiler/compile';
import { createStandardRegistry } from '../features/registry';

function verifyStrategyCompiles(name: string, yamlPath: string): boolean {
  try {
    const yaml = fs.readFileSync(yamlPath, 'utf-8');
    const registry = createStandardRegistry();
    const compiler = new StrategyCompiler(registry);
    const ir = compiler.compileFromYAML(yaml);

    console.log(`✅ ${name}`);
    console.log(`   Symbol: ${ir.symbol}`);
    console.log(`   Indicators used: ${ir.featurePlan.length}`);
    console.log(`   Transitions: ${ir.transitions.length}`);
    console.log(`   Order plans: ${ir.orderPlans.length}\n`);

    return true;
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${(error as Error).message}\n`);
    return false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║      NEW INDICATOR-BASED STRATEGIES - COMPILATION VERIFICATION   ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const strategies = [
    { name: 'RSI Mean Reversion v1 (NFLX)', path: '../strategies/rsi-mean-reversion.yaml' },
    { name: 'Bollinger Bands Bounce v1 (TSLA)', path: '../strategies/bb-bounce.yaml' },
    { name: 'MACD Momentum v1 (AAPL)', path: '../strategies/macd-momentum.yaml' },
  ];

  const existingStrategies = [
    { name: 'NFLX Adaptive v2 (Baseline)', path: '../strategies/nflx-adaptive.yaml' },
    { name: 'TSLA Volatile v2 (Baseline)', path: '../strategies/tsla-volatile.yaml' },
    { name: 'AAPL Momentum v2 (Baseline)', path: '../strategies/aapl-momentum.yaml' },
    { name: 'SPY ETF v2 (Baseline)', path: '../strategies/spy-etf.yaml' },
  ];

  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('NEW STRATEGIES (Using RSI, Bollinger Bands, MACD):\n');

  let newSuccesses = 0;
  for (const strat of strategies) {
    if (verifyStrategyCompiles(strat.name, strat.path)) {
      newSuccesses++;
    }
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('EXISTING STRATEGIES (For Comparison):\n');

  let existingSuccesses = 0;
  for (const strat of existingStrategies) {
    if (verifyStrategyCompiles(strat.name, strat.path)) {
      existingSuccesses++;
    }
  }

  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('SUMMARY:\n');
  console.log(`New Strategies Compiled: ${newSuccesses}/${strategies.length}`);
  console.log(`Existing Strategies Compiled: ${existingSuccesses}/${existingStrategies.length}`);
  console.log(`Total Success: ${newSuccesses + existingSuccesses}/${strategies.length + existingStrategies.length}`);

  if (newSuccesses === strategies.length) {
    console.log('\n✅ All new indicator-based strategies compile successfully!');
    console.log('\nYou can now use these indicators in your strategies:');
    console.log('  • rsi - Relative Strength Index (14-period)');
    console.log('  • bb_upper - Bollinger Band Upper');
    console.log('  • bb_middle - Bollinger Band Middle (SMA)');
    console.log('  • bb_lower - Bollinger Band Lower');
    console.log('  • macd - MACD Line');
    console.log('  • macd_signal - MACD Signal Line');
    console.log('  • macd_histogram - MACD Histogram');
  } else {
    console.log('\n⚠️ Some strategies failed to compile. Check errors above.');
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
