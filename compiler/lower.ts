/**
 * Lowering: simplify DSL constructs into canonical IR form
 * E.g., invalidate.when_any: [...] -> OR expression
 */
import { ExprNode } from '../spec/types';
import { parseExpression } from './expr';

// ============================================================================
// Lower invalidate.when_any into OR expression
// ============================================================================

export function lowerInvalidateWhenAny(
  conditionStrings: string[]
): ExprNode | null {
  if (!conditionStrings || conditionStrings.length === 0) {
    return null;
  }

  const nodes = conditionStrings.map((s) => parseExpression(s));

  // Build left-associative OR tree: (a || b) || c || d
  let result = nodes[0];
  for (let i = 1; i < nodes.length; i++) {
    result = {
      type: 'binary',
      operator: '||',
      left: result,
      right: nodes[i],
    };
  }

  return result;
}

// ============================================================================
// Lower invalidate object to single OR condition
// ============================================================================

export function lowerInvalidate(invalidate: {
  when_any?: string[];
} | undefined): ExprNode | null {
  if (!invalidate) {
    return null;
  }

  if (invalidate.when_any) {
    return lowerInvalidateWhenAny(invalidate.when_any);
  }

  return null;
}
