/**
 * Bar Cache Service
 * Multi-level caching for market bar data with gap detection and automatic backfill
 *
 * Architecture:
 * - Tier 1: In-memory cache (fastest, 30s TTL)
 * - Tier 2: Database persistence (source of truth)
 * - Tier 3: TWS API fallback (slowest, only for new bars)
 */

import type { Bar } from '../../spec/types';
import type { BarRepository } from '../../database/repositories/BarRepository';
import type { CachedBars, Gap, BarCacheConfig, CacheStats } from './types';
import { TwsMarketDataClient } from '../../broker/twsMarketData';
import { getTimeframeMs, isMarketHours, rangeIncludesMarketHours } from '../../utils/marketHours';
import { LoggerFactory } from '../../logging/logger';

const logger = LoggerFactory.getLogger('BarCacheService');

export class BarCacheService {
  // In-memory cache: symbol → timeframe → cached bars
  private cache: Map<string, Map<string, CachedBars>> = new Map();

  // Statistics for monitoring
  private stats: Map<string, Map<string, { hits: number; misses: number }>> = new Map();

  private config: BarCacheConfig;
  private twsClient: TwsMarketDataClient;

  constructor(
    private barRepo: BarRepository,
    config: Partial<BarCacheConfig> = {}
  ) {
    // Load config from environment with defaults
    this.config = {
      enabled: process.env.BAR_CACHE_ENABLED === 'true',
      ttlMs: parseInt(process.env.BAR_CACHE_TTL_MS || '30000', 10),
      maxSize: parseInt(process.env.BAR_CACHE_MAX_SIZE || '10000', 10),
      retentionDays: parseInt(process.env.BAR_RETENTION_DAYS || '365', 10),
      lazyLoad: process.env.BAR_CACHE_LAZY_LOAD !== 'false',
      multiTimeframe: process.env.BAR_CACHE_MULTI_TIMEFRAME !== 'false',
      gapDetection: process.env.BAR_CACHE_GAP_DETECTION !== 'false',
      gapBackfill: process.env.BAR_CACHE_GAP_BACKFILL !== 'false',
      gapThreshold: parseInt(process.env.BAR_CACHE_GAP_THRESHOLD || '50', 10),
      logStatsInterval: parseInt(process.env.BAR_CACHE_LOG_STATS_INTERVAL || '3600000', 10),
      ...config,
    };

    // Initialize TWS client
    const twsHost = process.env.TWS_HOST || '127.0.0.1';
    const twsPort = parseInt(process.env.TWS_PORT || '7497', 10);
    const twsClientId = parseInt(process.env.TWS_CLIENT_ID || '2', 10);
    this.twsClient = new TwsMarketDataClient(twsHost, twsPort, twsClientId);

    logger.info('[BarCacheService] Initialized with config', { config: this.config });
  }

