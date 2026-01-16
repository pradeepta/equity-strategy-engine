/**
 * Repository Factory
 * Provides centralized access to all repositories with shared PrismaClient instance
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { StrategyRepository } from './repositories/StrategyRepository';
import { OrderRepository } from './repositories/OrderRepository';
import { ExecutionHistoryRepository } from './repositories/ExecutionHistoryRepository';
import { SystemLogRepository } from './repositories/SystemLogRepository';

export class RepositoryFactory {
  private prisma: PrismaClient;
  private strategyRepo?: StrategyRepository;
  private orderRepo?: OrderRepository;
  private execHistoryRepo?: ExecutionHistoryRepository;
  private systemLogRepo?: SystemLogRepository;
  private pool?: Pool;

  constructor(prisma?: PrismaClient) {
    if (prisma) {
      this.prisma = prisma;
    } else {
      // Create PostgreSQL connection pool
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
      });

      // Create Prisma adapter
      const adapter = new PrismaPg(this.pool);

      // Initialize Prisma with adapter
      this.prisma = new PrismaClient({
        adapter,
        log: ['error', 'warn'],
      });
    }
  }

  /**
   * Get Strategy Repository instance (singleton per factory)
   */
  getStrategyRepo(): StrategyRepository {
    if (!this.strategyRepo) {
      this.strategyRepo = new StrategyRepository(this.prisma);
    }
    return this.strategyRepo;
  }

  /**
   * Get Order Repository instance (singleton per factory)
   */
  getOrderRepo(): OrderRepository {
    if (!this.orderRepo) {
      this.orderRepo = new OrderRepository(this.prisma);
    }
    return this.orderRepo;
  }

  /**
   * Get Execution History Repository instance (singleton per factory)
   */
  getExecutionHistoryRepo(): ExecutionHistoryRepository {
    if (!this.execHistoryRepo) {
      this.execHistoryRepo = new ExecutionHistoryRepository(this.prisma);
    }
    return this.execHistoryRepo;
  }

  /**
   * Get System Log Repository instance (singleton per factory)
   */
  getSystemLogRepo(): SystemLogRepository {
    if (!this.systemLogRepo) {
      this.systemLogRepo = new SystemLogRepository(this.prisma);
    }
    return this.systemLogRepo;
  }

  /**
   * Get the underlying PrismaClient instance
   */
  getPrisma(): PrismaClient {
    return this.prisma;
  }

  /**
   * Get the PostgreSQL connection pool
   * Required for services that need direct pool access (e.g., DistributedLockService)
   */
  getPool(): Pool {
    if (!this.pool) {
      throw new Error('Pool not available - RepositoryFactory was initialized with external PrismaClient');
    }
    return this.pool;
  }

  /**
   * Disconnect Prisma client and pool
   */
  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * Check database connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      console.error('Database health check failed:', error);
      return false;
    }
  }
}

// Export singleton factory instance
let factoryInstance: RepositoryFactory | undefined;

export function getRepositoryFactory(): RepositoryFactory {
  if (!factoryInstance) {
    factoryInstance = new RepositoryFactory();
  }
  return factoryInstance;
}

// Export individual repository getters for convenience
export function getStrategyRepo(): StrategyRepository {
  return getRepositoryFactory().getStrategyRepo();
}

export function getOrderRepo(): OrderRepository {
  return getRepositoryFactory().getOrderRepo();
}

export function getExecutionHistoryRepo(): ExecutionHistoryRepository {
  return getRepositoryFactory().getExecutionHistoryRepo();
}

export function getSystemLogRepo(): SystemLogRepository {
  return getRepositoryFactory().getSystemLogRepo();
}
