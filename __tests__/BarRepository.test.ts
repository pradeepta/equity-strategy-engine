/**
 * BarRepository Unit Tests
 * Tests database operations for bar caching
 */

import { PrismaClient } from '@prisma/client';
import { BarRepository } from '../database/repositories/BarRepository';
import { Bar } from '../spec/types';

describe('BarRepository', () => {
  let prisma: PrismaClient;
  let barRepo: BarRepository;

  beforeAll(async () => {
    // Use test database (or default DATABASE_URL)
    prisma = new PrismaClient();
    barRepo = new BarRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    await prisma.marketBar.deleteMany({
      where: {
        symbol: { in: ['TEST', 'AAPL', 'NVDA'] },
      },
    });
  });

  describe('insertBars', () => {
    it('should insert bars successfully', async () => {
      const bars: Bar[] = [
        {
          timestamp: 1000000,
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 10000,
        },
        {
          timestamp: 2000000,
          open: 103,
          high: 107,
          low: 102,
          close: 106,
          volume: 15000,
        },
      ];

      const insertedCount = await barRepo.insertBars('TEST', '5m', bars);

      expect(insertedCount).toBe(2);
    });

    it('should handle duplicate bars with conflict resolution', async () => {
      const bars: Bar[] = [
        {
          timestamp: 1000000,
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 10000,
        },
      ];

      // Insert first time
      const count1 = await barRepo.insertBars('TEST', '5m', bars);
      expect(count1).toBe(1);

      // Insert again (should be ignored due to unique constraint)
      const count2 = await barRepo.insertBars('TEST', '5m', bars);
      expect(count2).toBe(0); // No new rows inserted
    });

    it('should insert bars with different timeframes separately', async () => {
      const bars: Bar[] = [
        {
          timestamp: 1000000,
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 10000,
        },
      ];

      const count5m = await barRepo.insertBars('TEST', '5m', bars);
      const count1h = await barRepo.insertBars('TEST', '1h', bars);

      expect(count5m).toBe(1);
      expect(count1h).toBe(1); // Different timeframe, so inserted
    });
  });

  describe('getBars', () => {
    beforeEach(async () => {
      // Insert test data
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
        { timestamp: 3000000, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];
      await barRepo.insertBars('TEST', '5m', bars);
    });

    it('should retrieve bars in time range', async () => {
      const bars = await barRepo.getBars('TEST', '5m', 1500000, 2500000);

      expect(bars.length).toBe(1);
      expect(bars[0].timestamp).toBe(2000000);
    });

    it('should return empty array for non-existent symbol', async () => {
      const bars = await barRepo.getBars('NONEXISTENT', '5m', 0, Date.now());

      expect(bars.length).toBe(0);
    });

    it('should return bars sorted by timestamp', async () => {
      const bars = await barRepo.getBars('TEST', '5m', 0, 4000000);

      expect(bars.length).toBe(3);
      expect(bars[0].timestamp).toBe(1000000);
      expect(bars[1].timestamp).toBe(2000000);
      expect(bars[2].timestamp).toBe(3000000);
    });
  });

  describe('getRecentBars', () => {
    beforeEach(async () => {
      // Insert test data (10 bars)
      const bars: Bar[] = [];
      for (let i = 1; i <= 10; i++) {
        bars.push({
          timestamp: i * 1000000,
          open: 100 + i,
          high: 105 + i,
          low: 99 + i,
          close: 103 + i,
          volume: 10000 + i * 1000,
        });
      }
      await barRepo.insertBars('TEST', '5m', bars);
    });

    it('should return last N bars', async () => {
      const bars = await barRepo.getRecentBars('TEST', '5m', 5);

      expect(bars.length).toBe(5);
      expect(bars[0].timestamp).toBe(6000000); // 6th bar
      expect(bars[4].timestamp).toBe(10000000); // 10th bar
    });

    it('should return all bars if limit exceeds count', async () => {
      const bars = await barRepo.getRecentBars('TEST', '5m', 100);

      expect(bars.length).toBe(10);
    });

    it('should return bars in ascending timestamp order', async () => {
      const bars = await barRepo.getRecentBars('TEST', '5m', 3);

      expect(bars[0].timestamp).toBeLessThan(bars[1].timestamp);
      expect(bars[1].timestamp).toBeLessThan(bars[2].timestamp);
    });
  });

  describe('getLatestBarTimestamp', () => {
    it('should return latest timestamp for symbol/timeframe', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
        { timestamp: 3000000, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];
      await barRepo.insertBars('TEST', '5m', bars);

      const latestTimestamp = await barRepo.getLatestBarTimestamp('TEST', '5m');

      expect(latestTimestamp).toBe(3000000);
    });

    it('should return null for non-existent symbol', async () => {
      const latestTimestamp = await barRepo.getLatestBarTimestamp('NONEXISTENT', '5m');

      expect(latestTimestamp).toBeNull();
    });

    it('should handle different timeframes independently', async () => {
      const bars5m: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];
      const bars1h: Bar[] = [
        { timestamp: 5000000, open: 110, high: 115, low: 109, close: 113, volume: 50000 },
      ];

      await barRepo.insertBars('TEST', '5m', bars5m);
      await barRepo.insertBars('TEST', '1h', bars1h);

      const latest5m = await barRepo.getLatestBarTimestamp('TEST', '5m');
      const latest1h = await barRepo.getLatestBarTimestamp('TEST', '1h');

      expect(latest5m).toBe(1000000);
      expect(latest1h).toBe(5000000);
    });
  });

  describe('getBarCount', () => {
    it('should return correct bar count', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
      ];
      await barRepo.insertBars('TEST', '5m', bars);

      const count = await barRepo.getBarCount('TEST', '5m');

      expect(count).toBe(2);
    });

    it('should return 0 for non-existent symbol', async () => {
      const count = await barRepo.getBarCount('NONEXISTENT', '5m');

      expect(count).toBe(0);
    });
  });

  describe('deleteOldBars', () => {
    beforeEach(async () => {
      // Insert bars with different timestamps
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
        { timestamp: 3000000, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];
      await barRepo.insertBars('TEST', '5m', bars);
    });

    it('should delete bars older than cutoff timestamp', async () => {
      const deletedCount = await barRepo.deleteOldBars('TEST', '5m', 2500000);

      expect(deletedCount).toBe(2); // First 2 bars deleted

      const remainingBars = await barRepo.getBars('TEST', '5m', 0, 4000000);
      expect(remainingBars.length).toBe(1);
      expect(remainingBars[0].timestamp).toBe(3000000);
    });

    it('should delete all bars if null symbol/timeframe', async () => {
      // Insert bars for multiple symbols
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];
      await barRepo.insertBars('AAPL', '5m', bars);
      await barRepo.insertBars('NVDA', '5m', bars);

      const deletedCount = await barRepo.deleteOldBars(null, null, 2000000);

      // Should delete old bars from all symbols
      expect(deletedCount).toBeGreaterThan(0);
    });

    it('should return 0 if no bars match criteria', async () => {
      const deletedCount = await barRepo.deleteOldBars('TEST', '5m', 500000);

      expect(deletedCount).toBe(0);
    });
  });

  describe('getAllSymbolTimeframes', () => {
    it('should return all unique symbol/timeframe combinations', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      await barRepo.insertBars('AAPL', '5m', bars);
      await barRepo.insertBars('AAPL', '1h', bars);
      await barRepo.insertBars('NVDA', '5m', bars);

      const symbolTimeframes = await barRepo.getAllSymbolTimeframes();

      expect(symbolTimeframes.length).toBeGreaterThanOrEqual(3);
      expect(symbolTimeframes).toContainEqual({ symbol: 'AAPL', timeframe: '5m' });
      expect(symbolTimeframes).toContainEqual({ symbol: 'AAPL', timeframe: '1h' });
      expect(symbolTimeframes).toContainEqual({ symbol: 'NVDA', timeframe: '5m' });
    });
  });
});
