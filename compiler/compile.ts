/**
 * Compiler: DSL → IR
 * Orchestrates validation, parsing, type-checking, and IR generation
 */
import YAML from 'yaml';
import { StrategyDSL, validateStrategyDSL } from '../spec/schema';
import { CompiledIR, StateTransition, StrategyState, OrderPlan, ExprNode } from '../spec/types';
import { parseExpression } from './expr';
import { typeCheckExpression } from './typecheck';
import { lowerInvalidate } from './lower';
import { FeatureRegistry } from '../features/registry';

// ============================================================================
// Compilation Errors
// ============================================================================

export interface CompilationError {
  code: string;
  message: string;
  details?: unknown;
}

// ============================================================================
// Compiler
// ============================================================================

export class StrategyCompiler {
  constructor(private featureRegistry: FeatureRegistry) {}

  /**
   * Compile from YAML string
   */
  compileFromYAML(yamlSource: string): CompiledIR {
    const parsed = YAML.parse(yamlSource);
    return this.compileFromDSL(parsed);
  }

  /**
   * Compile from DSL object
   */
  compileFromDSL(dslObj: any): CompiledIR {
    // Validate schema
    const dsl: StrategyDSL = validateStrategyDSL(dslObj);

    // Collect declared features
    const declaredFeatures = new Set(dsl.features.map((f) => f.name));

    // Validate that all declared features exist in registry
    this.validateFeatureRegistry(declaredFeatures);

    // Parse all expressions and type-check
    this.validateExpressions(dsl, declaredFeatures);

    // Build feature plan (topological sort)
    const featurePlan = this.buildFeaturePlan(dsl, declaredFeatures);

    // Build transitions
    const transitions = this.buildTransitions(dsl, declaredFeatures);

    // Build order plans
    const orderPlans = this.buildOrderPlans(dsl);

    // Build IR
    const ir: CompiledIR = {
      symbol: dsl.meta.symbol,
      timeframe: dsl.meta.timeframe,
      initialState: 'IDLE',
      featurePlan,
      transitions,
      orderPlans,
      execution: {
        entryTimeoutBars: dsl.execution?.entryTimeoutBars || 10,
        rthOnly: dsl.execution?.rthOnly || false,
        freezeLevelsOn: dsl.execution?.freezeLevelsOn, // Pass through freeze trigger
      },
      risk: {
        maxRiskPerTrade: dsl.risk.maxRiskPerTrade,
      },
      dslSource: undefined, // Can be set by caller if needed
    };

    return ir;
  }

  /**
   * Validate that all declared features exist in the registry
   */
  private validateFeatureRegistry(declaredFeatures: Set<string>): void {
    const builtins = new Set(['open', 'high', 'low', 'close', 'volume', 'price']);
    const undefinedFeatures: string[] = [];

    for (const featureName of declaredFeatures) {
      // Skip builtins
      if (builtins.has(featureName)) {
        continue;
      }

      // Check if feature exists in registry
      const feature = this.featureRegistry.getFeature(featureName);
      if (!feature) {
        undefinedFeatures.push(featureName);
      }
    }

    if (undefinedFeatures.length > 0) {
      const availableFeatures = Array.from(this.featureRegistry.getAllFeatures().keys())
        .filter(name => !builtins.has(name))
        .sort();

      throw new Error(
        `Undefined feature(s) in strategy: ${undefinedFeatures.join(', ')}. ` +
        `These features are not registered in the feature registry. ` +
        `Available features: ${availableFeatures.join(', ')}`
      );
    }
  }

  /**
   * Validate all expressions in DSL
   */
  private validateExpressions(dsl: StrategyDSL, declaredFeatures: Set<string>): void {
    const expressions = [
      dsl.rules.arm,
      dsl.rules.trigger,
      ...(dsl.rules.invalidate?.when_any || []),
    ].filter(Boolean) as string[];

    for (const expr of expressions) {
      try {
        const ast = parseExpression(expr);
        const error = typeCheckExpression(ast, declaredFeatures);
        if (error) {
          throw new Error(error.message);
        }
      } catch (e) {
        throw new Error(`Expression parse/type error: "${expr}" -> ${(e as Error).message}`);
      }
    }
  }

  /**
   * Build feature computation plan
   */
  private buildFeaturePlan(dsl: StrategyDSL, declaredFeatures: Set<string>) {
    // Collect all features needed (builtin + declared)
    const allFeatures = new Set<string>();

    // Add builtins (always available)
    ['open', 'high', 'low', 'close', 'volume', 'price'].forEach((f) =>
      allFeatures.add(f)
    );

    // Add declared
    for (const feat of declaredFeatures) {
      allFeatures.add(feat);
    }

    // Topological sort
    const sorted = this.featureRegistry.topologicalSort(allFeatures);

    // Map to descriptors
    const plan = sorted
      .map((name) => this.featureRegistry.getFeature(name))
      .filter(Boolean) as any[];

    return plan;
  }

