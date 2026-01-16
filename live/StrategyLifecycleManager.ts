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
    });

    // Check if already completed (idempotency)
    if (await this.operationQueue.isCompleted(operationId)) {
      const result = await this.operationQueue.getResult(operationId);
      console.log(`✓ Strategy swap already completed (idempotent): ${result?.newStrategyId}`);
      return;
    }

    try {
      // Lock the symbol to prevent concurrent operations (distributed lock)
      if (this.orchestrator) {
        const lockAcquired = await this.orchestrator.lockSymbol(instance.symbol);
        if (!lockAcquired) {
          console.warn(`⚠️  Failed to acquire lock for ${instance.symbol}. Another process may be swapping this symbol.`);
          throw new Error(`Failed to acquire lock for ${instance.symbol}`);
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
        await this.operationQueue.fail(operationId, errorMsg);
        throw new Error(errorMsg);
      }

      console.log(`✓ Cancelled ${cancelResult.succeeded.length} orders for ${instance.symbol}`);

      // Check for active position
      const state = instance.getState();
      if (state.currentState === 'MANAGING' || state.openOrders.length > 0) {
        console.warn(`⚠️ Strategy ${instance.symbol} has active position during swap.`);
        console.warn(`📍 Position for ${instance.symbol} may be unmanaged. Monitor manually.`);
      }

      // Deploy new strategy if suggested
      if (response.suggestedStrategy) {
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

        // Close old strategy in database
        await this.strategyRepo.close(oldStrategyId, response.reason);

        // Create new strategy in database
        const newStrategy = await this.strategyRepo.createWithVersion({
          userId: instance.userId,
          symbol: instance.symbol,
          name: response.suggestedStrategy.name,
          timeframe: instance.getTimeframe(),
          yamlContent: response.suggestedStrategy.yamlContent,
          changeReason: 'Auto-swap by evaluator',
        });

        console.log(`✅ Created new strategy in database: ${newStrategy.id}`);

        // Activate new strategy
        await this.strategyRepo.activate(newStrategy.id);

        // Mark evaluation action as taken
        await this.execHistoryRepo.markActionTaken(evaluation.id, 'Swapped successfully');

        // Swap in MultiStrategyManager (removes old, loads new from database)
        await this.multiStrategyManager.swapStrategyById(instance.symbol, newStrategy.id);

        console.log(`✓ Strategy swap complete for ${instance.symbol}`);

        // Mark operation as completed
        await this.operationQueue.complete(operationId, {
          newStrategyId: newStrategy.id,
          oldStrategyId,
          symbol: instance.symbol,
        });
      }
    } catch (error) {
      console.error(`Failed to swap strategy for ${instance.symbol}:`, error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.operationQueue.fail(operationId, errorMsg);
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
    });

    // Check if already completed (idempotency)
    if (await this.operationQueue.isCompleted(operationId)) {
      console.log(`✓ Strategy close already completed (idempotent)`);
      return;
    }

    try {
      // Log evaluation to database
      await this.execHistoryRepo.logEvaluation({
        strategyId: instance.strategyId,
        recommendation: 'CLOSE',
        confidence: response.confidence,
        reason: response.reason,
      });

      // Cancel all open orders
      await instance.cancelAllOrders();

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
}
