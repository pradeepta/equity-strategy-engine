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
