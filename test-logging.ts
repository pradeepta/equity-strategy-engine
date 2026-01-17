/**
 * Test script to demonstrate Winston + PostgreSQL logging
 * Run with: ts-node test-logging.ts
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { LoggerFactory } from './logging/logger';
import 'dotenv/config';

async function testLogging() {
  console.log('🧪 Testing Winston + PostgreSQL Logging System\n');

  // Initialize Prisma
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  // Set up logger factory
  LoggerFactory.setPrisma(prisma);

  // Get loggers for different components
  const liveLogger = LoggerFactory.getLogger('live-server');
  const orderLogger = LoggerFactory.getLogger('order-manager');
  const strategyLogger = LoggerFactory.getLogger('strategy-manager');

  console.log('✅ Loggers initialized\n');
  console.log('📝 Generating test logs...\n');

  // Test basic logging levels
  liveLogger.info('Live server started', {
    symbol: 'AAPL',
    timeframe: '1h',
    broker: 'alpaca',
  });

  liveLogger.debug('Fetching historical bars', {
    symbol: 'AAPL',
    days: 30,
    barsRequested: 100,
  });

  liveLogger.warn('Connection latency high', {
    latency: 500,
    threshold: 200,
  });

  // Test error logging with stack trace
  try {
    throw new Error('Simulated network timeout');
  } catch (error) {
    liveLogger.error('Failed to fetch bars', error as Error, {
      symbol: 'AAPL',
      retryCount: 3,
    });
  }

  // Test order logging
  orderLogger.logOrder('info', 'Order submitted', 'order-123', {
    symbol: 'AAPL',
    side: 'BUY',
    quantity: 100,
    type: 'MARKET',
  });

  orderLogger.logOrder('warn', 'Order partially filled', 'order-123', {
    symbol: 'AAPL',
    filled: 50,
    remaining: 50,
  });

  // Test strategy logging
  strategyLogger.logStrategy('info', 'Strategy activated', 'strategy-456', {
    symbol: 'AAPL',
    timeframe: '1h',
    state: 'ARMED',
  });

  strategyLogger.logStrategy('error', 'Strategy failed validation', 'strategy-789', {
    symbol: 'TSLA',
    reason: 'Invalid timeframe',
  });

  // More diverse logs
  liveLogger.info('Bar processed', {
    symbol: 'AAPL',
    barNumber: 100,
    price: 185.50,
    volume: 1000000,
    state: 'TRIGGERED',
  });

  orderLogger.info('Position opened', {
    symbol: 'AAPL',
    quantity: 100,
    avgPrice: 185.25,
    positionValue: 18525.00,
  });

  console.log('✅ Test logs created\n');
  console.log('🔍 Querying logs from database...\n');

  // Query logs to verify they were stored
  const allLogs = await prisma.systemLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  console.log(`📊 Found ${allLogs.length} recent logs:\n`);
  allLogs.forEach((log, idx) => {
    const time = new Date(log.createdAt).toLocaleTimeString();
    console.log(`${idx + 1}. [${time}] [${log.level}] [${log.component}] ${log.message}`);
  });

  console.log('\n📈 Log statistics:\n');
  const stats = await prisma.systemLog.groupBy({
    by: ['level'],
    _count: true,
  });

  stats.forEach((stat) => {
    console.log(`  ${stat.level}: ${stat._count} logs`);
  });

  console.log('\n✅ Logging system test complete!');
  console.log('\n🌐 View logs on the web dashboard:');
  console.log('   1. Start API: npm run portfolio:api:dev');
  console.log('   2. Start Web: cd web-client && npm run dev');
  console.log('   3. Open: http://localhost:3000');
  console.log('   4. Click the "Logs" tab\n');

  // Cleanup
  LoggerFactory.closeAll();
  await prisma.$disconnect();
  await pool.end();
}

testLogging().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
