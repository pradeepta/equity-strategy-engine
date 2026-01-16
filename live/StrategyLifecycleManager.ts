/**
 * Strategy Lifecycle Manager
 * Orchestrates strategy evaluation, swapping, and database operations
 * Updated to use repositories instead of filesystem
 */

import { StrategyInstance } from './StrategyInstance';
import { MultiStrategyManager } from './MultiStrategyManager';
import { StrategyEvaluatorClient } from '../evaluation/StrategyEvaluatorClient';
import { PortfolioDataFetcher } from '../broker/twsPortfolio';
import { EvaluationRequest, EvaluationResponse } from '../evaluation/types';
import { StrategyRepository } from '../database/repositories/StrategyRepository';
import { ExecutionHistoryRepository } from '../database/repositories/ExecutionHistoryRepository';
import { OperationQueueService } from './queue/OperationQueueService';

export class StrategyLifecycleManager {
  private multiStrategyManager: MultiStrategyManager;
  private evaluatorClient: StrategyEvaluatorClient;
  private portfolioFetcher: PortfolioDataFetcher;
  private strategyRepo: StrategyRepository;
  private execHistoryRepo: ExecutionHistoryRepository;
  private operationQueue: OperationQueueService;
  private orchestrator?: any;  // Reference to orchestrator for locking

  constructor(
    manager: MultiStrategyManager,
    evaluator: StrategyEvaluatorClient,
    portfolio: PortfolioDataFetcher,
    strategyRepo: StrategyRepository,
    execHistoryRepo: ExecutionHistoryRepository,
    operationQueue: OperationQueueService
  ) {
    this.multiStrategyManager = manager;
    this.evaluatorClient = evaluator;
    this.portfolioFetcher = portfolio;
    this.strategyRepo = strategyRepo;
    this.execHistoryRepo = execHistoryRepo;
    this.operationQueue = operationQueue;
  }

  /**
   * Set orchestrator reference for locking during swaps
   */
  setOrchestrator(orchestrator: any): void {
    this.orchestrator = orchestrator;
  }

  /**
   * Evaluate strategy appropriateness
   */
  async evaluateStrategy(instance: StrategyInstance): Promise<void> {
    console.log(`🔍 Evaluating strategy: ${instance.strategyName} for ${instance.symbol}`);

    try {
      // Fetch portfolio snapshot
      const portfolio = await this.portfolioFetcher.getPortfolioSnapshot();

      // Get strategy state
      const state = instance.getState();
      const performance = instance.getPerformanceMetrics();
      const recentBars = instance.getBarHistory(20);

      if (!state.currentBar) {
        console.warn('No current bar available for evaluation');
        return;
      }

      // Build evaluation request
      const request: EvaluationRequest = {
        timestamp: Date.now(),
        portfolio: portfolio,
        currentStrategy: {
          symbol: instance.symbol,
          name: instance.strategyName,
          timeframe: instance.getTimeframe(),
          state: state.currentState,
          yamlContent: instance.getYamlContent(),
        },
        marketData: {
          symbol: instance.symbol,
          currentBar: state.currentBar,
          recentBars: recentBars,
        },
        performance: {
          barsActive: performance.barsActive,
          ordersPlaced: performance.ordersPlaced,
          currentState: state.currentState,
        },
      };

      // Send to evaluation endpoint
      const response = await this.evaluatorClient.evaluate(request);

      console.log(`📊 Evaluation result for ${instance.symbol}:`);
      console.log(`   Recommendation: ${response.recommendation}`);
      console.log(`   Confidence: ${(response.confidence * 100).toFixed(0)}%`);
      console.log(`   Reason: ${response.reason}`);

      // Handle recommendation
      if (response.recommendation === 'swap') {
        await this.handleSwapRecommendation(instance, response);
      } else if (response.recommendation === 'close') {
        await this.handleCloseRecommendation(instance, response);
      }

      // Reset evaluation counter
      instance.resetEvaluationCounter();
    } catch (error) {
      console.error(`Error evaluating strategy for ${instance.symbol}:`, error);
    }
  }

