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

  throw new Error(`Unknown node type: ${(node as any).type}`);
}
