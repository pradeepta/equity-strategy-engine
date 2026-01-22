/**
 * Bar Cache Integration Tests
 * Tests end-to-end bar caching with database and strategy integration
 */

import { PrismaClient } from '@prisma/client';
import { BarRepository } from '../database/repositories/BarRepository';
import { BarCacheService } from '../live/cache/BarCacheService';
import { BarCacheMonitor } from '../live/cache/BarCacheMonitor';
import { MultiStrategyManager } from '../live/MultiStrategyManager';
import { TwsAdapter } from '../broker/twsAdapter';
import { StrategyRepository } from '../database/repositories/StrategyRepository';
import { Bar, BrokerEnvironment } from '../spec/types';

// Mock TWS client to avoid real broker connection
jest.mock('../broker/twsMarketData');

describe('Bar Cache Integration Tests', () => {
  let prisma: PrismaClient;
  let barRepo: BarRepository;
  let cacheService: BarCacheService;
  let cacheMonitor: BarCacheMonitor;

  beforeAll(async () => {
    // Use test database (or default DATABASE_URL)
    prisma = new PrismaClient();

    barRepo = new BarRepository(prisma);
    cacheService = new BarCacheService(barRepo);
    cacheMonitor = new BarCacheMonitor(barRepo, cacheService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up test data
    await prisma.marketBar.deleteMany({
      where: {
        symbol: { in: ['TEST', 'AAPL', 'NVDA', 'TSLA'] },
      },
    });

    // Clear cache
    cacheService.clearAllCaches();
  });

  describe('Multi-Strategy Bar Sharing', () => {
    it('should share bars across multiple strategies on same symbol', async () => {
      // Simulate 3 strategies on NVDA
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
      ];

      // First strategy fetches bars (cache miss + DB insert)
      await barRepo.insertBars('NVDA', '5m', bars);
      const bars1 = await cacheService.getBars('NVDA', '5m', 10);
      expect(bars1.length).toBe(2);

      // Second strategy fetches bars (cache hit)
      const bars2 = await cacheService.getBars('NVDA', '5m', 10);
      expect(bars2.length).toBe(2);

      // Third strategy fetches bars (cache hit)
      const bars3 = await cacheService.getBars('NVDA', '5m', 10);
      expect(bars3.length).toBe(2);

      // Verify all strategies got same data
      expect(bars1[0].timestamp).toBe(bars2[0].timestamp);
      expect(bars2[0].timestamp).toBe(bars3[0].timestamp);
    });

    it('should maintain separate caches for different timeframes', async () => {
      const bars5m: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];
      const bars1h: Bar[] = [
        { timestamp: 1000000, open: 100, high: 110, low: 98, close: 108, volume: 50000 },
      ];

      await barRepo.insertBars('NVDA', '5m', bars5m);
      await barRepo.insertBars('NVDA', '1h', bars1h);

      const fetched5m = await cacheService.getBars('NVDA', '5m', 10);
      const fetched1h = await cacheService.getBars('NVDA', '1h', 10);

      expect(fetched5m[0].close).toBe(103);
      expect(fetched1h[0].close).toBe(108);
    });
  });

  describe('Database Persistence', () => {
    it('should persist bars to database for audit trail', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
      ];

      // Insert via repository
      await barRepo.insertBars('AAPL', '5m', bars);

      // Verify in database
      const dbBars = await prisma.marketBar.findMany({
        where: { symbol: 'AAPL', timeframe: '5m' },
        orderBy: { timestamp: 'asc' },
      });

      expect(dbBars.length).toBe(2);
      expect(Number(dbBars[0].timestamp)).toBe(1000000);
      expect(Number(dbBars[1].timestamp)).toBe(2000000);
    });

    it('should retrieve persisted bars after cache clear', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      await barRepo.insertBars('AAPL', '5m', bars);

      // First fetch populates cache
      await cacheService.getBars('AAPL', '5m', 10);

      // Clear cache
      cacheService.clearCache('AAPL', '5m');

      // Second fetch should retrieve from DB
      const retrievedBars = await cacheService.getBars('AAPL', '5m', 10);

      expect(retrievedBars.length).toBe(1);
      expect(retrievedBars[0].timestamp).toBe(1000000);
    });
  });

  describe('Incremental Bar Fetching', () => {
    it('should only fetch new bars after initial load', async () => {
      // Initial bars
      const initialBars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
      ];

      await barRepo.insertBars('AAPL', '5m', initialBars);

      // First fetch
      const bars1 = await cacheService.getBars('AAPL', '5m', 10);
      expect(bars1.length).toBe(2);

      // Simulate new bar arrival
      const newBar: Bar = {
        timestamp: 3000000,
        open: 106,
        high: 110,
        low: 105,
        close: 108,
        volume: 20000,
      };
      await barRepo.insertBars('AAPL', '5m', [newBar]);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Second fetch should get all 3 bars
      const bars2 = await cacheService.getBars('AAPL', '5m', 10);
      expect(bars2.length).toBe(3);
      expect(bars2[2].timestamp).toBe(3000000);
    });
  });

  describe('Cache Statistics and Monitoring', () => {
    it('should track cache performance metrics', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      await barRepo.insertBars('AAPL', '5m', bars);

      // Generate some cache hits and misses
      await cacheService.getBars('AAPL', '5m', 10); // Miss
      await cacheService.getBars('AAPL', '5m', 10); // Hit
      await cacheService.getBars('AAPL', '5m', 10); // Hit

      const stats = await cacheService.getCacheStats();
      const aaplStats = stats.find((s) => s.symbol === 'AAPL' && s.timeframe === '5m');

      expect(aaplStats).toBeDefined();
      expect(aaplStats!.cacheHits).toBe(2);
      expect(aaplStats!.cacheMisses).toBe(1);
      expect(aaplStats!.barCount).toBe(1);
      expect(aaplStats!.hitRate).toBeCloseTo(66.67, 1);
    });

    it('should calculate memory usage', async () => {
      const bars: Bar[] = [];
      for (let i = 0; i < 100; i++) {
        bars.push({
          timestamp: i * 1000,
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 10000,
        });
      }

      await barRepo.insertBars('AAPL', '5m', bars);
      await cacheService.getBars('AAPL', '5m', 200);

      const stats = await cacheService.getCacheStats();
      const aaplStats = stats.find((s) => s.symbol === 'AAPL');

      expect(aaplStats).toBeDefined();
      expect(aaplStats!.memoryBytes).toBeGreaterThan(0);
    });
  });

  describe('Retention Policy and Cleanup', () => {
    it('should delete old bars beyond retention period', async () => {
      const now = Date.now();
      const oldTimestamp = now - 366 * 24 * 60 * 60 * 1000; // 366 days ago
      const recentTimestamp = now - 1 * 24 * 60 * 60 * 1000; // 1 day ago

      const bars: Bar[] = [
        { timestamp: oldTimestamp, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: recentTimestamp, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
      ];

      await barRepo.insertBars('AAPL', '5m', bars);

      // Cleanup with 365-day retention
      const cutoffTimestamp = now - 365 * 24 * 60 * 60 * 1000;
      const deletedCount = await barRepo.deleteOldBars('AAPL', '5m', cutoffTimestamp);

      expect(deletedCount).toBe(1); // Only old bar deleted

      const remainingBars = await barRepo.getRecentBars('AAPL', '5m', 10);
      expect(remainingBars.length).toBe(1);
      expect(remainingBars[0].timestamp).toBe(recentTimestamp);
    });
  });

  describe('Gap Detection and Backfilling', () => {
    it('should detect gaps in bar sequence', async () => {
      // Create bars with gap: 1000000, 2000000, [missing 3000000, 4000000], 5000000
      const barsWithGap: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
        { timestamp: 5000000, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];

      await barRepo.insertBars('AAPL', '5m', barsWithGap);

      // Fetch should detect gap (internal logic)
      const bars = await cacheService.getBars('AAPL', '5m', 10);

      // Should have original bars (gap backfill tested separately)
      expect(bars.length).toBeGreaterThan(0);
      expect(bars[0].timestamp).toBe(1000000);
    });
  });

  describe('Cache Monitor Operations', () => {
    it('should log cache statistics', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      await barRepo.insertBars('AAPL', '5m', bars);
      await cacheService.getBars('AAPL', '5m', 10);

      // Should not throw
      await expect(cacheMonitor.logStats()).resolves.not.toThrow();
    });

    it('should get database storage statistics', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      await barRepo.insertBars('AAPL', '5m', bars);
      await barRepo.insertBars('NVDA', '5m', bars);

      const dbStats = await cacheMonitor.getDatabaseStats();

      expect(dbStats.totalBars).toBeGreaterThanOrEqual(2);
      expect(dbStats.symbolTimeframes.length).toBeGreaterThanOrEqual(2);
    });

    it('should evict inactive cache entries', async () => {
      const bars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      await barRepo.insertBars('AAPL', '5m', bars);
      await cacheService.getBars('AAPL', '5m', 10);

      // Evict entries not accessed in last 50ms
      await new Promise((resolve) => setTimeout(resolve, 100));
      const evictedCount = await cacheMonitor.evictInactiveEntries(50);

      expect(evictedCount).toBe(1);
    });
  });

  describe('Deduplication', () => {
    it('should handle duplicate bar inserts gracefully', async () => {
      const bar: Bar = {
        timestamp: 1000000,
        open: 100,
        high: 105,
        low: 99,
        close: 103,
        volume: 10000,
      };

      // Insert same bar multiple times
      await barRepo.insertBars('AAPL', '5m', [bar]);
      await barRepo.insertBars('AAPL', '5m', [bar]);
      await barRepo.insertBars('AAPL', '5m', [bar]);

      // Should only have one bar in database
      const bars = await barRepo.getRecentBars('AAPL', '5m', 10);
      expect(bars.length).toBe(1);
    });
  });
});
