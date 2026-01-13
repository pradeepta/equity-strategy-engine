/**
 * Compiler: DSL → IR
 * Orchestrates validation, parsing, type-checking, and IR generation
 */
import YAML from 'yaml';
import { StrategyDSL, validateStrategyDSL } from '../spec/schema';
import { CompiledIR, StateTransition, StrategyState, OrderPlan } from '../spec/types';
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
      },
      risk: {
        maxRiskPerTrade: dsl.risk.maxRiskPerTrade,
      },
      dslSource: undefined, // Can be set by caller if needed
    };

    return ir;
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

    // PLACED -> MANAGING: entry filled (stub: assume instant fill for now)
    transitions.push({
      from: 'PLACED',
      to: 'MANAGING',
      when: { type: 'literal', value: true }, // Simplified: could check order fills
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
   */
  private buildOrderPlans(dsl: StrategyDSL): OrderPlan[] {
    return dsl.orderPlans.map((planDSL, idx) => ({
      id: planDSL.name || `plan_${idx}`,
      name: planDSL.name,
      symbol: dsl.meta.symbol,
      side: planDSL.side,
      targetEntryPrice: (planDSL.entryZone[0] + planDSL.entryZone[1]) / 2,
      entryZone: planDSL.entryZone,
      qty: planDSL.qty,
      stopPrice: planDSL.stopPrice,
      brackets: planDSL.targets.map((t) => ({
        price: t.price,
        ratioOfPosition: t.ratioOfPosition,
      })),
      type: 'split_bracket',
    }));
  }
}
