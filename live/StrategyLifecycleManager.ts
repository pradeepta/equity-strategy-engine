/**
 * Strategy Lifecycle Manager
 * Orchestrates strategy evaluation, swapping, and database operations
 * Updated to use repositories instead of filesystem
 */

import { StrategyInstance } from "./StrategyInstance";
import { MultiStrategyManager } from "./MultiStrategyManager";
import { StrategyEvaluatorClient } from "../evaluation/StrategyEvaluatorClient";
import { PortfolioDataFetcher } from "../broker/twsPortfolio";
import { EvaluationRequest, EvaluationResponse } from "../evaluation/types";
import { StrategyRepository } from "../database/repositories/StrategyRepository";
import { ExecutionHistoryRepository } from "../database/repositories/ExecutionHistoryRepository";
import { OrderRepository } from "../database/repositories/OrderRepository";
import { OperationQueueService } from "./queue/OperationQueueService";
import * as YAML from "yaml";

export class StrategyLifecycleManager {
  private multiStrategyManager: MultiStrategyManager;
  private evaluatorClient: StrategyEvaluatorClient;
  private portfolioFetcher: PortfolioDataFetcher;
  private strategyRepo: StrategyRepository;
  private execHistoryRepo: ExecutionHistoryRepository;
  private orderRepo: OrderRepository;
  private operationQueue: OperationQueueService;
  private orchestrator?: any; // Reference to orchestrator for locking
  private exitOrdersInFlight: Set<string> = new Set();

