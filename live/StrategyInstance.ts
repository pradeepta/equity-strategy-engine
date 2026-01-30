/**
 * Strategy Instance Wrapper
 * Encapsulates a single strategy's complete lifecycle
 * Updated to work with database instead of filesystem
 */

import { StrategyCompiler } from '../compiler/compile';
import { createStandardRegistry } from '../features/registry';
import { StrategyEngine } from '../runtime/engine';
import { BaseBrokerAdapter } from '../broker/broker';
import { Bar, CompiledIR, StrategyRuntimeState, BrokerEnvironment, CancellationResult, Order } from '../spec/types';
import { RealtimeBarClient } from './streaming/RealtimeBarClient';
import { StrategyRepository } from '../database/repositories/StrategyRepository';
import { ExecutionHistoryRepository } from '../database/repositories/ExecutionHistoryRepository';
import { OrderRepository } from '../database/repositories/OrderRepository';

export class StrategyInstance {
  readonly strategyId: string;  // Database ID
  readonly userId: string;      // Owner
  readonly symbol: string;
  readonly strategyName: string;

  private engine!: StrategyEngine;
  private compiler: StrategyCompiler;
  private brokerAdapter: BaseBrokerAdapter;
  private brokerEnv: BrokerEnvironment;
  private strategyRepo: StrategyRepository;  // For persisting runtime state
  private execHistoryRepo: ExecutionHistoryRepository;  // For logging execution events
  private orderRepo: OrderRepository;  // For persisting orders
  private ir!: CompiledIR;
  private barsSinceLastEval: number = 0;
  private yamlContent: string;
  private initialized: boolean = false;
  private lastBarFetchTime: number = 0;  // Track last time we fetched bars
  private lastProcessedBarTimestamp: number | null = null;
  private activatedAt: Date;  // When strategy was activated
  private barsProcessedSinceActivation: number = 0;  // Real-time bars only
  private streamingClient: RealtimeBarClient | null = null;  // Real-time bar streaming
  private isStreaming: boolean = false;  // Track streaming state
  private lastStateName: string | null = null;  // Track state changes
  private persistedOrderIds: Set<string> = new Set();  // Track which orders are persisted

