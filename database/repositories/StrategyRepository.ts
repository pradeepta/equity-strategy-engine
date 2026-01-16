/**
 * Strategy Repository
 * Handles all database operations for strategies including versioning and lifecycle
 */

import { PrismaClient, Strategy, StrategyStatus, StrategyVersion, VersionChangeType } from '@prisma/client';

export class StrategyRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create new strategy (DRAFT status by default)
   */
  async create(params: {
    userId: string;
    accountId?: string;
    symbol: string;
    name: string;
    timeframe: string;
    yamlContent: string;
    description?: string;
    status?: StrategyStatus;
  }): Promise<Strategy> {
    return this.prisma.strategy.create({
      data: {
        ...params,
        status: params.status || 'DRAFT',
      },
    });
  }

  /**
   * Create strategy with initial version (recommended for new strategies)
   */
  async createWithVersion(params: {
    userId: string;
    accountId?: string;
    symbol: string;
    name: string;
    timeframe: string;
    yamlContent: string;
    description?: string;
    changeReason?: string;
  }): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      // Create strategy
      const strategy = await tx.strategy.create({
        data: {
          userId: params.userId,
          accountId: params.accountId,
          symbol: params.symbol,
          name: params.name,
          timeframe: params.timeframe,
          yamlContent: params.yamlContent,
          description: params.description,
          status: 'DRAFT',
        },
      });

      // Create initial version
      await tx.strategyVersion.create({
        data: {
          strategyId: strategy.id,
          versionNumber: 1,
          yamlContent: params.yamlContent,
          name: params.name,
          timeframe: params.timeframe,
          description: params.description,
          changeReason: params.changeReason || 'Initial version',
          changeType: 'CREATED',
        },
      });

      return strategy;
    });
  }

  /**
   * Find active strategies for a user
   */
  async findActiveByUser(userId: string): Promise<Strategy[]> {
    return this.prisma.strategy.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      orderBy: { activatedAt: 'desc' },
    });
  }

  /**
   * Find strategy by symbol (active only)
   */
  async findActiveBySymbol(userId: string, symbol: string): Promise<Strategy | null> {
    return this.prisma.strategy.findFirst({
      where: {
        userId,
        symbol,
        status: 'ACTIVE',
        deletedAt: null,
      },
    });
  }

  /**
   * Find pending strategies (ready to load)
   */
  async findPending(userId: string): Promise<Strategy[]> {
    return this.prisma.strategy.findMany({
      where: {
        userId,
        status: 'PENDING',
        deletedAt: null,
      },
      orderBy: { updatedAt: 'asc' },
    });
  }

  /**
   * Find strategy by ID
   */
  async findById(strategyId: string): Promise<Strategy | null> {
    return this.prisma.strategy.findUnique({
      where: { id: strategyId },
    });
  }

  /**
   * Update strategy YAML content and create new version
   */
  async updateYaml(
    strategyId: string,
    yamlContent: string,
    changeReason: string,
    changeType: VersionChangeType = 'MANUAL_EDIT'
  ): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      // Get strategy
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

      // Get next version number
      const lastVersion = await tx.strategyVersion.findFirst({
        where: { strategyId },
        orderBy: { versionNumber: 'desc' },
      });
      const nextVersion = (lastVersion?.versionNumber || 0) + 1;

      // Create new version
      await tx.strategyVersion.create({
        data: {
          strategyId,
          versionNumber: nextVersion,
          yamlContent,
          name: strategy.name,
          timeframe: strategy.timeframe,
          description: strategy.description,
          changeReason,
          changeType,
        },
      });

      // Update strategy
      return tx.strategy.update({
        where: { id: strategyId },
        data: { yamlContent },
      });
    });
  }

  /**
   * Activate strategy (DRAFT/PENDING -> ACTIVE)
   */
  async activate(strategyId: string): Promise<Strategy> {
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: {
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
  }

  /**
   * Close strategy (ACTIVE -> CLOSED)
   */
  async close(strategyId: string, reason?: string): Promise<Strategy> {
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closeReason: reason,
      },
    });
  }

  /**
   * Archive strategy (any status -> ARCHIVED)
   */
  async archive(strategyId: string, reason?: string): Promise<Strategy> {
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        closeReason: reason,
      },
    });
  }

  /**
   * Mark strategy as failed (validation/compilation error)
   */
  async markFailed(strategyId: string, error: string): Promise<Strategy> {
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: {
        status: 'FAILED',
        closeReason: error,
      },
    });
  }

  /**
   * Get version history for a strategy
   */
  async getVersionHistory(strategyId: string): Promise<StrategyVersion[]> {
    return this.prisma.strategyVersion.findMany({
      where: { strategyId },
      orderBy: { versionNumber: 'desc' },
    });
  }

  /**
   * Rollback to specific version
   */
  async rollbackToVersion(strategyId: string, versionNumber: number): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      // Get the target version
      const version = await tx.strategyVersion.findUniqueOrThrow({
        where: {
          strategyId_versionNumber: {
            strategyId,
            versionNumber,
          },
        },
      });

      // Get next version number
      const lastVersion = await tx.strategyVersion.findFirst({
        where: { strategyId },
        orderBy: { versionNumber: 'desc' },
      });
      const nextVersion = (lastVersion?.versionNumber || 0) + 1;

      // Create new version (rollback is a new version)
      await tx.strategyVersion.create({
        data: {
          strategyId,
          versionNumber: nextVersion,
          yamlContent: version.yamlContent,
          name: version.name,
          timeframe: version.timeframe,
          description: version.description,
          changeReason: `Rollback to version ${versionNumber}`,
          changeType: 'ROLLBACK',
        },
      });

      // Update strategy with rolled-back content
      return tx.strategy.update({
        where: { id: strategyId },
        data: {
          yamlContent: version.yamlContent,
          name: version.name,
          timeframe: version.timeframe,
          description: version.description,
        },
      });
    });
  }

  /**
   * Soft delete strategy
   */
  async softDelete(strategyId: string): Promise<Strategy> {
    return this.prisma.strategy.update({
      where: { id: strategyId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Find strategy by ID with all related data (versions, executions, evaluations, orders)
   */
  async findByIdWithRelations(strategyId: string) {
    return this.prisma.strategy.findUnique({
      where: { id: strategyId },
      include: {
        versions: { orderBy: { versionNumber: 'desc' }, take: 10 },
        executions: { orderBy: { createdAt: 'desc' }, take: 20 },
        evaluations: { orderBy: { createdAt: 'desc' }, take: 10 },
        orders: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
  }

  /**
   * Get all strategies for a user (including closed/archived)
   */
  async findAllByUser(userId: string): Promise<Strategy[]> {
    return this.prisma.strategy.findMany({
      where: {
        userId,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Get strategies by status
   */
  async findByStatus(userId: string, status: StrategyStatus): Promise<Strategy[]> {
    return this.prisma.strategy.findMany({
      where: {
        userId,
        status,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
