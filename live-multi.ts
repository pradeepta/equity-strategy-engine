/**
 * Multi-Strategy Live Trading Entry Point
 * Starts the LiveTradingOrchestrator for managing multiple concurrent strategies
 */

import * as dotenv from 'dotenv';
import { LiveTradingOrchestrator } from './live/LiveTradingOrchestrator';
import { TwsAdapter } from './broker/twsAdapter';
import { BrokerEnvironment } from './spec/types';

// Load environment variables
dotenv.config();

async function main() {
  // TWS connection settings
  const twsHost = process.env.TWS_HOST || '127.0.0.1';
  const twsPort = parseInt(process.env.TWS_PORT || '7497');
  const twsClientId = 0; // Main trading client

  // Create broker adapter
  const adapter = new TwsAdapter(twsHost, twsPort, twsClientId);

  // Broker environment
  const brokerEnv: BrokerEnvironment = {
    accountId: process.env.TWS_ACCOUNT_ID || 'paper',
    dryRun: !(process.env.LIVE === 'true' || process.env.LIVE === '1'),
    allowLiveOrders: process.env.ALLOW_LIVE_ORDERS !== 'false',
    allowCancelEntries: process.env.ALLOW_CANCEL_ENTRIES === 'true',
    maxOrdersPerSymbol: process.env.MAX_ORDERS_PER_SYMBOL
      ? parseInt(process.env.MAX_ORDERS_PER_SYMBOL)
      : undefined,
    maxOrderQty: process.env.MAX_ORDER_QTY
      ? parseInt(process.env.MAX_ORDER_QTY)
      : undefined,
    maxNotionalPerSymbol: process.env.MAX_NOTIONAL_PER_SYMBOL
      ? parseFloat(process.env.MAX_NOTIONAL_PER_SYMBOL)
      : undefined,
    dailyLossLimit: process.env.DAILY_LOSS_LIMIT
      ? parseFloat(process.env.DAILY_LOSS_LIMIT)
      : undefined,
  };

  // User ID for database queries (from env or default)
  const userId = process.env.USER_ID || 'default-user';

  // Orchestrator configuration
  const config = {
    brokerAdapter: adapter,
    brokerEnv: brokerEnv,
    userId: userId,
    evalEndpoint: process.env.STRATEGY_EVAL_WS_ENDPOINT || 'ws://localhost:8080/evaluate',
    evalEnabled: process.env.STRATEGY_EVAL_ENABLED === 'true',
    allowCrossSymbolSwap: process.env.ALLOW_CROSS_SYMBOL_SWAP === 'true',
    maxConcurrentStrategies: parseInt(process.env.MAX_CONCURRENT_STRATEGIES || '10'),
    watchInterval: parseInt(process.env.STRATEGY_WATCH_INTERVAL_MS || '30000'),
    twsHost,
    twsPort,
  };

  // Create orchestrator
  const orchestrator = new LiveTradingOrchestrator(config);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('');
    console.log('Received SIGINT signal. Shutting down gracefully...');
    await orchestrator.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('');
    console.log('Received SIGTERM signal. Shutting down gracefully...');
    await orchestrator.stop();
    process.exit(0);
  });

  // Initialize and start
  try {
    await orchestrator.initialize();
    await orchestrator.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
