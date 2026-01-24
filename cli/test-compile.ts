#!/usr/bin/env tsx
/**
 * Test Strategy Compiler
 * Validates and compiles a strategy YAML file without deploying
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyCompiler } from '../compiler/compile';
import { createStandardRegistry } from '../features/registry';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npm run test:compile -- <yaml-file-or-content>');
    console.error('');
    console.error('Examples:');
    console.error('  npm run test:compile -- ./strategies/my-strategy.yaml');
    console.error('  npm run test:compile -- "meta:\\n  name: Test\\n  ..."');
    process.exit(1);
  }

  const input = args[0];
  let yamlContent: string;

  // Check if input is a file path or raw YAML content
  if (fs.existsSync(input)) {
    console.log(`📄 Reading strategy from file: ${input}\n`);
    yamlContent = fs.readFileSync(input, 'utf-8');
  } else {
    console.log(`📝 Parsing inline YAML content\n`);
    yamlContent = input;
  }

  console.log('=== YAML Content ===');
  console.log(yamlContent);
  console.log('\n=== Compilation ===\n');

  try {
    // Initialize feature registry with all standard features
    const registry = createStandardRegistry();

    // Compile strategy
    const compiler = new StrategyCompiler(registry);
    const compiled = compiler.compileFromYAML(yamlContent);

    console.log('✅ Compilation successful!\n');
    console.log('=== Compiled IR ===');
    console.log(JSON.stringify(compiled, null, 2));
    console.log('\n=== Summary ===');
    console.log(`Symbol: ${compiled.symbol}`);
    console.log(`Timeframe: ${compiled.timeframe}`);
    console.log(`Initial State: ${compiled.initialState}`);
    console.log(`Feature Plan: ${compiled.featurePlan.map(f => f.name).join(', ')}`);
    console.log(`Order Plans: ${compiled.orderPlans.map(op => op.name).join(', ')}`);
    console.log(`\n✅ Strategy is valid and ready to deploy!`);
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Compilation failed!\n');
    console.error('Error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