  constructor(
    strategyId: string,
    userId: string,
    yamlContent: string,
    symbol: string,
    name: string,
    adapter: BaseBrokerAdapter,
    brokerEnv: BrokerEnvironment,
    strategyRepo: StrategyRepository,
    execHistoryRepo: ExecutionHistoryRepository,
    orderRepo: OrderRepository,
    activatedAt?: Date  // Optional - defaults to now
  ) {
    this.strategyId = strategyId;
    this.userId = userId;
    this.yamlContent = yamlContent;
    this.symbol = symbol;
    this.strategyName = name;
    this.brokerAdapter = adapter;
    this.brokerEnv = brokerEnv;
    this.strategyRepo = strategyRepo;
    this.execHistoryRepo = execHistoryRepo;
    this.orderRepo = orderRepo;
    this.activatedAt = activatedAt || new Date();

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

    try {
      // Compile YAML to IR (yamlContent already provided in constructor)
      this.ir = this.compiler.compileFromYAML(this.yamlContent);

      // Create engine
      const featureRegistry = createStandardRegistry();
      this.engine = new StrategyEngine(this.ir, featureRegistry, this.brokerAdapter, this.brokerEnv, this.strategyId);

      this.initialized = true;
      console.log(`✓ Initialized strategy: ${this.strategyName} for ${this.symbol} (ID: ${this.strategyId})`);
    } catch (error: any) {
      // Audit log for compilation failure
      this.brokerEnv.auditEvent?.({
        component: 'StrategyInstance',
        level: 'error',
        message: 'Strategy compilation failed',
        metadata: {
          strategyId: this.strategyId,
          strategyName: this.strategyName,
          symbol: this.symbol,
          error: error.message,
          stackTrace: error.stack,
        },
      });
      console.error(`✗ Failed to compile strategy ${this.strategyName} for ${this.symbol}:`, error.message);
      throw error;
    }
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

    // Only count non-replay bars toward evaluation and real-time tracking
    if (!options?.replay) {
      this.barsSinceLastEval++;
      // Only count bars that occurred after activation as "real-time"
      if (bar.timestamp >= this.activatedAt.getTime()) {
        this.barsProcessedSinceActivation++;
      }

      // Check if state changed and update streaming accordingly
      const currentState = this.engine.getState();
      const currentStateName = currentState.currentState;

      if (currentStateName !== this.lastStateName) {
        const fromState = this.lastStateName || 'init';
        console.log(`[${this.symbol}] State transition: ${fromState} → ${currentStateName}`);

        // Persist state to database for API access
        try {
          await this.strategyRepo.updateRuntimeState(this.strategyId, currentStateName);
        } catch (error) {
          console.error(`[${this.symbol}] Failed to persist runtime state:`, error);
          // Don't fail strategy processing if DB write fails
        }

        // Log state transition to execution history
        try {
          await this.execHistoryRepo.logStateTransition({
            strategyId: this.strategyId,
            fromState,
            toState: currentStateName,
            barTimestamp: new Date(bar.timestamp),
            currentPrice: bar.close,
            currentVolume: BigInt(bar.volume),
            barsProcessed: this.barsProcessedSinceActivation,
            openOrderCount: currentState.openOrders.length,
          });
        } catch (error) {
          console.error(`[${this.symbol}] Failed to log state transition:`, error);
          // Don't fail strategy processing if DB write fails
        }

        this.lastStateName = currentStateName;

        // Start or stop streaming based on new state
        await this.updateStreamingForState(currentStateName);

        // Check if reached terminal state (no outgoing transitions)
        if (this.isTerminalState(currentStateName)) {
          console.log(`[${this.symbol}] ⚠️  Reached terminal state: ${currentStateName} (strategy will be auto-closed)`);

          // System event for operator visibility
          if (this.brokerEnv.auditEvent) {
            this.brokerEnv.auditEvent({
              component: 'StrategyInstance',
              level: 'info',
              message: `Strategy reached terminal state: ${currentStateName}`,
              metadata: {
                strategyId: this.strategyId,
                symbol: this.symbol,
                terminalState: currentStateName,
                autoClose: true,
              },
            });
          }

          // Database audit log for terminal state
          try {
            await this.strategyRepo.createAuditLog({
              strategyId: this.strategyId,
              eventType: 'STATUS_CHANGED',
              changeReason: `Strategy reached terminal state: ${currentStateName}`,
              metadata: {
                terminalState: currentStateName,
                autoClose: true,
                barsProcessed: this.barsProcessedSinceActivation,
                timestamp: new Date(bar.timestamp).toISOString(),
              },
            });
          } catch (error) {
            console.error(`[${this.symbol}] Failed to log terminal state audit:`, error);
          }
        }
      }

      // Persist any new orders to database (after state transitions)
      await this.persistNewOrders(currentState);
    }
  }

