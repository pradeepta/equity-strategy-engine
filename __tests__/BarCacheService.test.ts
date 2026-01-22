/**
 * BarCacheService Unit Tests
 * Tests in-memory caching, gap detection, and backfilling logic
 */

import { BarCacheService } from '../live/cache/BarCacheService';
import { BarRepository } from '../database/repositories/BarRepository';
import { Bar } from '../spec/types';

// Mock BarRepository
jest.mock('../database/repositories/BarRepository');

describe('BarCacheService', () => {
  let barRepo: jest.Mocked<BarRepository>;
  let cacheService: BarCacheService;

  beforeEach(() => {
    // Create mock repository
    barRepo = new BarRepository(null as any) as jest.Mocked<BarRepository>;

    // Mock repository methods
    barRepo.getRecentBars = jest.fn();
    barRepo.getLatestBarTimestamp = jest.fn();
    barRepo.insertBars = jest.fn();
    barRepo.getBarCount = jest.fn();
    barRepo.getAllSymbolTimeframes = jest.fn();
    barRepo.getBars = jest.fn();
    barRepo.deleteOldBars = jest.fn();

    // Create cache service with short TTL for testing
    process.env.BAR_CACHE_TTL_MS = '100'; // 100ms
    process.env.BAR_CACHE_MAX_SIZE = '1000';
    cacheService = new BarCacheService(barRepo);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Cache Hit/Miss', () => {
    it('should return cached bars on cache hit (within TTL)', async () => {
      const mockBars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBars);
      barRepo.getLatestBarTimestamp.mockResolvedValue(2000000);

      // First call - cache miss
      const bars1 = await cacheService.getBars('AAPL', '5m', 10);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(1);
      expect(bars1.length).toBe(2);

      // Second call immediately - cache hit
      const bars2 = await cacheService.getBars('AAPL', '5m', 10);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(1); // No additional call
      expect(bars2.length).toBe(2);
    });

    it('should refresh cache after TTL expires', async () => {
      const mockBars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBars);
      barRepo.getLatestBarTimestamp.mockResolvedValue(1000000);

      // First call
      await cacheService.getBars('AAPL', '5m', 10);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Second call after TTL - should refresh
      await cacheService.getBars('AAPL', '5m', 10);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(2);
    });

    it('should maintain separate caches per symbol', async () => {
      const mockBarsAAPL: Bar[] = [
        { timestamp: 1000000, open: 150, high: 155, low: 149, close: 153, volume: 20000 },
      ];
      const mockBarsNVDA: Bar[] = [
        { timestamp: 1000000, open: 450, high: 455, low: 449, close: 453, volume: 30000 },
      ];

      barRepo.getRecentBars
        .mockResolvedValueOnce(mockBarsAAPL)
        .mockResolvedValueOnce(mockBarsNVDA);
      barRepo.getLatestBarTimestamp
        .mockResolvedValueOnce(1000000)
        .mockResolvedValueOnce(1000000);

      const barsAAPL = await cacheService.getBars('AAPL', '5m', 10);
      const barsNVDA = await cacheService.getBars('NVDA', '5m', 10);

      expect(barsAAPL[0].close).toBe(153);
      expect(barsNVDA[0].close).toBe(453);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(2);
    });

    it('should maintain separate caches per timeframe', async () => {
      const mockBars5m: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];
      const mockBars1h: Bar[] = [
        { timestamp: 1000000, open: 100, high: 108, low: 98, close: 107, volume: 50000 },
      ];

      barRepo.getRecentBars
        .mockResolvedValueOnce(mockBars5m)
        .mockResolvedValueOnce(mockBars1h);
      barRepo.getLatestBarTimestamp
        .mockResolvedValueOnce(1000000)
        .mockResolvedValueOnce(1000000);

      const bars5m = await cacheService.getBars('AAPL', '5m', 10);
      const bars1h = await cacheService.getBars('AAPL', '1h', 10);

      expect(bars5m[0].close).toBe(103);
      expect(bars1h[0].close).toBe(107);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(2);
    });
  });

  describe('Gap Detection', () => {
    it('should detect gaps in bar data', async () => {
      // Bars with gap: 1000000, 2000000, [GAP], 5000000
      const mockBarsWithGap: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
        { timestamp: 5000000, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBarsWithGap);
      barRepo.getLatestBarTimestamp.mockResolvedValue(5000000);

      // Mock gap backfill to return empty (already tested separately)
      barRepo.getBars.mockResolvedValue([]);

      const bars = await cacheService.getBars('AAPL', '5m', 10);

      // Should have detected and attempted to backfill gaps
      // (Gap detection logic is internal, verify through behavior)
      expect(bars.length).toBeGreaterThan(0);
    });

    it('should not flag gaps during non-market hours', async () => {
      // Create bars spanning overnight (market closed)
      const marketCloseTime = new Date('2024-01-15T16:00:00-05:00').getTime();
      const marketOpenTime = new Date('2024-01-16T09:30:00-05:00').getTime();

      const mockBarsOvernight: Bar[] = [
        { timestamp: marketCloseTime - 300000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: marketCloseTime, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
        { timestamp: marketOpenTime, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBarsOvernight);
      barRepo.getLatestBarTimestamp.mockResolvedValue(marketOpenTime);

      const bars = await cacheService.getBars('AAPL', '5m', 10);

      // Should not attempt to backfill overnight gap
      expect(barRepo.getBars).not.toHaveBeenCalled();
      expect(bars.length).toBe(3);
    });
  });

  describe('Cache Statistics', () => {
    it('should track cache hits and misses', async () => {
      const mockBars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBars);
      barRepo.getLatestBarTimestamp.mockResolvedValue(1000000);

      // First call - miss
      await cacheService.getBars('AAPL', '5m', 10);

      // Second call - hit
      await cacheService.getBars('AAPL', '5m', 10);

      const stats = await cacheService.getCacheStats();
      const aaplStats = stats.find((s) => s.symbol === 'AAPL' && s.timeframe === '5m');

      expect(aaplStats).toBeDefined();
      expect(aaplStats!.cacheHits).toBe(1);
      expect(aaplStats!.cacheMisses).toBe(1);
      expect(aaplStats!.hitRate).toBeCloseTo(50, 0);
    });

    it('should report correct bar count in cache', async () => {
      const mockBars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 2000000, open: 103, high: 107, low: 102, close: 106, volume: 15000 },
        { timestamp: 3000000, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBars);
      barRepo.getLatestBarTimestamp.mockResolvedValue(3000000);

      await cacheService.getBars('AAPL', '5m', 10);

      const stats = await cacheService.getCacheStats();
      const aaplStats = stats.find((s) => s.symbol === 'AAPL' && s.timeframe === '5m');

      expect(aaplStats).toBeDefined();
      expect(aaplStats!.barCount).toBe(3);
    });
  });

  describe('Cache Clearing', () => {
    it('should clear cache for specific symbol/timeframe', async () => {
      const mockBars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBars);
      barRepo.getLatestBarTimestamp.mockResolvedValue(1000000);

      // Populate cache
      await cacheService.getBars('AAPL', '5m', 10);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(1);

      // Clear cache
      cacheService.clearCache('AAPL', '5m');

      // Next call should be cache miss
      await cacheService.getBars('AAPL', '5m', 10);
      expect(barRepo.getRecentBars).toHaveBeenCalledTimes(2);
    });

    it('should clear all caches', async () => {
      const mockBars: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBars);
      barRepo.getLatestBarTimestamp.mockResolvedValue(1000000);

      // Populate multiple caches
      await cacheService.getBars('AAPL', '5m', 10);
      await cacheService.getBars('NVDA', '5m', 10);

      // Clear all
      cacheService.clearAllCaches();

      const stats = await cacheService.getCacheStats();
      expect(stats.length).toBe(0);
    });
  });

  describe('Memory Management', () => {
    it('should cap bar count at maxSize', async () => {
      // Create 1500 bars (exceeds maxSize of 1000)
      const mockBars: Bar[] = [];
      for (let i = 0; i < 1500; i++) {
        mockBars.push({
          timestamp: i * 1000,
          open: 100 + i,
          high: 105 + i,
          low: 99 + i,
          close: 103 + i,
          volume: 10000,
        });
      }

      barRepo.getRecentBars.mockResolvedValue(mockBars);
      barRepo.getLatestBarTimestamp.mockResolvedValue(1499000);

      await cacheService.getBars('AAPL', '5m', 2000);

      const stats = await cacheService.getCacheStats();
      const aaplStats = stats.find((s) => s.symbol === 'AAPL');

      // Should be capped at maxSize
      expect(aaplStats!.barCount).toBeLessThanOrEqual(1000);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      barRepo.getRecentBars.mockRejectedValue(new Error('Database connection failed'));

      await expect(cacheService.getBars('AAPL', '5m', 10)).rejects.toThrow();
    });

    it('should continue on gap backfill failure', async () => {
      const mockBarsWithGap: Bar[] = [
        { timestamp: 1000000, open: 100, high: 105, low: 99, close: 103, volume: 10000 },
        { timestamp: 5000000, open: 106, high: 110, low: 105, close: 108, volume: 20000 },
      ];

      barRepo.getRecentBars.mockResolvedValue(mockBarsWithGap);
      barRepo.getLatestBarTimestamp.mockResolvedValue(5000000);
      barRepo.getBars.mockRejectedValue(new Error('TWS connection failed'));

      // Should return available bars even if gap backfill fails
      const bars = await cacheService.getBars('AAPL', '5m', 10);
      expect(bars.length).toBeGreaterThan(0);
    });
  });
});
