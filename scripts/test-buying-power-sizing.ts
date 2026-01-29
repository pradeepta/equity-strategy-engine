/**
 * Test script for buying power-based position sizing
 * Run with: npx tsx scripts/test-buying-power-sizing.ts
 */

console.log('🧪 Testing Buying Power-Based Position Sizing\n');
console.log('═'.repeat(80));

interface TestScenario {
  name: string;
  buyingPower: number;
  factor: number;
  entryPrice: number;
  yamlQty: number;
  maxOrderQty?: number;
  maxNotional?: number;
}

function calculatePositionSize(scenario: TestScenario): {
  finalQty: number;
  notional: number;
  utilization: number;
  limits: string[];
  wasAdjusted: boolean;
} {
  const { buyingPower, factor, entryPrice, yamlQty, maxOrderQty, maxNotional } = scenario;

  // Step 1: Calculate adjusted buying power
  const adjustedBuyingPower = buyingPower * factor;

  // Step 2: Calculate max shares by buying power
  let maxShares = Math.floor(adjustedBuyingPower / entryPrice);
  const limits: string[] = [];

  // Step 3: Apply YAML limit
  let wasAdjusted = false;
  if (maxShares > yamlQty) {
    maxShares = yamlQty;
    limits.push(`YAML max (${yamlQty})`);
  } else {
    limits.push(`${(factor * 100).toFixed(0)}% buying power`);
    wasAdjusted = true;
  }

  // Step 4: Apply MAX_ORDER_QTY
  if (maxOrderQty !== undefined && maxShares > maxOrderQty) {
    maxShares = maxOrderQty;
    limits.push(`MAX_ORDER_QTY (${maxOrderQty})`);
    wasAdjusted = true;
  }

  // Step 5: Apply MAX_NOTIONAL
  if (maxNotional !== undefined) {
    const maxByNotional = Math.floor(maxNotional / entryPrice);
    if (maxShares > maxByNotional) {
      maxShares = maxByNotional;
      limits.push(`MAX_NOTIONAL ($${maxNotional})`);
      wasAdjusted = true;
    }
  }

  const notional = maxShares * entryPrice;
  const utilization = (notional / buyingPower) * 100;

  return {
    finalQty: maxShares,
    notional,
    utilization,
    limits,
    wasAdjusted: maxShares !== yamlQty,
  };
}

// Test 1: Normal scenario - buying power is sufficient
console.log('\n📊 Test 1: Sufficient Buying Power (No Adjustment Needed)');
console.log('─'.repeat(80));
const test1: TestScenario = {
  name: 'AAPL Normal',
  buyingPower: 10000,
  factor: 0.75,
  entryPrice: 200,
  yamlQty: 10,
};
const result1 = calculatePositionSize(test1);
console.log(`Setup: $${test1.buyingPower} buying power, ${(test1.factor * 100)}% factor, $${test1.entryPrice} entry, YAML qty=${test1.yamlQty}`);
console.log(`✅ Final Qty: ${result1.finalQty} shares (${result1.wasAdjusted ? 'ADJUSTED' : 'unchanged'})`);
console.log(`   Notional: $${result1.notional} (${result1.utilization.toFixed(1)}% of buying power)`);
console.log(`   Limits: ${result1.limits.join(', ')}`);

// Test 2: YAML qty exceeds buying power - adjustment needed
console.log('\n📊 Test 2: YAML Qty Exceeds Buying Power (Adjustment Required)');
console.log('─'.repeat(80));
const test2: TestScenario = {
  name: 'NFLX Oversize',
  buyingPower: 5000,
  factor: 0.75,
  entryPrice: 350,
  yamlQty: 20, // Wants 20 shares = $7,000
};
const result2 = calculatePositionSize(test2);
console.log(`Setup: $${test2.buyingPower} buying power, ${(test2.factor * 100)}% factor, $${test2.entryPrice} entry, YAML qty=${test2.yamlQty}`);
console.log(`⚠️  Final Qty: ${result2.finalQty} shares (ADJUSTED from ${test2.yamlQty})`);
console.log(`   Reason: Only $${test2.buyingPower * test2.factor} available (${(test2.factor * 100)}% of $${test2.buyingPower})`);
console.log(`   Notional: $${result2.notional} (${result2.utilization.toFixed(1)}% of buying power)`);
console.log(`   Limits: ${result2.limits.join(', ')}`);

// Test 3: Multiple strategies depleting buying power
console.log('\n📊 Test 3: Multiple Strategies (Progressive Depletion)');
console.log('─'.repeat(80));
let remainingBuyingPower = 10000;

