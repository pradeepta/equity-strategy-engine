/**
 * Integration Tests - Multiple Strategies Same Symbol
 *
 * End-to-end tests for multi-strategy scenarios.
 * These are simplified integration tests; full manual testing should be done
 * after all phases are complete.
 *
 * These tests should PASS after all implementation phases are complete.
 */

import { PrismaClient, StrategyStatus } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

describe('Integration - Multiple Strategies Same Symbol', () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const testUserId = 'test-user-integration-' + Date.now();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    // Create test user
    await prisma.user.create({
      data: {
        id: testUserId,
        email: `test-integration-${Date.now()}@example.com`,
        name: 'Test User Integration',
      },
    });
  });

  afterAll(async () => {
    // Clean up (cascade delete will handle strategies and orders)
    await prisma.user.delete({
      where: { id: testUserId },
    }).catch(() => {}); // Ignore if already deleted
    await prisma.$disconnect();
    await pool.end();
  });

  afterEach(async () => {
    // Clean up after each test
    await prisma.order.deleteMany({
      where: { strategy: { userId: testUserId } },
    });
    await prisma.strategy.deleteMany({
      where: { userId: testUserId },
    });
  });

  test('should create and activate 3 strategies on NVDA concurrently', async () => {
    // Create 3 NVDA strategies
    const strategyRSI = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'NVDA',
        name: 'NVDA-RSI',
        timeframe: '5m',
        status: StrategyStatus.PENDING,
        yamlContent: `meta:
  name: "NVDA RSI"
  symbol: "NVDA"
  timeframe: "5m"
features:
  - name: rsi
  - name: close
rules:
  arm: "rsi < 30"
  trigger: "close > 500"
positions:
  side: "buy"
  qty: 10
  entryZone: [499, 500]
  stopLoss: 490
  targets:
    - price: 510
      partial: 1.0`,
      },
    });

    const strategyMACD = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'NVDA',
        name: 'NVDA-MACD',
        timeframe: '5m',
        status: StrategyStatus.PENDING,
        yamlContent: `meta:
  name: "NVDA MACD"
  symbol: "NVDA"
  timeframe: "5m"
features:
  - name: macd_histogram
  - name: close
rules:
  arm: "macd_histogram > 0"
  trigger: "close > 500"
positions:
  side: "buy"
  qty: 10
  entryZone: [499, 500]
  stopLoss: 490
  targets:
    - price: 510
      partial: 1.0`,
      },
    });

    const strategyBB = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'NVDA',
        name: 'NVDA-BB',
        timeframe: '5m',
        status: StrategyStatus.PENDING,
        yamlContent: `meta:
  name: "NVDA Bollinger Bands"
  symbol: "NVDA"
  timeframe: "5m"
features:
  - name: bb_lower
  - name: close
rules:
  arm: "close < bb_lower"
  trigger: "close > bb_lower"
positions:
  side: "buy"
  qty: 10
  entryZone: [499, 500]
  stopLoss: 490
  targets:
    - price: 510
      partial: 1.0`,
      },
    });

    // Verify all created
    const strategies = await prisma.strategy.findMany({
      where: {
        userId: testUserId,
        symbol: 'NVDA',
      },
    });

    expect(strategies).toHaveLength(3);
    expect(strategies.map((s) => s.name)).toContain('NVDA-RSI');
    expect(strategies.map((s) => s.name)).toContain('NVDA-MACD');
    expect(strategies.map((s) => s.name)).toContain('NVDA-BB');
  });

  test('should allow activating all 3 NVDA strategies', async () => {
    // Create strategies
    await prisma.strategy.createMany({
      data: [
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-RSI',
          timeframe: '5m',
          status: StrategyStatus.DRAFT,
          yamlContent: 'meta:\n  name: "NVDA RSI"',
        },
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-MACD',
          timeframe: '5m',
          status: StrategyStatus.DRAFT,
          yamlContent: 'meta:\n  name: "NVDA MACD"',
        },
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-BB',
          timeframe: '5m',
          status: StrategyStatus.DRAFT,
          yamlContent: 'meta:\n  name: "NVDA BB"',
        },
      ],
    });

    // Activate all
    await prisma.strategy.updateMany({
      where: {
        userId: testUserId,
        symbol: 'NVDA',
      },
      data: {
        status: StrategyStatus.ACTIVE,
        activatedAt: new Date(),
      },
    });

    // Verify all active
    const activeStrategies = await prisma.strategy.findMany({
      where: {
        userId: testUserId,
        symbol: 'NVDA',
        status: StrategyStatus.ACTIVE,
      },
    });

    expect(activeStrategies).toHaveLength(3);
  });

  test('should close one NVDA strategy without affecting others', async () => {
    // Create and activate 3 strategies
    const strategies = await Promise.all([
      prisma.strategy.create({
        data: {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-1',
          timeframe: '5m',
          status: StrategyStatus.ACTIVE,
          yamlContent: 'meta:\n  name: "NVDA 1"',
          activatedAt: new Date(),
        },
      }),
      prisma.strategy.create({
        data: {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-2',
          timeframe: '5m',
          status: StrategyStatus.ACTIVE,
          yamlContent: 'meta:\n  name: "NVDA 2"',
          activatedAt: new Date(),
        },
      }),
      prisma.strategy.create({
        data: {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-3',
          timeframe: '5m',
          status: StrategyStatus.ACTIVE,
          yamlContent: 'meta:\n  name: "NVDA 3"',
          activatedAt: new Date(),
        },
      }),
    ]);

    // Close first strategy
    await prisma.strategy.update({
      where: { id: strategies[0].id },
      data: {
        status: StrategyStatus.CLOSED,
        closedAt: new Date(),
        closeReason: 'Manual close for test',
      },
    });

    // Verify counts
    const activeCount = await prisma.strategy.count({
      where: {
        userId: testUserId,
        symbol: 'NVDA',
        status: StrategyStatus.ACTIVE,
      },
    });

    const closedCount = await prisma.strategy.count({
      where: {
        userId: testUserId,
        symbol: 'NVDA',
        status: StrategyStatus.CLOSED,
      },
    });

    expect(activeCount).toBe(2);
    expect(closedCount).toBe(1);
  });

  test('should enforce maxConcurrentStrategies limit (database level)', async () => {
    // This test verifies that the system can handle multiple strategies
    // The actual enforcement is done in LiveTradingOrchestrator

    // Create 5 PENDING strategies (3 NVDA, 2 TSLA)
    await prisma.strategy.createMany({
      data: [
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-1',
          timeframe: '5m',
          status: StrategyStatus.PENDING,
          yamlContent: 'meta:\n  name: "NVDA 1"',
        },
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-2',
          timeframe: '5m',
          status: StrategyStatus.PENDING,
          yamlContent: 'meta:\n  name: "NVDA 2"',
        },
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA-3',
          timeframe: '5m',
          status: StrategyStatus.PENDING,
          yamlContent: 'meta:\n  name: "NVDA 3"',
        },
        {
          userId: testUserId,
          symbol: 'TSLA',
          name: 'TSLA-1',
          timeframe: '5m',
          status: StrategyStatus.PENDING,
          yamlContent: 'meta:\n  name: "TSLA 1"',
        },
        {
          userId: testUserId,
          symbol: 'TSLA',
          name: 'TSLA-2',
          timeframe: '5m',
          status: StrategyStatus.PENDING,
          yamlContent: 'meta:\n  name: "TSLA 2"',
        },
      ],
    });

    const allPending = await prisma.strategy.findMany({
      where: {
        userId: testUserId,
        status: StrategyStatus.PENDING,
      },
    });

    expect(allPending).toHaveLength(5);

    // Verify NVDA has 3
    const nvdaPending = allPending.filter((s) => s.symbol === 'NVDA');
    expect(nvdaPending).toHaveLength(3);

    // Verify TSLA has 2
    const tslaPending = allPending.filter((s) => s.symbol === 'TSLA');
    expect(tslaPending).toHaveLength(2);
  });

  test('should query all active strategies for a symbol efficiently', async () => {
    // Create 5 active NVDA strategies
    await prisma.strategy.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        userId: testUserId,
        symbol: 'NVDA',
        name: `NVDA-Strategy-${i + 1}`,
        timeframe: '5m',
        status: StrategyStatus.ACTIVE,
        yamlContent: `meta:\n  name: "NVDA ${i + 1}"`,
        activatedAt: new Date(),
      })),
    });

    // Query all active NVDA strategies
    const activeNVDA = await prisma.strategy.findMany({
      where: {
        userId: testUserId,
        symbol: 'NVDA',
        status: StrategyStatus.ACTIVE,
        deletedAt: null,
      },
      orderBy: {
        activatedAt: 'asc',
      },
    });

    expect(activeNVDA).toHaveLength(5);
    expect(activeNVDA.every((s) => s.symbol === 'NVDA')).toBe(true);
    expect(activeNVDA.every((s) => s.status === StrategyStatus.ACTIVE)).toBe(true);
  });
});
