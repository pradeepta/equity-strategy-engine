/**
 * Custom Winston Transport for PostgreSQL via Prisma
 * Stores logs in the SystemLog table
 */

import Transport from 'winston-transport';
import { PrismaClient, LogLevel } from '@prisma/client';

interface LogEntry {
  level: string;
  message: string;
  component?: string;
  strategyId?: string;
  orderId?: string;
  stackTrace?: string;
  errorCode?: string;
  metadata?: any;
  timestamp?: string;
}

export class PrismaTransport extends Transport {
  private prisma: PrismaClient;
  private component: string;

  constructor(opts: any = {}) {
    super(opts);
    this.prisma = opts.prisma || new PrismaClient();
    this.component = opts.component || 'system';
  }

  log(info: LogEntry, callback: () => void) {
    setImmediate(() => {
      this.emit('logged', info);
    });

    // Map Winston log levels to Prisma LogLevel enum
    const levelMap: Record<string, LogLevel> = {
      error: LogLevel.ERROR,
      warn: LogLevel.WARN,
      info: LogLevel.INFO,
      debug: LogLevel.DEBUG,
      verbose: LogLevel.DEBUG,
      silly: LogLevel.DEBUG,
    };

    const prismaLevel = levelMap[info.level] || LogLevel.INFO;

    // Extract metadata and special fields
    const {
      level,
      message,
      component,
      strategyId,
      orderId,
      stackTrace,
      errorCode,
      timestamp,
      ...metadata
    } = info;

    // Create log entry in database (BLOCKING - wait for DB write)
    const mergedMetadata = {
      ...metadata,
      strategyId,
      orderId,
      stackTrace,
      errorCode,
    };
    const hasMetadata = Object.keys(mergedMetadata).length > 0;
    this.prisma.systemLog
      .create({
        data: {
          level: prismaLevel,
          component: component || this.component,
          message: message || '',
          metadata: hasMetadata ? mergedMetadata : undefined,
        },
      })
      .then(() => {
        // Call callback only after successful DB write
        callback();
      })
      .catch((err) => {
        // Log errors to console to avoid losing logs if DB fails
        console.error('[PrismaTransport] Failed to write log to database:', err);
        // Still call callback to avoid blocking Winston
        callback();
      });
  }

  async close() {
    await this.prisma.$disconnect();
  }
}
