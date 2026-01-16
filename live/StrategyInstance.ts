/**
 * Strategy Instance Wrapper
 * Encapsulates a single strategy's complete lifecycle
 * Updated to work with database instead of filesystem
 */

import { StrategyCompiler } from '../compiler/compile';
import { createStandardRegistry } from '../features/registry';
import { StrategyEngine } from '../runtime/engine';
import { BaseBrokerAdapter } from '../broker/broker';
import { Bar, CompiledIR, StrategyRuntimeState, BrokerEnvironment, CancellationResult } from '../spec/types';

export class StrategyInstance {
  readonly strategyId: string;  // Database ID
  readonly userId: string;      // Owner
  readonly symbol: string;
  readonly strategyName: string;

  private engine!: StrategyEngine;
  private compiler: StrategyCompiler;
  private brokerAdapter: BaseBrokerAdapter;
  private brokerEnv: BrokerEnvironment;
  private ir!: CompiledIR;
  private barsSinceLastEval: number = 0;
  private yamlContent: string;
  private initialized: boolean = false;
  private lastBarFetchTime: number = 0;  // Track last time we fetched bars
  private lastProcessedBarTimestamp: number | null = null;

  constructor(
    strategyId: string,
    userId: string,
    yamlContent: string,
    symbol: string,
    name: string,
    adapter: BaseBrokerAdapter,
    brokerEnv: BrokerEnvironment
  ) {
    this.strategyId = strategyId;
    this.userId = userId;
    this.yamlContent = yamlContent;
    this.symbol = symbol;
    this.strategyName = name;
    this.brokerAdapter = adapter;
    this.brokerEnv = brokerEnv;

    // Create compiler with standard registry
    const featureRegistry = createStandardRegistry();
    this.compiler = new StrategyCompiler(featureRegistry);
  }

  /**
   * Initialize strategy: compile YAML, create engine
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Compile YAML to IR (yamlContent already provided in constructor)
    this.ir = this.compiler.compileFromYAML(this.yamlContent);

    // Create engine
    const featureRegistry = createStandardRegistry();
    this.engine = new StrategyEngine(this.ir, featureRegistry, this.brokerAdapter, this.brokerEnv);

    this.initialized = true;
    console.log(`✓ Initialized strategy: ${this.strategyName} for ${this.symbol} (ID: ${this.strategyId})`);
  }

  /**
   * Process a bar through the strategy engine
   */
  async processBar(
    bar: Bar,
    options?: { replay?: boolean }
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('Strategy not initialized. Call initialize() first.');
    }

    await this.engine.processBar(bar, options);
    this.lastProcessedBarTimestamp = bar.timestamp;
    if (!options?.replay) {
      this.barsSinceLastEval++;
    }
  }

  /**
   * Check if evaluation is due (every N bars)
   */
  shouldEvaluate(evalInterval: number): boolean {
    return this.barsSinceLastEval >= evalInterval;
  }

  /**
   * Reset evaluation counter
   */
  resetEvaluationCounter(): void {
    this.barsSinceLastEval = 0;
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(): Promise<CancellationResult> {
    const state = this.engine.getState();

    if (state.openOrders.length === 0) {
      return {
        succeeded: [],
        failed: [],
      };
    }

    console.log(`Cancelling ${state.openOrders.length} open orders for ${this.symbol}...`);

    // Cancel via broker adapter - let errors propagate
    const result = await this.brokerAdapter.cancelOpenEntries(
      this.symbol,
      state.openOrders,
      this.brokerEnv
    );

    // Log results
    if (result.succeeded.length > 0) {
      console.log(`✓ Successfully cancelled ${result.succeeded.length} orders for ${this.symbol}`);
    }
    if (result.failed.length > 0) {
      console.error(`✗ Failed to cancel ${result.failed.length} orders for ${this.symbol}:`,
        result.failed.map(f => `${f.orderId}: ${f.reason}`).join(', ')
      );
    }

    return result;
  }

  /**
   * Shutdown strategy
   */
  async shutdown(): Promise<void> {
    console.log(`Shutting down strategy: ${this.strategyName} for ${this.symbol}`);
    this.initialized = false;
  }

  /**
   * Get current runtime state
   */
  getState(): StrategyRuntimeState {
    if (!this.initialized) {
      throw new Error('Strategy not initialized');
    }
    return this.engine.getState();
  }

  /**
   * Get YAML content
   */
  getYamlContent(): string {
    return this.yamlContent;
  }

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): { barsActive: number; ordersPlaced: number } {
    const state = this.getState();
    return {
      barsActive: state.barCount,
      ordersPlaced: state.openOrders.length,
    };
  }

  /**
   * Get bar history (last N bars)
   */
  getBarHistory(count?: number): Bar[] {
    const history = this.engine.getHistory();
    if (count !== undefined && count > 0) {
      return history.slice(-count);
    }
    return history;
  }

  /**
   * Get timeframe from compiled IR
   */
  getTimeframe(): string {
    return this.ir.timeframe;
  }

  /**
   * Filter bars to only those newer than the last processed bar.
   */
  filterNewBars(bars: Bar[]): Bar[] {
    if (this.lastProcessedBarTimestamp === null) {
      return bars;
    }

    return bars.filter((bar) => bar.timestamp > this.lastProcessedBarTimestamp!);
  }

  /**
   * Check if enough time has elapsed to fetch new bars for this strategy's timeframe
   */
  shouldFetchBars(timeframeMs: number): boolean {
    const now = Date.now();
    const elapsed = now - this.lastBarFetchTime;
    return elapsed >= timeframeMs;
  }

  /**
   * Mark that bars were fetched at this time
   */
  markBarsFetched(): void {
    this.lastBarFetchTime = Date.now();
  }
}
