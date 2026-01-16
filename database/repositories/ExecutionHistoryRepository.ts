/**
 * Execution History Repository
 * Handles logging of strategy executions, evaluations, and lifecycle events
 */

import { PrismaClient, StrategyExecution, StrategyEvaluation, ExecutionEventType, EvaluationRecommendation } from '@prisma/client';

export class ExecutionHistoryRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Log execution event
   */
  async logEvent(params: {
    strategyId: string;
    eventType: ExecutionEventType;
    currentState?: string;
    barsProcessed?: number;
    openOrderCount?: number;
    oldVersionId?: string;
    newVersionId?: string;
    swapReason?: string;
    currentPrice?: number;
    currentVolume?: bigint;
    barTimestamp?: Date;
    metadata?: any;
  }): Promise<StrategyExecution> {
    return this.prisma.strategyExecution.create({
      data: params,
    });
  }

  /**
   * Log swap operation
   */
  async logSwap(
    strategyId: string,
    oldVersionId: string,
    newVersionId: string,
    reason: string
  ): Promise<StrategyExecution> {
    return this.logEvent({
      strategyId,
      eventType: 'SWAP',
      oldVersionId,
      newVersionId,
      swapReason: reason,
    });
  }

  /**
   * Log activation
   */
  async logActivation(strategyId: string): Promise<StrategyExecution> {
    return this.logEvent({
      strategyId,
      eventType: 'ACTIVATED',
    });
  }

  /**
   * Log deactivation
   */
  async logDeactivation(strategyId: string, reason?: string): Promise<StrategyExecution> {
    return this.logEvent({
      strategyId,
      eventType: 'DEACTIVATED',
      swapReason: reason,
    });
  }

  /**
   * Log evaluation
   */
  async logEvaluation(params: {
    strategyId: string;
    portfolioValue?: number;
    unrealizedPnL?: number;
    realizedPnL?: number;
    currentBar?: any;
    recentBars?: any;
    recommendation: EvaluationRecommendation;
    confidence: number;
    reason: string;
    suggestedYaml?: string;
    suggestedName?: string;
    suggestedReasoning?: string;
  }): Promise<StrategyEvaluation> {
    return this.prisma.strategyEvaluation.create({
      data: params,
    });
  }

  /**
   * Mark evaluation action as taken
   */
  async markActionTaken(evaluationId: string, result: string): Promise<StrategyEvaluation> {
    return this.prisma.strategyEvaluation.update({
      where: { id: evaluationId },
      data: {
        actionTaken: true,
        actionResult: result,
      },
    });
  }

  /**
   * Get execution history
   */
  async getHistory(strategyId: string, limit: number = 100): Promise<StrategyExecution[]> {
    return this.prisma.strategyExecution.findMany({
      where: { strategyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get evaluation history
   */
  async getEvaluations(strategyId: string, limit: number = 50): Promise<StrategyEvaluation[]> {
    return this.prisma.strategyEvaluation.findMany({
      where: { strategyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get swap history
   */
  async getSwapHistory(strategyId: string): Promise<StrategyExecution[]> {
    return this.prisma.strategyExecution.findMany({
      where: {
        strategyId,
        eventType: 'SWAP',
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get recent evaluations by recommendation type
   */
  async getEvaluationsByRecommendation(
    strategyId: string,
    recommendation: EvaluationRecommendation,
    limit: number = 20
  ): Promise<StrategyEvaluation[]> {
    return this.prisma.strategyEvaluation.findMany({
      where: {
        strategyId,
        recommendation,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Get evaluation statistics
   */
  async getEvaluationStats(strategyId: string) {
    const evaluations = await this.prisma.strategyEvaluation.groupBy({
      by: ['recommendation'],
      where: { strategyId },
      _count: true,
      _avg: {
        confidence: true,
      },
    });

    return evaluations.reduce(
      (acc, item) => {
        acc[item.recommendation] = {
          count: item._count,
          avgConfidence: item._avg.confidence || 0,
        };
        return acc;
      },
      {} as Record<string, { count: number; avgConfidence: number }>
    );
  }

  /**
   * Get latest evaluation for a strategy
   */
  async getLatestEvaluation(strategyId: string): Promise<StrategyEvaluation | null> {
    return this.prisma.strategyEvaluation.findFirst({
      where: { strategyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get execution events by type
   */
  async getEventsByType(strategyId: string, eventType: ExecutionEventType): Promise<StrategyExecution[]> {
    return this.prisma.strategyExecution.findMany({
      where: {
        strategyId,
        eventType,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
