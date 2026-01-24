/**
 * Bar Cache Monitor
 * Monitors cache performance and handles database cleanup
 */

import type { BarRepository } from '../../database/repositories/BarRepository';
import { LoggerFactory } from '../../logging/logger';

const logger = LoggerFactory.getLogger('BarCacheMonitor');

// Define a minimal interface that both BarCacheService and BarCacheServiceV2 can satisfy
interface CacheService {
  clearCache(symbol?: string, timeframe?: string): void;
  getCacheStats(symbol?: string, timeframe?: string): Promise<any>;
}

export class BarCacheMonitor {
  private config: {
    retentionDays: number;
    logStatsInterval: number;
  };

  private statsIntervalId: NodeJS.Timeout | null = null;

  constructor(
    private barRepo: BarRepository,
    private cacheService: CacheService,
    config: Partial<{ retentionDays: number; logStatsInterval: number }> = {}
  ) {
    this.config = {
      retentionDays: config.retentionDays || parseInt(process.env.BAR_RETENTION_DAYS || '365', 10),
      logStatsInterval: config.logStatsInterval || parseInt(process.env.BAR_CACHE_LOG_STATS_INTERVAL || '3600000', 10),
    };

    logger.info('[BarCacheMonitor] Initialized', { config: this.config });
  }

