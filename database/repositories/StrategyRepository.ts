/**
 * Strategy Repository
 * Handles all database operations for strategies including versioning and lifecycle
 */

import { PrismaClient, Strategy, StrategyStatus, StrategyVersion, VersionChangeType, Prisma } from '@prisma/client';

export class StrategyRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create strategy audit log entry
   */
  async createAuditLog(params: {
    strategyId: string;
    eventType: 'CREATED' | 'ACTIVATED' | 'CLOSED' | 'ARCHIVED' | 'FAILED' | 'YAML_UPDATED' | 'ROLLED_BACK' | 'SWAPPED_IN' | 'SWAPPED_OUT' | 'DELETED' | 'STATUS_CHANGED';
    oldStatus?: StrategyStatus;
    newStatus?: StrategyStatus;
    changedBy?: string;
    changeReason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.strategyAuditLog.create({
      data: {
        ...params,
        metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

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

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId: strategy.id,
          eventType: 'CREATED',
          newStatus: 'DRAFT',
          changedBy: params.userId,
          changeReason: params.changeReason || 'Initial version',
          metadata: {
            symbol: params.symbol,
            name: params.name,
            timeframe: params.timeframe,
          } as Prisma.InputJsonValue,
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

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType: 'YAML_UPDATED',
          oldStatus: strategy.status,
          newStatus: strategy.status,
          changedBy: strategy.userId,
          changeReason,
          metadata: {
            versionNumber: nextVersion,
            changeType,
          } as Prisma.InputJsonValue,
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
  async activate(
    strategyId: string,
    changedBy: string = 'system',
    options?: {
      isSwap?: boolean;
      replacedStrategyId?: string;
      swapReason?: string;
      evaluationScore?: number;
    }
  ): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

      // Determine event type and reason based on context
      const eventType = options?.isSwap ? 'SWAPPED_IN' : 'ACTIVATED';
      const changeReason = options?.isSwap
        ? `Swapped in: ${options.swapReason || 'Replacing strategy'}`
        : 'Strategy activated by orchestrator';

      // Build metadata
      const metadata: Record<string, unknown> | undefined = options?.isSwap
        ? {
            replacedStrategyId: options.replacedStrategyId,
            evaluationScore: options.evaluationScore,
          }
        : undefined;

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType,
          oldStatus: strategy.status,
          newStatus: 'ACTIVE',
          changedBy,
          changeReason,
          metadata: metadata as Prisma.InputJsonValue | undefined,
        },
      });

      // Update strategy
      return tx.strategy.update({
        where: { id: strategyId },
        data: {
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });
    });
  }

  /**
   * Close strategy (ACTIVE -> CLOSED)
   */
  async close(
    strategyId: string,
    reason?: string,
    changedBy: string = 'system',
    options?: {
      isSwap?: boolean;
      newStrategyId?: string;
      evaluationScore?: number;
    }
  ): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

      // Determine event type based on context
      const eventType = options?.isSwap ? 'SWAPPED_OUT' : 'CLOSED';
      const changeReason = options?.isSwap
        ? `Swapped out: ${reason || 'Replaced by better strategy'}`
        : reason || 'Strategy closed';

      // Build metadata
      const metadata: Record<string, unknown> | undefined = options?.isSwap
        ? {
            swapReason: reason,
            newStrategyId: options.newStrategyId,
            evaluationScore: options.evaluationScore,
          }
        : undefined;

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType,
          oldStatus: strategy.status,
          newStatus: 'CLOSED',
          changedBy,
          changeReason,
          metadata: metadata as Prisma.InputJsonValue | undefined,
        },
      });

      // Update strategy
      return tx.strategy.update({
        where: { id: strategyId },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closeReason: reason,
        },
      });
    });
  }

  /**
   * Reopen closed strategy (CLOSED -> PENDING)
   */
  async reopen(strategyId: string, reason?: string, changedBy: string = 'user'): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

      if (strategy.status !== 'CLOSED') {
        throw new Error('Only CLOSED strategies can be reopened');
      }

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType: 'STATUS_CHANGED',
          oldStatus: strategy.status,
          newStatus: 'PENDING',
          changedBy,
          changeReason: reason || 'Strategy reopened via UI',
        },
      });

      // Update strategy to PENDING (orchestrator will pick it up)
      return tx.strategy.update({
        where: { id: strategyId },
        data: {
          status: 'PENDING',
          closedAt: null,
          closeReason: null,
        },
      });
    });
  }

  /**
   * Archive strategy (any status -> ARCHIVED)
   */
  async archive(strategyId: string, reason?: string, changedBy: string = 'system'): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType: 'ARCHIVED',
          oldStatus: strategy.status,
          newStatus: 'ARCHIVED',
          changedBy,
          changeReason: reason || 'Strategy archived',
        },
      });

      // Update strategy
      return tx.strategy.update({
        where: { id: strategyId },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          closeReason: reason,
        },
      });
    });
  }

  /**
   * Mark strategy as failed (validation/compilation error)
   */
  async markFailed(strategyId: string, error: string, changedBy: string = 'system'): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType: 'FAILED',
          oldStatus: strategy.status,
          newStatus: 'FAILED',
          changedBy,
          changeReason: error,
        },
      });

      // Update strategy
      return tx.strategy.update({
        where: { id: strategyId },
        data: {
          status: 'FAILED',
          closeReason: error,
        },
      });
    });
  }

  /**
   * Update runtime state (called by orchestrator on FSM state transitions)
   * This allows API server to read current FSM state without orchestrator dependency
   */
  async updateRuntimeState(strategyId: string, runtimeState: string): Promise<void> {
    await this.prisma.strategy.update({
      where: { id: strategyId },
      data: { runtimeState },
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
  async rollbackToVersion(strategyId: string, versionNumber: number, changedBy: string = 'system'): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      // Get the current strategy
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

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

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType: 'ROLLED_BACK',
          oldStatus: strategy.status,
          newStatus: strategy.status,
          changedBy,
          changeReason: `Rolled back to version ${versionNumber}`,
          metadata: {
            targetVersionNumber: versionNumber,
            newVersionNumber: nextVersion,
          } as Prisma.InputJsonValue,
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
  async softDelete(strategyId: string, changedBy: string = 'system'): Promise<Strategy> {
    return this.prisma.$transaction(async (tx) => {
      const strategy = await tx.strategy.findUniqueOrThrow({
        where: { id: strategyId },
      });

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId,
          eventType: 'DELETED',
          oldStatus: strategy.status,
          newStatus: strategy.status,
          changedBy,
          changeReason: 'Strategy soft deleted',
        },
      });

      // Soft delete
      return tx.strategy.update({
        where: { id: strategyId },
        data: { deletedAt: new Date() },
      });
    });
  }

  /**
   * Get audit log for a strategy
   */
  async getAuditLog(strategyId: string, limit: number = 100) {
    return this.prisma.strategyAuditLog.findMany({
      where: { strategyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get all audit logs (for admin/debugging)
   */
  async getAllAuditLogs(limit: number = 100) {
    return this.prisma.strategyAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Create force deploy audit entry
   * Records manual entry trigger for audit trail
   */
  async createForceDeployAudit(params: {
    strategyId: string;
    changedBy: string;
    reason: string;
    metadata?: {
      currentState: string;
      currentPrice: number;
      orderPlanId: string;
      barTimestamp: number;
    };
  }): Promise<void> {
    await this.prisma.strategyAuditLog.create({
      data: {
        strategyId: params.strategyId,
        eventType: 'FORCE_DEPLOYED',
        oldStatus: undefined,
        newStatus: undefined,
        changedBy: params.changedBy,
        changeReason: params.reason,
        metadata: params.metadata as Prisma.InputJsonValue | undefined,
      },
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

  /**
   * Get or create MANUAL strategy for a symbol
   * Used by reconciliation service to import orphaned orders from TWS
   */
  async getOrCreateManualStrategy(params: {
    symbol: string;
    userId: string;
    accountId?: string;
  }): Promise<Strategy> {
    const manualStrategyName = `MANUAL_${params.symbol}`;

    // Try to find existing MANUAL strategy for this symbol
    const existing = await this.prisma.strategy.findFirst({
      where: {
        name: manualStrategyName,
        symbol: params.symbol,
        isManual: true,
        deletedAt: null,
      },
    });

    if (existing) {
      return existing;
    }

    // Create new MANUAL strategy
    const placeholderYaml = `# SYSTEM GENERATED - DO NOT EDIT
# This strategy is a container for manually placed orders imported from TWS
# Status: ARCHIVED (never executed by orchestrator)
# Purpose: Track manual orders detected during broker reconciliation

meta:
  name: "${manualStrategyName}"
  symbol: "${params.symbol}"
  timeframe: "1d"
  description: "System-generated placeholder for manually placed orders imported from TWS"

# No features, rules, or states - this is a data container only
# Orders under this strategy were placed directly in TWS, not through automation
`;

    return this.prisma.$transaction(async (tx) => {
      // Create MANUAL strategy with ARCHIVED status
      // Note: accountId is optional since MANUAL strategies may not be associated with a specific account
      const createData: any = {
        userId: params.userId,
        symbol: params.symbol,
        name: manualStrategyName,
        timeframe: '1d',
        yamlContent: placeholderYaml,
        description: 'System-generated placeholder for manually placed orders imported from TWS',
        status: 'ARCHIVED', // Won't be loaded by orchestrator
        isManual: true, // Flag for filtering
      };

      // Only include accountId if it's provided and not empty (avoids FK constraint errors)
      if (params.accountId && params.accountId.trim().length > 0) {
        createData.accountId = params.accountId;
      }

      const strategy = await tx.strategy.create({
        data: createData,
      });

      // Create initial version
      await tx.strategyVersion.create({
        data: {
          strategyId: strategy.id,
          versionNumber: 1,
          yamlContent: placeholderYaml,
          name: manualStrategyName,
          timeframe: '1d',
          description: 'System-generated placeholder for manual orders',
          changeReason: 'Auto-created by reconciliation service',
          changeType: 'CREATED',
        },
      });

      // Create audit log entry
      await tx.strategyAuditLog.create({
        data: {
          strategyId: strategy.id,
          eventType: 'CREATED',
          newStatus: 'ARCHIVED',
          changedBy: 'system:reconciliation',
          changeReason: `Auto-created MANUAL strategy for ${params.symbol} to import orphaned orders from TWS`,
        },
      });

      return strategy;
    });
  }
}
