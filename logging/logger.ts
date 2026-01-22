/**
 * Centralized Logger Service
 * Uses Winston with multiple transports (Console + PostgreSQL)
 */

import winston from 'winston';
import { PrismaClient } from '@prisma/client';
import { PrismaTransport } from './PrismaTransport';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom format for console output
const consoleFormat = printf(({ level, message, timestamp, component, ...meta }) => {
  const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
  const componentStr = component ? `[${component}]` : '';
  return `${timestamp} ${level} ${componentStr} ${message} ${metaStr}`;
});

export interface LoggerOptions {
  component: string;
  prisma?: PrismaClient;
  enableConsole?: boolean;
  enableDatabase?: boolean;
  enableFile?: boolean;
  logFilePath?: string;
  logLevel?: string;
}

export class Logger {
  private logger: winston.Logger;
  private component: string;

  constructor(options: LoggerOptions) {
    this.component = options.component;

    const transports: any[] = [];

    // Console transport (always enabled unless explicitly disabled)
    if (options.enableConsole !== false) {
      transports.push(
        new winston.transports.Console({
          format: combine(
            colorize(),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            errors({ stack: true }),
            consoleFormat
          ),
        })
      );
    }

    // PostgreSQL transport via Prisma
    if (options.enableDatabase !== false && options.prisma) {
      transports.push(
        new PrismaTransport({
          prisma: options.prisma,
          component: options.component,
        })
      );
    }

    // File transport (optional, for stdio mode where stderr isn't visible)
    if (options.enableFile && options.logFilePath) {
      transports.push(
        new winston.transports.File({
          filename: options.logFilePath,
          format: combine(
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            errors({ stack: true }),
            winston.format.json()
          ),
        })
      );
    }

    this.logger = winston.createLogger({
      level: options.logLevel || process.env.LOG_LEVEL || 'info',
      format: combine(
        timestamp(),
        errors({ stack: true }),
        winston.format.json()
      ),
      transports,
      exitOnError: false,
    });
  }

  debug(message: string, meta?: Record<string, any>) {
    this.logger.debug(message, { component: this.component, ...meta });
  }

  info(message: string, meta?: Record<string, any>) {
    this.logger.info(message, { component: this.component, ...meta });
  }

  warn(message: string, meta?: Record<string, any>) {
    this.logger.warn(message, { component: this.component, ...meta });
  }

  error(message: string, error?: Error | any, meta?: Record<string, any>) {
    const errorMeta: Record<string, any> = { component: this.component, ...meta };

    if (error) {
      if (error instanceof Error) {
        errorMeta.stackTrace = error.stack;
        errorMeta.errorCode = error.name;
      } else if (typeof error === 'object') {
        errorMeta.errorDetails = error;
      }
    }

    this.logger.error(message, errorMeta);
  }

  // Convenience methods for strategy-related logs
  logStrategy(level: 'info' | 'warn' | 'error', message: string, strategyId: string, meta?: Record<string, any>) {
    this.logger[level](message, {
      component: this.component,
      strategyId,
      ...meta,
    });
  }

  // Convenience methods for order-related logs
  logOrder(level: 'info' | 'warn' | 'error', message: string, orderId: string, meta?: Record<string, any>) {
    this.logger[level](message, {
      component: this.component,
      orderId,
      ...meta,
    });
  }

  close() {
    this.logger.close();
  }
}

// Singleton factory for creating loggers
class LoggerFactory {
  private static prisma: PrismaClient | null = null;
  private static loggers: Map<string, Logger> = new Map();

  static setPrisma(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  static getLogger(component: string, options?: Partial<LoggerOptions>): Logger {
    if (!this.loggers.has(component)) {
      this.loggers.set(
        component,
        new Logger({
          component,
          prisma: this.prisma || undefined,
          ...options,
        })
      );
    }
    return this.loggers.get(component)!;
  }

  static closeAll() {
    this.loggers.forEach((logger) => logger.close());
    this.loggers.clear();
  }
}

export { LoggerFactory };