  /**
   * Handle swap recommendation
   */
  private async handleSwapRecommendation(
    instance: StrategyInstance,
    response: EvaluationResponse
  ): Promise<void> {
    console.log(`🔄 Swapping strategy for ${instance.symbol}...`);

    const state = instance.getState();
    const suggestedHash = response.suggestedStrategy
      ? this.hashString(response.suggestedStrategy.yamlContent)
      : 'none';

    // Enqueue swap operation for idempotency and retry
    const operationId = await this.operationQueue.enqueue({
      operationType: 'SWAP_STRATEGY',
      targetSymbol: instance.symbol,
      strategyId: instance.strategyId,
      priority: 1, // High priority for swaps
      payload: {
        oldStrategyId: instance.strategyId,
        confidence: response.confidence,
        reason: response.reason,
        suggestedStrategy: response.suggestedStrategy,
      },
      operationId: `swap:${instance.symbol}:${instance.strategyId}:${suggestedHash}`,
    });

    // CRITICAL: Check idempotency BEFORE attempting lock acquisition
    // This prevents unnecessary lock contention when operation already completed
    if (await this.operationQueue.isCompleted(operationId)) {
      const result = await this.operationQueue.getResult(operationId);
      console.log(`✓ Strategy swap already completed (idempotent): ${result?.newStrategyId}`);
      return;
    }

    let operationFailed = false;
    const failOperation = async (message: string): Promise<void> => {
      if (operationFailed) {
        return;
      }
      operationFailed = true;
      await this.operationQueue.fail(operationId, message);
    };

    try {
      // Lock the symbol to prevent concurrent operations (distributed lock)
      // Using 5-second timeout instead of 30 seconds to fail fast on contention
      if (this.orchestrator) {
        const lockAcquired = await this.orchestrator.lockSymbol(instance.symbol);
        if (!lockAcquired) {
          console.warn(`⚠️  Failed to acquire lock for ${instance.symbol}. Another swap is in progress.`);
          // Don't throw - mark as failed and let retry queue handle it
          await failOperation(`Lock acquisition failed - another swap in progress`);
          return; // Exit gracefully instead of throwing
        }
      }

      const oldStrategyId = instance.strategyId;

      // Cancel all open orders - CRITICAL: Verify success before proceeding
      const cancelResult = await instance.cancelAllOrders();

      if (cancelResult.failed.length > 0) {
        const failedIds = cancelResult.failed.map(f => f.orderId).join(', ');
        const reasons = cancelResult.failed.map(f => f.reason).join('; ');
        const errorMsg = `Cannot swap strategy for ${instance.symbol} - failed to cancel orders: ${failedIds}. Reasons: ${reasons}`;
        console.error(`❌ ${errorMsg}`);

        // Log the failed swap attempt
        await this.execHistoryRepo.logEvaluation({
          strategyId: oldStrategyId,
          recommendation: 'SWAP',
          confidence: response.confidence,
          reason: `Swap aborted: ${errorMsg}`,
        });

        // Mark operation as failed
        await failOperation(errorMsg);
        return;
      }

      console.log(`✓ Cancelled ${cancelResult.succeeded.length} orders for ${instance.symbol}`);

      const positionQty = await this.getPositionQuantity(instance.symbol);
      if (positionQty !== 0) {
        console.warn(`⚠️ Active position detected for ${instance.symbol} during swap: ${positionQty}`);
        await this.closePositionAndWait(instance, positionQty);
      }

      // Check for active position
      if (state.currentState === 'MANAGING' || state.openOrders.length > 0) {
        console.warn(`⚠️ Strategy ${instance.symbol} has active position during swap.`);
        console.warn(`📍 Position for ${instance.symbol} may be unmanaged. Monitor manually.`);
      }

      // Deploy new strategy if suggested
      if (!response.suggestedStrategy) {
        const errorMsg = `Swap recommended for ${instance.symbol} but no suggested strategy was provided`;
        console.error(`❌ ${errorMsg}`);
        await this.execHistoryRepo.logEvaluation({
          strategyId: oldStrategyId,
          recommendation: 'SWAP',
          confidence: response.confidence,
          reason: `Swap aborted: ${errorMsg}`,
        });
        await failOperation(errorMsg);
        return;
      }

      // Log evaluation to database
      const evaluation = await this.execHistoryRepo.logEvaluation({
        strategyId: oldStrategyId,
        recommendation: 'SWAP',
        confidence: response.confidence,
        reason: response.reason,
        suggestedYaml: response.suggestedStrategy.yamlContent,
        suggestedName: response.suggestedStrategy.name,
        suggestedReasoning: response.suggestedStrategy.reasoning,
      });

      // Create new strategy in database (DRAFT until swap succeeds)
      const newStrategy = await this.strategyRepo.createWithVersion({
        userId: instance.userId,
        symbol: instance.symbol,
        name: response.suggestedStrategy.name,
        timeframe: instance.getTimeframe(),
        yamlContent: response.suggestedStrategy.yamlContent,
        changeReason: 'Auto-swap by evaluator',
      });

      console.log(`✅ Created new strategy in database: ${newStrategy.id}`);

      try {
        // Swap in MultiStrategyManager (removes old, loads new from database)
        await this.multiStrategyManager.swapStrategyById(instance.symbol, newStrategy.id, {
          skipOrderCancel: true,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`Failed to swap runtime strategy for ${instance.symbol}:`, error);
        await this.strategyRepo.markFailed(newStrategy.id, errorMsg);
        await failOperation(errorMsg);
        return;
      }

      // Activate new strategy only after runtime swap succeeds
      await this.strategyRepo.activate(newStrategy.id);

      // Close old strategy in database after successful swap
      await this.strategyRepo.close(oldStrategyId, response.reason);

      // Mark evaluation action as taken
      await this.execHistoryRepo.markActionTaken(evaluation.id, 'Swapped successfully');

      console.log(`✓ Strategy swap complete for ${instance.symbol}`);

      // Mark operation as completed
      await this.operationQueue.complete(operationId, {
        newStrategyId: newStrategy.id,
        oldStrategyId,
        symbol: instance.symbol,
      });
    } catch (error) {
      console.error(`Failed to swap strategy for ${instance.symbol}:`, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await failOperation(errorMsg);
      throw error;
    } finally {
      // Always unlock the symbol, even if swap failed
      if (this.orchestrator) {
        await this.orchestrator.unlockSymbol(instance.symbol);
      }
    }
  }

  /**
   * Handle close recommendation
   */
  private async handleCloseRecommendation(
    instance: StrategyInstance,
    response: EvaluationResponse
  ): Promise<void> {
    console.log(`❌ Closing strategy for ${instance.symbol}...`);

    const state = instance.getState();

    // Enqueue close operation for idempotency and retry
    const operationId = await this.operationQueue.enqueue({
      operationType: 'CLOSE_STRATEGY',
      targetSymbol: instance.symbol,
      strategyId: instance.strategyId,
      priority: 2, // High priority for closes
      payload: {
        strategyId: instance.strategyId,
        confidence: response.confidence,
        reason: response.reason,
      },
      operationId: `close:${instance.symbol}:${instance.strategyId}`,
    });

    // Check if already completed (idempotency)
    if (await this.operationQueue.isCompleted(operationId)) {
      console.log(`✓ Strategy close already completed (idempotent)`);
      return;
    }

    try {
      // Cancel all open orders
      const cancelResult = await instance.cancelAllOrders();
      if (cancelResult.failed.length > 0) {
        const failedIds = cancelResult.failed.map(f => f.orderId).join(', ');
        const reasons = cancelResult.failed.map(f => f.reason).join('; ');
        const errorMsg = `Cannot close strategy for ${instance.symbol} - failed to cancel orders: ${failedIds}. Reasons: ${reasons}`;
        console.error(`❌ ${errorMsg}`);
        await this.execHistoryRepo.logEvaluation({
          strategyId: instance.strategyId,
          recommendation: 'CLOSE',
          confidence: response.confidence,
          reason: `Close aborted: ${errorMsg}`,
        });
        await this.operationQueue.fail(operationId, errorMsg);
        return;
      }

      const positionQty = await this.getPositionQuantity(instance.symbol);
      if (positionQty !== 0) {
        console.warn(`⚠️ Active position detected for ${instance.symbol} during close: ${positionQty}`);
        await this.closePositionAndWait(instance, positionQty);
      }

      // Log evaluation to database after successful cancellation
      await this.execHistoryRepo.logEvaluation({
        strategyId: instance.strategyId,
        recommendation: 'CLOSE',
        confidence: response.confidence,
        reason: response.reason,
      });

      // Close strategy in database
      await this.strategyRepo.close(instance.strategyId, response.reason);
      console.log(`📦 Strategy closed in database: ${instance.strategyId}`);

      // Log deactivation
      await this.execHistoryRepo.logDeactivation(instance.strategyId, response.reason);

      // Remove from MultiStrategyManager
      await this.multiStrategyManager.removeStrategy(instance.symbol);

      console.log(`✓ Strategy closed for ${instance.symbol}`);

      // Mark operation as completed
      await this.operationQueue.complete(operationId, {
        strategyId: instance.strategyId,
        symbol: instance.symbol,
        closedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`Failed to close strategy for ${instance.symbol}:`, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.operationQueue.fail(operationId, errorMsg);
      throw error;
    }
  }

  /**
   * Simple deterministic hash for idempotency keys
   */
  private hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private async getPositionQuantity(symbol: string): Promise<number> {
    const portfolio = await this.portfolioFetcher.getPortfolioSnapshot(true);
    const position = portfolio.positions.find(p => p.symbol === symbol);
    return position ? position.quantity : 0;
  }

  private async closePositionAndWait(
    instance: StrategyInstance,
    positionQty: number
  ): Promise<void> {
    if (this.orchestrator?.config?.brokerEnv?.dryRun) {
      console.warn(
        `⚠️  Dry-run mode active - skipping market exit for ${instance.symbol} (position ${positionQty})`
      );
      return;
    }

    if (this.orchestrator?.config?.brokerEnv?.allowLiveOrders === false) {
      throw new Error(
        `Live orders disabled - cannot close position for ${instance.symbol}`
      );
    }

    await instance.closePositionMarket(positionQty);

    const timeoutMs = 15000;
    const pollIntervalMs = 500;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const qty = await this.getPositionQuantity(instance.symbol);
      if (qty === 0) {
        console.log(`✓ Position flattened for ${instance.symbol}`);
        return;
      }
      await this.sleep(pollIntervalMs);
    }

    throw new Error(`Timeout waiting for position to close for ${instance.symbol}`);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
