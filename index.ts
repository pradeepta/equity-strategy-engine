/**
 * Trading Strategy DSL v1
 * Main entry point and public API
 */

// ============================================================================
// Core Types
// ============================================================================
export {
  Bar,
  FeatureValue,
  FeatureDescriptor,
  FeatureComputeContext,
  ExprNode,
  EvaluationContext,
  Order,
  OrderSide,
  OrderType,
  OrderStatus,
  OrderPlan,
  StrategyState,
  StateTransition,
  ActionType,
  Action,
  CompiledIR,
  StrategyRuntimeState,
  RuntimeLog,
  BrokerAdapter,
  BrokerEnvironment,
} from './spec/types';

// ============================================================================
// Schema & Validation
// ============================================================================
export {
  StrategyDSLSchema,
  FeatureDSLSchema,
  OrderPlanDSLSchema,
  validateStrategyDSL,
} from './spec/schema';

// ============================================================================
// Compiler
// ============================================================================
export { StrategyCompiler } from './compiler/compile';
export {
  parseExpression,
  extractIdentifiers,
  evaluateExpression,
} from './compiler/expr';
export {
  typeCheckExpression,
  TypeCheckError,
} from './compiler/typecheck';
export {
  lowerInvalidateWhenAny,
  lowerInvalidate,
} from './compiler/lower';

// ============================================================================
// Features
// ============================================================================
export { FeatureRegistry, createStandardRegistry } from './features/registry';
export {
  computeVWAP,
  computeEMA,
  computeLOD,
  computeVolumeZScore,
} from './features/indicators';
export { computeDelta, computeAbsorption } from './features/microstructure';

// ============================================================================
// Runtime
// ============================================================================
export { StrategyEngine } from './runtime/engine';
export { evaluateCondition } from './runtime/eval';
export { TimerManager } from './runtime/timers';

// ============================================================================
// Broker Adapters
// ============================================================================
export { BaseBrokerAdapter } from './broker/broker';