  /**
   * Build state transitions from rules
   */
  private buildTransitions(
    dsl: StrategyDSL,
    declaredFeatures: Set<string>
  ): StateTransition[] {
    const transitions: StateTransition[] = [];

    const arm = dsl.rules.arm;
    const trigger = dsl.rules.trigger;
    const invalidate = dsl.rules.invalidate;

    if (!arm || !trigger) {
      throw new Error('Rules must define both "arm" and "trigger"');
    }

    // Parse expressions
    const armExpr = parseExpression(arm);
    const triggerExpr = parseExpression(trigger);
    const invalidateExpr = lowerInvalidate(invalidate);

    // Validate
    typeCheckExpression(armExpr, declaredFeatures);
    typeCheckExpression(triggerExpr, declaredFeatures);
    if (invalidateExpr) {
      typeCheckExpression(invalidateExpr, declaredFeatures);
    }

    // Build transitions
    // IDLE -> ARMED: when arm condition
    transitions.push({
      from: 'IDLE',
      to: 'ARMED',
      when: armExpr,
      actions: [{ type: 'log', message: 'Arming strategy' }],
    });

    // ARMED -> PLACED: when trigger condition
    transitions.push({
      from: 'ARMED',
      to: 'PLACED',
      when: triggerExpr,
      actions: [
        {
          type: 'submit_order_plan',
          planId: dsl.orderPlans[0]?.name || 'primary',
        },
        { type: 'start_timer', barCount: dsl.execution?.entryTimeoutBars || 10 },
        { type: 'log', message: 'Order placed' },
      ],
    });

    // PLACED -> MANAGING: entry filled
    // Engine safety check enforces that orders/position must exist before allowing this transition
    // Condition is always true, but engine blocks transition if no orders/position exist
    transitions.push({
      from: 'PLACED',
      to: 'MANAGING',
      when: { type: 'literal', value: true },
      actions: [{ type: 'log', message: 'Entry filled, managing position' }],
    });

    // MANAGING -> EXITED: exit conditions
    if (invalidateExpr) {
      transitions.push({
        from: 'MANAGING',
        to: 'EXITED',
        when: invalidateExpr,
        actions: [
          { type: 'cancel_entries' },
          { type: 'log', message: 'Position exited' },
        ],
      });
    }

    // EXITED -> IDLE: re-arm for next trade opportunity
    // Always re-arm on next bar after exit (allows multiple trades per session)
    transitions.push({
      from: 'EXITED',
      to: 'IDLE',
      when: { type: 'literal', value: true }, // Always re-arm on next bar
      actions: [{ type: 'log', message: 'Re-arming for next trade setup' }],
    });

    // ARMED -> IDLE: if timer expires without trigger
    transitions.push({
      from: 'ARMED',
      to: 'IDLE',
      when: { type: 'literal', value: false }, // Timer logic handled in runtime
      actions: [{ type: 'log', message: 'Arm timeout, reset' }],
    });

    return transitions;
  }

  /**
   * Build order plans from DSL
   * Supports expression-based entry zones, stops, and targets
   * Examples:
   *   entryZone: ["vwap - 0.2*atr", "vwap"]
   *   stopPrice: "entry - 1.5*atr"
   *   targets: [{ price: "entry + 2.5*atr" }]
   */
  private buildOrderPlans(dsl: StrategyDSL): OrderPlan[] {
    return dsl.orderPlans.map((planDSL, idx) => {
      // Parse entry zone (numeric or expression)
      let entryZoneLow: number;
      let entryZoneHigh: number;
      let entryZoneExpr: [ExprNode | null, ExprNode | null] | undefined;

      if (typeof planDSL.entryZone[0] === 'string' || typeof planDSL.entryZone[1] === 'string') {
        // At least one entry zone bound is an expression
        entryZoneExpr = [null, null];

        if (typeof planDSL.entryZone[0] === 'string') {
          entryZoneExpr[0] = parseExpression(planDSL.entryZone[0]);
          entryZoneLow = 0; // Placeholder, will be computed at runtime
        } else {
          entryZoneLow = planDSL.entryZone[0];
        }

        if (typeof planDSL.entryZone[1] === 'string') {
          entryZoneExpr[1] = parseExpression(planDSL.entryZone[1]);
          entryZoneHigh = 0; // Placeholder, will be computed at runtime
        } else {
          entryZoneHigh = planDSL.entryZone[1];
        }
      } else {
        // Both are numeric
        entryZoneLow = planDSL.entryZone[0];
        entryZoneHigh = planDSL.entryZone[1];
      }

      const targetEntryPrice = (entryZoneLow + entryZoneHigh) / 2;

      // Parse stop price (numeric or expression)
      let stopPrice: number;
      let stopPriceExpr: ExprNode | undefined;

      if (typeof planDSL.stopPrice === 'string') {
        // Parse expression
        stopPriceExpr = parseExpression(planDSL.stopPrice);
        // Use target entry as default for static stop price
        // Runtime will recompute using actual entry and current feature values
        stopPrice = targetEntryPrice;
      } else {
        stopPrice = planDSL.stopPrice;
      }

      // Parse target prices (numeric or expression)
      const brackets = planDSL.targets.map((t) => {
        let price: number;
        let priceExpr: ExprNode | undefined;

        if (typeof t.price === 'string') {
          // Parse expression
          priceExpr = parseExpression(t.price);
          // Use target entry as default
          price = targetEntryPrice;
        } else {
          price = t.price;
        }

        return {
          price,
          priceExpr,
          ratioOfPosition: t.ratioOfPosition,
        };
      });

      return {
        id: planDSL.name || `plan_${idx}`,
        name: planDSL.name,
        symbol: dsl.meta.symbol,
        side: planDSL.side,
        targetEntryPrice,
        entryZone: [entryZoneLow, entryZoneHigh],
        entryZoneExpr,
        qty: planDSL.qty,
        stopPrice,
        stopPriceExpr,
        brackets,
        type: 'split_bracket',
      };
    });
  }
}
