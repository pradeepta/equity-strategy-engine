/**
 * Test script for TWS Adapter
 * This script tests the connection to TWS/IB Gateway and validates the broker adapter
 */

import * as dotenv from 'dotenv';
import { TwsAdapter } from './broker/twsAdapter';
import { OrderPlan, BrokerEnvironment } from './spec/types';

// Load .env
dotenv.config();

async function testTWSConnection() {
  console.log('\n╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('║' + 'TWS ADAPTER TEST'.padEnd(58) + '║');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝\n');

  // Get configuration from environment
  const twsHost = process.env.TWS_HOST || '127.0.0.1';
  const twsPort = parseInt(process.env.TWS_PORT || '7497');
  const twsClientId = parseInt(process.env.TWS_CLIENT_ID || '0');
  const dryRun = process.env.LIVE !== 'true';

  console.log('Configuration:');
  console.log(`  Host: ${twsHost}`);
  console.log(`  Port: ${twsPort} (${twsPort === 7497 ? 'Paper Trading' : twsPort === 7496 ? 'Live Trading' : 'Custom'})`);
  console.log(`  Client ID: ${twsClientId}`);
  console.log(`  Mode: ${dryRun ? 'DRY-RUN' : 'LIVE'}\n`);

  // Create adapter
  const adapter = new TwsAdapter(twsHost, twsPort, twsClientId);

  // Create test broker environment
  const env: BrokerEnvironment = {
    dryRun,
  };

  // Test 1: Dry-run order submission
  console.log('═'.repeat(60));
  console.log('TEST 1: Dry-run Bracket Order Submission');
  console.log('═'.repeat(60) + '\n');

  const testOrderPlan: OrderPlan = {
    id: 'test-plan-001',
    name: 'Test Bracket Order',
    symbol: 'AAPL',
    side: 'buy',
    targetEntryPrice: 150.0,
    entryZone: [149.5, 150.5],
    qty: 100,
    stopPrice: 148.0,
    brackets: [
      { price: 152.0, ratioOfPosition: 0.5 }, // Take 50% profit at $152
      { price: 154.0, ratioOfPosition: 0.5 }, // Take remaining 50% at $154
    ],
    type: 'split_bracket',
  };

  try {
    const orders = await adapter.submitOrderPlan(testOrderPlan, env);
    console.log(`\n✓ Successfully submitted ${orders.length} order(s)`);
    console.log('\nOrder Details:');
    orders.forEach((order, i) => {
      console.log(`  Order ${i + 1}: ${order.id}`);
      console.log(`    Symbol: ${order.symbol}`);
      console.log(`    Side: ${order.side}`);
      console.log(`    Qty: ${order.qty}`);
      console.log(`    Limit Price: ${order.limitPrice}`);
      console.log(`    Status: ${order.status}`);
    });
  } catch (e) {
    console.error(`\n✗ Failed to submit order: ${(e as Error).message}`);
  }

  // Test 2: Get open orders
  console.log('\n' + '═'.repeat(60));
  console.log('TEST 2: Get Open Orders');
  console.log('═'.repeat(60) + '\n');

  try {
    const openOrders = await adapter.getOpenOrders('AAPL', env);
    console.log(`✓ Retrieved ${openOrders.length} open order(s)`);
    if (openOrders.length > 0) {
      console.log('\nOpen Orders:');
      openOrders.forEach((order, i) => {
        console.log(`  Order ${i + 1}: ${order.id}`);
        console.log(`    Symbol: ${order.symbol}`);
        console.log(`    Side: ${order.side}`);
        console.log(`    Qty: ${order.qty}`);
        console.log(`    Status: ${order.status}`);
      });
    }
  } catch (e) {
    console.error(`✗ Failed to get orders: ${(e as Error).message}`);
  }

  // Test 3: Cancel orders (only in dry-run or if live mode with orders)
  if (dryRun) {
    console.log('\n' + '═'.repeat(60));
    console.log('TEST 3: Cancel Orders (Dry-run)');
    console.log('═'.repeat(60) + '\n');

    try {
      await adapter.cancelOpenEntries('AAPL', [], env);
      console.log('✓ Cancel test completed (no actual orders to cancel)');
    } catch (e) {
      console.error(`✗ Failed to cancel: ${(e as Error).message}`);
    }
  }

  // Disconnect
  adapter.disconnect();
  console.log('\n✓ Disconnected from TWS\n');

  console.log('═'.repeat(60));
  console.log('TEST SUMMARY');
  console.log('═'.repeat(60));
  console.log('\nAll tests completed!');
  console.log('\nNext Steps:');
  console.log('1. Ensure TWS/IB Gateway is running and configured');
  console.log('2. Set LIVE=true in .env to test with real paper trading orders');
  console.log('3. Run: LIVE=true npm run test:tws\n');
}

// Run tests
testTWSConnection()
  .then(() => {
    console.log('✓ Tests completed successfully\n');
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n❌ Test failed:', (e as Error).message);
    console.error('\nTroubleshooting:');
    console.error('1. Make sure TWS/IB Gateway is running');
    console.error('2. Check that API connections are enabled in TWS settings');
    console.error('3. Verify 127.0.0.1 is in the trusted IP addresses list');
    console.error('4. Ensure the correct port is configured (7497 for paper, 7496 for live)');
    console.error('5. Check that no other applications are using the same client ID\n');
    process.exit(1);
  });
