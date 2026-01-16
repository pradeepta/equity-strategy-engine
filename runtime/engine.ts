/**
 * Trading Strategy Runtime Engine
 * FSM-based bar processing and action execution
 */
import {
  Bar,
  CompiledIR,
  StrategyRuntimeState,
  StrategyState,
  StateTransition,
  Order,
  Action,
  FeatureValue,
  EvaluationContext,
  FeatureComputeContext,
} from '../spec/types';
import { evaluateCondition } from './eval';
import { TimerManager } from './timers';
import { FeatureRegistry } from '../features/registry';
import { BrokerAdapter, BrokerEnvironment } from '../spec/types';

// ============================================================================
// Runtime Engine
// ============================================================================

export class StrategyEngine {
  private state: StrategyRuntimeState;
  private timers: TimerManager;
  private barHistory: Bar[] = [];
  private replayMode: boolean = false;

  constructor(
    private ir: CompiledIR,
    private featureRegistry: FeatureRegistry,
    private brokerAdapter: BrokerAdapter,
    private brokerEnv: BrokerEnvironment
  ) {
    this.timers = new TimerManager();
    this.state = {
      symbol: ir.symbol,
      currentState: ir.initialState,
      barCount: 0,
      currentBar: null,
      features: new Map(),
      openOrders: [],
      timers: new Map(),
      log: [],
    };
  }

  /**
   * Process a bar close event
   */
  async processBar(
    bar: Bar,
    options?: { replay?: boolean }
  ): Promise<void> {
    this.replayMode = options?.replay ?? false;

    try {
      this.state.barCount++;
      this.state.currentBar = bar;
      this.barHistory.push(bar);

      // Compute features for this bar
      await this.computeFeatures(bar);

      // Tick timers
      this.timers.tick();
      this._updateStateTimers();

      // Evaluate transitions from current state
      await this.evaluateTransitions();
    } finally {
      this.replayMode = false;
    }
  }

  /**
   * Compute all features for the current bar
   */
  private async computeFeatures(bar: Bar): Promise<void> {
    const newFeatures = new Map<string, FeatureValue>();

    for (const feature of this.ir.featurePlan) {
      try {
        let value: FeatureValue;

        // Builtin features
        if (feature.type === 'builtin' && feature.builtinName) {
          value = (bar as any)[feature.builtinName];
        } else if (feature.compute) {
          // Indicator or microstructure
          const ctx: FeatureComputeContext = {
            bar,
            history: this.barHistory.slice(0, -1), // Exclude current bar
            features: newFeatures,
            now: Date.now(),
          };
          value = feature.compute(ctx);
        } else {
          throw new Error(`No computation for feature: ${feature.name}`);
        }

        newFeatures.set(feature.name, value);
      } catch (e) {
        const err = e as Error;
        this.log('error', `Failed to compute ${feature.name}: ${err.message}`);
      }
    }

    this.state.features = newFeatures;
  }

  /**
   * Evaluate all transitions from current state
   */
  private async evaluateTransitions(): Promise<void> {
    const possibleTransitions = this.ir.transitions.filter(
      (t) => t.from === this.state.currentState
    );

    for (const transition of possibleTransitions) {
      if (await this.evaluateCondition(transition.when)) {
        // Transition triggered!
        this.log('info', `Transition: ${transition.from} -> ${transition.to}`);
        this.state.currentState = transition.to;

        // Execute actions
        for (const action of transition.actions) {
          await this.executeAction(action);
        }

        // Only one transition per bar
        break;
      }
    }
  }

  /**
   * Evaluate a condition expression
   */
  private async evaluateCondition(condition: any): Promise<boolean> {
    try {
      const ctx: EvaluationContext = {
        features: this.state.features,
        builtins: new Map([
          ['open', this.state.currentBar?.open || 0],
          ['high', this.state.currentBar?.high || 0],
          ['low', this.state.currentBar?.low || 0],
          ['close', this.state.currentBar?.close || 0],
          ['volume', this.state.currentBar?.volume || 0],
          ['price', this.state.currentBar?.close || 0],
        ]),
        functions: new Map<string, (args: FeatureValue[]) => FeatureValue>([
          [
            'in_range',
            (args: FeatureValue[]) => {
              if (args.length !== 3) return 0;
              const [value, min, max] = args as number[];
              return value >= min && value <= max ? 1 : 0;
            },
          ],
          [
            'clamp',
            (args: FeatureValue[]) => {
              if (args.length !== 3) return 0;
              const [value, min, max] = args as number[];
              return Math.max(min, Math.min(max, value));
            },
          ],
          [
            'abs',
            (args: FeatureValue[]) => {
              if (args.length !== 1) return 0;
              return Math.abs(args[0] as number);
            },
          ],
          [
            'min',
            (args: FeatureValue[]) => {
              return Math.min(...(args as number[]));
            },
          ],
          [
            'max',
            (args: FeatureValue[]) => {
              return Math.max(...(args as number[]));
            },
          ],
          [
            'round',
            (args: FeatureValue[]) => {
              if (args.length < 1 || args.length > 2) return 0;
              const [value, decimals = 0] = args as number[];
              const mult = Math.pow(10, decimals);
              return Math.round((value as number) * mult) / mult;
            },
          ],
        ]),
      };

      return evaluateCondition(condition, ctx);
    } catch (e) {
      const err = e as Error;
      this.log('error', `Condition evaluation error: ${err.message}`);
      return false;
    }
  }