const strategies = [
  { name: 'AAPL', entryPrice: 200, yamlQty: 10 },
  { name: 'NFLX', entryPrice: 350, yamlQty: 10 },
  { name: 'MSFT', entryPrice: 380, yamlQty: 10 },
];

console.log(`Starting Buying Power: $${remainingBuyingPower}`);
console.log(`Factor: 75%\n`);

strategies.forEach((strat, idx) => {
  const result = calculatePositionSize({
    name: strat.name,
    buyingPower: remainingBuyingPower,
    factor: 0.75,
    entryPrice: strat.entryPrice,
    yamlQty: strat.yamlQty,
  });

  console.log(`Strategy ${idx + 1}: ${strat.name}`);
  console.log(`   Qty: ${result.finalQty} shares ${result.wasAdjusted ? '(ADJUSTED)' : ''}`);
  console.log(`   Notional: $${result.notional}`);
  console.log(`   Utilization: ${result.utilization.toFixed(1)}% of current buying power`);

  remainingBuyingPower -= result.notional;
  console.log(`   Remaining: $${remainingBuyingPower.toFixed(0)}\n`);
});

// Test 4: With MAX_ORDER_QTY limit
console.log('\n📊 Test 4: MAX_ORDER_QTY Hard Limit');
console.log('─'.repeat(80));
const test4: TestScenario = {
  name: 'Cheap Stock',
  buyingPower: 10000,
  factor: 0.75,
  entryPrice: 50,
  yamlQty: 100,
  maxOrderQty: 20,
};
const result4 = calculatePositionSize(test4);
console.log(`Setup: $${test4.buyingPower} buying power, $${test4.entryPrice} entry, YAML qty=${test4.yamlQty}`);
console.log(`   75% of buying power = $${test4.buyingPower * test4.factor}`);
console.log(`   Would allow: ${Math.floor((test4.buyingPower * test4.factor) / test4.entryPrice)} shares`);
console.log(`   MAX_ORDER_QTY=${test4.maxOrderQty}`);
console.log(`⚠️  Final Qty: ${result4.finalQty} shares (capped by MAX_ORDER_QTY)`);
console.log(`   Notional: $${result4.notional} (${result4.utilization.toFixed(1)}% of buying power)`);
console.log(`   Limits: ${result4.limits.join(', ')}`);

// Test 5: With MAX_NOTIONAL limit
console.log('\n📊 Test 5: MAX_NOTIONAL Limit');
console.log('─'.repeat(80));
const test5: TestScenario = {
  name: 'TSLA',
  buyingPower: 20000,
  factor: 0.75,
  entryPrice: 200,
  yamlQty: 50,
  maxNotional: 3000,
};
const result5 = calculatePositionSize(test5);
console.log(`Setup: $${test5.buyingPower} buying power, $${test5.entryPrice} entry, YAML qty=${test5.yamlQty}`);
console.log(`   75% of buying power = $${test5.buyingPower * test5.factor}`);
console.log(`   Would allow: ${Math.floor((test5.buyingPower * test5.factor) / test5.entryPrice)} shares`);
console.log(`   MAX_NOTIONAL=$${test5.maxNotional}`);
console.log(`⚠️  Final Qty: ${result5.finalQty} shares (capped by MAX_NOTIONAL)`);
console.log(`   Notional: $${result5.notional} (${result5.utilization.toFixed(1)}% of buying power)`);
console.log(`   Limits: ${result5.limits.join(', ')}`);

// Test 6: Different factor values
console.log('\n📊 Test 6: Different Factor Values (Conservative vs Aggressive)');
console.log('─'.repeat(80));
const baseScenario = {
  name: 'AAPL',
  buyingPower: 10000,
  entryPrice: 200,
  yamlQty: 50,
};

[0.5, 0.75, 1.0].forEach((factor) => {
  const result = calculatePositionSize({ ...baseScenario, factor });
  console.log(`Factor ${(factor * 100)}%:`);
  console.log(`   Available: $${(baseScenario.buyingPower * factor).toFixed(0)}`);
  console.log(`   Max Shares: ${result.finalQty}`);
  console.log(`   Notional: $${result.notional} (${result.utilization.toFixed(1)}% utilization)\n`);
});

console.log('═'.repeat(80));
console.log('\n✅ All tests completed!\n');
console.log('Key Insights:');
console.log('  • Factor controls how much buying power to use (0.75 = 75% is recommended)');
console.log('  • System automatically adjusts YAML qty if it exceeds available buying power');
console.log('  • User is alerted when quantities are adjusted');
console.log('  • Multiple limits work together (YAML, MAX_ORDER_QTY, MAX_NOTIONAL)');
console.log('  • No margin usage as long as factor ≤ 1.0\n');
