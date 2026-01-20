# Compiler — Local Rules

## Overview
YAML DSL to type-safe Intermediate Representation (IR) compiler. Critical path for strategy execution.

## Purpose
Transform human-readable YAML strategies into optimized, type-safe IR that the runtime engine can execute as finite state machines.

## Stack
- **Language:** TypeScript 5.3.3
- **Parser:** jsep (expression parser)
- **Validation:** Joi schema (from `spec/schema.ts`)
- **Output:** CompiledIR with states, transitions, actions

## Key Files
- `compile.ts` - **Main compiler** (7925 lines)
  - YAML parsing and validation
  - State machine construction
  - Feature dependency resolution
  - Expression compilation
- `expr.ts` - Expression parser using jsep
  - Mathematical expressions
  - Boolean logic
  - Feature references
- `typecheck.ts` - Type validation
  - Expression type inference
  - Feature type checking

## Architecture

### Compilation Pipeline
```
YAML Input
  ↓
Schema Validation (Joi)
  ↓
Parse Meta, Features, Rules
  ↓
Build State Machine Graph
  ↓
Resolve Feature Dependencies (topological sort)
  ↓
Compile Expressions
  ↓
Generate CompiledIR
  ↓
Output (stored in database)
```

### Key Data Structures

**Input (YAML):**
```yaml
meta:
  name: "Strategy Name"
  symbol: "AAPL"
  timeframe: "5m"

features:
  - name: rsi
    args: [14]
  - name: ema20

rules:
  arm: "rsi < 30"
  trigger: "close > ema20"
  disarm: "rsi > 70"

actions:
  on_arm: { type: "enter", ... }
```

**Output (CompiledIR):**
```typescript
interface CompiledIR {
  meta: { name, symbol, timeframe }
  states: Record<string, CompiledState>
  initialState: string
  featurePlan: string[] // Topologically sorted
}

interface CompiledState {
  name: string
  transitions: CompiledTransition[]
  onEnterActions?: CompiledAction[]
  onExitActions?: CompiledAction[]
}

interface CompiledTransition {
  condition: CompiledExpr
  targetState: string
  actions?: CompiledAction[]
}
```

## Conventions

### Error Handling
- **Custom errors:** `CompilationError` extends `Error`
- **Preserve context:** Include line/column info where possible
- **Fail-fast:** Throw on unrecoverable errors
- **Collect errors:** For multi-error scenarios (e.g., validation)

Example:
```typescript
throw new CompilationError(
  `Unknown feature: ${featureName}`,
  { feature: featureName, availableFeatures }
)
```

### Expression Compilation
- **Parse with jsep:** Convert string to AST
- **Type check:** Ensure boolean for conditions, number for values
- **Feature references:** Resolve to feature plan index
- **Supported operators:**
  - Comparison: `<`, `>`, `<=`, `>=`, `==`, `!=`
  - Logical: `&&`, `||`, `!`
  - Arithmetic: `+`, `-`, `*`, `/`, `%`
  - Special: `abs()`, `min()`, `max()`

**CRITICAL LIMITATIONS:**
- ❌ NO array indexing: `rsi[0]`, `macd.histogram[1]`
- ❌ NO dot notation: `macd.histogram` (use `macd_histogram`)
- ❌ NO previous bar access: Can't reference historical values directly
- ✅ Use current indicator values: `rsi < 30`, `macd_histogram > 0`

### Feature Dependency Resolution
Use topological sort to ensure features are computed in correct order:

```typescript
// Example: ema20 depends on close
// Computation order: close → ema20 → (user expressions)
const featurePlan = topologicalSort(features, dependencies)
```

### State Machine Construction
1. **Start state:** Always `IDLE`
2. **Armed state:** When arm condition met
3. **In-position state:** After entry order filled
4. **Exit states:** Normal exit, stop loss, take profit
5. **Transitions:** Condition-based with action execution

## Development Workflow

### Testing Compilation
```bash
# Compile a YAML file
npm run compile -- --file=./strategies/test.yaml

# Validate without compiling
npm run validate -- --file=./strategies/test.yaml
```

### Adding a New Feature Type
1. Implement compute function in `features/indicators.ts`
2. Register in `features/registry.ts`
3. Update type definitions in `spec/types.ts`
4. Update YAML schema in `spec/schema.ts` if needed
5. Test compilation with example strategy

### Adding a New Expression Function
1. Add to expression parser in `expr.ts`
2. Add type checking rule in `typecheck.ts`
3. Update runtime evaluator in `runtime/eval.ts`
4. Document in schema

### Debugging Compilation Issues

**Validation errors:**
- Check YAML syntax (use online validator)
- Verify feature names against registry
- Check expression syntax

**Feature dependency cycles:**
- Review feature definitions
- Check for circular dependencies
- Simplify feature graph

**Expression type errors:**
- Check return type (boolean for conditions)
- Verify feature types
- Check operator compatibility

## Common Patterns

### Validating YAML Schema
```typescript
import { strategySchema } from '../spec/schema'

const result = strategySchema.validate(yamlObject, {
  abortEarly: false, // Collect all errors
  allowUnknown: false
})

if (result.error) {
  throw new CompilationError('Validation failed', result.error.details)
}
```

### Resolving Feature Dependencies
```typescript
// Build dependency graph
const deps: Map<string, Set<string>> = new Map()

for (const feature of features) {
  const dependencies = extractDependencies(feature)
  deps.set(feature.name, dependencies)
}

// Topological sort
const plan = topologicalSort(deps)
```

### Compiling Expressions
```typescript
import * as jsep from 'jsep'

function compileExpr(exprStr: string): CompiledExpr {
  const ast = jsep(exprStr)
  const typedAst = typecheck(ast, featureTypes)
  return optimizeAst(typedAst)
}
```

## Safety Rails
- **No eval():** Use jsep for safe parsing
- **Bounded compilation:** Limit expression depth/complexity
- **Type safety:** Validate all expressions at compile time
- **Feature validation:** Ensure all features exist in registry

## Performance Considerations
- **Cache compiled IR:** Store in database to avoid recompilation
- **Topological sort:** O(V + E) for feature dependency resolution
- **Expression optimization:** Constant folding, dead code elimination
- **Parallel compilation:** Can compile multiple strategies concurrently

## Examples

### Simple RSI Strategy
```yaml
meta:
  name: "RSI Mean Reversion"
  symbol: "AAPL"
  timeframe: "5m"

features:
  - name: rsi
    args: [14]

rules:
  arm: "rsi < 30"
  trigger: "rsi > 35"
  disarm: "rsi > 70"
```

### Complex Multi-Indicator Strategy
```yaml
features:
  - name: rsi
  - name: macd
  - name: bb_upper
  - name: bb_lower

rules:
  arm: "rsi < 30 && close < bb_lower"
  trigger: "macd_histogram > 0 && close > bb_lower"
  disarm: "rsi > 70 || close > bb_upper"
```

---

**Related Files:**
- Root: `/CLAUDE.md` - Full project guide
- Runtime: `/runtime/engine.ts` - IR execution engine
- Features: `/features/registry.ts` - Feature registry
- Schema: `/spec/schema.ts` - YAML validation schema
