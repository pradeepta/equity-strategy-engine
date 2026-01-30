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
} from "../spec/types";
import { evaluateCondition } from "./eval";
import { evaluateExpression } from "../compiler/expr";
import { TimerManager } from "./timers";
import { FeatureRegistry } from "../features/registry";
import { BrokerAdapter, BrokerEnvironment } from "../spec/types";

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
  private levelsFrozen: boolean = false; // Track if dynamic levels are frozen
  // Option A: We freeze plan levels only. Rules continue to use live features.

  constructor(
    private ir: CompiledIR,
    private featureRegistry: FeatureRegistry,
    private brokerAdapter: BrokerAdapter,
    private brokerEnv: BrokerEnvironment,
    private strategyId: string = "unknown",
  ) {
    this.timers = new TimerManager();

    // Read MAX_BAR_HISTORY from environment variable (default: 200 bars)
    // Most indicators (e.g., SMA200) need at most 200 bars
    this.MAX_BAR_HISTORY = parseInt(
      process.env.ENGINE_MAX_BAR_HISTORY || "200",
      10,
    );

    this.state = {
      symbol: ir.symbol,
      currentState: ir.initialState,
      barCount: 0,
      stateBarCount: 0, // FIX 2: Track bars in current state
      currentBar: null,
      features: new Map(),
      openOrders: [],
      positionSize: 0, // FIX 3: Track net position
      timers: new Map(),
      log: [],
    };

    // Fix 2: Check if we should freeze on startup (e.g., if restoring state from DB)
    this.maybeFreezeOnStartup();
  }

  /**
   * Emit visualization event (if callback provided)
   */
  private emitVisualization(
    eventType: keyof NonNullable<BrokerEnvironment["visualizationCallback"]>,
    data: any,
  ): void {
    const callback = this.brokerEnv.visualizationCallback?.[eventType];
    if (callback && !this.replayMode) {
      // Don't emit during replay mode to avoid flooding the client
      try {
        callback(data);
      } catch (error) {
        // Silently ignore visualization errors - don't break strategy execution
      }
    }
  }

  /**
   * Process a bar close event
   */
  async processBar(bar: Bar, options?: { replay?: boolean }): Promise<void> {
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

      // Emit feature compute event
      this.emitVisualization("onFeatureCompute", {
        strategyId: this.strategyId,
        symbol: this.ir.symbol,
        features: Object.fromEntries(this.state.features),
        indicators: Array.from(this.state.features.entries()).map(
          ([name, value]) => ({
            name,
            value,
            historicalValues: this.featureHistory.get(name)?.slice(-5) || [],
          }),
        ),
      });

      // Recompute dynamic stop/target levels (if any order plans use expressions)
      this.recomputeDynamicLevels();

      // Freeze *after* levels are computed so the frozen snapshot is up-to-date.
      // Also ensures deferred freeze-on-startup actually happens.
      if (this.ir.execution.freezeLevelsOn) {
        this.checkAndFreezeLevels(this.state.currentState);
      }

      // Tick timers
      this.timers.tick();
      this._updateStateTimers();

      // Emit bar processed event
      this.emitVisualization("onBarProcessed", {
        strategyId: this.strategyId,
        symbol: this.ir.symbol,
        bar: {
          timestamp: bar.timestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        },
        state: this.state.currentState,
        stateBarCount: this.state.stateBarCount,
        positionSize: this.state.positionSize,
        openOrderCount: this.state.openOrders.length,
        replayMode: this.replayMode,
      });

      // Evaluate transitions from current state
      await this.evaluateTransitions();

      // FIX 2: Increment state bar counter AFTER transitions (prevents premature disarm checks)
      this.state.stateBarCount++;

      // Log summary after bar processing (only in live mode)
      if (!this.replayMode) {
        this.log(
          "info",
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        );
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
        if (feature.type === "builtin" && feature.builtinName) {
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
        this.log("error", `Failed to compute ${feature.name}: ${err.message}`);
      }
    }

    this.state.features = newFeatures;
  }

  /**
   * Check if dynamic levels should be frozen at this state transition
   * Freezes levels when strategy reaches the configured freeze event
   */
  private checkAndFreezeLevels(newState: StrategyState): void {
    const freezeTrigger = this.ir.execution.freezeLevelsOn;

    if (!freezeTrigger || this.levelsFrozen) {
      return; // No freeze configured or already frozen
    }

    const shouldFreeze =
      (freezeTrigger === "armed" && newState === "ARMED") ||
      (freezeTrigger === "triggered" && newState === "PLACED");

    if (shouldFreeze) {
      this.levelsFrozen = true;
      this.log(
        "info",
        `🔒 Dynamic levels FROZEN at ${freezeTrigger.toUpperCase()} event (entry zones, stops, targets will no longer update)`,
      );

      // Option A: Do not snapshot features; only plan levels are frozen.
      // Rules continue to evaluate on live features, but stop/eL/eH/targets are frozen.

      // Log frozen plan levels for debugging
      for (const plan of this.ir.orderPlans) {
        this.log(
          "debug",
          `Frozen levels for ${plan.name}: entry=[${plan.entryZone[0].toFixed(
            2,
          )}, ${plan.entryZone[1].toFixed(2)}], stop=${plan.stopPrice.toFixed(
            2,
          )}, targets=[${plan.brackets
            .map((b) => b.price.toFixed(2))
            .join(", ")}]`,
        );
      }
    }
  }

  /**
   * Check if we should freeze on startup (e.g., if restoring state from DB)
   * Called once in constructor after state is initialized
   *
   * FIX 3: Guard against freezing uninitialized plan levels
   * Only freeze if plan levels are already materialized (non-null, finite)
   */
  private maybeFreezeOnStartup(): void {
    const freezeTrigger = this.ir.execution.freezeLevelsOn;
    if (!freezeTrigger || this.levelsFrozen) {
      return;
    }

    if (freezeTrigger === "armed" && this.state.currentState === "ARMED") {
      this.checkAndFreezeLevels("ARMED");
    }

    if (freezeTrigger === "triggered" && this.state.currentState === "PLACED") {
      // Defer freeze unless plan levels look initialized
      const plan = this.ir.orderPlans?.[0];
      const initialized =
        !!plan &&
        Array.isArray(plan.entryZone) &&
        Number.isFinite(plan.entryZone[0]) &&
        Number.isFinite(plan.entryZone[1]) &&
        Number.isFinite(plan.stopPrice) &&
        (plan.brackets?.every((b: any) => Number.isFinite(b.price)) ?? true);

      if (initialized) {
        this.checkAndFreezeLevels("PLACED");
      } else {
        this.log(
          "debug",
          "Deferred freeze on startup - plan levels not yet initialized (will freeze on first bar)"
        );
      }
    }
  }

  /**
   * Recompute dynamic stop/target levels from expressions
   * This allows levels to adapt every bar based on current feature values
   *
   * Example: stopPrice: "entry - 1.2*atr" recomputes every bar
   *
   * Option A: When frozen, stop ALL level recomputation
   * This ensures invalidate rules see consistent stop/eL/eH values
   */
  private recomputeDynamicLevels(): void {
    // When frozen, stop mutating plan levels entirely
    if (this.levelsFrozen) {
      return;
    }

    for (const plan of this.ir.orderPlans) {
      // Build evaluation context with current features + special "entry" variable
      const entryPrice = plan.targetEntryPrice; // Use target as proxy until actual fill

      const context: EvaluationContext = {
        features: new Map(this.state.features),
        builtins: new Map(),
        functions: new Map(),
        featureHistory: this.featureHistory,
      };

      // Add "entry" variable (actual entry price)
      context.features.set("entry", entryPrice);

      // Recompute stop price if expression exists
      if (plan.stopPriceExpr) {
        try {
          const oldStop = plan.stopPrice;
          const newStop = evaluateExpression(
            plan.stopPriceExpr,
            context,
          ) as number;

          if (Math.abs(newStop - oldStop) > 0.01) {
            // Changed by more than 1 cent
            plan.stopPrice = newStop;
            this.log(
              "debug",
              `Dynamic stop updated: ${oldStop.toFixed(2)} → ${newStop.toFixed(
                2,
              )} (${plan.name})`,
            );
          }
        } catch (err: any) {
          this.log(
            "warn",
            `Failed to evaluate stop expression for ${plan.name}: ${err.message}`,
          );
        }
      }

      // Recompute target prices if expressions exist
      for (let i = 0; i < plan.brackets.length; i++) {
        const bracket = plan.brackets[i];
        if (bracket.priceExpr) {
          try {
            const oldPrice = bracket.price;
            const newPrice = evaluateExpression(
              bracket.priceExpr,
              context,
            ) as number;

            if (Math.abs(newPrice - oldPrice) > 0.01) {
              // Changed by more than 1 cent
              bracket.price = newPrice;
              this.log(
                "debug",
                `Dynamic target ${i + 1} updated: ${oldPrice.toFixed(
                  2,
                )} → ${newPrice.toFixed(2)} (${plan.name})`,
              );
            }
          } catch (err: any) {
            this.log(
              "warn",
              `Failed to evaluate target ${i + 1} expression for ${
                plan.name
              }: ${err.message}`,
            );
          }
        }
      }

      // Recompute entry zone if expressions exist
      if (plan.entryZoneExpr) {
        let needsUpdate = false;
        const oldZone = [...plan.entryZone];

        // Evaluate low bound expression if present
        if (plan.entryZoneExpr[0]) {
          try {
            const newLow = evaluateExpression(
              plan.entryZoneExpr[0],
              context,
            ) as number;
            if (Math.abs(newLow - plan.entryZone[0]) > 0.01) {
              // Changed by more than 1 cent
              plan.entryZone[0] = newLow;
              needsUpdate = true;
            }
          } catch (err: any) {
            this.log(
              "warn",
              `Failed to evaluate entry zone low expression for ${plan.name}: ${err.message}`,
            );
          }
        }

        // Evaluate high bound expression if present
        if (plan.entryZoneExpr[1]) {
          try {
            const newHigh = evaluateExpression(
              plan.entryZoneExpr[1],
              context,
            ) as number;
            if (Math.abs(newHigh - plan.entryZone[1]) > 0.01) {
              // Changed by more than 1 cent
              plan.entryZone[1] = newHigh;
              needsUpdate = true;
            }
          } catch (err: any) {
            this.log(
              "warn",
              `Failed to evaluate entry zone high expression for ${plan.name}: ${err.message}`,
            );
          }
        }

        // Update target entry price (midpoint) if zone changed
        if (needsUpdate) {
          plan.targetEntryPrice = (plan.entryZone[0] + plan.entryZone[1]) / 2;
          this.log(
            "debug",
            `Dynamic entry zone updated: [${oldZone[0].toFixed(
              2,
            )}, ${oldZone[1].toFixed(2)}] → [${plan.entryZone[0].toFixed(
              2,
            )}, ${plan.entryZone[1].toFixed(2)}] (${plan.name})`,
          );
        }
      }
    }
  }

  /**
   * Evaluate all transitions from current state
   */
  private async evaluateTransitions(): Promise<void> {
    const possibleTransitions = this.ir.transitions.filter(
      (t) => t.from === this.state.currentState,
    );

    // Log current state and bar info
    const bar = this.state.currentBar;
    if (!this.replayMode) {
      this.log(
        "info",
        `[${this.state.symbol}] State: ${this.state.currentState} | Bar #${
          this.state.barCount
        } | Price: $${bar?.close.toFixed(2)} | Vol: ${bar?.volume}`,
      );
    }

    for (const transition of possibleTransitions) {
      // FIX 2: Make PLACED sticky for 1 bar (prevent ARMED→PLACED→DISARM in same bar)
      const isDisarm =
        transition.from === "PLACED" && transition.to !== "MANAGING";
      if (isDisarm && this.state.stateBarCount < 1) {
        if (!this.replayMode) {
          this.log(
            "debug",
            `⏸️  Skipping DISARM transition (PLACED must dwell for 1 bar, current: ${this.state.stateBarCount})`,
          );
        }
        continue; // Skip this transition
      }

      // FIX 3: MANAGING requires broker truth (live orders or position)
      // CRITICAL: Always check, even at stateBarCount=0, to prevent invalid state transitions
      // This prevents strategies from entering MANAGING when orders fail to submit
      if (transition.to === "MANAGING") {
        // FIX 5: Force broker sync before MANAGING gate check
        if (!this.replayMode) {
          await this.syncOpenOrdersFromBroker();
        }

        const hasLiveOrders = this.state.openOrders.length > 0;
        const hasPosition = this.state.positionSize !== 0;

        if (!hasLiveOrders && !hasPosition) {
          if (!this.replayMode) {
            this.log(
              "warn",
              `⛔ Blocked MANAGING transition: no live orders or position (bars in PLACED: ${this.state.stateBarCount}, orders: ${this.state.openOrders.length}, position: ${this.state.positionSize})`,
            );
          }
          continue; // Skip this transition
        }
      }

      const conditionLabel = this.getTransitionLabel(
        transition.from,
        transition.to,
      );
      const result = await this.evaluateConditionWithLogging(
        transition.when,
        conditionLabel,
      );

      // Emit rule evaluation event
      this.emitVisualization("onRuleEvaluation", {
        strategyId: this.strategyId,
        symbol: this.ir.symbol,
        ruleName: conditionLabel,
        expression: JSON.stringify(transition.when),
        result: result,
        features: Object.fromEntries(this.state.features),
        fromState: transition.from,
        toState: transition.to,
      });

      if (result) {
        // Skip state transitions during replay mode (warmup only)
        if (this.replayMode) {
          continue; // Don't change state during historical bar replay
        }
        // Detect special events
        const isInvalidation =
          transition.from === "MANAGING" && transition.to === "EXITED";
        const isTrigger =
          transition.from === "ARMED" && transition.to === "PLACED";

        // Transition triggered!
        if (isInvalidation) {
          this.log(
            "info",
            `🚨 ${conditionLabel} TRIGGERED → Transition: ${transition.from} -> ${transition.to}`,
          );
        } else if (isTrigger) {
          this.log(
            "info",
            `📍 ${conditionLabel} TRIGGERED → Transition: ${transition.from} -> ${transition.to}`,
          );
        } else {
          this.log(
            "info",
            `✅ ${conditionLabel} PASSED → Transition: ${transition.from} -> ${transition.to}`,
          );
        }

        // Audit log for state transitions (especially important in replay mode)
        if (this.replayMode) {
          this.brokerEnv.auditEvent?.({
            component: "StrategyEngine",
            level: "info",
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
            component: "StrategyEngine",
            level: "warn",
            message: "Strategy invalidated - exit condition triggered",
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

        const previousState = this.state.currentState;
        this.state.currentState = transition.to;
        // FIX 2: Reset state bar counter on state change
        this.state.stateBarCount = 0;

        // Check if levels should be frozen at this new state
        this.checkAndFreezeLevels(transition.to);

        // Emit state transition event
        this.emitVisualization("onStateTransition", {
          strategyId: this.strategyId,
          symbol: this.ir.symbol,
          fromState: previousState,
          toState: transition.to,
          reason: conditionLabel,
          triggeredByRule: conditionLabel,
        });

        // Execute actions
        for (const action of transition.actions) {
          await this.executeAction(action);
        }

        // Only one transition per bar
        break;
      } else {
        // Condition not yet met - this is normal operation (only log in non-replay mode)
        if (!this.replayMode) {
          this.log("debug", `⏳ ${conditionLabel} (waiting for condition)`);
        }
      }
    }
  }

  /**
   * Get human-readable label for transition
   */
  private getTransitionLabel(from: string, to: string): string {
    if (from === "IDLE" && to === "ARMED") return "ARM";
    if (from === "ARMED" && to === "PLACED") return "TRIGGER";
    if (from === "PLACED" && to === "MANAGING") return "ENTRY";
    if (from === "MANAGING" && to === "EXITED") return "INVALIDATE";
    if (from === "ARMED" && to === "IDLE") return "DISARM";
    return `${from}->${to}`;
  }

  /**
   * Evaluate condition with detailed logging
   */
  private async evaluateConditionWithLogging(
    condition: any,
    label: string,
  ): Promise<boolean> {
    try {
      const result = await this.evaluateCondition(condition);

      // Identify important transition types
      const isTrigger = label === "TRIGGER";
      const isInvalidate = label === "INVALIDATE";
      const isDisarm = label === "DISARM";
      const isImportant = isTrigger || isInvalidate || isDisarm;

      // Log feature values for important transitions
      // ALWAYS log trigger failures (to see why not triggering), sample other failures every 20th bar
      const shouldLogSuccess = !this.replayMode && result;
      const shouldLogTriggerFailure = !this.replayMode && !result && isTrigger; // Always log trigger failures
      const shouldLogOtherFailure =
        !this.replayMode &&
        !result &&
        !isTrigger &&
        isImportant &&
        this.state.barCount % 20 === 0;
      const shouldLog =
        shouldLogSuccess || shouldLogTriggerFailure || shouldLogOtherFailure;

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
            if (name === "close") featureValues[name] = bar.close;
            else if (name === "open") featureValues[name] = bar.open;
            else if (name === "high") featureValues[name] = bar.high;
            else if (name === "low") featureValues[name] = bar.low;
            else if (name === "volume") featureValues[name] = bar.volume;
            else if (name === "price") featureValues[name] = bar.close;
          }
        }

        if (Object.keys(featureValues).length > 0) {
          const valuesStr = Object.entries(featureValues)
            .map(([k, v]) => {
              if (typeof v === "number") {
                return `${k}=${v.toFixed(2)}`;
              } else {
                return `${k}=${v}`;
              }
            })
            .join(", ");

          // Better status message: "✓" for met, "⏳" for waiting
          const status = result ? "✓ MET" : "⏳ WAITING";
          const logLevel = result ? "info" : "debug";
          this.log(logLevel, `  [${label}] ${status}: ${valuesStr}`);
        }
      }

      return result;
    } catch (error) {
      const err = error as Error;
      this.log("error", `Failed to evaluate ${label}: ${err.message}`);
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

      if (node.type === "identifier" && node.name) {
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
   * Build evaluation context for rule expressions (arm, trigger, invalidate)
   * When levels are frozen, rules still evaluate on live features.
   * The "frozen" part is stop/eL/eH/targets (plan fields), which we inject below.
   */
  private buildRuleEvalContext(): EvaluationContext {
    const base = new Map(this.state.features);

    // Global convenience vars for rules:
    // If you have a single plan per strategy, use that plan.
    const plan = this.ir.orderPlans?.[0];
    if (plan) {
      base.set("entry", plan.targetEntryPrice);
      base.set("stop", plan.stopPrice);
      base.set("eL", plan.entryZone?.[0] || 0);
      base.set("eH", plan.entryZone?.[1] || 0);

      // Optional: first target
      const t1 = plan.brackets?.[0]?.price;
      if (typeof t1 === "number") {
        base.set("t1", t1);
      }
    }

    return {
      features: base,
      builtins: new Map([
        ["open", this.state.currentBar?.open || 0],
        ["high", this.state.currentBar?.high || 0],
        ["low", this.state.currentBar?.low || 0],
        ["close", this.state.currentBar?.close || 0],
        ["volume", this.state.currentBar?.volume || 0],
        ["price", this.state.currentBar?.close || 0],
      ]),
      featureHistory: this.featureHistory,
      functions: new Map<string, (args: FeatureValue[]) => FeatureValue>([
        [
          "in_range",
          (args: FeatureValue[]) => {
            if (args.length !== 3) return 0;
            const [value, min, max] = args as number[];
            return value >= min && value <= max ? 1 : 0;
          },
        ],
        [
          "clamp",
          (args: FeatureValue[]) => {
            if (args.length !== 3) return 0;
            const [value, min, max] = args as number[];
            return Math.max(min, Math.min(max, value));
          },
        ],
        [
          "abs",
          (args: FeatureValue[]) => {
            if (args.length !== 1) return 0;
            return Math.abs(args[0] as number);
          },
        ],
        [
          "min",
          (args: FeatureValue[]) => {
            return Math.min(...(args as number[]));
          },
        ],
        [
          "max",
          (args: FeatureValue[]) => {
            return Math.max(...(args as number[]));
          },
        ],
        [
          "round",
          (args: FeatureValue[]) => {
            if (args.length < 1 || args.length > 2) return 0;
            const [value, decimals = 0] = args as number[];
            const mult = Math.pow(10, decimals);
            return Math.round((value as number) * mult) / mult;
          },
        ],
      ]),
    };
  }

  /**
   * Evaluate a condition expression
   * Uses buildRuleEvalContext() to include frozen stop/entry/target variables
   */
  private async evaluateCondition(condition: any): Promise<boolean> {
    try {
      const ctx = this.buildRuleEvalContext();
      return evaluateCondition(condition, ctx);
    } catch (e) {
      const err = e as Error;
      this.log("error", `Condition evaluation error: ${err.message}`);
      return false;
    }
  }

  /**
   * Execute an action
   */
  private async executeAction(action: Action): Promise<void> {
    try {
      switch (action.type) {
        case "start_timer":
          if (action.barCount) {
            this.timers.startTimer("entry_timeout", action.barCount);
            this.log("info", `Started timer: ${action.barCount} bars`);
          }
          break;

        case "submit_order_plan":
          // DIAGNOSTIC: Log entry to submit_order_plan
          this.log("debug", `🔍 DIAGNOSTIC: Entered submit_order_plan action`, {
            planId: action.planId,
            replayMode: this.replayMode,
            currentState: this.state.currentState,
            barCount: this.state.barCount,
            currentPrice: this.state.currentBar?.close,
            existingOpenOrders: this.state.openOrders.length,
          });

          if (this.replayMode) {
            this.log(
              "info",
              `Replay mode active - skipping order plan submission${
                action.planId ? ` (${action.planId})` : ""
              }`,
            );
            this.brokerEnv.auditEvent?.({
              component: "StrategyEngine",
              level: "info",
              message: "Replay mode - simulated order plan submission",
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
              // DIAGNOSTIC: Log order plan details and market context
              this.log("debug", `🔍 DIAGNOSTIC: Found order plan`, {
                planId: plan.id,
                side: plan.side,
                qty: plan.qty,
                targetEntryPrice: plan.targetEntryPrice,
                entryZone: plan.entryZone,
                stopPrice: plan.stopPrice,
                currentPrice: this.state.currentBar?.close,
                priceVsZoneLow: this.state.currentBar
                  ? (this.state.currentBar.close - plan.entryZone[0]).toFixed(4)
                  : "N/A",
                priceVsZoneHigh: this.state.currentBar
                  ? (this.state.currentBar.close - plan.entryZone[1]).toFixed(4)
                  : "N/A",
              });
              // DIAGNOSTIC: Check kill switch
              this.log("debug", `🔍 DIAGNOSTIC: Checking kill switch`, {
                allowLiveOrders: this.brokerEnv.allowLiveOrders,
              });

              if (this.brokerEnv.allowLiveOrders === false) {
                this.log(
                  "warn",
                  "🛑 DIAGNOSTIC: Live order submission BLOCKED by kill switch",
                );
                this.brokerEnv.auditEvent?.({
                  component: "StrategyEngine",
                  level: "warn",
                  message: "Live order submission blocked by kill switch",
                  metadata: {
                    symbol: this.ir.symbol,
                    planId: action.planId,
                  },
                });
                return;
              }

              this.log(
                "debug",
                `✅ DIAGNOSTIC: Kill switch check passed (allowLiveOrders=true)`,
              );

              // DIAGNOSTIC: Check daily loss limit
              this.log("debug", `🔍 DIAGNOSTIC: Checking daily loss limit`, {
                dailyLossLimit: this.brokerEnv.dailyLossLimit,
                currentDailyPnL: this.brokerEnv.currentDailyPnL,
              });

              if (
                this.brokerEnv.dailyLossLimit !== undefined &&
                this.brokerEnv.currentDailyPnL !== undefined &&
                this.brokerEnv.currentDailyPnL <= -this.brokerEnv.dailyLossLimit
              ) {
                this.log(
                  "warn",
                  "🛑 DIAGNOSTIC: Live order submission BLOCKED by daily loss limit",
                  {
                    currentDailyPnL: this.brokerEnv.currentDailyPnL,
                    dailyLossLimit: this.brokerEnv.dailyLossLimit,
                  },
                );
                this.brokerEnv.auditEvent?.({
                  component: "StrategyEngine",
                  level: "warn",
                  message: "Live order submission blocked by daily loss limit",
                  metadata: {
                    symbol: this.ir.symbol,
                    planId: action.planId,
                    currentDailyPnL: this.brokerEnv.currentDailyPnL,
                    dailyLossLimit: this.brokerEnv.dailyLossLimit,
                  },
                });
                return;
              }

              this.log("debug", `✅ DIAGNOSTIC: Daily loss limit check passed`);

              const expectedNewOrders =
                plan.brackets.length > 0 ? plan.brackets.length : 1;

              // DIAGNOSTIC: Check max orders per symbol
              this.log("debug", `🔍 DIAGNOSTIC: Checking maxOrdersPerSymbol`, {
                currentOpenOrders: this.state.openOrders.length,
                expectedNewOrders,
                maxOrdersPerSymbol: this.brokerEnv.maxOrdersPerSymbol,
              });

              if (
                this.brokerEnv.maxOrdersPerSymbol !== undefined &&
                this.state.openOrders.length + expectedNewOrders >
                  this.brokerEnv.maxOrdersPerSymbol
              ) {
                this.log(
                  "warn",
                  "🛑 DIAGNOSTIC: Live order submission BLOCKED by maxOrdersPerSymbol",
                  {
                    currentOpenOrders: this.state.openOrders.length,
                    expectedNewOrders,
                    maxOrdersPerSymbol: this.brokerEnv.maxOrdersPerSymbol,
                  },
                );
                this.brokerEnv.auditEvent?.({
                  component: "StrategyEngine",
                  level: "warn",
                  message:
                    "Live order submission blocked by maxOrdersPerSymbol",
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

              this.log(
                "debug",
                `✅ DIAGNOSTIC: maxOrdersPerSymbol check passed`,
              );

              // NOTE: maxOrderQty and maxNotionalPerSymbol checks removed
              // The broker adapter handles all quantity/notional scaling when dynamic sizing is enabled
              // Blocking here prevents the broker adapter's intelligent scaling logic from running

              // CRITICAL: Always cancel any existing pending entry orders before placing new ones
              // This prevents duplicate orders when strategy retriggers
              if (this.state.openOrders.length > 0) {
                this.log(
                  "info",
                  `Cancelling ${this.state.openOrders.length} existing order(s) before placing new order plan`,
                );

                const cancelResult = await this.brokerAdapter.cancelOpenEntries(
                  this.ir.symbol,
                  this.state.openOrders,
                  this.brokerEnv,
                );

                // CRITICAL: Verify cancellation succeeded before proceeding
                if (cancelResult.failed.length > 0) {
                  const failedIds = cancelResult.failed
                    .map((f) => f.orderId)
                    .join(", ");
                  const reasons = cancelResult.failed
                    .map((f) => f.reason)
                    .join("; ");
                  this.log(
                    "error",
                    `Failed to cancel orders: ${failedIds}. Reasons: ${reasons}`,
                  );

                  // DO NOT proceed with new order submission
                  throw new Error(
                    `Cannot place new orders - cancellation failed for: ${failedIds}`,
                  );
                }

                // Only clear state if cancellation succeeded
                this.state.openOrders = this.state.openOrders.filter(
                  (o) => !cancelResult.succeeded.includes(o.id),
                );

                this.log(
                  "info",
                  `Successfully cancelled ${cancelResult.succeeded.length} orders`,
                );
              }

              // Log order plan details before submission
              this.log(
                "info",
                `📤 Submitting order plan: ${plan.id} | Side: ${plan.side} | Qty: ${plan.qty} | Entry: [${plan.entryZone[0]}, ${plan.entryZone[1]}] | Stop: ${plan.stopPrice}`,
              );

              // Emit order plan event
              this.emitVisualization("onOrderPlan", {
                strategyId: this.strategyId,
                symbol: this.ir.symbol,
                planId: plan.id,
                side: plan.side,
                qty: plan.qty,
                entryZone: plan.entryZone as [number, number],
                targetEntryPrice: plan.targetEntryPrice,
                stopPrice: plan.stopPrice,
                targets: plan.brackets.map((b) => ({
                  price: b.price,
                  ratio: b.ratioOfPosition,
                })),
                status: "pending",
              });

              // Apply buying power-based position sizing if enabled
              let finalPlan = plan;
              if (
                this.brokerEnv.enableDynamicSizing &&
                this.brokerEnv.buyingPower
              ) {
                const buyingPowerFactor =
                  this.brokerEnv.buyingPowerFactor || 0.75; // Default 75%
                const adjustedBuyingPower =
                  this.brokerEnv.buyingPower * buyingPowerFactor;
                const entryPrice = plan.targetEntryPrice;

                // Calculate max shares based on adjusted buying power
                let maxSharesByBuyingPower = Math.floor(
                  adjustedBuyingPower / entryPrice,
                );

                // Apply additional limits
                const limits: string[] = [];

                // Apply YAML max shares
                if (maxSharesByBuyingPower > plan.qty) {
                  maxSharesByBuyingPower = plan.qty;
                  limits.push(`YAML max (${plan.qty})`);
                } else {
                  limits.push(
                    `${(buyingPowerFactor * 100).toFixed(0)}% buying power`,
                  );
                }

                // Apply MAX_ORDER_QTY if set
                if (
                  this.brokerEnv.maxOrderQty !== undefined &&
                  maxSharesByBuyingPower > this.brokerEnv.maxOrderQty
                ) {
                  maxSharesByBuyingPower = this.brokerEnv.maxOrderQty;
                  limits.push(`MAX_ORDER_QTY (${this.brokerEnv.maxOrderQty})`);
                }

                // Apply MAX_NOTIONAL if set
                if (this.brokerEnv.maxNotionalPerSymbol !== undefined) {
                  const maxSharesByNotional = Math.floor(
                    this.brokerEnv.maxNotionalPerSymbol / entryPrice,
                  );
                  if (maxSharesByBuyingPower > maxSharesByNotional) {
                    maxSharesByBuyingPower = maxSharesByNotional;
                    limits.push(
                      `MAX_NOTIONAL ($${this.brokerEnv.maxNotionalPerSymbol})`,
                    );
                  }
                }

                // Ensure at least 1 share if affordable
                if (maxSharesByBuyingPower < 1) {
                  this.log("error", `Position sizing resulted in 0 shares`, {
                    adjustedBuyingPower: adjustedBuyingPower.toFixed(2),
                    entryPrice: entryPrice.toFixed(2),
                    buyingPowerFactor: `${(buyingPowerFactor * 100).toFixed(
                      0,
                    )}%`,
                  });
                  this.brokerEnv.auditEvent?.({
                    component: "StrategyEngine",
                    level: "error",
                    message:
                      "Position sizing resulted in 0 shares - insufficient buying power",
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
                const utilizationPercent =
                  (notionalValue / this.brokerEnv.buyingPower) * 100;

                // Create modified plan
                finalPlan = { ...plan, qty: maxSharesByBuyingPower };

                // Alert user about quantity adjustment
                const wasAdjusted = maxSharesByBuyingPower !== plan.qty;
                const alertLevel = wasAdjusted ? "warn" : "info";
                const alertEmoji = wasAdjusted ? "⚠️" : "✅";

                this.log(
                  alertLevel,
                  `${alertEmoji} Position Size ${
                    wasAdjusted ? "ADJUSTED" : "Applied"
                  }:`,
                  {
                    originalQty: plan.qty,
                    finalQty: maxSharesByBuyingPower,
                    notionalValue: notionalValue.toFixed(2),
                    buyingPower: this.brokerEnv.buyingPower.toFixed(2),
                    adjustedBuyingPower: adjustedBuyingPower.toFixed(2),
                    utilizationPercent: `${utilizationPercent.toFixed(1)}%`,
                    appliedLimits: limits.join(", "),
                    reason: wasAdjusted
                      ? "Respecting portfolio buying power"
                      : "Within buying power limits",
                  },
                );

                this.brokerEnv.auditEvent?.({
                  component: "StrategyEngine",
                  level: wasAdjusted ? "warn" : "info",
                  message: wasAdjusted
                    ? `Quantity adjusted from ${plan.qty} to ${maxSharesByBuyingPower} to respect buying power`
                    : "Position size within buying power limits",
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

                // DIAGNOSTIC: Check buying power validation
                this.log(
                  "debug",
                  `🔍 DIAGNOSTIC: Checking buying power (dynamic sizing disabled)`,
                  {
                    requiredCapital: requiredCapital.toFixed(2),
                    availableBuyingPower: this.brokerEnv.buyingPower.toFixed(2),
                  },
                );

                if (requiredCapital > this.brokerEnv.buyingPower) {
                  this.log(
                    "error",
                    `🛑 DIAGNOSTIC: Order BLOCKED - Insufficient buying power`,
                    {
                      requiredCapital: requiredCapital.toFixed(2),
                      availableBuyingPower:
                        this.brokerEnv.buyingPower.toFixed(2),
                      shortfall: (
                        requiredCapital - this.brokerEnv.buyingPower
                      ).toFixed(2),
                    },
                  );
                  this.brokerEnv.auditEvent?.({
                    component: "StrategyEngine",
                    level: "error",
                    message: "Order blocked - insufficient buying power",
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

                this.log("debug", `✅ DIAGNOSTIC: Buying power check passed`);
              } else {
                this.log(
                  "debug",
                  `✅ DIAGNOSTIC: Buying power not set (skipped)`,
                );
              }

              // DIAGNOSTIC: Log before broker adapter call
              this.log(
                "debug",
                `🔍 DIAGNOSTIC: About to call brokerAdapter.submitOrderPlan`,
                {
                  planId: finalPlan.id,
                  side: finalPlan.side,
                  qty: finalPlan.qty,
                  targetEntryPrice: finalPlan.targetEntryPrice,
                  entryZone: finalPlan.entryZone,
                  stopPrice: finalPlan.stopPrice,
                  allowLiveOrders: this.brokerEnv.allowLiveOrders,
                  brokerType: this.brokerAdapter.constructor.name,
                },
              );

              // Now safe to submit the new order plan
              try {
                const orders = await this.brokerAdapter.submitOrderPlan(
                  finalPlan,
                  this.brokerEnv,
                );

                // DIAGNOSTIC: Log broker adapter response
                this.log("debug", `🔍 DIAGNOSTIC: Broker adapter returned`, {
                  ordersReceived: orders.length,
                  orderIds: orders.map((o) => o.id),
                  orderStatuses: orders.map((o) => o.status),
                });

                this.state.openOrders.push(...orders);

                // DIAGNOSTIC: Log state after adding orders
                this.log("debug", `🔍 DIAGNOSTIC: Orders added to state`, {
                  totalOpenOrders: this.state.openOrders.length,
                  newlyAddedCount: orders.length,
                });

                this.log(
                  "info",
                  `✅ Successfully submitted ${orders.length} order(s) for ${action.planId}`,
                );

                // Emit order submission success event
                this.emitVisualization("onOrderSubmission", {
                  strategyId: this.strategyId,
                  symbol: this.ir.symbol,
                  planId: action.planId!,
                  ordersSubmitted: orders.length,
                  orderIds: orders.map((o) => o.id),
                  status: "success",
                });

                // Log individual order details
                for (const order of orders) {
                  this.log(
                    "info",
                    `  └─ Order ${order.id}: ${order.side} ${order.qty} @ ${
                      order.type
                    } | ${
                      order.limitPrice ? `Limit: ${order.limitPrice}` : ""
                    } ${order.stopPrice ? `Stop: ${order.stopPrice}` : ""}`,
                  );
                }
              } catch (error) {
                this.log(
                  "error",
                  `Failed to submit order plan: ${(error as Error).message}`,
                );

                // Emit order submission failure event
                this.emitVisualization("onOrderSubmission", {
                  strategyId: this.strategyId,
                  symbol: this.ir.symbol,
                  planId: action.planId!,
                  ordersSubmitted: 0,
                  orderIds: [],
                  status: "failed",
                  error: (error as Error).message,
                });

                // Re-throw to be handled by the bar processing try-catch
                throw error;
              }
            }
          }
          break;

        case "cancel_entries":
          if (this.replayMode) {
            this.log(
              "info",
              "Replay mode active - skipping order cancellation",
            );
            this.brokerEnv.auditEvent?.({
              component: "StrategyEngine",
              level: "info",
              message: "Replay mode - simulated order cancellation",
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
            this.log(
              "warn",
              "Order cancellation blocked (cancel_entries disabled)",
            );
            this.brokerEnv.auditEvent?.({
              component: "StrategyEngine",
              level: "warn",
              message: "Order cancellation blocked (cancel_entries disabled)",
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
              this.brokerEnv,
            );

            // Verify cancellation succeeded
            if (cancelResult.failed.length > 0) {
              const failedIds = cancelResult.failed
                .map((f) => f.orderId)
                .join(", ");
              const reasons = cancelResult.failed
                .map((f) => f.reason)
                .join("; ");
              this.log(
                "error",
                `Failed to cancel orders: ${failedIds}. Reasons: ${reasons}`,
              );
              throw new Error(`Order cancellation failed for: ${failedIds}`);
            }

            // Only clear successfully cancelled orders
            this.state.openOrders = this.state.openOrders.filter(
              (o) => !cancelResult.succeeded.includes(o.id),
            );

            this.log(
              "info",
              `Cancelled ${cancelResult.succeeded.length} entries`,
            );
          }
          break;

        case "log":
          if (action.message) {
            this.log("info", action.message);
          }
          break;

        case "noop":
          // Do nothing
          break;
      }
    } catch (e) {
      const err = e as Error;
      this.log("error", `Action execution error: ${err.message}`);
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
    level: "info" | "warn" | "error" | "debug",
    message: string,
    data?: Record<string, unknown>,
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
    if (level === "debug" && !process.env.DEBUG) {
      return;
    }

    console.log(
      `[Bar ${this.state.barCount}] [${level.toUpperCase()}] ${message}`,
      data ? JSON.stringify(data) : "",
    );
  }

  /**
   * Sync open orders from broker (handles force-deployed orders or external order placement)
   * FIX 4: Always sync to broker truth to avoid phantom/stale orders
   */
  private async syncOpenOrdersFromBroker(): Promise<void> {
    try {
      const brokerOrders = await this.brokerAdapter.getOpenOrders(
        this.ir.symbol,
        this.brokerEnv,
      );

      // Always sync to broker truth to avoid phantom/stale orders
      const oldCount = this.state.openOrders.length;
      this.state.openOrders = brokerOrders;

      if (brokerOrders.length > 0) {
        this.log(
          "info",
          `Syncing ${brokerOrders.length} open order(s) from broker into engine state`,
        );
      } else if (oldCount > 0) {
        // Log when broker cleared orders (filled/cancelled)
        this.log(
          "info",
          `Broker sync: cleared ${oldCount} order(s) from state (filled/cancelled)`,
        );
      }
    } catch (error) {
      this.log("warn", `Failed to sync orders from broker: ${error}`);
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
      stateBarCount: 0, // FIX 2: Reset state bar counter
      currentBar: null,
      features: new Map(),
      openOrders: [],
      positionSize: 0, // FIX 3: Reset position
      timers: new Map(),
      log: [],
    };
  }

  /**
   * FIX 3: Update position size when fills occur
   * Called by external order monitoring systems when orders fill
   *
   * @param quantity - Number of shares filled (always positive)
   * @param side - 'buy' (adds to position) or 'sell' (reduces position)
   */
  updatePosition(quantity: number, side: "buy" | "sell"): void {
    const delta = side === "buy" ? quantity : -quantity;
    const oldPosition = this.state.positionSize;
    this.state.positionSize += delta;

    this.log(
      "info",
      `Position updated: ${oldPosition} → ${this.state.positionSize} (${side} ${quantity})`,
    );

    // If position just became non-zero, log entry
    if (oldPosition === 0 && this.state.positionSize !== 0) {
      this.log(
        "info",
        `✅ Position opened: ${side.toUpperCase()} ${quantity} shares`,
      );
    }

    // If position just became zero, log exit
    if (oldPosition !== 0 && this.state.positionSize === 0) {
      this.log(
        "info",
        `✅ Position closed: ${side.toUpperCase()} ${quantity} shares (flat)`,
      );
    }
  }
}
