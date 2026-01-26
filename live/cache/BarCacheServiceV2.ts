/**
 * Bar Cache Service V2
 * New implementation using the improved getBars system
 *
 * Key improvements:
 * - Explicit session (rth/all) and what (trades/midpoint/bid/ask) parameters
 * - Better RTH gap handling (doesn't treat overnight as missing data)
 * - Simpler cache logic with automatic window expansion
 * - UPSERT pattern for deduplication
 * - Bar alignment guarantees
 */

import { Pool } from 'pg';
import type { Bar as LegacyBar } from '../../spec/types';
import { getBars, type GetBarsParams, type IbkrConfig, type Period, type Session, type What } from '../../broker/marketData';
import { LoggerFactory } from '../../logging/logger';

const logger = LoggerFactory.getLogger('BarCacheServiceV2');

export interface BarCacheConfigV2 {
  enabled: boolean;
  session: Session; // 'rth' | 'all'
  what: What;       // 'trades' | 'midpoint' | 'bid' | 'ask'
}

export class BarCacheServiceV2 {
  private pool: Pool;
  private ibkr: IbkrConfig;
  private config: BarCacheConfigV2;

  constructor(
    pool: Pool,
    ibkrConfig: Partial<IbkrConfig> = {},
    config: Partial<BarCacheConfigV2> = {}
  ) {
    this.pool = pool;

    // Load IBKR config from environment with defaults
    this.ibkr = {
      host: ibkrConfig.host || process.env.TWS_HOST || '127.0.0.1',
      port: ibkrConfig.port || parseInt(process.env.TWS_PORT || '7497', 10),
      clientId:
        ibkrConfig.clientId ||
        parseInt(process.env.TWS_CLIENT_ID || '2000', 10) +
          Math.floor(Math.random() * 1000),
    };

    // Load config from environment with defaults
    this.config = {
      enabled: config.enabled ?? process.env.BAR_CACHE_ENABLED === 'true',
      session: (config.session || process.env.BAR_CACHE_SESSION || 'rth') as Session,
      what: (config.what || process.env.BAR_CACHE_WHAT || 'trades') as What,
    };

    logger.info('[BarCacheServiceV2] Initialized', {
      ibkr: this.ibkr,
      config: this.config,
    });
  }

  /**
   * Convert timeframe string to Period enum
   * Maps various formats to standard periods
   */
  private mapTimeframeToPeriod(timeframe: string): Period {
    const normalized = timeframe.toLowerCase().trim();

    // Map common variations
    const mapping: Record<string, Period> = {
      '5m': '5m',
      '5min': '5m',
      '5mins': '5m',
      '15m': '15m',
      '15min': '15m',
      '15mins': '15m',
      '1h': '1h',
      '1hour': '1h',
      '60m': '1h',
      '60min': '1h',
      '1d': '1d',
      '1day': '1d',
      'daily': '1d',
    };

    const period = mapping[normalized];
    if (!period) {
      logger.warn(`[BarCacheServiceV2] Unknown timeframe: ${timeframe}, defaulting to 5m`);
      return '5m';
    }

    return period;
  }

  /**
   * Convert new Bar format (ISO timestamp) to legacy Bar format (Unix ms)
   */
  private convertToLegacyBar(bar: { t: string; o: number; h: number; l: number; c: number; v: number }): LegacyBar {
    return {
      timestamp: new Date(bar.t).getTime(),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    };
  }

  /**
   * Get bars for a symbol/timeframe
   * Main entry point compatible with old BarCacheService interface
   */
  async getBars(
    symbol: string,
    timeframe: string,
    limit: number,
    options: {
      forceRefresh?: boolean;
      session?: 'rth' | 'all';
      what?: 'trades' | 'midpoint' | 'bid' | 'ask';
      end?: string;
      includeForming?: boolean;
    } = {}
  ): Promise<LegacyBar[]> {
    const startTime = Date.now();

    // Check if cache is disabled
    if (!this.config.enabled) {
      logger.debug(`[BarCacheServiceV2] Cache disabled, fetching from IBKR directly`);
      // Fall back to direct IBKR fetch (implement if needed)
      throw new Error('Cache disabled mode not yet implemented in V2');
    }

    // Map timeframe to period
    const period = this.mapTimeframeToPeriod(timeframe);

    // Use per-request parameters if provided, otherwise fall back to config defaults
    const session = options.session || this.config.session;
    const what = options.what || this.config.what;
    const end = options.end || 'now';

    logger.debug('[BarCacheServiceV2] Getting bars', {
      symbol,
      timeframe,
      period,
      limit,
      session,
      what,
      end,
    });

    // Use new getBars system
    const result = await getBars({
      pool: this.pool,
      ibkr: this.ibkr,
      symbol,
      period,
      limit,
      session,
      what,
      end,
      includeForming: options.includeForming || false,
    });

    // Convert to legacy format
    const legacyBars = result.bars.map((bar) => this.convertToLegacyBar(bar));

    const duration = Date.now() - startTime;
    logger.info('[BarCacheServiceV2] Retrieved bars', {
      symbol,
      timeframe,
      period,
      count: legacyBars.length,
      source: result.meta.source,
      durationMs: duration,
    });

    return legacyBars;
  }

  /**
   * Clear cache for a specific symbol/timeframe
   * In V2, this is a no-op since we have no in-memory cache
   * The database is the source of truth
   */
  clearCache(symbol?: string, timeframe?: string): void {
    logger.debug('[BarCacheServiceV2] clearCache called (no-op in V2)', {
      symbol,
      timeframe,
    });
  }

  /**
   * Get cache statistics
   * In V2, return database statistics instead
   */
  async getCacheStats(symbol: string, timeframe: string): Promise<{
    barCount: number;
    oldestBar: number;
    newestBar: number;
  } | null> {
    const period = this.mapTimeframeToPeriod(timeframe);

    const query = `
      SELECT
        COUNT(*) as bar_count,
        MIN(barstart) as oldest,
        MAX(barstart) as newest
      FROM bars
      WHERE symbol = $1 AND period = $2 AND what = $3 AND session = $4
    `;

    const result = await this.pool.query(query, [
      symbol,
      period,
      this.config.what,
      this.config.session,
    ]);

    if (!result.rows[0] || result.rows[0].bar_count === '0') {
      return null;
    }

    const row = result.rows[0];
    return {
      barCount: parseInt(row.bar_count, 10),
      oldestBar: new Date(row.oldest).getTime(),
      newestBar: new Date(row.newest).getTime(),
    };
  }

  /**
   * Clear all caches
   * In V2, optionally truncate the bars table (dangerous!)
   */
  async clearAllCaches(truncateDb: boolean = false): Promise<void> {
    if (truncateDb) {
      logger.warn('[BarCacheServiceV2] Truncating bars table');
      await this.pool.query('TRUNCATE TABLE bars');
    } else {
      logger.debug('[BarCacheServiceV2] clearAllCaches called (no-op unless truncateDb=true)');
    }
  }
}