  /**
   * Get bars for a symbol/timeframe
   * Main entry point for all bar requests
   */
  async getBars(
    symbol: string,
    timeframe: string,
    limit: number,
    options: { forceRefresh?: boolean; detectGaps?: boolean; backfillGaps?: boolean } = {}
  ): Promise<Bar[]> {
    const startTime = Date.now();

    // Check if cache is disabled
    if (!this.config.enabled) {
      logger.debug(`[BarCacheService] Cache disabled, fetching from TWS directly`);
      return await this.fetchFromTWS(symbol, timeframe, limit, null);
    }

    // Step 1: Check in-memory cache (unless force refresh requested)
    if (!options.forceRefresh) {
      const cached = this.getFromCache(symbol, timeframe);
      if (cached && !this.shouldCheckForNewBars(cached)) {
        this.recordCacheHit(symbol, timeframe);
        const bars = cached.bars.slice(-limit);
        logger.debug(
          `[BarCacheService] Cache HIT for ${symbol} ${timeframe} (${bars.length} bars) in ${Date.now() - startTime}ms`
        );
        return bars;
      }
    }

    this.recordCacheMiss(symbol, timeframe);

    // Step 2: Get existing bars from database
    const dbBars = await this.barRepo.getRecentBars(symbol, timeframe, limit * 2);
    logger.debug(`[BarCacheService] Retrieved ${dbBars.length} bars from DB for ${symbol} ${timeframe}`);

    // Step 3: Check for gaps (if enabled and sufficient data)
    const detectGaps = options.detectGaps ?? this.config.gapDetection;
    const backfillGaps = options.backfillGaps ?? this.config.gapBackfill;

    if (detectGaps && dbBars.length >= 2) {
      const gaps = this.detectGaps(dbBars, timeframe);

      if (gaps.length > 0) {
        logger.warn(`[BarCacheService] Detected ${gaps.length} gap(s) in ${symbol} ${timeframe} data`, {
          symbol,
          timeframe,
          gaps: gaps.map((g) => ({
            startTime: new Date(g.startTime).toISOString(),
            endTime: new Date(g.endTime).toISOString(),
            missingBars: g.missingBars,
          })),
        });

        if (backfillGaps) {
          // Backfill each gap
          for (const gap of gaps) {
            try {
              logger.info(
                `[BarCacheService] Backfilling gap: ${new Date(gap.startTime).toISOString()} to ${new Date(gap.endTime).toISOString()}`,
                { symbol, timeframe, missingBars: gap.missingBars }
              );

              const gapBars = await this.fetchBarsInRange(symbol, timeframe, gap.startTime, gap.endTime);
              if (gapBars.length > 0) {
                await this.barRepo.insertBars(symbol, timeframe, gapBars);
                dbBars.push(...gapBars);
                logger.info(`[BarCacheService] Backfilled ${gapBars.length} bars for gap`, {
                  symbol,
                  timeframe,
                  expected: gap.missingBars,
                  actual: gapBars.length,
                });
              }
            } catch (error) {
              logger.error(`[BarCacheService] Failed to backfill gap`, {
                symbol,
                timeframe,
                gap,
                error: error instanceof Error ? error.message : String(error),
              });
              // Continue with other gaps even if one fails
            }
          }

          // Re-sort after backfill
          dbBars.sort((a, b) => a.timestamp - b.timestamp);
        }
      }
    }

    // Step 4: Check if we need more bars from TWS
    const latestTimestamp = dbBars.length > 0 ? dbBars[dbBars.length - 1].timestamp : null;

    // Determine if we have enough bars or need to fetch more
    const needMoreBars = dbBars.length < limit;
    const dataCompleteness = dbBars.length / limit;

    let newBars: Bar[] = [];

    if (needMoreBars && dataCompleteness < this.config.gapThreshold / 100) {
      // Less than threshold (e.g., 50%) of data exists → fetch full range
      logger.info(
        `[BarCacheService] Insufficient data (${dbBars.length}/${limit}), fetching full range from TWS`,
        { symbol, timeframe, completeness: `${(dataCompleteness * 100).toFixed(1)}%` }
      );
      newBars = await this.fetchFromTWS(symbol, timeframe, limit, null);

      // Persist all bars (deduplication handled by repository)
      if (newBars.length > 0) {
        await this.barRepo.insertBars(symbol, timeframe, newBars);
      }
    } else {
      // Fetch only NEW bars (incremental)
      newBars = await this.fetchFromTWS(symbol, timeframe, limit, latestTimestamp);

      // Persist only new bars
      if (newBars.length > 0) {
        await this.barRepo.insertBars(symbol, timeframe, newBars);
      }
    }

    // Step 5: Combine and cache
    const allBars = [...dbBars, ...newBars]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-limit);

    this.updateCache(symbol, timeframe, allBars);

    const duration = Date.now() - startTime;
    logger.info(
      `[BarCacheService] Cache MISS resolved for ${symbol} ${timeframe} (${allBars.length} bars) in ${duration}ms`,
      {
        symbol,
        timeframe,
        dbBars: dbBars.length,
        newBars: newBars.length,
        totalBars: allBars.length,
        durationMs: duration,
      }
    );

