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
  private featureHistory: Map<string, FeatureValue[]> = new Map();
  private replayMode: boolean = false;
  private readonly MAX_BAR_HISTORY: number; // Keep last N bars in memory
  private readonly MAX_FEATURE_HISTORY = 100; // Keep last 100 bars of history

  constructor(
    private ir: CompiledIR,
    private featureRegistry: FeatureRegistry,
    private brokerAdapter: BrokerAdapter,
    private brokerEnv: BrokerEnvironment
  ) {
    this.timers = new TimerManager();

    // Read MAX_BAR_HISTORY from environment variable (default: 200 bars)
    // Most indicators (e.g., SMA200) need at most 200 bars
    this.MAX_BAR_HISTORY = parseInt(process.env.ENGINE_MAX_BAR_HISTORY || '200', 10);

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

      // Keep only last MAX_BAR_HISTORY bars to prevent unbounded memory growth
      if (this.barHistory.length > this.MAX_BAR_HISTORY) {
        this.barHistory.shift(); // Remove oldest bar
      }

      // Sync open orders from broker if engine's state is empty but orders might exist
      // This handles force-deployed orders or orders placed by other systems
      if (this.state.openOrders.length === 0 && !this.replayMode) {
        await this.syncOpenOrdersFromBroker();
      }

      // Compute features for this bar
      await this.computeFeatures(bar);

      // Tick timers
      this.timers.tick();
      this._updateStateTimers();

      // Evaluate transitions from current state
      await this.evaluateTransitions();

      // Log summary after bar processing (only in live mode)
      if (!this.replayMode) {
        this.log('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      }
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

        // Store feature history for array indexing support
        if (!this.featureHistory.has(feature.name)) {
          this.featureHistory.set(feature.name, []);
        }
        const history = this.featureHistory.get(feature.name)!;
        history.push(value);

        // Keep only last MAX_FEATURE_HISTORY bars to manage memory
        if (history.length > this.MAX_FEATURE_HISTORY) {
          history.shift();
        }
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

    // Log current state and bar info
    const bar = this.state.currentBar;
    if (!this.replayMode) {
      this.log('info', `[${this.state.symbol}] State: ${this.state.currentState} | Bar #${this.state.barCount} | Price: $${bar?.close.toFixed(2)} | Vol: ${bar?.volume}`);
    }

    for (const transition of possibleTransitions) {
      const conditionLabel = this.getTransitionLabel(transition.from, transition.to);
      const result = await this.evaluateConditionWithLogging(transition.when, conditionLabel);

      if (result) {
        // Detect special events
        const isInvalidation = transition.from === 'MANAGING' && transition.to === 'EXITED';
        const isTrigger = transition.from === 'ARMED' && transition.to === 'PLACED';

        // Transition triggered!
        if (isInvalidation) {
          this.log('info', `🚨 ${conditionLabel} TRIGGERED → Transition: ${transition.from} -> ${transition.to}`);
        } else if (isTrigger) {
          this.log('info', `📍 ${conditionLabel} TRIGGERED → Transition: ${transition.from} -> ${transition.to}`);
        } else {
          this.log('info', `✅ ${conditionLabel} PASSED → Transition: ${transition.from} -> ${transition.to}`);
        }

        // Audit log for state transitions (especially important in replay mode)
        if (this.replayMode) {
          this.brokerEnv.auditEvent?.({
            component: 'StrategyEngine',
            level: 'info',
            message: `Replay mode state transition: ${transition.from} -> ${transition.to}`,
            metadata: {
              symbol: this.ir.symbol,
              barCount: this.state.barCount,
              fromState: transition.from,
              toState: transition.to,
              replayMode: true,
              timestamp: this.state.currentBar?.timestamp,
              price: this.state.currentBar?.close,
              invalidation: isInvalidation,
            },
          });
        }

        // Audit log for invalidation events (in both live and replay mode)
        if (isInvalidation) {
          this.brokerEnv.auditEvent?.({
            component: 'StrategyEngine',
            level: 'warn',
            message: 'Strategy invalidated - exit condition triggered',
            metadata: {
              symbol: this.ir.symbol,
              barCount: this.state.barCount,
              replayMode: this.replayMode,
              timestamp: this.state.currentBar?.timestamp,
              price: this.state.currentBar?.close,
              openOrdersCount: this.state.openOrders.length,
              features: Object.fromEntries(this.state.features),
            },
          });
        }

        this.state.currentState = transition.to;

        // Execute actions
        for (const action of transition.actions) {
          await this.executeAction(action);
        }

        // Only one transition per bar
        break;
      } else {
        // Condition not yet met - this is normal operation (only log in non-replay mode)
        if (!this.replayMode) {
          this.log('debug', `⏳ ${conditionLabel} (waiting for condition)`);
        }
      }
    }
  }

  /**
   * Get human-readable label for transition
   */
  private getTransitionLabel(from: string, to: string): string {
    if (from === 'IDLE' && to === 'ARMED') return 'ARM';
    if (from === 'ARMED' && to === 'TRIGGERED') return 'TRIGGER';
    if (from === 'TRIGGERED' && to === 'MANAGING') return 'ENTRY';
    if (from === 'MANAGING' && to === 'EXITED') return 'INVALIDATE';
    if (from === 'ARMED' && to === 'IDLE') return 'DISARM';
    return `${from}->${to}`;
  }

  /**
   * Evaluate condition with detailed logging
   */
  private async evaluateConditionWithLogging(condition: any, label: string): Promise<boolean> {
    try {
      const result = await this.evaluateCondition(condition);

      // Identify important transition types
      const isTrigger = label === 'TRIGGER' || label.includes('->PLACED') || label === 'ARMED->PLACED';
      const isInvalidate = label === 'INVALIDATE';
      const isDisarm = label === 'DISARM' || label.includes('DISARM');
      const isImportant = isTrigger || isInvalidate || isDisarm;

      // Log feature values for important transitions, even when they fail
      // Use sampling to reduce log spam: log every 20th failure
      const shouldLogSuccess = !this.replayMode && result;
      const shouldLogFailure = !this.replayMode && !result && isImportant && (this.state.barCount % 20 === 0);
      const shouldLog = shouldLogSuccess || shouldLogFailure;

      if (shouldLog) {
        const relevantFeatures = this.extractRelevantFeatures(condition);
        const featureValues: Record<string, number | string> = {};

        for (const name of relevantFeatures) {
          if (this.state.features.has(name)) {
            featureValues[name] = this.state.features.get(name) as number;
          } else if (this.state.timers.has(name)) {
            // Include timer values (e.g., "entry_timer")
            const timerValue = this.state.timers.get(name);
            featureValues[name] = `${timerValue} bars`;
          } else if (this.state.currentBar) {
            const bar = this.state.currentBar;
            if (name === 'close') featureValues[name] = bar.close;
            else if (name === 'open') featureValues[name] = bar.open;
            else if (name === 'high') featureValues[name] = bar.high;
            else if (name === 'low') featureValues[name] = bar.low;
            else if (name === 'volume') featureValues[name] = bar.volume;
            else if (name === 'price') featureValues[name] = bar.close;
          }
        }

        if (Object.keys(featureValues).length > 0) {
          const valuesStr = Object.entries(featureValues)
            .map(([k, v]) => {
              if (typeof v === 'number') {
                return `${k}=${v.toFixed(2)}`;
              } else {
                return `${k}=${v}`;
              }
            })
            .join(', ');

          // Better status message: "✓" for met, "⏳" for waiting
          const status = result ? '✓ MET' : '⏳ WAITING';
          const logLevel = result ? 'info' : 'debug';
          this.log(logLevel, `  [${label}] ${status}: ${valuesStr}`);
        }
      }

      return result;
    } catch (error) {
      const err = error as Error;
      this.log('error', `Failed to evaluate ${label}: ${err.message}`);
      return false;
    }
  }

  /**
   * Extract feature/variable names from condition expression
   */
  private extractRelevantFeatures(condition: any): Set<string> {
    const features = new Set<string>();

    const traverse = (node: any) => {
      if (!node) return;

      if (node.type === 'identifier' && node.name) {
        features.add(node.name);
      }
      if (node.left) traverse(node.left);
      if (node.right) traverse(node.right);
      if (node.argument) traverse(node.argument);
      if (node.arguments) {
        for (const arg of node.arguments) {
          traverse(arg);
        }
      }
    };

    traverse(condition);
    return features;
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
        featureHistory: this.featureHistory,
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
            this.brokerEnv.auditEvent?.({
              component: 'StrategyEngine',
              level: 'info',
              message: 'Replay mode - simulated order plan submission',
              metadata: {
                symbol: this.ir.symbol,
                planId: action.planId,
                barCount: this.state.barCount,
                replayMode: true,
                price: this.state.currentBar?.close,
                timestamp: this.state.currentBar?.timestamp,
              },
            });
            return;
          }
          if (action.planId) {
            const plan = this.ir.orderPlans.find((p) => p.id === action.planId);
            if (plan) {
              if (this.brokerEnv.allowLiveOrders === false) {
                this.log('warn', 'Live order submission blocked by kill switch');
                this.brokerEnv.auditEvent?.({
                  component: 'StrategyEngine',
                  level: 'warn',
                  message: 'Live order submission blocked by kill switch',
                  metadata: {
                    symbol: this.ir.symbol,
                    planId: action.planId,
                  },
                });
                return;
              }

              if (
                this.brokerEnv.dailyLossLimit !== undefined &&
                this.brokerEnv.currentDailyPnL !== undefined &&
                this.brokerEnv.currentDailyPnL <= -this.brokerEnv.dailyLossLimit
              ) {
                this.log('warn', 'Live order submission blocked by daily loss limit', {
                  currentDailyPnL: this.brokerEnv.currentDailyPnL,
                  dailyLossLimit: this.brokerEnv.dailyLossLimit,
                });
                this.brokerEnv.auditEvent?.({
                  component: 'StrategyEngine',
                  level: 'warn',
                  message: 'Live order submission blocked by daily loss limit',
                  metadata: {
                    symbol: this.ir.symbol,
                    planId: action.planId,
                    currentDailyPnL: this.brokerEnv.currentDailyPnL,
                    dailyLossLimit: this.brokerEnv.dailyLossLimit,
                  },
                });
                return;
              }

              const expectedNewOrders = plan.brackets.length > 0 ? plan.brackets.length : 1;
              if (
                this.brokerEnv.maxOrdersPerSymbol !== undefined &&
                (this.state.openOrders.length + expectedNewOrders) > this.brokerEnv.maxOrdersPerSymbol
              ) {
                this.log('warn', 'Live order submission blocked by maxOrdersPerSymbol', {
                  currentOpenOrders: this.state.openOrders.length,
                  expectedNewOrders,
                  maxOrdersPerSymbol: this.brokerEnv.maxOrdersPerSymbol,
                });
                this.brokerEnv.auditEvent?.({
                  component: 'StrategyEngine',
                  level: 'warn',
                  message: 'Live order submission blocked by maxOrdersPerSymbol',
                  metadata: {
                    symbol: this.ir.symbol,
                    planId: action.planId,
                    currentOpenOrders: this.state.openOrders.length,
                    expectedNewOrders,
                    maxOrdersPerSymbol: this.brokerEnv.maxOrdersPerSymbol,
                  },
                });
                return;
              }

              if (
                this.brokerEnv.maxOrderQty !== undefined &&
                plan.qty > this.brokerEnv.maxOrderQty
              ) {
                this.log('warn', 'Live order submission blocked by maxOrderQty', {
                  orderQty: plan.qty,
                  maxOrderQty: this.brokerEnv.maxOrderQty,
                });
                this.brokerEnv.auditEvent?.({
                  component: 'StrategyEngine',
                  level: 'warn',
                  message: 'Live order submission blocked by maxOrderQty',
                  metadata: {
                    symbol: this.ir.symbol,
                    planId: action.planId,
                    orderQty: plan.qty,
                    maxOrderQty: this.brokerEnv.maxOrderQty,
                  },
                });
                return;
              }

              if (this.brokerEnv.maxNotionalPerSymbol !== undefined) {
                const notional = plan.qty * plan.targetEntryPrice;
                if (notional > this.brokerEnv.maxNotionalPerSymbol) {
                  this.log('warn', 'Live order submission blocked by maxNotionalPerSymbol', {
                    notional,
                    maxNotionalPerSymbol: this.brokerEnv.maxNotionalPerSymbol,
                  });
                  this.brokerEnv.auditEvent?.({
                    component: 'StrategyEngine',
                    level: 'warn',
                    message: 'Live order submission blocked by maxNotionalPerSymbol',
                    metadata: {
                      symbol: this.ir.symbol,
                      planId: action.planId,
                      notional,
                      maxNotionalPerSymbol: this.brokerEnv.maxNotionalPerSymbol,
                    },
                  });
                  return;
                }
              }

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

              // Log order plan details before submission
              this.log('info', `📤 Submitting order plan: ${plan.id} | Side: ${plan.side} | Qty: ${plan.qty} | Entry: [${plan.entryZone[0]}, ${plan.entryZone[1]}] | Stop: ${plan.stopPrice}`);

              // Apply buying power-based position sizing if enabled
              let finalPlan = plan;
              if (this.brokerEnv.enableDynamicSizing && this.brokerEnv.buyingPower) {
                const buyingPowerFactor = this.brokerEnv.buyingPowerFactor || 0.75; // Default 75%
                const adjustedBuyingPower = this.brokerEnv.buyingPower * buyingPowerFactor;
                const entryPrice = plan.targetEntryPrice;

                // Calculate max shares based on adjusted buying power
                let maxSharesByBuyingPower = Math.floor(adjustedBuyingPower / entryPrice);

                // Apply additional limits
                const limits: string[] = [];

                // Apply YAML max shares
                if (maxSharesByBuyingPower > plan.qty) {
                  maxSharesByBuyingPower = plan.qty;
                  limits.push(`YAML max (${plan.qty})`);
                } else {
                  limits.push(`${(buyingPowerFactor * 100).toFixed(0)}% buying power`);
                }

                // Apply MAX_ORDER_QTY if set
                if (this.brokerEnv.maxOrderQty !== undefined && maxSharesByBuyingPower > this.brokerEnv.maxOrderQty) {
                  maxSharesByBuyingPower = this.brokerEnv.maxOrderQty;
                  limits.push(`MAX_ORDER_QTY (${this.brokerEnv.maxOrderQty})`);
                }

                // Apply MAX_NOTIONAL if set
                if (this.brokerEnv.maxNotionalPerSymbol !== undefined) {
                  const maxSharesByNotional = Math.floor(this.brokerEnv.maxNotionalPerSymbol / entryPrice);
                  if (maxSharesByBuyingPower > maxSharesByNotional) {
                    maxSharesByBuyingPower = maxSharesByNotional;
                    limits.push(`MAX_NOTIONAL ($${this.brokerEnv.maxNotionalPerSymbol})`);
                  }
                }

                // Ensure at least 1 share if affordable
                if (maxSharesByBuyingPower < 1) {
                  this.log('error', `Position sizing resulted in 0 shares`, {
                    adjustedBuyingPower: adjustedBuyingPower.toFixed(2),
                    entryPrice: entryPrice.toFixed(2),
                    buyingPowerFactor: `${(buyingPowerFactor * 100).toFixed(0)}%`,
                  });
                  this.brokerEnv.auditEvent?.({
                    component: 'StrategyEngine',
                    level: 'error',
                    message: 'Position sizing resulted in 0 shares - insufficient buying power',
                    metadata: {
                      symbol: this.ir.symbol,
                      planId: action.planId,
                      totalBuyingPower: this.brokerEnv.buyingPower,
                      adjustedBuyingPower,
                      entryPrice,
                      buyingPowerFactor,
                    },
                  });
                  return;
                }

                const notionalValue = maxSharesByBuyingPower * entryPrice;
                const utilizationPercent = (notionalValue / this.brokerEnv.buyingPower) * 100;

                // Create modified plan
                finalPlan = { ...plan, qty: maxSharesByBuyingPower };

                // Alert user about quantity adjustment
                const wasAdjusted = maxSharesByBuyingPower !== plan.qty;
                const alertLevel = wasAdjusted ? 'warn' : 'info';
                const alertEmoji = wasAdjusted ? '⚠️' : '✅';

                this.log(alertLevel, `${alertEmoji} Position Size ${wasAdjusted ? 'ADJUSTED' : 'Applied'}:`, {
                  originalQty: plan.qty,
                  finalQty: maxSharesByBuyingPower,
                  notionalValue: notionalValue.toFixed(2),
                  buyingPower: this.brokerEnv.buyingPower.toFixed(2),
                  adjustedBuyingPower: adjustedBuyingPower.toFixed(2),
                  utilizationPercent: `${utilizationPercent.toFixed(1)}%`,
                  appliedLimits: limits.join(', '),
                  reason: wasAdjusted ? 'Respecting portfolio buying power' : 'Within buying power limits',
                });

                this.brokerEnv.auditEvent?.({
                  component: 'StrategyEngine',
                  level: wasAdjusted ? 'warn' : 'info',
                  message: wasAdjusted
                    ? `Quantity adjusted from ${plan.qty} to ${maxSharesByBuyingPower} to respect buying power`
                    : 'Position size within buying power limits',
                  metadata: {
                    symbol: this.ir.symbol,
                    planId: action.planId,
                    originalQty: plan.qty,
                    finalQty: maxSharesByBuyingPower,
                    notionalValue,
                    totalBuyingPower: this.brokerEnv.buyingPower,
                    adjustedBuyingPower,
                    buyingPowerFactor,
                    utilizationPercent,
                    appliedLimits: limits,
                  },
                });
              } else if (this.brokerEnv.buyingPower !== undefined) {
                // Even if dynamic sizing is disabled, validate buying power
                const requiredCapital = plan.qty * plan.targetEntryPrice;
                if (requiredCapital > this.brokerEnv.buyingPower) {
                  this.log('error', `⛔ Order BLOCKED - Insufficient buying power`, {
                    requiredCapital: requiredCapital.toFixed(2),
                    availableBuyingPower: this.brokerEnv.buyingPower.toFixed(2),
                    shortfall: (requiredCapital - this.brokerEnv.buyingPower).toFixed(2),
                  });
                  this.brokerEnv.auditEvent?.({
                    component: 'StrategyEngine',
                    level: 'error',
                    message: 'Order blocked - insufficient buying power',
                    metadata: {
                      symbol: this.ir.symbol,
                      planId: action.planId,
                      qty: plan.qty,
                      entryPrice: plan.targetEntryPrice,
                      requiredCapital,
                      buyingPower: this.brokerEnv.buyingPower,
                      shortfall: requiredCapital - this.brokerEnv.buyingPower,
                    },
                  });
                  return;
                }
              }

              // Now safe to submit the new order plan
              const orders = await this.brokerAdapter.submitOrderPlan(
                finalPlan,
                this.brokerEnv
              );
              this.state.openOrders.push(...orders);
              this.log('info', `✅ Successfully submitted ${orders.length} order(s) for ${action.planId}`);

              // Log individual order details
              for (const order of orders) {
                this.log('info', `  └─ Order ${order.id}: ${order.side} ${order.qty} @ ${order.type} | ${order.limitPrice ? `Limit: ${order.limitPrice}` : ''} ${order.stopPrice ? `Stop: ${order.stopPrice}` : ''}`);
              }
            }
          }
          break;

        case 'cancel_entries':
          if (this.replayMode) {
            this.log('info', 'Replay mode active - skipping order cancellation');
            this.brokerEnv.auditEvent?.({
              component: 'StrategyEngine',
              level: 'info',
              message: 'Replay mode - simulated order cancellation',
              metadata: {
                symbol: this.ir.symbol,
                barCount: this.state.barCount,
                replayMode: true,
                openOrdersCount: this.state.openOrders.length,
                timestamp: this.state.currentBar?.timestamp,
              },
            });
            return;
          }
          if (this.brokerEnv.allowCancelEntries !== true) {
            this.log('warn', 'Order cancellation blocked (cancel_entries disabled)');
            this.brokerEnv.auditEvent?.({
              component: 'StrategyEngine',
              level: 'warn',
              message: 'Order cancellation blocked (cancel_entries disabled)',
              metadata: {
                symbol: this.ir.symbol,
              },
            });
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
    level: 'info' | 'warn' | 'error' | 'debug',
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

    // Only log debug messages if DEBUG env var is set
    if (level === 'debug' && !process.env.DEBUG) {
      return;
    }

    console.log(
      `[Bar ${this.state.barCount}] [${level.toUpperCase()}] ${message}`,
      data ? JSON.stringify(data) : ''
    );
  }

  /**
   * Sync open orders from broker (handles force-deployed orders or external order placement)
   */
  private async syncOpenOrdersFromBroker(): Promise<void> {
    try {
      const brokerOrders = await this.brokerAdapter.getOpenOrders(
        this.ir.symbol,
        this.brokerEnv
      );

      if (brokerOrders.length > 0) {
        this.log('info', `Syncing ${brokerOrders.length} open order(s) from broker into engine state`);
        this.state.openOrders = brokerOrders;
      }
    } catch (error) {
      this.log('warn', `Failed to sync orders from broker: ${error}`);
      // Don't fail bar processing if sync fails
    }
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
