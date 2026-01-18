/**
 * Runtime expression evaluation
 * Bridges compiled IR and feature values to condition evaluation
 */
import { ExprNode, EvaluationContext, FeatureValue } from '../spec/types';

// ============================================================================
// Safe Evaluator (same as compiler, but for runtime)
// ============================================================================

export function evaluateCondition(
  node: ExprNode,
  ctx: EvaluationContext
): boolean {
  const result = evaluate(node, ctx);
  return Boolean(result);
}

function evaluate(node: ExprNode, ctx: EvaluationContext): FeatureValue {
  if (node.type === 'literal') {
    return node.value as FeatureValue;
  }

  if (node.type === 'identifier') {
    const name = node.name!;
    if (ctx.features.has(name)) {
      return ctx.features.get(name)!;
    }
    if (ctx.builtins.has(name)) {
      return ctx.builtins.get(name)!;
    }
    throw new Error(`Undefined identifier at runtime: ${name}`);
  }

  if (node.type === 'binary') {
    const left = evaluate(node.left!, ctx);
    const right = evaluate(node.right!, ctx);
    const op = node.operator!;

    switch (op) {
      case '+':
        return (left as number) + (right as number);
      case '-':
        return (left as number) - (right as number);
      case '*':
        return (left as number) * (right as number);
      case '/':
        return (left as number) / (right as number);
      case '%':
        return (left as number) % (right as number);
      case '==':
        return left === right ? 1 : 0;
      case '!=':
        return left !== right ? 1 : 0;
      case '<':
        return (left as number) < (right as number) ? 1 : 0;
      case '>':
        return (left as number) > (right as number) ? 1 : 0;
      case '<=':
        return (left as number) <= (right as number) ? 1 : 0;
      case '>=':
        return (left as number) >= (right as number) ? 1 : 0;
      case '&&':
        return left && right ? 1 : 0;
      case '||':
        return left || right ? 1 : 0;
      default:
        throw new Error(`Unknown operator: ${op}`);
    }
  }

  if (node.type === 'unary') {
    const arg = evaluate(node.argument!, ctx);
    const op = node.operator!;

    switch (op) {
      case '-':
        return -(arg as number);
      case '+':
        return arg as number;
      case '!':
        return arg ? 0 : 1;
      default:
        throw new Error(`Unknown unary operator: ${op}`);
    }
  }

  if (node.type === 'call') {
    const funcName = node.callee!;
    const func = ctx.functions.get(funcName);
    if (!func) {
      throw new Error(`Unknown function: ${funcName}`);
    }

    const args = (node.arguments || []).map((arg) => evaluate(arg, ctx));
    return func(args as number[]);
  }

  if (node.type === 'member') {
    // Handle dot notation: macd.histogram
    // Convert to underscore format: macd_histogram
    const objectName = (node.object as any).name;
    if (!objectName) {
      throw new Error('Member expression object must be an identifier');
    }
    const property = node.property!;
    const featureName = `${objectName}_${property}`;

    // Look up in features
    if (ctx.features.has(featureName)) {
      return ctx.features.get(featureName)!;
    }
    if (ctx.builtins.has(featureName)) {
      return ctx.builtins.get(featureName)!;
    }
    throw new Error(`Undefined feature: ${featureName} (from ${objectName}.${property})`);
  }

  if (node.type === 'array_access') {
    // Handle array indexing: feature[1], macd.histogram[0]
    const index = evaluate(node.index!, ctx) as number;

    // Get the base identifier (could be simple or member expression)
    let featureName: string;
    if (node.object!.type === 'identifier') {
      featureName = (node.object as any).name;
    } else if (node.object!.type === 'member') {
      // macd.histogram[1] -> macd_histogram
      const objectName = ((node.object as any).object as any).name;
      const property = (node.object as any).property;
      featureName = `${objectName}_${property}`;
    } else {
      throw new Error(`Array access requires identifier or member expression, got ${node.object!.type}`);
    }

    // Look up historical values
    if (!ctx.featureHistory || !ctx.featureHistory.has(featureName)) {
      throw new Error(`No history available for feature: ${featureName}`);
    }

    const history = ctx.featureHistory.get(featureName)!;
    if (history.length === 0) {
      throw new Error(`Feature history is empty for: ${featureName}`);
    }

    // Index 0 = most recent (current), 1 = previous, 2 = 2 bars ago, etc.
    // History array is stored oldest to newest, so we index from the end
    const historyIndex = history.length - 1 - index;

    if (historyIndex < 0 || historyIndex >= history.length) {
      throw new Error(
        `Insufficient history for ${featureName}[${index}]. ` +
        `Available: ${history.length} bars, requested: ${index + 1} bars ago`
      );
    }

    return history[historyIndex];
  }

  throw new Error(`Unknown node type: ${(node as any).type}`);
}
