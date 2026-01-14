/**
 * Strategy Lifecycle Manager
 * Orchestrates strategy evaluation, swapping, and file management
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyInstance } from './StrategyInstance';
import { MultiStrategyManager } from './MultiStrategyManager';
import { StrategyEvaluatorClient } from '../evaluation/StrategyEvaluatorClient';
import { PortfolioDataFetcher } from '../broker/twsPortfolio';
import { EvaluationRequest, EvaluationResponse } from '../evaluation/types';

export class StrategyLifecycleManager {
  private multiStrategyManager: MultiStrategyManager;
  private evaluatorClient: StrategyEvaluatorClient;
  private portfolioFetcher: PortfolioDataFetcher;
  private liveDir: string;
  private closedDir: string;
  private archiveDir: string;
  private orchestrator?: any;  // Reference to orchestrator for locking

  constructor(
    manager: MultiStrategyManager,
    evaluator: StrategyEvaluatorClient,
    portfolio: PortfolioDataFetcher,
    liveDir: string,
    closedDir: string,
    archiveDir: string
  ) {
    this.multiStrategyManager = manager;
    this.evaluatorClient = evaluator;
    this.portfolioFetcher = portfolio;
    this.liveDir = liveDir;
    this.closedDir = closedDir;
    this.archiveDir = archiveDir;
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

    try {
      // Lock the symbol to prevent filesystem watcher from loading during swap
      if (this.orchestrator) {
        this.orchestrator.lockSymbol(instance.symbol);
      }

      // Save old yaml path before any modifications
      const oldYamlPath = instance.yamlPath;

      // Cancel all open orders
      await instance.cancelAllOrders();

      // Check for active position
      const state = instance.getState();
      if (state.currentState === 'MANAGING' || state.openOrders.length > 0) {
        console.warn(`⚠️ Strategy ${instance.symbol} has active position during swap.`);
        console.warn(`📍 Position for ${instance.symbol} may be unmanaged. Monitor manually.`);
      }

      // Deploy new strategy if suggested
      if (response.suggestedStrategy) {
        const newYamlPath = await this.deployNewStrategy(
          instance.symbol,
          response.suggestedStrategy.yamlContent,
          response.suggestedStrategy.name
        );
        console.log(`✅ Deployed new strategy: ${newYamlPath}`);

        // Mark file as deployed to prevent filesystem watcher from auto-loading
        if (this.orchestrator) {
          this.orchestrator.markFileAsDeployed(newYamlPath);
        }

        // Swap in MultiStrategyManager (removes old, loads new)
        await this.multiStrategyManager.swapStrategy(instance.symbol, newYamlPath);

        // Now move old strategy to closed (using saved path)
        const closedPath = await this.moveStrategyToClosed(oldYamlPath);
        console.log(`📦 Archived old strategy to: ${closedPath}`);

        console.log(`✓ Strategy swap complete for ${instance.symbol}`);
      }
    } catch (error) {
      console.error(`Failed to swap strategy for ${instance.symbol}:`, error);
    } finally {
      // Always unlock the symbol, even if swap failed
      if (this.orchestrator) {
        this.orchestrator.unlockSymbol(instance.symbol);
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

    try {
      // Cancel all open orders
      await instance.cancelAllOrders();

      // Move to closed
      const closedPath = await this.moveStrategyToClosed(instance.yamlPath);
      console.log(`📦 Archived strategy to: ${closedPath}`);

      // Remove from MultiStrategyManager
      await this.multiStrategyManager.removeStrategy(instance.symbol);

      console.log(`✓ Strategy closed for ${instance.symbol}`);
    } catch (error) {
      console.error(`Failed to close strategy for ${instance.symbol}:`, error);
    }
  }

  /**
   * Move strategy YAML to closed directory with timestamp
   */
  async moveStrategyToClosed(yamlPath: string): Promise<string> {
    const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const originalName = path.basename(yamlPath);
    const closedName = `${timestamp}_${originalName}`;
    const closedPath = path.join(this.closedDir, closedName);

    // Ensure closed directory exists
    await fs.promises.mkdir(this.closedDir, { recursive: true });

    // Move file
    await fs.promises.rename(yamlPath, closedPath);

    return closedPath;
  }

  /**
   * Deploy new strategy to live directory
   */
  async deployNewStrategy(symbol: string, yamlContent: string, name: string): Promise<string> {
    const sanitizedName = name.replace(/[^a-zA-Z0-9-_]/g, '-');
    const filename = `${symbol}-${sanitizedName}.yaml`;
    const newYamlPath = path.join(this.liveDir, filename);

    // Ensure live directory exists
    await fs.promises.mkdir(this.liveDir, { recursive: true });

    // Write new YAML
    await fs.promises.writeFile(newYamlPath, yamlContent, 'utf-8');

    return newYamlPath;
  }

  /**
   * Move invalid strategy to archive
   */
  async moveToArchive(yamlPath: string, reason: string = 'invalid'): Promise<string> {
    const invalidDir = path.join(this.archiveDir, reason);
    await fs.promises.mkdir(invalidDir, { recursive: true });

    const filename = path.basename(yamlPath);
    const archivePath = path.join(invalidDir, filename);

    await fs.promises.rename(yamlPath, archivePath);

    return archivePath;
  }
}
