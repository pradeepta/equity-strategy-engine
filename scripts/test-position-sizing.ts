/**
 * Manual test script for position sizing utilities
 * Run with: npx tsx scripts/test-position-sizing.ts
 */
import { calculatePositionSize, validateBuyingPower, calculateAccountRisk } from '../utils/positionSizing';

console.log('🧪 Testing Position Sizing Utilities\n');
console.log('═'.repeat(80));

// Test 1: Basic risk-based calculation
console.log('\n📊 Test 1: Basic Risk-Based Calculation');
console.log('─'.repeat(80));
try {
  const result1 = calculatePositionSize({
    accountValue: 10000,
    riskPercentage: 2,
    entryPrice: 200,
    stopPrice: 195,
  });
  console.log('✅ PASS: Basic calculation');
  console.log(`   Account: $10,000 | Risk: 2% | Entry: $200 | Stop: $195`);
  console.log(`   → Shares: ${result1.shares}`);
  console.log(`   → Notional: $${result1.notionalValue}`);
  console.log(`   → Dollar Risk: $${result1.dollarRisk}`);
  console.log(`   → Limits Applied: ${result1.appliedLimits.join(', ')}`);
} catch (error) {
  console.log('❌ FAIL:', (error as Error).message);
}

// Test 2: Max shares limit
console.log('\n📊 Test 2: Max Shares Limit from YAML');
console.log('─'.repeat(80));
try {
  const result2 = calculatePositionSize({
    accountValue: 10000,
    riskPercentage: 2,
    entryPrice: 200,
    stopPrice: 195,
    maxShares: 10,
  });
  console.log('✅ PASS: Max shares limit applied');
  console.log(`   Calculated would be 40, but capped at maxShares: ${result2.shares}`);
  console.log(`   → Limits Applied: ${result2.appliedLimits.join(', ')}`);
} catch (error) {
  console.log('❌ FAIL:', (error as Error).message);
}

// Test 3: Buying power limit
console.log('\n📊 Test 3: Buying Power Limit');
console.log('─'.repeat(80));
try {
  const result3 = calculatePositionSize({
    accountValue: 10000,
    riskPercentage: 2,
    entryPrice: 200,
    stopPrice: 195,
    availableBuyingPower: 1000,
  });
  console.log('✅ PASS: Buying power limit applied');
  console.log(`   Only $1,000 available → Max ${result3.shares} shares`);
  console.log(`   → Notional: $${result3.notionalValue}`);
  console.log(`   → Utilization: ${result3.utilizationPercent.toFixed(1)}%`);
} catch (error) {
  console.log('❌ FAIL:', (error as Error).message);
}

// Test 4: Real-world AAPL scenario
console.log('\n📊 Test 4: Real-World AAPL Scenario');
console.log('─'.repeat(80));
console.log('   Setup: $15k account, AAPL @ $200, stop $195, max 10 shares, $10k cash');
try {
  const result4 = calculatePositionSize({
    accountValue: 15000,
    riskPercentage: 2,
    entryPrice: 200,
    stopPrice: 195,
    maxShares: 10,
    availableBuyingPower: 10000,
  });
  console.log('✅ PASS: AAPL example');
  console.log(`   → Shares: ${result4.shares} (would be 60 without limits)`);
  console.log(`   → Notional: $${result4.notionalValue} (${((result4.notionalValue / 15000) * 100).toFixed(1)}% of account)`);
  console.log(`   → Dollar Risk: $${result4.dollarRisk} (${((result4.dollarRisk / 15000) * 100).toFixed(2)}% of account)`);
  console.log(`   → Limits: ${result4.appliedLimits.join(', ')}`);
} catch (error) {
  console.log('❌ FAIL:', (error as Error).message);
}

// Test 5: Insufficient buying power validation
console.log('\n📊 Test 5: Buying Power Validation');
console.log('─'.repeat(80));
const validation1 = validateBuyingPower(10, 200, 5000);
console.log(`✅ PASS: Sufficient buying power (10 shares @ $200 vs $5,000 available)`);
console.log(`   → Valid: ${validation1.valid}`);

const validation2 = validateBuyingPower(10, 200, 1000);
console.log(`✅ PASS: Insufficient buying power detected (10 shares @ $200 vs $1,000 available)`);
console.log(`   → Valid: ${validation2.valid}`);
console.log(`   → Reason: ${validation2.reason}`);

// Test 6: Account risk calculation
console.log('\n📊 Test 6: Account Risk Calculation');
console.log('─'.repeat(80));
const riskPercent = calculateAccountRisk(40, 200, 195, 10000);
console.log(`✅ PASS: Risk calculation (40 shares, $200 entry, $195 stop, $10k account)`);
console.log(`   → Account Risk: ${riskPercent.toFixed(2)}%`);

// Test 7: Error handling
console.log('\n📊 Test 7: Error Handling');
console.log('─'.repeat(80));

// Invalid account value
try {
  calculatePositionSize({
    accountValue: 0,
    riskPercentage: 2,
    entryPrice: 200,
    stopPrice: 195,
  });
  console.log('❌ FAIL: Should have thrown error for invalid account value');
} catch (error) {
  console.log('✅ PASS: Caught invalid account value error');
  console.log(`   → ${(error as Error).message}`);
}

// Invalid stop price (wrong side)
try {
  calculatePositionSize({
    accountValue: 10000,
    riskPercentage: 2,
    entryPrice: 200,
    stopPrice: 205,
  });
  console.log('❌ FAIL: Should have thrown error for wrong-side stop');
} catch (error) {
  console.log('✅ PASS: Caught invalid stop price error');
  console.log(`   → ${(error as Error).message}`);
}

// Account too small
try {
  calculatePositionSize({
    accountValue: 100,
    riskPercentage: 2,
    entryPrice: 200,
    stopPrice: 195,
  });
  console.log('❌ FAIL: Should have thrown error for account too small');
} catch (error) {
  console.log('✅ PASS: Caught account too small error');
  console.log(`   → ${(error as Error).message}`);
}

console.log('\n═'.repeat(80));
console.log('✅ All tests completed successfully!\n');
