/**
 * Bar Repository
 * Handles all database operations for market bar caching
 */

import { PrismaClient, MarketBar } from '@prisma/client';
import type { Bar } from '../../spec/types';
import { LoggerFactory } from '../../logging/logger';

const logger = LoggerFactory.getLogger('BarRepository');

export class BarRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Bulk insert bars with conflict resolution (deduplication)
   * Uses ON CONFLICT DO NOTHING to handle duplicate timestamps
   *
   * @returns Number of bars actually inserted (not skipped due to conflicts)
   */
  async insertBars(symbol: string, timeframe: string, bars: Bar[]): Promise<number> {
    if (bars.length === 0) {
      return 0;
    }

    const startTime = Date.now();

    try {
      // Use raw SQL for better control over ON CONFLICT behavior
      const values = bars
        .map((bar) => {
          return `('${symbol}', '${timeframe}', ${bar.timestamp}, ${bar.open}, ${bar.high}, ${bar.low}, ${bar.close}, ${bar.volume})`;
        })
        .join(',\n  ');

      const query = `
        INSERT INTO market_bars (symbol, timeframe, timestamp, open, high, low, close, volume)
        VALUES ${values}
        ON CONFLICT (symbol, timeframe, timestamp) DO NOTHING
        RETURNING id;
      `;

      const result = await this.prisma.$queryRawUnsafe<{ id: number }[]>(query);
      const insertedCount = result.length;

      const duration = Date.now() - startTime;
      logger.debug(
        `[BarRepository] Inserted ${insertedCount}/${bars.length} bars for ${symbol} ${timeframe} in ${duration}ms`,
        {
          symbol,
          timeframe,
          attempted: bars.length,
          inserted: insertedCount,
          skipped: bars.length - insertedCount,
          durationMs: duration,
        }
      );

      return insertedCount;
    } catch (error) {
      logger.error(`[BarRepository] Failed to insert bars for ${symbol} ${timeframe}`, {
        symbol,
        timeframe,
        barCount: bars.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get bars within a specific time range
   *
   * @param symbol Stock symbol
   * @param timeframe Bar timeframe (e.g., "5m", "1h", "1d")
   * @param startTime Start timestamp (ms) inclusive
   * @param endTime End timestamp (ms) inclusive
   * @returns Array of bars sorted by timestamp ascending
   */
  async getBars(
    symbol: string,
    timeframe: string,
    startTime: number,
    endTime: number
  ): Promise<Bar[]> {
    const startTimeMs = Date.now();

    try {
      const dbBars = await this.prisma.marketBar.findMany({
        where: {
          symbol,
          timeframe,
          timestamp: {
            gte: BigInt(startTime),
            lte: BigInt(endTime),
          },
        },
        orderBy: {
          timestamp: 'asc',
        },
      });

      const bars = this.mapToBar(dbBars);

      const duration = Date.now() - startTimeMs;
      logger.debug(
        `[BarRepository] Retrieved ${bars.length} bars for ${symbol} ${timeframe} in ${duration}ms`,
        {
          symbol,
          timeframe,
          startTime,
          endTime,
          barCount: bars.length,
          durationMs: duration,
        }
      );

      return bars;
    } catch (error) {
      logger.error(`[BarRepository] Failed to retrieve bars for ${symbol} ${timeframe}`, {
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
   * Get the most recent N bars
   *
   * @param symbol Stock symbol
   * @param timeframe Bar timeframe
   * @param limit Number of bars to retrieve
   * @returns Array of bars sorted by timestamp ascending
   */
  async getRecentBars(symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
    const startTime = Date.now();

    try {
      const dbBars = await this.prisma.marketBar.findMany({
        where: {
          symbol,
          timeframe,
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: limit,
      });

      // Reverse to get ascending order
      const bars = this.mapToBar(dbBars.reverse());

      const duration = Date.now() - startTime;
      logger.debug(
        `[BarRepository] Retrieved ${bars.length} recent bars for ${symbol} ${timeframe} in ${duration}ms`,
        {
          symbol,
          timeframe,
          limit,
          barCount: bars.length,
          durationMs: duration,
        }
      );

      return bars;
    } catch (error) {
      logger.error(`[BarRepository] Failed to retrieve recent bars for ${symbol} ${timeframe}`, {
        symbol,
        timeframe,
        limit,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get timestamp of the latest bar for a symbol/timeframe
   * Used for incremental fetching
   *
   * @returns Latest timestamp in milliseconds, or null if no bars exist
   */
  async getLatestBarTimestamp(symbol: string, timeframe: string): Promise<number | null> {
    try {
      const result = await this.prisma.marketBar.findFirst({
        where: {
          symbol,
          timeframe,
        },
        orderBy: {
          timestamp: 'desc',
        },
        select: {
          timestamp: true,
        },
      });

      return result ? Number(result.timestamp) : null;
    } catch (error) {
      logger.error(`[BarRepository] Failed to get latest timestamp for ${symbol} ${timeframe}`, {
        symbol,
        timeframe,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete bars older than a specific timestamp (for retention policy)
   *
   * @param symbol Stock symbol (optional, if provided deletes only for this symbol)
   * @param timeframe Timeframe (optional, if provided deletes only for this timeframe)
   * @param beforeTimestamp Delete bars older than this timestamp (ms)
   * @returns Number of bars deleted
   */
  async deleteOldBars(
    symbol: string | null,
    timeframe: string | null,
    beforeTimestamp: number
  ): Promise<number> {
    const startTime = Date.now();

    try {
      const whereClause: {
        symbol?: string;
        timeframe?: string;
        timestamp: { lt: bigint };
      } = {
        timestamp: {
          lt: BigInt(beforeTimestamp),
        },
      };

      if (symbol) {
        whereClause.symbol = symbol;
      }
      if (timeframe) {
        whereClause.timeframe = timeframe;
      }

      const result = await this.prisma.marketBar.deleteMany({
        where: whereClause,
      });

      const duration = Date.now() - startTime;
      logger.info(
        `[BarRepository] Deleted ${result.count} old bars in ${duration}ms`,
        {
          symbol,
          timeframe,
          beforeTimestamp,
          deletedCount: result.count,
          durationMs: duration,
        }
      );

      return result.count;
    } catch (error) {
      logger.error('[BarRepository] Failed to delete old bars', {
        symbol,
        timeframe,
        beforeTimestamp,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get count of bars for a symbol/timeframe
   * Used for monitoring and statistics
   */
  async getBarCount(symbol: string, timeframe: string): Promise<number> {
    try {
      return await this.prisma.marketBar.count({
        where: {
          symbol,
          timeframe,
        },
      });
    } catch (error) {
      logger.error(`[BarRepository] Failed to get bar count for ${symbol} ${timeframe}`, {
        symbol,
        timeframe,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get all unique symbol/timeframe combinations in the database
   * Used for cache monitoring and cleanup
   */
  async getAllSymbolTimeframes(): Promise<Array<{ symbol: string; timeframe: string }>> {
    try {
      const result = await this.prisma.marketBar.findMany({
        select: {
          symbol: true,
          timeframe: true,
        },
        distinct: ['symbol', 'timeframe'],
      });

      return result;
    } catch (error) {
      logger.error('[BarRepository] Failed to get all symbol/timeframes', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Map database MarketBar records to Bar type
   */
  private mapToBar(dbBars: MarketBar[]): Bar[] {
    return dbBars.map((dbBar) => ({
      timestamp: Number(dbBar.timestamp),
      open: dbBar.open,
      high: dbBar.high,
      low: dbBar.low,
      close: dbBar.close,
      volume: dbBar.volume,
    }));
  }
}
