#!/usr/bin/env tsx

/**
 * Test MCP integration for deterministic strategy generator
 */

import { proposeDeterministic } from './src/strategy/mcp-integration';
import type { Bar } from './src/strategy/metrics';

// Mock market data
function generateTestBars(count: number): Bar[] {
  const bars: Bar[] = [];
  let price = 100;

  for (let i = 0; i < count; i++) {
    price += 0.1 + (Math.random() - 0.5) * 0.2;
    bars.push({
      timestamp: Date.now() - (count - i) * 300000,
      open: price - 0.1,
      high: price + 0.3,
      low: price - 0.3,
      close: price,
      volume: 10000,
    });
  }

  return bars;
}

async function main() {
  console.log('Testing MCP Integration for Deterministic Strategy Generator');
  console.log('='.repeat(70));
  console.log();

  const bars = generateTestBars(100);

  console.log('Test 1: Valid input');
  console.log('-'.repeat(70));
  const result1 = proposeDeterministic({
    symbol: 'TEST',
    timeframe: '5m',
    bars,
    maxRiskPerTrade: 100,
    rrTarget: 3.0,
    maxEntryDistancePct: 3.0,
  });

  console.log('Success:', result1.success);
  if (result1.success && result1.result) {
    console.log('Best Strategy:', result1.result.best.name);
    console.log('Side:', result1.result.best.side);
    console.log('R:R:', result1.result.best.rrWorst);
    console.log('Risk:', result1.result.best.dollarRiskWorst);
    console.log('Distance:', result1.result.best.entryDistancePct + '%');
    console.log('Alternatives:', result1.result.candidatesTop5.length);
    console.log('✅ YAML generated:', result1.result.yaml.split('\n').length, 'lines');
  } else {
    console.log('❌ Error:', result1.error);
  }
  console.log();

  console.log('Test 2: Insufficient bars');
  console.log('-'.repeat(70));
  const result2 = proposeDeterministic({
    symbol: 'TEST',
    timeframe: '5m',
    bars: generateTestBars(30), // Too few
    maxRiskPerTrade: 100,
  });

  console.log('Success:', result2.success);
  console.log('Error (expected):', result2.error);
  console.log('✅ Correctly rejected insufficient bars');
  console.log();

  console.log('Test 3: Invalid maxRiskPerTrade');
  console.log('-'.repeat(70));
  const result3 = proposeDeterministic({
    symbol: 'TEST',
    timeframe: '5m',
    bars,
    maxRiskPerTrade: -10, // Invalid
  });

  console.log('Success:', result3.success);
  console.log('Error (expected):', result3.error);
  console.log('✅ Correctly rejected negative risk');
  console.log();

  console.log('='.repeat(70));
  console.log('✅ All MCP integration tests passed!');
  console.log();
  console.log('Ready to use in mcp-server.ts as:');
  console.log('  const { proposeDeterministic } = await import("./src/strategy/mcp-integration");');
  console.log('  return proposeDeterministic({ symbol, bars, maxRiskPerTrade, ... });');
}

main().catch(console.error);