  constructor(
    manager: MultiStrategyManager,
    evaluator: StrategyEvaluatorClient,
    portfolio: PortfolioDataFetcher,
    strategyRepo: StrategyRepository,
    execHistoryRepo: ExecutionHistoryRepository,
    orderRepo: OrderRepository,
    operationQueue: OperationQueueService
  ) {
    this.multiStrategyManager = manager;
    this.evaluatorClient = evaluator;
    this.portfolioFetcher = portfolio;
    this.strategyRepo = strategyRepo;
    this.execHistoryRepo = execHistoryRepo;
    this.orderRepo = orderRepo;
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
    console.log(
      `🔍 Evaluating strategy: ${instance.strategyName} for ${instance.symbol}`
    );

    try {
      // Fetch portfolio snapshot
      const portfolio = await this.portfolioFetcher.getPortfolioSnapshot();

      // Get strategy state
      const state = instance.getState();
      const performance = instance.getPerformanceMetrics();
      const recentBars = instance.getBarHistory(20);

      if (!state.currentBar) {
        console.warn("No current bar available for evaluation");
        return;
      }

      this.logEvaluationDebug(instance, state);

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

      const evaluation = await this.execHistoryRepo.logEvaluation({
        strategyId: instance.strategyId,
        portfolioValue: portfolio.totalValue,
        unrealizedPnL: portfolio.unrealizedPnL,
        realizedPnL: portfolio.realizedPnL,
        currentBar: state.currentBar,
        recentBars: recentBars,
        recommendation: this.mapRecommendation(response.recommendation),
        confidence: response.confidence,
        reason: response.reason,
        suggestedYaml: response.suggestedStrategy?.yamlContent,
        suggestedName: response.suggestedStrategy?.name,
        suggestedReasoning: response.suggestedStrategy?.reasoning,
      });

      // Handle recommendation
      if (response.recommendation === "swap") {
        await this.handleSwapRecommendation(instance, response, evaluation.id);
      } else if (response.recommendation === "close") {
        await this.handleCloseRecommendation(instance, response, evaluation.id);
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
    response: EvaluationResponse,
    evaluationId: string
  ): Promise<void> {
    console.log(`🔄 Swapping strategy for ${instance.symbol}...`);

    const state = instance.getState();
    const suggestedHash = response.suggestedStrategy
      ? this.hashString(response.suggestedStrategy.yamlContent)
      : "none";

    // Enqueue swap operation for idempotency and retry
    const operationId = await this.operationQueue.enqueue({
      operationType: "SWAP_STRATEGY",
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
      console.log(
        `✓ Strategy swap already completed (idempotent): ${result?.newStrategyId}`
      );
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
        const lockAcquired = await this.orchestrator.lockSymbol(
          instance.symbol
        );
        if (!lockAcquired) {
          console.warn(
            `⚠️  Failed to acquire lock for ${instance.symbol}. Another swap is in progress.`
          );
          // Don't throw - mark as failed and let retry queue handle it
          await failOperation(
            `Lock acquisition failed - another swap in progress`
          );
          return; // Exit gracefully instead of throwing
        }
      }

      const oldStrategyId = instance.strategyId;

      // Cancel all open orders - CRITICAL: Verify success before proceeding
      const cancelResult = await instance.cancelAllOrders();

      if (cancelResult.failed.length > 0) {
        const failedIds = cancelResult.failed.map((f) => f.orderId).join(", ");
        const reasons = cancelResult.failed.map((f) => f.reason).join("; ");
        const errorMsg = `Cannot swap strategy for ${instance.symbol} - failed to cancel orders: ${failedIds}. Reasons: ${reasons}`;
        console.error(`❌ ${errorMsg}`);

        await this.execHistoryRepo.markActionTaken(
          evaluationId,
          `Swap aborted: ${errorMsg}`
        );
        await this.execHistoryRepo.logEvent({
          strategyId: oldStrategyId,
          eventType: "ERROR",
          swapReason: errorMsg,
          metadata: {
            symbol: instance.symbol,
            operationId,
            failedOrderIds: failedIds,
          },
        });

        // Mark operation as failed
        await failOperation(errorMsg);
        return;
      }

      console.log(
        `✓ Cancelled ${cancelResult.succeeded.length} orders for ${instance.symbol}`
      );

      const positionQty = await this.getPositionQuantity(instance.symbol);
      if (positionQty !== 0) {
        console.warn(
          `⚠️ Active position detected for ${instance.symbol} during swap: ${positionQty}`
        );
        await this.closePositionAndWait(instance, positionQty);
      }

      // Check for active position
      if (state.currentState === "MANAGING" || state.openOrders.length > 0) {
        console.warn(
          `⚠️ Strategy ${instance.symbol} has active position during swap.`
        );
        console.warn(
          `📍 Position for ${instance.symbol} may be unmanaged. Monitor manually.`
        );
      }

      // Deploy new strategy if suggested
      if (!response.suggestedStrategy) {
        const errorMsg = `Swap recommended for ${instance.symbol} but no suggested strategy was provided`;
        console.error(`❌ ${errorMsg}`);
        await this.execHistoryRepo.markActionTaken(
          evaluationId,
          `Swap aborted: ${errorMsg}`
        );
        await this.execHistoryRepo.logEvent({
          strategyId: oldStrategyId,
          eventType: "ERROR",
          swapReason: errorMsg,
          metadata: {
            symbol: instance.symbol,
            operationId,
          },
        });
        await failOperation(errorMsg);
        return;
      }

      const suggestedMeta = this.parseSuggestedMeta(
        response.suggestedStrategy.yamlContent
      );
      const suggestedSymbolRaw = suggestedMeta?.symbol?.trim();
      const suggestedSymbol = suggestedSymbolRaw || instance.symbol;
      const suggestedTimeframe =
        suggestedMeta?.timeframe?.trim() || instance.getTimeframe();
      const crossSymbol =
        suggestedSymbol.toUpperCase() !== instance.symbol.toUpperCase();
      const allowCrossSymbolSwap =
        this.orchestrator?.config?.allowCrossSymbolSwap === true;

      if (crossSymbol && !allowCrossSymbolSwap) {
        const errorMsg = `Swap suggested for ${instance.symbol} but evaluator returned ${suggestedSymbol}. Cross-symbol swaps disabled.`;
        console.error(`❌ ${errorMsg}`);
        await this.execHistoryRepo.markActionTaken(
          evaluationId,
          `Swap aborted: ${errorMsg}`
        );
        await this.execHistoryRepo.logEvent({
          strategyId: oldStrategyId,
          eventType: "ERROR",
          swapReason: errorMsg,
          metadata: {
            symbol: instance.symbol,
            operationId,
            suggestedSymbol,
          },
        });
        await failOperation(errorMsg);
        return;
      }

      if (crossSymbol) {
        if (this.multiStrategyManager.getStrategyBySymbol(suggestedSymbol)) {
          const errorMsg = `Cross-symbol swap blocked: strategy for ${suggestedSymbol} already loaded.`;
          console.error(`❌ ${errorMsg}`);
          await this.execHistoryRepo.markActionTaken(
            evaluationId,
            `Swap aborted: ${errorMsg}`
          );
          await this.execHistoryRepo.logEvent({
            strategyId: oldStrategyId,
            eventType: "ERROR",
            swapReason: errorMsg,
            metadata: {
              symbol: instance.symbol,
              operationId,
              suggestedSymbol,
            },
          });
          await failOperation(errorMsg);
          return;
        }
        console.warn(
          `⚠️ Cross-symbol swap enabled: ${instance.symbol} -> ${suggestedSymbol}`
        );
      }

      // Create new strategy in database (DRAFT until swap succeeds)
      const newStrategy = await this.strategyRepo.createWithVersion({
        userId: instance.userId,
        symbol: suggestedSymbol,
        name: response.suggestedStrategy.name,
        timeframe: suggestedTimeframe,
        yamlContent: response.suggestedStrategy.yamlContent,
        changeReason: "Auto-swap by evaluator",
      });

      console.log(`✅ Created new strategy in database: ${newStrategy.id}`);

      try {
        // Swap in MultiStrategyManager (removes old, loads new from database)
        await this.multiStrategyManager.swapStrategyById(
          instance.symbol,
          newStrategy.id,
          {
            skipOrderCancel: true,
          }
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `Failed to swap runtime strategy for ${instance.symbol}:`,
          error
        );
        await this.strategyRepo.markFailed(newStrategy.id, errorMsg);
        await failOperation(errorMsg);
        return;
      }

      // Activate new strategy only after runtime swap succeeds
      await this.strategyRepo.activate(newStrategy.id, 'evaluator', {
        isSwap: true,
        replacedStrategyId: oldStrategyId,
        swapReason: response.reason,
        evaluationScore: response.confidence,
      });

      // Close old strategy in database after successful swap
      await this.strategyRepo.close(oldStrategyId, response.reason, 'evaluator', {
        isSwap: true,
        newStrategyId: newStrategy.id,
        evaluationScore: response.confidence,
      });
      await this.execHistoryRepo.logDeactivation(
        oldStrategyId,
        response.reason
      );

      // Audit swap execution
      await this.execHistoryRepo.logEvent({
        strategyId: oldStrategyId,
        eventType: "SWAP",
        swapReason: response.reason,
        oldVersionId: oldStrategyId,
        newVersionId: newStrategy.id,
        metadata: {
          symbol: instance.symbol,
          oldStrategyId,
          newStrategyId: newStrategy.id,
          newSymbol: suggestedSymbol,
        },
      });

      // Mark evaluation action as taken
      await this.execHistoryRepo.markActionTaken(
        evaluationId,
        "Swapped successfully"
      );

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
      await this.execHistoryRepo.logEvent({
        strategyId: instance.strategyId,
        eventType: "ERROR",
        swapReason: errorMsg,
        metadata: {
          symbol: instance.symbol,
          operationId,
        },
      });
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
    response: EvaluationResponse,
    evaluationId: string
  ): Promise<void> {
    console.log(`❌ Closing strategy for ${instance.symbol}...`);

    const state = instance.getState();

    // Enqueue close operation for idempotency and retry
    const operationId = await this.operationQueue.enqueue({
      operationType: "CLOSE_STRATEGY",
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
        const failedIds = cancelResult.failed.map((f) => f.orderId).join(", ");
        const reasons = cancelResult.failed.map((f) => f.reason).join("; ");
        const errorMsg = `Cannot close strategy for ${instance.symbol} - failed to cancel orders: ${failedIds}. Reasons: ${reasons}`;
        console.error(`❌ ${errorMsg}`);
        await this.execHistoryRepo.markActionTaken(
          evaluationId,
          `Close aborted: ${errorMsg}`
        );
        await this.execHistoryRepo.logEvent({
          strategyId: instance.strategyId,
          eventType: "ERROR",
          swapReason: errorMsg,
          metadata: {
            symbol: instance.symbol,
            operationId,
            failedOrderIds: failedIds,
          },
        });
        await this.operationQueue.fail(operationId, errorMsg);
        return;
      }

      const positionQty = await this.getPositionQuantity(instance.symbol);
      if (positionQty !== 0) {
        console.warn(
          `⚠️ Active position detected for ${instance.symbol} during close: ${positionQty}`
        );
        await this.closePositionAndWait(instance, positionQty);
      }

      // Close strategy in database
      await this.strategyRepo.close(instance.strategyId, response.reason);
      console.log(`📦 Strategy closed in database: ${instance.strategyId}`);

      // Log deactivation
      await this.execHistoryRepo.logDeactivation(
        instance.strategyId,
        response.reason
      );

      // Remove from MultiStrategyManager
      await this.multiStrategyManager.removeStrategy(instance.symbol);

      console.log(`✓ Strategy closed for ${instance.symbol}`);

      await this.execHistoryRepo.markActionTaken(
        evaluationId,
        "Closed successfully"
      );

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
      await this.execHistoryRepo.logEvent({
        strategyId: instance.strategyId,
        eventType: "ERROR",
        swapReason: errorMsg,
        metadata: {
          symbol: instance.symbol,
          operationId,
        },
      });
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
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private async getPositionQuantity(symbol: string): Promise<number> {
    const portfolio = await this.portfolioFetcher.getPortfolioSnapshot(true);
    const position = portfolio.positions.find((p) => p.symbol === symbol);
    return position ? position.quantity : 0;
  }

  private async closePositionAndWait(
    instance: StrategyInstance,
    positionQty: number
  ): Promise<void> {
    if (positionQty === 0) {
      this.exitOrdersInFlight.delete(instance.symbol);
      return;
    }

    if (this.exitOrdersInFlight.has(instance.symbol)) {
      console.warn(
        `⚠️ Market-exit already in flight for ${instance.symbol}; skipping duplicate exit`
      );
      return;
    }

    const existingExit = await this.orderRepo.findOpenMarketExit(
      instance.symbol
    );
    if (existingExit) {
      console.warn(
        `⚠️ Existing market-exit order already open for ${instance.symbol} (${existingExit.id}); skipping duplicate exit`
      );
      this.exitOrdersInFlight.add(instance.symbol);
      return;
    }

    const brokerOpenOrders = await instance.getOpenOrders();
    const exitSide = positionQty > 0 ? "sell" : "buy";
    const hasBrokerExit = brokerOpenOrders.some(
      (order) =>
        order.symbol === instance.symbol &&
        order.type === "market" &&
        order.side === exitSide &&
        (order.status === "pending" || order.status === "submitted")
    );
    if (hasBrokerExit) {
      console.warn(
        `⚠️ Broker already has open market-exit order for ${instance.symbol}; skipping duplicate exit`
      );
      this.exitOrdersInFlight.add(instance.symbol);
      return;
    }

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

    const exitOrder = await instance.closePositionMarket(positionQty);
    this.exitOrdersInFlight.add(instance.symbol);

    try {
      const dbOrder = await this.orderRepo.create({
        strategyId: instance.strategyId,
        brokerOrderId: exitOrder.id,
        planId: exitOrder.planId || `market-exit-${Date.now()}`,
        symbol: exitOrder.symbol,
        side: exitOrder.side === "buy" ? "BUY" : "SELL",
        qty: exitOrder.qty,
        type: "MARKET",
      });
      await this.orderRepo.updateStatus(dbOrder.id, "SUBMITTED");
      await this.orderRepo.createAuditLog({
        orderId: dbOrder.id,
        brokerOrderId: exitOrder.id,
        strategyId: instance.strategyId,
        eventType: "SUBMITTED",
        newStatus: "SUBMITTED",
        quantity: exitOrder.qty,
        metadata: {
          source: "swap_market_exit",
        },
      });
    } catch (error) {
      console.warn(
        `⚠️ Failed to record market exit in DB for ${instance.symbol}:`,
        error
      );
    }

    if (!this.isMarketOpenNow()) {
      console.warn(
        `⚠️  Market closed - skipping position close wait for ${instance.symbol}`
      );
      return;
    }

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

    throw new Error(
      `Timeout waiting for position to close for ${instance.symbol}`
    );
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseSuggestedMeta(
    yamlContent: string
  ): { symbol?: string; timeframe?: string } | null {
    try {
      const parsed = YAML.parse(yamlContent) as any;
      return {
        symbol: parsed?.meta?.symbol,
        timeframe: parsed?.meta?.timeframe,
      };
    } catch (error) {
      console.warn(
        `⚠️ Failed to parse suggested strategy meta: ${String(error)}`
      );
      return null;
    }
  }

  private logEvaluationDebug(
    instance: StrategyInstance,
    state: { currentBar: any; features: Map<string, any> }
  ): void {
    try {
      const yamlContent = instance.getYamlContent();
      const parsed = YAML.parse(yamlContent) as any;
      const rules = parsed?.rules || {};
      const orderPlan = Array.isArray(parsed?.orderPlans)
        ? parsed.orderPlans[0]
        : undefined;
      const bar = state.currentBar;

      if (!bar) {
        return;
      }

      const baseValues: Record<string, number> = {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        price: bar.close,
      };

      for (const [key, value] of state.features.entries()) {
        if (typeof value === "number") {
          baseValues[key] = value;
        }
      }

      const logRule = (label: string, expr: string | undefined) => {
        if (!expr || typeof expr !== "string") {
          return;
        }
        const identifiers = this.extractIdentifiers(expr);
        const values: Record<string, number> = {};
        for (const key of identifiers) {
          if (key in baseValues) {
            values[key] = baseValues[key];
          }
        }
        console.log(
          `🧪 EVAL DEBUG [${
            instance.symbol
          }] ${label}: ${expr} | current: ${JSON.stringify(values)}`
        );
      };

      console.log(
        `🧪 EVAL DEBUG [${instance.symbol}] bar: close=${bar.close} high=${bar.high} low=${bar.low} volume=${bar.volume}`
      );

      logRule("arm", rules.arm);
      logRule("trigger", rules.trigger);

      if (rules.invalidate) {
        const invalidate = rules.invalidate;
        if (Array.isArray(invalidate)) {
          invalidate.forEach((expr: string, idx: number) =>
            logRule(`invalidate[${idx}]`, expr)
          );
        } else if (invalidate.when_any && Array.isArray(invalidate.when_any)) {
          invalidate.when_any.forEach((expr: string, idx: number) =>
            logRule(`invalidate.any[${idx}]`, expr)
          );
        } else if (invalidate.when_all && Array.isArray(invalidate.when_all)) {
          invalidate.when_all.forEach((expr: string, idx: number) =>
            logRule(`invalidate.all[${idx}]`, expr)
          );
        }
      }

      if (orderPlan?.entryZone && Array.isArray(orderPlan.entryZone)) {
        console.log(
          `🧪 EVAL DEBUG [${instance.symbol}] entryZone: [${orderPlan.entryZone[0]}, ${orderPlan.entryZone[1]}] | close=${bar.close}`
        );
      }
      if (orderPlan?.stopPrice) {
        console.log(
          `🧪 EVAL DEBUG [${instance.symbol}] stopPrice: ${orderPlan.stopPrice} | close=${bar.close}`
        );
      }
    } catch (error) {
      console.warn(
        `⚠️ EVAL DEBUG failed for ${instance.symbol}: ${String(error)}`
      );
    }
  }

  private extractIdentifiers(expression: string): string[] {
    const matches = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    return Array.from(new Set(matches));
  }

  private mapRecommendation(
    recommendation: EvaluationResponse["recommendation"]
  ): "KEEP" | "SWAP" | "CLOSE" {
    switch (recommendation) {
      case "swap":
        return "SWAP";
      case "close":
        return "CLOSE";
      default:
        return "KEEP";
    }
  }

  private isMarketOpenNow(): boolean {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });

      const parts = formatter.formatToParts(new Date());
      const weekday = parts.find((p) => p.type === "weekday")?.value || "";
      const hour = parseInt(
        parts.find((p) => p.type === "hour")?.value || "0",
        10
      );
      const minute = parseInt(
        parts.find((p) => p.type === "minute")?.value || "0",
        10
      );

      if (["Sat", "Sun"].includes(weekday)) {
        return false;
      }

      const minutes = hour * 60 + minute;
      const open = 9 * 60 + 30;
      const close = 16 * 60;
      return minutes >= open && minutes < close;
    } catch {
      return false;
    }
  }
}