  /**
   * Execute an action
   */
  private async executeAction(action: Action): Promise<void> {
    try {
      switch (action.type) {
        case 'start_timer':
          if (action.barCount) {
            this.timers.startTimer('entry_timeout', action.barCount);
            this.log('info', `Started timer: ${action.barCount} bars`);
          }
          break;

        case 'submit_order_plan':
          if (this.replayMode) {
            this.log(
              'info',
              `Replay mode active - skipping order plan submission${action.planId ? ` (${action.planId})` : ''}`
            );
            return;
          }
          if (action.planId) {
            const plan = this.ir.orderPlans.find((p) => p.id === action.planId);
            if (plan) {
              // CRITICAL: Always cancel any existing pending entry orders before placing new ones
              // This prevents duplicate orders when strategy retriggers
              if (this.state.openOrders.length > 0) {
                this.log('info', `Cancelling ${this.state.openOrders.length} existing order(s) before placing new order plan`);

                const cancelResult = await this.brokerAdapter.cancelOpenEntries(
                  this.ir.symbol,
                  this.state.openOrders,
                  this.brokerEnv
                );

                // CRITICAL: Verify cancellation succeeded before proceeding
                if (cancelResult.failed.length > 0) {
                  const failedIds = cancelResult.failed.map(f => f.orderId).join(', ');
                  const reasons = cancelResult.failed.map(f => f.reason).join('; ');
                  this.log('error', `Failed to cancel orders: ${failedIds}. Reasons: ${reasons}`);

                  // DO NOT proceed with new order submission
                  throw new Error(
                    `Cannot place new orders - cancellation failed for: ${failedIds}`
                  );
                }

                // Only clear state if cancellation succeeded
                this.state.openOrders = this.state.openOrders.filter(
                  o => !cancelResult.succeeded.includes(o.id)
                );

                this.log('info', `Successfully cancelled ${cancelResult.succeeded.length} orders`);
              }

              // Now safe to submit the new order plan
              const orders = await this.brokerAdapter.submitOrderPlan(
                plan,
                this.brokerEnv
              );
              this.state.openOrders.push(...orders);
              this.log('info', `Submitted order plan: ${action.planId}`, {
                ordersCount: orders.length,
              });
            }
          }
          break;

        case 'cancel_entries':
          if (this.replayMode) {
            this.log('info', 'Replay mode active - skipping order cancellation');
            return;
          }
          if (this.state.openOrders.length > 0) {
            const cancelResult = await this.brokerAdapter.cancelOpenEntries(
              this.ir.symbol,
              this.state.openOrders,
              this.brokerEnv
            );

            // Verify cancellation succeeded
            if (cancelResult.failed.length > 0) {
              const failedIds = cancelResult.failed.map(f => f.orderId).join(', ');
              const reasons = cancelResult.failed.map(f => f.reason).join('; ');
              this.log('error', `Failed to cancel orders: ${failedIds}. Reasons: ${reasons}`);
              throw new Error(`Order cancellation failed for: ${failedIds}`);
            }

            // Only clear successfully cancelled orders
            this.state.openOrders = this.state.openOrders.filter(
              o => !cancelResult.succeeded.includes(o.id)
            );

            this.log('info', `Cancelled ${cancelResult.succeeded.length} entries`);
          }
          break;

        case 'log':
          if (action.message) {
            this.log('info', action.message);
          }
          break;

        case 'noop':
          // Do nothing
          break;
      }
    } catch (e) {
      const err = e as Error;
      this.log('error', `Action execution error: ${err.message}`);
    }
  }

  /**
   * Internal: sync runtime timers to state for access
   */
  private _updateStateTimers(): void {
    this.state.timers = this.timers.getAllTimers();
  }

  /**
   * Log a message
   */
  private log(
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>
  ): void {
    const entry = {
      timestamp: Date.now(),
      barNum: this.state.barCount,
      level,
      message,
      data,
    };
    this.state.log.push(entry);
    console.log(
      `[Bar ${this.state.barCount}] [${level.toUpperCase()}] ${message}`,
      data ? JSON.stringify(data) : ''
    );
  }

  /**
   * Get current state
   */
  getState(): StrategyRuntimeState {
    return { ...this.state };
  }

  /**
   * Get bar history
   */
  getHistory(): Bar[] {
    return [...this.barHistory];
  }

  /**
   * Reset engine
   */
  reset(): void {
    this.barHistory = [];
    this.timers.clearAll();
    this.state = {
      symbol: this.ir.symbol,
      currentState: this.ir.initialState,
      barCount: 0,
      currentBar: null,
      features: new Map(),
      openOrders: [],
      timers: new Map(),
      log: [],
    };
  }
}
