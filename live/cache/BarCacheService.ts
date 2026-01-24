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
import type { CachedBars, TimeRange, BarCacheConfig, CacheStats } from './types';
import { TwsMarketDataClient } from '../../broker/twsMarketData';
import { IbkrWebClient } from '../../broker/ibkrWebClient';
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
  private ibkrWebClient: IbkrWebClient;
  private provider: 'ibkr_web' | 'tws';

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

    this.provider = (process.env.BAR_CACHE_PROVIDER || 'ibkr_web') as 'ibkr_web' | 'tws';

    // Initialize TWS client
    const twsHost = process.env.TWS_HOST || '127.0.0.1';
    const twsPort = parseInt(process.env.TWS_PORT || '7497', 10);
    const baseClientId = parseInt(
      process.env.TWS_CLIENT_ID_BASE || process.env.TWS_CLIENT_ID || '2000',
      10
    );
    const jitter = Math.floor(Math.random() * 1000);
    const twsClientId = baseClientId + (process.pid % 1000) + jitter;
    this.twsClient = new TwsMarketDataClient(twsHost, twsPort, twsClientId);

    // Initialize IBKR Web API client
    this.ibkrWebClient = new IbkrWebClient();

    logger.info('[BarCacheService] Initialized with config', {
      config: this.config,
      twsClientId,
      provider: this.provider,
    });
  }

  /**
   * Get bars for a symbol/timeframe
   * Main entry point for all bar requests
   *
   * Refactored approach:
   * 1. Check in-memory cache first
   * 2. Query database for existing bars
   * 3. Identify ALL missing data (gaps, old data, new data)
   * 4. Fill ALL missing ranges with minimal API calls
   * 5. Merge, persist, cache, and return
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
      logger.debug(`[BarCacheService] Cache disabled, fetching from provider directly`);
      return await this.fetchFromProvider(symbol, timeframe, limit, null);
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

    // Step 2: Query database for existing bars
    const dbBars = await this.barRepo.getRecentBars(symbol, timeframe, limit * 2);
    logger.debug(`[BarCacheService] Retrieved ${dbBars.length} bars from DB for ${symbol} ${timeframe}`);

    // Step 3: Identify ALL missing data ranges
    const detectGaps = options.detectGaps ?? this.config.gapDetection;
    const backfillGaps = options.backfillGaps ?? this.config.gapBackfill;

    const missingRanges = this.identifyMissingData(dbBars, timeframe, limit, {
      detectGaps,
      backfillGaps,
    });

    if (missingRanges.length > 0) {
      logger.info(
        `[BarCacheService] Identified ${missingRanges.length} missing range(s) for ${symbol} ${timeframe}`,
        {
          symbol,
          timeframe,
          ranges: missingRanges.map((r) => ({
            reason: r.reason,
            startTime: new Date(r.startTime).toISOString(),
            endTime: new Date(r.endTime).toISOString(),
          })),
        }
      );
    }

    // Step 4: Fill ALL missing ranges with minimal API calls
    const filledBars = await this.fillMissingRanges(symbol, timeframe, missingRanges);

    // Step 5: Persist filled bars (bulk insert with deduplication)
    if (filledBars.length > 0) {
      await this.barRepo.insertBars(symbol, timeframe, filledBars);
      logger.info(`[BarCacheService] Persisted ${filledBars.length} filled bars`, {
        symbol,
        timeframe,
        source: this.provider,
      });
    }

    // Step 6: Merge, sort, and cache
    const allBars = this.mergeBars(dbBars, filledBars).slice(-limit);
    this.updateCache(symbol, timeframe, allBars);

    const duration = Date.now() - startTime;
    logger.info(
      `[BarCacheService] Cache MISS resolved for ${symbol} ${timeframe} (${allBars.length} bars) in ${duration}ms`,
      {
        symbol,
        timeframe,
        dbBars: dbBars.length,
        filledBars: filledBars.length,
        totalBars: allBars.length,
        durationMs: duration,
      }
    );

    return allBars;
  }

  /**
   * Identify ALL missing data ranges (gaps, old data, new data)
   * Returns array of time ranges to fill
   */
  private identifyMissingData(
    dbBars: Bar[],
    timeframe: string,
    limit: number,
    options: { detectGaps: boolean; backfillGaps: boolean }
  ): TimeRange[] {
    const ranges: TimeRange[] = [];
    const intervalMs = getTimeframeMs(timeframe);
    const now = Date.now();

    // If no bars exist, fetch full range
    if (dbBars.length === 0) {
      const barsPerDay = timeframe.endsWith('d') ? 1 : (6.5 * 60 * 60 * 1000) / intervalMs;
      const daysNeeded = Math.ceil(limit / barsPerDay) + 1;
      const startTime = now - daysNeeded * 24 * 60 * 60 * 1000;

      ranges.push({
        startTime,
        endTime: now,
        reason: 'old',
      });

      return ranges;
    }

    const oldestBar = dbBars[0];
    const newestBar = dbBars[dbBars.length - 1];

    // Check for missing OLD bars (before earliest bar)
    const expectedBars = limit;
    if (dbBars.length < expectedBars) {
      const missingOldBars = expectedBars - dbBars.length;
      const missingOldMs = missingOldBars * intervalMs;
      const oldStartTime = oldestBar.timestamp - missingOldMs;

      ranges.push({
        startTime: oldStartTime,
        endTime: oldestBar.timestamp - intervalMs,
        reason: 'old',
      });
    }

    // Check for GAPS between existing bars (if enabled)
    if (options.detectGaps && options.backfillGaps && dbBars.length >= 2) {
      for (let i = 1; i < dbBars.length; i++) {
        const prevBar = dbBars[i - 1];
        const currBar = dbBars[i];
        const timeDiff = currBar.timestamp - prevBar.timestamp;

        // Check if gap is larger than expected interval
        if (timeDiff > intervalMs * 1.5) {
          // Allow 50% tolerance
          // Only flag as gap if the range includes market hours
          if (rangeIncludesMarketHours(prevBar.timestamp + intervalMs, currBar.timestamp - intervalMs)) {
            ranges.push({
              startTime: prevBar.timestamp + intervalMs,
              endTime: currBar.timestamp - intervalMs,
              reason: 'gap',
            });
          }
        }
      }
    }

    // Check for missing NEW bars (after latest bar)
    const timeSinceLastBar = now - newestBar.timestamp;

    // DIAGNOSTIC: Log if newest bar is in the future
    if (timeSinceLastBar < 0) {
      logger.warn(
        `[BarCacheService] Newest bar timestamp is in the future (${timeframe})`,
        {
          newestBarTimestamp: newestBar.timestamp,
          newestBarTime: new Date(newestBar.timestamp).toISOString(),
          now,
          currentTime: new Date(now).toISOString(),
          timeSinceLastBar: Math.floor(timeSinceLastBar / 60000) + ' minutes',
        }
      );
    }

    if (timeSinceLastBar > intervalMs * 1.5) {
      // Allow 50% tolerance
      ranges.push({
        startTime: newestBar.timestamp + intervalMs,
        endTime: now,
        reason: 'new',
      });
    }

    return ranges;
  }

  /**
   * Fill ALL missing ranges with minimal API calls
   * Merges adjacent ranges to reduce API calls
   */
  private async fillMissingRanges(
    symbol: string,
    timeframe: string,
    ranges: TimeRange[]
  ): Promise<Bar[]> {
    if (ranges.length === 0) {
      return [];
    }

    // Merge overlapping/adjacent ranges to minimize API calls
    const mergedRanges = this.mergeTimeRanges(ranges, timeframe);

    logger.debug(
      `[BarCacheService] Merged ${ranges.length} ranges into ${mergedRanges.length} API calls for ${symbol} ${timeframe}`
    );

    // Fetch bars for each merged range
    const allFilledBars: Bar[] = [];

    for (const range of mergedRanges) {
      try {
        const intervalMs = getTimeframeMs(timeframe);
        const rangeMs = range.endTime - range.startTime;
        const expectedBars = Math.ceil(rangeMs / intervalMs);
        const daysInRange = Math.ceil(rangeMs / (24 * 60 * 60 * 1000)) + 1;

        logger.debug(
          `[BarCacheService] Fetching bars for range: ${new Date(range.startTime).toISOString()} to ${new Date(range.endTime).toISOString()}`,
          { symbol, timeframe, daysInRange, expectedBars, reason: range.reason }
        );

        // Fetch bars and filter to range
        const barsPerDay = timeframe.endsWith('d') ? 1 : (6.5 * 60 * 60 * 1000) / intervalMs;
        const limit = Math.ceil(daysInRange * barsPerDay);
        const allBars = await this.fetchFromProvider(symbol, timeframe, limit, null);
        const barsInRange = allBars.filter((bar) => bar.timestamp >= range.startTime && bar.timestamp <= range.endTime);

        logger.debug(
          `[BarCacheService] Fetched ${allBars.length} bars, filtered to ${barsInRange.length} bars in range`,
          {
            symbol,
            timeframe,
            totalBars: allBars.length,
            barsInRange: barsInRange.length,
            expectedBars,
          }
        );

        allFilledBars.push(...barsInRange);
      } catch (error) {
        logger.error(`[BarCacheService] Failed to fill range`, {
          symbol,
          timeframe,
          range,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other ranges even if one fails
      }
    }

    return allFilledBars;
  }

  /**
   * Merge overlapping or adjacent time ranges to minimize API calls
   */
  private mergeTimeRanges(ranges: TimeRange[], timeframe: string): TimeRange[] {
    if (ranges.length === 0) {
      return [];
    }

    // Sort by start time
    const sorted = [...ranges].sort((a, b) => a.startTime - b.startTime);

    const intervalMs = getTimeframeMs(timeframe);
    const merged: TimeRange[] = [];
    let current = { ...sorted[0] };

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];

      // Check if ranges overlap or are adjacent (within 2 intervals)
      if (next.startTime <= current.endTime + intervalMs * 2) {
        // Merge: extend current range
        current.endTime = Math.max(current.endTime, next.endTime);
      } else {
        // No overlap: push current and start new range
        merged.push(current);
        current = { ...next };
      }
    }

    // Push final range
    merged.push(current);

    return merged;
  }

  /**
   * Merge database bars with filled bars, remove duplicates, and sort
   */
  private mergeBars(dbBars: Bar[], filledBars: Bar[]): Bar[] {
    // Combine all bars
    const allBars = [...dbBars, ...filledBars];

    // Remove duplicates by timestamp (keep first occurrence)
    const uniqueBars = new Map<number, Bar>();
    for (const bar of allBars) {
      if (!uniqueBars.has(bar.timestamp)) {
        uniqueBars.set(bar.timestamp, bar);
      }
    }

    // Sort by timestamp ascending
    return Array.from(uniqueBars.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Fetch bars from TWS API
   * @param afterTimestamp If provided, only fetch bars newer than this timestamp
   */
  private async fetchFromProvider(
    symbol: string,
    timeframe: string,
    limit: number,
    afterTimestamp: number | null
  ): Promise<Bar[]> {
    if (this.provider === 'ibkr_web') {
      return this.fetchFromIbkrWeb(symbol, timeframe, limit, afterTimestamp);
    }
    return this.fetchFromTWS(symbol, timeframe, limit, afterTimestamp);
  }

  private async fetchFromIbkrWeb(
    symbol: string,
    timeframe: string,
    limit: number,
    afterTimestamp: number | null
  ): Promise<Bar[]> {
    try {
      const intervalMs = getTimeframeMs(timeframe);
      const barsPerDay = timeframe.endsWith('d') ? 1 : (6.5 * 60 * 60 * 1000) / intervalMs;
      const daysNeeded = Math.ceil(limit / barsPerDay) + 1;
      const period = `${daysNeeded}d`;
      const barSize = this.convertTimeframeToIbkrBar(timeframe);

      logger.debug(`[BarCacheService] Fetching from IBKR Web`, {
        symbol,
        timeframe,
        limit,
        period,
        barSize,
        afterTimestamp: afterTimestamp ? new Date(afterTimestamp).toISOString() : null,
      });

      const allBars = await this.ibkrWebClient.getHistoricalBars(symbol, {
        period,
        barSize,
        outsideRth: true,
      });

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
      logger.error(`[BarCacheService] Failed to fetch bars from IBKR Web`, {
        symbol,
        timeframe,
        limit,
        afterTimestamp,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

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

  private convertTimeframeToIbkrBar(timeframe: string): string {
    const tf = timeframe.toLowerCase();
    const mapping: Record<string, string> = {
      '1m': '1min',
      '5m': '5min',
      '15m': '15min',
      '30m': '30min',
      '1h': '1h',
      '1d': '1d',
      '1day': '1d',
    };
    return mapping[tf] || '1d';
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
