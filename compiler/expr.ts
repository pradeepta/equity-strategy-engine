/**
 * Expression language: parsing and safe evaluation
 * Uses jsep for parsing, implements custom safe evaluator
 */
import jsep from 'jsep';
import { ExprNode, EvaluationContext, FeatureValue } from '../spec/types';

// ============================================================================
// Built-in Functions (whitelisted)
// ============================================================================

const BUILTIN_FUNCTIONS: Record<string, (args: number[]) => number | boolean> = {
  in_range: (args: number[]) => {
    if (args.length !== 3) throw new Error('in_range expects 3 args');
    const [value, min, max] = args;
    return value >= min && value <= max;
  },
  clamp: (args: number[]) => {
    if (args.length !== 3) throw new Error('clamp expects 3 args');
    const [value, min, max] = args;
    return Math.max(min, Math.min(max, value));
  },
  abs: (args: number[]) => {
    if (args.length !== 1) throw new Error('abs expects 1 arg');
    return Math.abs(args[0]);
  },
  min: (args: number[]) => Math.min(...args),
  max: (args: number[]) => Math.max(...args),
  round: (args: number[]) => {
    if (args.length !== 1 && args.length !== 2) {
      throw new Error('round expects 1-2 args');
    }
    const [value, decimals = 0] = args;
    const mult = Math.pow(10, decimals);
    return Math.round(value * mult) / mult;
  },
};

// ============================================================================
// Parser
// ============================================================================

export function parseExpression(expr: string): ExprNode {
  // Convert jsep output to our ExprNode type
  const raw = jsep(expr);
  return normalizeNode(raw as any);
}

function normalizeNode(raw: any): ExprNode {
  if (!raw) {
    throw new Error('Invalid expression');
  }

  if (raw.type === 'Literal') {
    return {
      type: 'literal',
      value: raw.value,
    };
  }

  if (raw.type === 'Identifier') {
    return {
      type: 'identifier',
      name: raw.name,
    };
  }

  if (raw.type === 'BinaryExpression') {
    return {
      type: 'binary',
      operator: raw.operator,
      left: normalizeNode(raw.left),
      right: normalizeNode(raw.right),
    };
  }

  if (raw.type === 'UnaryExpression') {
    return {
      type: 'unary',
      operator: raw.operator,
      argument: normalizeNode(raw.argument),
    };
  }

  if (raw.type === 'CallExpression') {
    return {
      type: 'call',
      callee: raw.callee.name || raw.callee,
      arguments: raw.arguments.map((arg: any) => normalizeNode(arg)),
    };
  }

  if (raw.type === 'MemberExpression') {
    if (raw.computed) {
      // Array access: feature[1], macd.histogram[0]
      return {
        type: 'array_access',
        object: normalizeNode(raw.object),
        index: normalizeNode(raw.property),
      };
    } else {
      // Dot access: macd.histogram
      return {
        type: 'member',
        object: normalizeNode(raw.object),
        property: raw.property.name,
      };
    }
  }

  throw new Error(`Unknown node type: ${raw.type}`);
}

// ============================================================================
// Identifier Extraction
// ============================================================================

export function extractIdentifiers(node: ExprNode): Set<string> {
  const ids = new Set<string>();

  function walk(n: ExprNode): void {
    if (n.type === 'identifier') {
      if (n.name) ids.add(n.name);
    } else if (n.type === 'binary') {
      if (n.left) walk(n.left);
      if (n.right) walk(n.right);
    } else if (n.type === 'unary') {
      if (n.argument) walk(n.argument);
    } else if (n.type === 'call') {
      if (n.arguments) {
        for (const arg of n.arguments) {
          walk(arg);
        }
      }
    } else if (n.type === 'member') {
      // For dot notation: macd.histogram
      if (n.object) walk(n.object);
      // Property is a string, not a node, so don't walk it
    } else if (n.type === 'array_access') {
      // For array access: feature[1]
      if (n.object) walk(n.object);
      if (n.index) walk(n.index);
    }
  }

  walk(node);
  return ids;
}

// ============================================================================
// Safe Evaluator (NO eval!)
// ============================================================================

export function evaluateExpression(
  node: ExprNode,
  ctx: EvaluationContext
): FeatureValue {
  return evaluate(node, ctx);
}

function evaluate(node: ExprNode, ctx: EvaluationContext): FeatureValue {
  if (node.type === 'literal') {
    return node.value as FeatureValue;
  }

  if (node.type === 'identifier') {
    const name = node.name!;
    // Check features first, then builtins
    if (ctx.features.has(name)) {
      return ctx.features.get(name)!;
    }
    if (ctx.builtins.has(name)) {
      return ctx.builtins.get(name)!;
    }
    throw new Error(`Undefined identifier: ${name}`);
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
        return left === right;
      case '!=':
        return left !== right;
      case '<':
        return (left as number) < (right as number);
      case '>':
        return (left as number) > (right as number);
      case '<=':
        return (left as number) <= (right as number);
      case '>=':
        return (left as number) >= (right as number);
      case '&&':
        return left && right;
      case '||':
        return left || right;
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
        return !arg;
      default:
        throw new Error(`Unknown unary operator: ${op}`);
    }
  }

  if (node.type === 'call') {
    const funcName = node.callee!;
    if (!BUILTIN_FUNCTIONS.hasOwnProperty(funcName)) {
      throw new Error(`Unknown function: ${funcName}`);
    }

    const args = (node.arguments || []).map((arg) => evaluate(arg, ctx));
    const func = BUILTIN_FUNCTIONS[funcName];
    return func(args as number[]);
  }

  throw new Error(`Unknown node type: ${(node as any).type}`);
}
