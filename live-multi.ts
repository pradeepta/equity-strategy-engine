/**
 * Multi-Strategy Live Trading Entry Point
 * Starts the LiveTradingOrchestrator for managing multiple concurrent strategies
 */

import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { LiveTradingOrchestrator, setGlobalOrchestrator } from './live/LiveTradingOrchestrator';
import { TwsAdapter } from './broker/twsAdapter';
import { BrokerEnvironment } from './spec/types';
import { LoggerFactory } from './logging/logger';

// Load environment variables
dotenv.config();

// ============================================================================
// Initialize Logger
// ============================================================================
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter, log: ['error', 'warn'] });

// Set up logger factory
LoggerFactory.setPrisma(prisma);
const logger = LoggerFactory.getLogger('live-multi-server');

async function main() {
  // TWS connection settings
  const twsHost = process.env.TWS_HOST || '127.0.0.1';
  const twsPort = parseInt(process.env.TWS_PORT || '7497');
  const twsClientId = 0; // Main trading client

  logger.info('Starting multi-strategy live trading server', {
    twsHost,
    twsPort,
    twsClientId
  });

  // Create broker adapter
  const brokerAdapter = new TwsAdapter(twsHost, twsPort, twsClientId);

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
    // Dynamic position sizing configuration
    enableDynamicSizing: process.env.ENABLE_DYNAMIC_SIZING === 'true',
    buyingPowerFactor: process.env.BUYING_POWER_FACTOR
      ? parseFloat(process.env.BUYING_POWER_FACTOR)
      : 0.75, // Default 75% of buying power
    // accountValue and buyingPower will be populated by orchestrator from portfolio snapshot
  };

  logger.info('Broker environment configured', {
    accountId: brokerEnv.accountId,
    dryRun: brokerEnv.dryRun,
    allowLiveOrders: brokerEnv.allowLiveOrders,
    allowCancelEntries: brokerEnv.allowCancelEntries
  });

  // User ID for database queries (from env or default)
  const userId = process.env.USER_ID || 'default-user';

  // Orchestrator configuration
  const config = {
    brokerAdapter: brokerAdapter,
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

  logger.info('Orchestrator configuration', {
    userId: config.userId,
    evalEnabled: config.evalEnabled,
    allowCrossSymbolSwap: config.allowCrossSymbolSwap,
    maxConcurrentStrategies: config.maxConcurrentStrategies,
    watchIntervalMs: config.watchInterval
  });

  // Create orchestrator
  const orchestrator = new LiveTradingOrchestrator(config);

  // Set global orchestrator instance for API access (force deploy, etc.)
  setGlobalOrchestrator(orchestrator);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT signal. Shutting down gracefully...');
    await orchestrator.stop();
    LoggerFactory.closeAll();
    await prisma.$disconnect();
    await pool.end();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM signal. Shutting down gracefully...');
    await orchestrator.stop();
    LoggerFactory.closeAll();
    await prisma.$disconnect();
    await pool.end();
    process.exit(0);
  });

  // Initialize and start
  try {
    logger.info('Initializing orchestrator...');
    await orchestrator.initialize();
    logger.info('Starting orchestrator...');
    await orchestrator.start();
  } catch (error) {
    logger.error('Fatal error during initialization', error as Error);
    LoggerFactory.closeAll();
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  }
}

// Run
main().catch(error => {
  logger.error('Unhandled error in main', error as Error);
  LoggerFactory.closeAll();
  process.exit(1);
});
