/**
 * Cache-specific types for Bar Caching System
 */

import type { Bar } from '../../spec/types';

/**
 * Cached bars with metadata
 */
export interface CachedBars {
  bars: Bar[];           // Sorted by timestamp ascending
  lastFetch: number;     // Timestamp (ms) of last TWS fetch
  ttl: number;           // Cache TTL in milliseconds
}

/**
 * Detected gap in bar data
 */
export interface Gap {
  startTime: number;     // Timestamp (ms) of first missing bar
  endTime: number;       // Timestamp (ms) of last missing bar
  missingBars: number;   // Count of missing bars
}

/**
 * Time range for missing data (gaps, old data, new data)
 */
export interface TimeRange {
  startTime: number;     // Timestamp (ms) of range start
  endTime: number;       // Timestamp (ms) of range end
  reason: 'gap' | 'old' | 'new'; // Why this range is missing
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  symbol: string;
  timeframe: string;
  barCount: number;
  oldestBar: number;     // Timestamp (ms)
  newestBar: number;     // Timestamp (ms)
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;       // Percentage (0-100)
  lastAccess: number;    // Timestamp (ms)
  memoryBytes: number;   // Estimated memory usage
}

/**
 * Cache configuration
 */
export interface BarCacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxSize: number;
  retentionDays: number;
  lazyLoad: boolean;
  multiTimeframe: boolean;
  gapDetection: boolean;
  gapBackfill: boolean;
  gapThreshold: number;  // Percentage (0-100)
  logStatsInterval: number;
}

/**
 * Bar fetch options
 */
export interface BarFetchOptions {
  symbol: string;
  timeframe: string;
  limit: number;
  forceRefresh?: boolean;  // Bypass cache
  detectGaps?: boolean;    // Run gap detection
  backfillGaps?: boolean;  // Automatically backfill gaps
}

/**
 * TWS bar fetcher function type
 * Used by BarCacheService to fetch bars from TWS without managing connections
 */
export type TwsBarFetcher = (symbol: string, timeframe: string, limit: number) => Promise<Bar[]>;