  /**
   * Start periodic monitoring
   */
  start(): void {
    if (this.statsIntervalId) {
      logger.warn('[BarCacheMonitor] Monitor already running');
      return;
    }

    logger.info('[BarCacheMonitor] Starting periodic monitoring', {
      intervalMs: this.config.logStatsInterval,
    });

    this.statsIntervalId = setInterval(async () => {
      try {
        await this.logStats();
        await this.cleanupDatabase();
      } catch (error) {
        logger.error('[BarCacheMonitor] Error in monitoring loop', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, this.config.logStatsInterval);

    // Log stats immediately on start
    this.logStats().catch((error) => {
      logger.error('[BarCacheMonitor] Failed to log initial stats', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Stop periodic monitoring
   */
  stop(): void {
    if (this.statsIntervalId) {
      clearInterval(this.statsIntervalId);
      this.statsIntervalId = null;
      logger.info('[BarCacheMonitor] Stopped periodic monitoring');
    }
  }

  /**
   * Log cache statistics
   * Note: BarCacheServiceV2 doesn't have in-memory cache stats like V1
   */
  async logStats(): Promise<void> {
    try {
      const stats = await this.cacheService.getCacheStats();

      // Check if this is the old BarCacheService (returns array) or new V2 (returns single object or null)
      if (Array.isArray(stats)) {
        // Old BarCacheService behavior
        if (stats.length === 0) {
          logger.info('[BarCacheMonitor] No cache entries');
          return;
        }

        // Calculate aggregate statistics
        const totalBars = stats.reduce((sum: number, s: any) => sum + s.barCount, 0);
        const totalMemoryBytes = stats.reduce((sum: number, s: any) => sum + s.memoryBytes, 0);
        const totalMemoryMB = (totalMemoryBytes / (1024 * 1024)).toFixed(2);

        const totalHits = stats.reduce((sum: number, s: any) => sum + s.cacheHits, 0);
        const totalMisses = stats.reduce((sum: number, s: any) => sum + s.cacheMisses, 0);
        const totalRequests = totalHits + totalMisses;
        const overallHitRate = totalRequests > 0 ? ((totalHits / totalRequests) * 100).toFixed(2) : '0.00';

        logger.info('[BarCacheMonitor] Cache Statistics', {
          cacheEntries: stats.length,
          totalBars,
          totalMemoryMB,
          totalRequests,
          cacheHits: totalHits,
          cacheMisses: totalMisses,
          hitRate: `${overallHitRate}%`,
        });

        // Log top 5 most active cache entries
        const topEntries = stats
          .sort((a: any, b: any) => b.cacheHits + b.cacheMisses - (a.cacheHits + a.cacheMisses))
          .slice(0, 5);

        logger.info('[BarCacheMonitor] Top 5 Most Active Cache Entries', {
          entries: topEntries.map((s: any) => ({
            symbol: s.symbol,
            timeframe: s.timeframe,
            barCount: s.barCount,
            hitRate: `${s.hitRate.toFixed(2)}%`,
            requests: s.cacheHits + s.cacheMisses,
          })),
        });

        // Warn if hit rate is low
        if (parseFloat(overallHitRate) < 70 && totalRequests > 100) {
          logger.warn('[BarCacheMonitor] Low cache hit rate detected', {
            hitRate: `${overallHitRate}%`,
            totalRequests,
            recommendation: 'Consider increasing BAR_CACHE_TTL_MS or reviewing access patterns',
          });
        }

        // Warn if memory usage is high
        const memoryMB = parseFloat(totalMemoryMB);
        if (memoryMB > 500) {
          logger.warn('[BarCacheMonitor] High memory usage detected', {
            memoryMB,
            recommendation: 'Consider reducing BAR_CACHE_MAX_SIZE or clearing old cache entries',
          });
        }
      } else {
        // BarCacheServiceV2 behavior - no in-memory cache stats
        logger.debug('[BarCacheMonitor] BarCacheServiceV2 has no in-memory cache stats, skipping');
      }
    } catch (error) {
      logger.error('[BarCacheMonitor] Failed to log cache stats', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cleanup old bars from database based on retention policy
   */
  async cleanupDatabase(): Promise<void> {
    try {
      const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
      const cutoffTimestamp = Date.now() - retentionMs;

      logger.info('[BarCacheMonitor] Starting database cleanup', {
        retentionDays: this.config.retentionDays,
        cutoffDate: new Date(cutoffTimestamp).toISOString(),
      });

      // Delete bars older than retention period (for all symbols/timeframes)
      const deletedCount = await this.barRepo.deleteOldBars(null, null, cutoffTimestamp);

      if (deletedCount > 0) {
        logger.info('[BarCacheMonitor] Database cleanup completed', {
          deletedBars: deletedCount,
          retentionDays: this.config.retentionDays,
        });
      } else {
        logger.debug('[BarCacheMonitor] Database cleanup: no old bars to delete');
      }
    } catch (error) {
      logger.error('[BarCacheMonitor] Failed to cleanup database', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get database storage statistics
   */
  async getDatabaseStats(): Promise<{
    symbolTimeframes: Array<{ symbol: string; timeframe: string; barCount: number }>;
    totalBars: number;
  }> {
    try {
      const symbolTimeframes = await this.barRepo.getAllSymbolTimeframes();

      // Get bar counts for each symbol/timeframe combination
      const results = await Promise.all(
        symbolTimeframes.map(async (st) => ({
          symbol: st.symbol,
          timeframe: st.timeframe,
          barCount: await this.barRepo.getBarCount(st.symbol, st.timeframe),
        }))
      );

      const totalBars = results.reduce((sum, r) => sum + r.barCount, 0);

      return {
        symbolTimeframes: results,
        totalBars,
      };
    } catch (error) {
      logger.error('[BarCacheMonitor] Failed to get database stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { symbolTimeframes: [], totalBars: 0 };
    }
  }

  /**
   * Log database storage statistics
   */
  async logDatabaseStats(): Promise<void> {
    try {
      const dbStats = await this.getDatabaseStats();

      logger.info('[BarCacheMonitor] Database Storage Statistics', {
        totalSymbolTimeframes: dbStats.symbolTimeframes.length,
        totalBars: dbStats.totalBars,
        symbolTimeframes: dbStats.symbolTimeframes.slice(0, 10), // Top 10
      });
    } catch (error) {
      logger.error('[BarCacheMonitor] Failed to log database stats', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clear cache entries that haven't been accessed recently
   * Note: Only works with old BarCacheService, V2 has no in-memory cache
   * @param inactiveDurationMs Clear entries not accessed in this duration (default: 1 hour)
   */
  async evictInactiveEntries(inactiveDurationMs: number = 3600000): Promise<number> {
    try {
      const stats = await this.cacheService.getCacheStats();

      // Only works with old BarCacheService
      if (!Array.isArray(stats)) {
        logger.debug('[BarCacheMonitor] BarCacheServiceV2 has no in-memory cache to evict');
        return 0;
      }

      const now = Date.now();
      let evictedCount = 0;

      for (const stat of stats) {
        const timeSinceAccess = now - stat.lastAccess;
        if (timeSinceAccess > inactiveDurationMs) {
          this.cacheService.clearCache(stat.symbol, stat.timeframe);
          evictedCount++;
          logger.debug('[BarCacheMonitor] Evicted inactive cache entry', {
            symbol: stat.symbol,
            timeframe: stat.timeframe,
            timeSinceAccessMs: timeSinceAccess,
          });
        }
      }

      if (evictedCount > 0) {
        logger.info('[BarCacheMonitor] Evicted inactive cache entries', {
          evictedCount,
          inactiveDurationMs,
        });
      }

      return evictedCount;
    } catch (error) {
      logger.error('[BarCacheMonitor] Failed to evict inactive entries', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