    return allBars;
  }

  /**
   * Fetch bars from TWS API
   * @param afterTimestamp If provided, only fetch bars newer than this timestamp
   */
  private async fetchFromTWS(
    symbol: string,
    timeframe: string,
    limit: number,
    afterTimestamp: number | null
  ): Promise<Bar[]> {
    try {
      // Calculate how many days of data we need based on timeframe
      const intervalMs = getTimeframeMs(timeframe);
      const barsPerDay = timeframe.endsWith('d') ? 1 : (6.5 * 60 * 60 * 1000) / intervalMs; // 6.5 market hours per day
      const daysNeeded = Math.ceil(limit / barsPerDay) + 1; // +1 for safety

      logger.debug(`[BarCacheService] Fetching from TWS: ${symbol} ${timeframe} (${daysNeeded} days)`, {
        symbol,
        timeframe,
        limit,
        daysNeeded,
        afterTimestamp: afterTimestamp ? new Date(afterTimestamp).toISOString() : null,
      });

      const allBars = await this.twsClient.getHistoricalBars(symbol, daysNeeded, timeframe);

      // Filter bars if afterTimestamp is provided (incremental fetch)
      if (afterTimestamp !== null) {
        const filteredBars = allBars.filter((bar) => bar.timestamp > afterTimestamp);
        logger.debug(
          `[BarCacheService] Filtered ${allBars.length} → ${filteredBars.length} bars (after ${new Date(afterTimestamp).toISOString()})`,
          {
            symbol,
            timeframe,
            totalBars: allBars.length,
            newBars: filteredBars.length,
          }
        );
        return filteredBars;
      }

      return allBars;
    } catch (error) {
      logger.error(`[BarCacheService] Failed to fetch bars from TWS`, {
        symbol,
        timeframe,
        limit,
        afterTimestamp,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Fetch bars for a specific time range (for gap backfilling)
   */
  private async fetchBarsInRange(
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number
  ): Promise<Bar[]> {
    try {
      const intervalMs = getTimeframeMs(timeframe);
      const rangeMs = endTime - startTime;
      const expectedBars = Math.ceil(rangeMs / intervalMs);
      const daysInRange = Math.ceil(rangeMs / (24 * 60 * 60 * 1000)) + 1;

      logger.debug(
        `[BarCacheService] Fetching bars in range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`,
        { symbol, timeframe, daysInRange, expectedBars }
      );

      // Fetch bars and filter to range
      const allBars = await this.twsClient.getHistoricalBars(symbol, daysInRange, timeframe);
      const barsInRange = allBars.filter((bar) => bar.timestamp >= startTime && bar.timestamp <= endTime);

      logger.debug(`[BarCacheService] Filtered ${allBars.length} → ${barsInRange.length} bars in range`, {
        symbol,
        timeframe,
        totalBars: allBars.length,
        barsInRange: barsInRange.length,
        expectedBars,
      });

      return barsInRange;
    } catch (error) {
      logger.error(`[BarCacheService] Failed to fetch bars in range`, {
        symbol,
        timeframe,
        startTime,
        endTime,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Detect gaps in bar data
   */
  private detectGaps(bars: Bar[], timeframe: string): Gap[] {
    if (bars.length < 2) {
      return [];
    }

    const expectedInterval = getTimeframeMs(timeframe);
    const gaps: Gap[] = [];

    for (let i = 1; i < bars.length; i++) {
      const prevBar = bars[i - 1];
      const currBar = bars[i];
      const timeDiff = currBar.timestamp - prevBar.timestamp;

      // Check if gap is larger than expected interval
      if (timeDiff > expectedInterval * 1.5) {
        // Allow 50% tolerance
        // Only flag as gap if the range includes market hours
        if (rangeIncludesMarketHours(prevBar.timestamp + expectedInterval, currBar.timestamp - expectedInterval)) {
          gaps.push({
            startTime: prevBar.timestamp + expectedInterval,
            endTime: currBar.timestamp - expectedInterval,
            missingBars: Math.floor(timeDiff / expectedInterval) - 1,
          });
        }
      }
    }

    return gaps;
  }

  /**
   * Get bars from in-memory cache
   */
  private getFromCache(symbol: string, timeframe: string): CachedBars | null {
    const symbolCache = this.cache.get(symbol);
    if (!symbolCache) {
      return null;
    }

    return symbolCache.get(timeframe) || null;
  }

  /**
   * Update in-memory cache
   */
  private updateCache(symbol: string, timeframe: string, bars: Bar[]): void {
    if (!this.cache.has(symbol)) {
      this.cache.set(symbol, new Map());
    }

    const symbolCache = this.cache.get(symbol)!;

    // Cap bars at maxSize to prevent memory bloat
    const cappedBars = bars.length > this.config.maxSize ? bars.slice(-this.config.maxSize) : bars;

    symbolCache.set(timeframe, {
      bars: cappedBars,
      lastFetch: Date.now(),
      ttl: this.config.ttlMs,
    });

    logger.debug(`[BarCacheService] Updated cache for ${symbol} ${timeframe} (${cappedBars.length} bars)`);
  }

  /**
   * Check if we should query TWS for new bars (TTL expired)
   */
  private shouldCheckForNewBars(cached: CachedBars): boolean {
    const timeSinceLastCheck = Date.now() - cached.lastFetch;
    return timeSinceLastCheck > cached.ttl;
  }

  /**
   * Record cache hit for statistics
   */
  private recordCacheHit(symbol: string, timeframe: string): void {
    if (!this.stats.has(symbol)) {
      this.stats.set(symbol, new Map());
    }
    const symbolStats = this.stats.get(symbol)!;

    if (!symbolStats.has(timeframe)) {
      symbolStats.set(timeframe, { hits: 0, misses: 0 });
    }

    const stats = symbolStats.get(timeframe)!;
    stats.hits++;
  }

  /**
   * Record cache miss for statistics
   */
  private recordCacheMiss(symbol: string, timeframe: string): void {
    if (!this.stats.has(symbol)) {
      this.stats.set(symbol, new Map());
    }
    const symbolStats = this.stats.get(symbol)!;

    if (!symbolStats.has(timeframe)) {
      symbolStats.set(timeframe, { hits: 0, misses: 0 });
    }

    const stats = symbolStats.get(timeframe)!;
    stats.misses++;
  }

  /**
   * Get cache statistics for monitoring
   */
  async getCacheStats(): Promise<CacheStats[]> {
    const statsArray: CacheStats[] = [];

    for (const [symbol, symbolCache] of this.cache.entries()) {
      for (const [timeframe, cached] of symbolCache.entries()) {
        const symbolStats = this.stats.get(symbol)?.get(timeframe) || { hits: 0, misses: 0 };
        const totalRequests = symbolStats.hits + symbolStats.misses;
        const hitRate = totalRequests > 0 ? (symbolStats.hits / totalRequests) * 100 : 0;

        const oldestBar = cached.bars.length > 0 ? cached.bars[0].timestamp : 0;
        const newestBar = cached.bars.length > 0 ? cached.bars[cached.bars.length - 1].timestamp : 0;

        // Rough estimate of memory usage (8 bytes per number * 6 fields per bar)
        const memoryBytes = cached.bars.length * 6 * 8;

        statsArray.push({
          symbol,
          timeframe,
          barCount: cached.bars.length,
          oldestBar,
          newestBar,
          cacheHits: symbolStats.hits,
          cacheMisses: symbolStats.misses,
          hitRate,
          lastAccess: cached.lastFetch,
          memoryBytes,
        });
      }
    }

    return statsArray;
  }

  /**
   * Clear cache for a specific symbol/timeframe (or all if not specified)
   */
  clearCache(symbol?: string, timeframe?: string): void {
    if (!symbol) {
      this.cache.clear();
      this.stats.clear();
      logger.info('[BarCacheService] Cleared all cache');
      return;
    }

    if (!timeframe) {
      this.cache.delete(symbol);
      this.stats.delete(symbol);
      logger.info(`[BarCacheService] Cleared cache for ${symbol}`);
      return;
    }

    const symbolCache = this.cache.get(symbol);
    if (symbolCache) {
      symbolCache.delete(timeframe);
      logger.info(`[BarCacheService] Cleared cache for ${symbol} ${timeframe}`);
    }

    const symbolStats = this.stats.get(symbol);
    if (symbolStats) {
      symbolStats.delete(timeframe);
    }
  }

  /**
   * Alias for clearCache() without arguments
   * Clears all caches for all symbols and timeframes
   */
  clearAllCaches(): void {
    this.clearCache();
  }
}