  /**
   * Persist orders that haven't been saved to database yet
   */
  private async persistNewOrders(state: StrategyRuntimeState): Promise<void> {
    const newOrders = state.openOrders.filter(order => !this.persistedOrderIds.has(order.id));

    if (newOrders.length === 0) {
      return;
    }

    console.log(`[${this.symbol}] Persisting ${newOrders.length} new order(s) to database`);

    for (const order of newOrders) {
      try {
        // Filter out invalid numeric values (Infinity, NaN, Number.MAX_VALUE)
        const limitPrice = isFinite(order.limitPrice ?? NaN) ? order.limitPrice : undefined;
        const stopPrice = isFinite(order.stopPrice ?? NaN) ? order.stopPrice : undefined;

        // Log warning if invalid values detected
        if (order.limitPrice !== undefined && !isFinite(order.limitPrice)) {
          console.warn(`[${this.symbol}] Order ${order.id} has invalid limitPrice: ${order.limitPrice}`);
        }
        if (order.stopPrice !== undefined && !isFinite(order.stopPrice)) {
          console.warn(`[${this.symbol}] Order ${order.id} has invalid stopPrice: ${order.stopPrice}`);
        }

        await this.orderRepo.create({
          brokerOrderId: order.brokerOrderId || order.id,
          planId: order.planId,
          strategyId: this.strategyId,
          symbol: order.symbol,
          side: order.side.toUpperCase() as any, // Map 'buy' → 'BUY', 'sell' → 'SELL'
          qty: order.qty,
          type: order.type.toUpperCase() as any, // Map 'limit' → 'LIMIT', 'market' → 'MARKET'
          limitPrice,
          stopPrice,
        });

        // Create audit log entry for order submission
        await this.orderRepo.createAuditLog({
          brokerOrderId: order.brokerOrderId || order.id,
          strategyId: this.strategyId,
          eventType: 'SUBMITTED',
        });

        this.persistedOrderIds.add(order.id);
        console.log(`[${this.symbol}] ✓ Persisted order ${order.id} (${order.side} ${order.qty} @ ${order.type})`);
      } catch (error) {
        console.error(`[${this.symbol}] Failed to persist order ${order.id}:`, error);
        // Don't fail bar processing if order persistence fails
      }
    }
  }

  /**
   * Check if a state is terminal (no outgoing transitions)
   */
  private isTerminalState(stateName: string): boolean {
    // A state is terminal if there are no transitions FROM it
    const hasOutgoingTransitions = this.ir.transitions.some(
      (t) => t.from === stateName
    );
    return !hasOutgoingTransitions;
  }

  /**
   * Check if a state requires real-time bar streaming
   */
  private needsStreaming(stateName: string): boolean {
    // States that benefit from real-time updates:
    // - "armed": Waiting for trigger condition
    // - "managing": Position open, monitoring for exit
    // - "placed": Order placed, waiting for fill
    // - "trigger": Already triggered, about to enter position
    // - "exited": Trade complete, may re-arm for next opportunity
    //
    // Note: Strategies should stream in ALL active states except "idle"
    // to ensure they receive real-time bar updates for condition evaluation
    const streamingStates = ['armed', 'managing', 'placed', 'trigger', 'position_open', 'position_monitoring', 'exited'];

    return streamingStates.some((s) => stateName.toLowerCase().includes(s.toLowerCase()));
  }

  /**
   * Update streaming subscription based on current state
   */
  private async updateStreamingForState(stateName: string): Promise<void> {
    const shouldStream = this.needsStreaming(stateName);

    if (shouldStream && !this.isStreaming) {
      await this.startStreaming();
    } else if (!shouldStream && this.isStreaming) {
      await this.stopStreaming();
    }
  }

  /**
   * Start real-time bar streaming for this strategy's symbol
   */
  private async startStreaming(): Promise<void> {
    if (this.isStreaming || !this.streamingClient) {
      return;
    }

    try {
      console.log(`[${this.symbol}] 📡 Starting real-time bar streaming (state: ${this.lastStateName})`);

      await this.streamingClient.subscribe({
        symbol: this.symbol,
        period: this.ir.timeframe,
        session: 'rth',
        what: 'TRADES',
      });

      this.isStreaming = true;
    } catch (error: any) {
      console.error(`[${this.symbol}] ❌ Failed to start streaming: ${error.message}`);
    }
  }

  /**
   * Stop real-time bar streaming for this strategy's symbol
   */
  private async stopStreaming(): Promise<void> {
    if (!this.isStreaming || !this.streamingClient) {
      return;
    }

    try {
      console.log(`[${this.symbol}] 🛑 Stopping real-time bar streaming (state: ${this.lastStateName})`);

      await this.streamingClient.unsubscribe(this.symbol);

      this.isStreaming = false;
    } catch (error: any) {
      console.error(`[${this.symbol}] ❌ Failed to stop streaming: ${error.message}`);
    }
  }

