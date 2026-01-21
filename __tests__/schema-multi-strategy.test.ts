/**
 * Database Schema Tests - Multiple Strategies Per Symbol
 *
 * Tests that the database schema allows multiple strategies with the same symbol
 * after removing the unique constraint on [userId, symbol, status, deletedAt].
 *
 * These tests should FAIL initially (unique constraint exists) and PASS after
 * the schema migration is applied.
 */

import { PrismaClient, StrategyStatus } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

describe('Database Schema - Multiple Strategies Per Symbol', () => {
  let prisma: PrismaClient;
  let pool: Pool;
  const testUserId = 'test-user-schema-' + Date.now();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    // Create test user
    await prisma.user.create({
      data: {
        id: testUserId,
        email: `test-${testUserId}@example.com`,
        name: 'Test User',
      },
    });
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.strategy.deleteMany({
      where: { userId: testUserId },
    });
    await prisma.user.delete({
      where: { id: testUserId },
    });
    await prisma.$disconnect();
    await pool.end();
  });

  afterEach(async () => {
    // Clean up after each test
    await prisma.strategy.deleteMany({
      where: { userId: testUserId },
    });
  });

  test('should allow two strategies with same userId, symbol, status', async () => {
    // Create first NVDA strategy
    const strategy1 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'NVDA',
        name: 'NVDA RSI Strategy',
        timeframe: '5m',
        status: StrategyStatus.DRAFT,
        yamlContent: 'meta:\n  name: "NVDA RSI"\n  symbol: "NVDA"\n  timeframe: "5m"',
      },
    });

    // Create second NVDA strategy with same status
    const strategy2 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'NVDA',
        name: 'NVDA MACD Strategy',
        timeframe: '5m',
        status: StrategyStatus.DRAFT,
        yamlContent: 'meta:\n  name: "NVDA MACD"\n  symbol: "NVDA"\n  timeframe: "5m"',
      },
    });

    // Assertions
    expect(strategy1.id).not.toBe(strategy2.id);
    expect(strategy1.symbol).toBe('NVDA');
    expect(strategy2.symbol).toBe('NVDA');
    expect(strategy1.status).toBe(StrategyStatus.DRAFT);
    expect(strategy2.status).toBe(StrategyStatus.DRAFT);
    expect(strategy1.userId).toBe(testUserId);
    expect(strategy2.userId).toBe(testUserId);
  });

  test('should allow two ACTIVE strategies with same symbol', async () => {
    // Create first ACTIVE NVDA strategy
    const strategy1 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'NVDA',
        name: 'NVDA Momentum',
        timeframe: '5m',
        status: StrategyStatus.ACTIVE,
        yamlContent: 'meta:\n  name: "NVDA Momentum"\n  symbol: "NVDA"\n  timeframe: "5m"',
        activatedAt: new Date(),
      },
    });

    // Create second ACTIVE NVDA strategy
    const strategy2 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'NVDA',
        name: 'NVDA Mean Reversion',
        timeframe: '5m',
        status: StrategyStatus.ACTIVE,
        yamlContent: 'meta:\n  name: "NVDA Mean Reversion"\n  symbol: "NVDA"\n  timeframe: "5m"',
        activatedAt: new Date(),
      },
    });

    // Assertions
    expect(strategy1.id).not.toBe(strategy2.id);
    expect(strategy1.symbol).toBe('NVDA');
    expect(strategy2.symbol).toBe('NVDA');
    expect(strategy1.status).toBe(StrategyStatus.ACTIVE);
    expect(strategy2.status).toBe(StrategyStatus.ACTIVE);
  });

  test('should allow three strategies with same symbol but different statuses', async () => {
    const strategy1 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'TSLA',
        name: 'TSLA Draft',
        timeframe: '5m',
        status: StrategyStatus.DRAFT,
        yamlContent: 'meta:\n  name: "TSLA Draft"\n  symbol: "TSLA"\n  timeframe: "5m"',
      },
    });

    const strategy2 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'TSLA',
        name: 'TSLA Active',
        timeframe: '5m',
        status: StrategyStatus.ACTIVE,
        yamlContent: 'meta:\n  name: "TSLA Active"\n  symbol: "TSLA"\n  timeframe: "5m"',
        activatedAt: new Date(),
      },
    });

    const strategy3 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'TSLA',
        name: 'TSLA Pending',
        timeframe: '5m',
        status: StrategyStatus.PENDING,
        yamlContent: 'meta:\n  name: "TSLA Pending"\n  symbol: "TSLA"\n  timeframe: "5m"',
      },
    });

    expect(strategy1.status).toBe(StrategyStatus.DRAFT);
    expect(strategy2.status).toBe(StrategyStatus.ACTIVE);
    expect(strategy3.status).toBe(StrategyStatus.PENDING);
    expect(new Set([strategy1.id, strategy2.id, strategy3.id]).size).toBe(3);
  });

  test('should allow two strategies with same symbol but different users', async () => {
    const user2Id = testUserId + '-user2';

    // Create user2
    await prisma.user.create({
      data: {
        id: user2Id,
        email: `test-${user2Id}@example.com`,
        name: 'Test User 2',
      },
    });

    const s1 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'AAPL',
        name: 'AAPL User1',
        timeframe: '5m',
        status: StrategyStatus.ACTIVE,
        yamlContent: 'meta:\n  name: "AAPL User1"\n  symbol: "AAPL"\n  timeframe: "5m"',
        activatedAt: new Date(),
      },
    });

    const s2 = await prisma.strategy.create({
      data: {
        userId: user2Id,
        symbol: 'AAPL',
        name: 'AAPL User2',
        timeframe: '5m',
        status: StrategyStatus.ACTIVE,
        yamlContent: 'meta:\n  name: "AAPL User2"\n  symbol: "AAPL"\n  timeframe: "5m"',
        activatedAt: new Date(),
      },
    });

    expect(s1.id).not.toBe(s2.id);
    expect(s1.symbol).toBe('AAPL');
    expect(s2.symbol).toBe('AAPL');
    expect(s1.userId).not.toBe(s2.userId);

    // Clean up user2
    await prisma.strategy.deleteMany({ where: { userId: user2Id } });
    await prisma.user.delete({ where: { id: user2Id } });
  });

  test('should still enforce ID uniqueness constraint', async () => {
    const strategy = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'MSFT',
        name: 'MSFT Strategy',
        timeframe: '5m',
        status: StrategyStatus.DRAFT,
        yamlContent: 'meta:\n  name: "MSFT"\n  symbol: "MSFT"\n  timeframe: "5m"',
      },
    });

    // Attempt to create another strategy with the same ID should fail
    await expect(
      prisma.strategy.create({
        data: {
          id: strategy.id, // Same ID
          userId: testUserId,
          symbol: 'GOOG',
          name: 'GOOG Strategy',
          timeframe: '5m',
          status: StrategyStatus.DRAFT,
          yamlContent: 'meta:\n  name: "GOOG"\n  symbol: "GOOG"\n  timeframe: "5m"',
        },
      })
    ).rejects.toThrow();
  });

  test('should allow multiple strategies with soft delete (deletedAt not null)', async () => {
    // Create and delete first strategy
    const strategy1 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'AMD',
        name: 'AMD Old',
        timeframe: '5m',
        status: StrategyStatus.CLOSED,
        yamlContent: 'meta:\n  name: "AMD Old"\n  symbol: "AMD"\n  timeframe: "5m"',
        deletedAt: new Date(),
      },
    });

    // Create active strategy with same symbol
    const strategy2 = await prisma.strategy.create({
      data: {
        userId: testUserId,
        symbol: 'AMD',
        name: 'AMD New',
        timeframe: '5m',
        status: StrategyStatus.ACTIVE,
        yamlContent: 'meta:\n  name: "AMD New"\n  symbol: "AMD"\n  timeframe: "5m"',
        activatedAt: new Date(),
      },
    });

    expect(strategy1.id).not.toBe(strategy2.id);
    expect(strategy1.deletedAt).not.toBeNull();
    expect(strategy2.deletedAt).toBeNull();
  });

  test('should query multiple active strategies for same symbol', async () => {
    // Create 3 ACTIVE NVDA strategies
    await prisma.strategy.createMany({
      data: [
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA RSI',
          timeframe: '5m',
          status: StrategyStatus.ACTIVE,
          yamlContent: 'meta:\n  name: "NVDA RSI"\n  symbol: "NVDA"\n  timeframe: "5m"',
          activatedAt: new Date(),
        },
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA MACD',
          timeframe: '5m',
          status: StrategyStatus.ACTIVE,
          yamlContent: 'meta:\n  name: "NVDA MACD"\n  symbol: "NVDA"\n  timeframe: "5m"',
          activatedAt: new Date(),
        },
        {
          userId: testUserId,
          symbol: 'NVDA',
          name: 'NVDA BB',
          timeframe: '5m',
          status: StrategyStatus.ACTIVE,
          yamlContent: 'meta:\n  name: "NVDA BB"\n  symbol: "NVDA"\n  timeframe: "5m"',
          activatedAt: new Date(),
        },
      ],
    });

    // Query all active NVDA strategies
    const activeNVDAStrategies = await prisma.strategy.findMany({
      where: {
        userId: testUserId,
        symbol: 'NVDA',
        status: StrategyStatus.ACTIVE,
        deletedAt: null,
      },
    });

    expect(activeNVDAStrategies).toHaveLength(3);
    expect(activeNVDAStrategies.every((s) => s.symbol === 'NVDA')).toBe(true);
    expect(activeNVDAStrategies.every((s) => s.status === StrategyStatus.ACTIVE)).toBe(true);
  });
});
