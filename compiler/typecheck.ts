/**
 * Type checking and identifier validation
 */
import { ExprNode } from '../spec/types';
import { extractIdentifiers } from './expr';

// ============================================================================
// Builtin identifiers
// ============================================================================

const BUILTIN_IDENTIFIERS = new Set([
  'open',
  'high',
  'low',
  'close',
  'volume',
  'price', // alias for close
]);

const BUILTIN_FUNCTIONS = new Set([
  'in_range',
  'clamp',
  'abs',
  'min',
  'max',
  'round',
]);

// ============================================================================
// Type Checker
// ============================================================================

export interface TypeCheckError {
  message: string;
  identifiers?: string[];
}

export function typeCheckExpression(
  expr: ExprNode,
  declaredFeatures: Set<string>
): TypeCheckError | null {
  const identifiers = extractIdentifiers(expr);

  const undeclared: string[] = [];
  for (const id of identifiers) {
    if (!BUILTIN_IDENTIFIERS.has(id) && !declaredFeatures.has(id)) {
      undeclared.push(id);
    }
  }

  if (undeclared.length > 0) {
    return {
      message: `Undefined identifiers in expression: ${undeclared.join(', ')}`,
      identifiers: undeclared,
    };
  }

  // Check for invalid function calls
  const funcError = checkFunctionCalls(expr);
  if (funcError) return funcError;

  return null;
}

function checkFunctionCalls(node: ExprNode): TypeCheckError | null {
  if (node.type === 'call') {
    const funcName = node.callee;
    if (!BUILTIN_FUNCTIONS.has(funcName!)) {
      return {
        message: `Unknown function: ${funcName}. Allowed: ${Array.from(BUILTIN_FUNCTIONS).join(', ')}`,
      };
    }
  }

  if (node.type === 'binary') {
    if (node.left) {
      const err = checkFunctionCalls(node.left);
      if (err) return err;
    }
    if (node.right) {
      const err = checkFunctionCalls(node.right);
      if (err) return err;
    }
  }

  if (node.type === 'unary') {
    if (node.argument) {
      const err = checkFunctionCalls(node.argument);
      if (err) return err;
    }
  }

  if (node.type === 'call') {
    if (node.arguments) {
      for (const arg of node.arguments) {
        const err = checkFunctionCalls(arg);
        if (err) return err;
      }
    }
  }

  return null;
}
