/**
 * Example: Live Trading with Winston + PostgreSQL Logging
 * This is a reference implementation showing how to integrate the logger into live.ts
 */

import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { LoggerFactory } from './logging/logger';
import { StrategyCompiler } from './compiler/compile';
import { createStandardRegistry } from './features/registry';
import { StrategyEngine } from './runtime/engine';

dotenv.config();

// ============================================================================
// Initialize Prisma + Logger (Do this at the top of your file)
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({
  adapter,
  log: ['error', 'warn'],
});

// Initialize logger factory with Prisma instance
LoggerFactory.setPrisma(prisma);

// Get logger for this component
const logger = LoggerFactory.getLogger('live-server');

// ============================================================================
// Example Usage in Live Trading
// ============================================================================

async function runLiveTrading(strategyYaml: string, symbol: string) {
  logger.info('Starting live trading session', {
    symbol,
    timestamp: new Date().toISOString(),
  });

  try {
    // Compile strategy
    logger.debug('Compiling strategy', { symbol });
    const compiler = new StrategyCompiler(createStandardRegistry());
    const ir = compiler.compileFromYAML(strategyYaml);
    logger.info('Strategy compiled successfully', {
      symbol,
      timeframe: ir.timeframe,
      name: ir.name,
    });

    // Create engine
    const registry = createStandardRegistry();
    const engine = new StrategyEngine(ir, registry);
    logger.debug('Strategy engine created', { symbol, state: engine.getState() });

    // Fetch initial bars (your existing code)
    logger.info('Fetching initial bars', { symbol, timeframe: ir.timeframe });
    // ... your bar fetching code ...
    const bars = []; // Replace with actual bars
    logger.info('Bars fetched successfully', {
      symbol,
      count: bars.length,
      latestPrice: bars.length > 0 ? bars[bars.length - 1].close : null,
    });

    // Start monitoring loop
    logger.info('Starting bar monitoring loop', {
      symbol,
      checkInterval: 60000, // example
    });

    let barCount = 0;
    while (true) {
      try {
        // Fetch new bar (your existing code)
        // const newBar = await fetchLatestBar(symbol);

        // Log every 10th bar to avoid spam
        if (barCount % 10 === 0) {
          logger.debug('Processing bar', {
            symbol,
            barNumber: barCount,
            // price: newBar.close,
            // volume: newBar.volume,
          });
        }

        // Process bar
        // const result = engine.processBar(newBar);

        // Log state changes
        const currentState = engine.getState();
        logger.debug('Engine state', {
          symbol,
          state: currentState,
          // ordersPlaced: result.ordersPlaced.length,
        });

        barCount++;
        await new Promise(resolve => setTimeout(resolve, 60000));
      } catch (barError) {
        logger.error('Error processing bar', barError, {
          symbol,
          barNumber: barCount,
        });
        // Continue processing despite errors
      }
    }

  } catch (error) {
    logger.error('Live trading failed', error, {
      symbol,
      errorCode: error instanceof Error ? error.name : 'UNKNOWN',
    });
    throw error;
  }
}

// ============================================================================
// Example: Order Logging
// ============================================================================

function logOrderActivity(orderId: string, strategyId: string, orderDetails: any) {
  const orderLogger = LoggerFactory.getLogger('order-manager');

  orderLogger.logOrder('info', 'Order submitted', orderId, {
    strategyId,
    symbol: orderDetails.symbol,
    side: orderDetails.side,
    quantity: orderDetails.qty,
    type: orderDetails.type,
  });
}

function logOrderError(orderId: string, strategyId: string, error: Error) {
  const orderLogger = LoggerFactory.getLogger('order-manager');

  orderLogger.logOrder('error', 'Order failed', orderId, {
    strategyId,
    errorMessage: error.message,
    stackTrace: error.stack,
  });
}

// ============================================================================
// Example: Strategy Logging
// ============================================================================

function logStrategyEvent(strategyId: string, event: string, details: any) {
  const strategyLogger = LoggerFactory.getLogger('strategy-manager');

  strategyLogger.logStrategy('info', event, strategyId, details);
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

async function shutdown() {
  logger.info('Shutting down live server');

  // Close all loggers
  LoggerFactory.closeAll();

  // Disconnect Prisma
  await prisma.$disconnect();
  await pool.end();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ============================================================================
// Example: Error Handler with Logging
// ============================================================================

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error, {
    fatal: true,
  });
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', reason as Error, {
    promise: promise.toString(),
  });
});

// ============================================================================
// Main
// ============================================================================

async function main() {
  logger.info('Live server starting', {
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
    broker: process.env.BROKER || 'tws',
  });

  try {
    const strategyPath = process.argv[2] || './strategies/example.yaml';
    const symbol = process.argv[3] || 'AAPL';

    logger.info('Loading strategy', { strategyPath, symbol });

    // Load and run strategy (replace with your actual code)
    // const strategyYaml = fs.readFileSync(strategyPath, 'utf-8');
    // await runLiveTrading(strategyYaml, symbol);

  } catch (error) {
    logger.error('Main execution failed', error as Error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// ============================================================================
// Export for use in other files
// ============================================================================

export { logger, LoggerFactory, prisma };
