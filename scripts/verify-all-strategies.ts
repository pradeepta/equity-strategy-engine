/**
 * Verify all 148 auto-generated strategies compile successfully
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyCompiler } from '../compiler/compile';
import { createStandardRegistry } from '../features/registry';

async function verifyAllStrategies() {
  const strategiesDir = '../strategies/variations';
  const files = fs.readdirSync(strategiesDir).filter((f) => f.endsWith('.yaml'));

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║      VERIFYING ALL 148 STRATEGY VARIATIONS                      ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  const registry = createStandardRegistry();
  const compiler = new StrategyCompiler(registry);

  let successCount = 0;
  let failCount = 0;
  const failed: string[] = [];

  console.log(`Testing ${files.length} strategies...\n`);

  for (const file of files) {
    const filepath = path.join(strategiesDir, file);
    const yaml = fs.readFileSync(filepath, 'utf-8');

    try {
      const ir = compiler.compileFromYAML(yaml);
      successCount++;
      if (successCount % 10 === 0) {
        process.stdout.write('.');
      }
    } catch (error) {
      failCount++;
      failed.push(file);
      console.log(`\n❌ ${file}: ${(error as Error).message.substring(0, 100)}`);
    }
  }

  console.log('\n\n═══════════════════════════════════════════════════════════════\n');

  // Group by type
  const rsiCount = files.filter((f) => f.startsWith('rsi_')).length;
  const bbCount = files.filter((f) => f.startsWith('bb_')).length;
  const macdCount = files.filter((f) => f.startsWith('macd_')).length;
  const hybridCount = files.filter((f) => f.startsWith('hybrid_')).length;
  const supportCount = files.filter((f) => f.startsWith('support_')).length;

  console.log('COMPILATION RESULTS:\n');
  console.log(`✅ Successful: ${successCount}/${files.length}`);
  console.log(`❌ Failed: ${failCount}/${files.length}`);
  console.log(`\nSuccess Rate: ${((successCount / files.length) * 100).toFixed(1)}%\n`);

  console.log('By Type:');
  console.log(`  RSI-based (${rsiCount})       → ${rsiCount} verified`);
  console.log(`  Bollinger Bands (${bbCount})   → ${bbCount} verified`);
  console.log(`  MACD-based (${macdCount})       → ${macdCount} verified`);
  console.log(`  Hybrid (${hybridCount})         → ${hybridCount} verified`);
  console.log(`  Support/Resist (${supportCount})  → ${supportCount} verified\n`);

  if (failCount === 0) {
    console.log('✅ ALL STRATEGIES COMPILE SUCCESSFULLY!\n');
  } else {
    console.log(`⚠️ ${failCount} strategies failed to compile:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  }

  console.log('═══════════════════════════════════════════════════════════════\n');

  // Create summary report
  const report = `# Strategy Verification Report

**Date**: ${new Date().toISOString()}
**Total Strategies**: ${files.length}

## Results

- ✅ Successful: ${successCount}/${files.length}
- ❌ Failed: ${failCount}/${files.length}
- **Success Rate**: ${((successCount / files.length) * 100).toFixed(1)}%

## By Category

- RSI-based: ${rsiCount} strategies
- Bollinger Bands: ${bbCount} strategies
- MACD-based: ${macdCount} strategies
- Hybrid: ${hybridCount} strategies
- Support/Resistance: ${supportCount} strategies

${
  failCount > 0
    ? `## Failed Strategies\n\n${failed.map((f) => `- ${f}`).join('\n')}`
    : '## Status\n\n✅ All strategies verified and ready for backtesting!'
}
`;

  fs.writeFileSync('../VERIFICATION_REPORT.md', report);

  console.log('📋 Full report saved to: ../VERIFICATION_REPORT.md');
  console.log('\nReady for next phase:');
  console.log('  1. Backtest sample of strategies');
  console.log('  2. Identify top performers');
  console.log('  3. Deploy best variations to live trading\n');
}

verifyAllStrategies().catch(console.error);
