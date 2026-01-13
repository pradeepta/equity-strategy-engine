/**
 * Zod schemas for DSL validation
 */
import { z } from 'zod';

// ============================================================================
// DSL Schema
// ============================================================================

export const FeatureDSLSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['builtin', 'indicator', 'microstructure']),
  params: z.record(z.unknown()).optional(),
});

export const RuleDSLSchema = z.object({
  arm: z.string().optional(),
  trigger: z.string().optional(),
  invalidate: z.object({
    when_any: z.array(z.string()).optional(),
  }).optional(),
});

export const TargetDSLSchema = z.object({
  price: z.number(),
  ratioOfPosition: z.number().min(0).max(1),
});

export const OrderPlanDSLSchema = z.object({
  name: z.string(),
  side: z.enum(['buy', 'sell']),
  entryZone: z.tuple([z.number(), z.number()]),
  qty: z.number().positive(),
  stopPrice: z.number(),
  targets: z.array(TargetDSLSchema),
});

export const ExecutionDSLSchema = z.object({
  entryTimeoutBars: z.number().int().positive().optional().default(10),
  rthOnly: z.boolean().optional().default(false),
});

export const RiskDSLSchema = z.object({
  maxRiskPerTrade: z.number().positive(),
});

export const StrategyDSLSchema = z.object({
  meta: z.object({
    name: z.string(),
    symbol: z.string(),
    timeframe: z.string(),
    description: z.string().optional(),
  }),
  features: z.array(FeatureDSLSchema).optional().default([]),
  rules: RuleDSLSchema,
  orderPlans: z.array(OrderPlanDSLSchema),
  execution: ExecutionDSLSchema.optional(),
  risk: RiskDSLSchema,
});

export type StrategyDSL = z.infer<typeof StrategyDSLSchema>;
export type FeatureDSL = z.infer<typeof FeatureDSLSchema>;
export type OrderPlanDSL = z.infer<typeof OrderPlanDSLSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

export function validateStrategyDSL(input: unknown): StrategyDSL {
  return StrategyDSLSchema.parse(input);
}