  /**
   * Set streaming client (called by orchestrator)
   */
  setStreamingClient(client: RealtimeBarClient): void {
    this.streamingClient = client;
  }

  /**
   * Get streaming status
   */
  getStreamingStatus(): { enabled: boolean; active: boolean } {
    return {
      enabled: this.streamingClient !== null,
      active: this.isStreaming,
    };
  }

  /**
   * Check if strategy has reached a terminal state (no outgoing transitions)
   * Orchestrator should close these strategies in the database
   */
  isInTerminalState(): boolean {
    if (!this.lastStateName) {
      return false;
    }
    return this.isTerminalState(this.lastStateName);
  }

  /**
   * Get current FSM state name
   */
  getCurrentStateName(): string | null {
    return this.lastStateName;
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
   * Fetch open orders from broker
   */
  async getOpenOrders(): Promise<Order[]> {
    return this.brokerAdapter.getOpenOrders(this.symbol, this.brokerEnv);
  }

  /**
   * Submit a market order to close an open position
   */
  async closePositionMarket(quantity: number): Promise<Order> {
    const side = quantity > 0 ? 'sell' : 'buy';
    const qty = Math.abs(quantity);

    if (qty === 0) {
      throw new Error('Cannot close position with zero quantity');
    }

    console.log(`Submitting market exit for ${this.symbol}: ${side} ${qty}`);
    return this.brokerAdapter.submitMarketOrder(
      this.symbol,
      qty,
      side,
      this.brokerEnv
    );
  }

  /**
   * Shutdown strategy (with audit log)
   */
  async shutdown(): Promise<void> {
    console.log(`Shutting down strategy: ${this.strategyName} for ${this.symbol}`);

    // Stop streaming if active
    if (this.isStreaming) {
      await this.stopStreaming();
    }

    // Log shutdown to execution history
    try {
      await this.execHistoryRepo.logDeactivation(
        this.strategyId,
        'Strategy instance shutdown'
      );
    } catch (error) {
      console.error(`[${this.symbol}] Failed to log shutdown:`, error);
    }

    // Create strategy audit log for shutdown
    try {
      await this.strategyRepo.createAuditLog({
        strategyId: this.strategyId,
        eventType: 'STATUS_CHANGED',
        changeReason: 'Strategy instance shutdown',
        metadata: {
          barsProcessedSinceActivation: this.barsProcessedSinceActivation,
          lastState: this.lastStateName,
        },
      });
    } catch (error) {
      console.error(`[${this.symbol}] Failed to create shutdown audit log:`, error);
    }

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
  getPerformanceMetrics(): {
    barsActive: number;
    barsActiveSinceActivation: number;
    ordersPlaced: number;
    activatedAt: Date;
  } {
    const state = this.getState();
    return {
      barsActive: state.barCount,  // Total bars (including historical replay)
      barsActiveSinceActivation: this.barsProcessedSinceActivation,  // Real-time only
      ordersPlaced: state.openOrders.length,
      activatedAt: this.activatedAt,
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
   * Get compiled IR (for force deploy)
   * Exposes internal IR to allow external order submission
   */
  getCompiledIR(): CompiledIR {
    if (!this.initialized) {
      throw new Error('Strategy not initialized');
    }
    return this.ir;
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
    // If orchestrator loop interval override is set, always fetch bars on every loop iteration
    const loopOverride = process.env.ORCHESTRATOR_LOOP_INTERVAL_MS;
    if (loopOverride) {
      const interval = parseInt(loopOverride, 10);
      if (!isNaN(interval) && interval > 0) {
        const now = Date.now();
        const elapsed = now - this.lastBarFetchTime;
        return elapsed >= interval; // Use override interval instead of timeframe
      }
    }

    // Normal behavior: respect strategy timeframe
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
