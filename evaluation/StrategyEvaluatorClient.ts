/**
 * Strategy Evaluator Client
 * WebSocket client for strategy evaluation with stub mode
 */

import * as YAML from 'yaml';
import { EvaluationRequest, EvaluationResponse } from './types';

export class StrategyEvaluatorClient {
  private endpoint: string;
  private stubMode: boolean;
  private enabled: boolean;

  constructor(endpoint: string, enabled: boolean = true) {
    this.endpoint = endpoint;
    this.enabled = enabled;
    // Always use stub mode for now (until real WebSocket endpoint is implemented)
    this.stubMode = true;
  }

  /**
   * Evaluate strategy appropriateness
   */
  async evaluate(request: EvaluationRequest, options: { timeout?: number } = {}): Promise<EvaluationResponse> {
    if (!this.enabled) {
      // Evaluation disabled, return 'keep' recommendation
      return {
        timestamp: Date.now(),
        symbol: request.currentStrategy.symbol,
        recommendation: 'keep',
        confidence: 1.0,
        reason: 'Evaluation disabled in configuration',
      };
    }

    const timeout = options.timeout || 5000;

    try {
      if (this.stubMode) {
        return await this.evaluateStub(request);
      } else {
        return await this.evaluateWebSocket(request, timeout);
      }
    } catch (error: any) {
      console.warn(`⚠️ Evaluation failed: ${error.message}. Continuing with current strategy.`);
      // Return 'keep' recommendation on failure
      return {
        timestamp: Date.now(),
        symbol: request.currentStrategy.symbol,
        recommendation: 'keep',
        confidence: 0.5,
        reason: `Evaluation error: ${error.message}`,
      };
    }
  }

  /**
   * Stub evaluation for testing (no external service needed)
   */
  private async evaluateStub(request: EvaluationRequest): Promise<EvaluationResponse> {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));

    // 20% chance to recommend swap (for testing)
    const shouldSwap = Math.random() > 0.8;

    if (shouldSwap) {
      // Modify trigger point slightly (±2-5%)
      const modifiedYaml = this.modifyTriggerPoint(request.currentStrategy.yamlContent);

      return {
        timestamp: Date.now(),
        symbol: request.currentStrategy.symbol,
        recommendation: 'swap',
        confidence: 0.7,
        reason: 'Market volatility increased; adjusting entry zone',
        suggestedStrategy: {
          yamlContent: modifiedYaml,
          name: `${request.currentStrategy.name}-adjusted-${Date.now()}`,
          reasoning: 'Widened entry zone by 3% based on volatility spike'
        }
      };
    }

    return {
      timestamp: Date.now(),
      symbol: request.currentStrategy.symbol,
      recommendation: 'keep',
      confidence: 0.9,
      reason: 'Strategy performing within expected parameters'
    };
  }

  /**
   * Real WebSocket evaluation (not implemented yet)
   */
  private async evaluateWebSocket(request: EvaluationRequest, timeout: number): Promise<EvaluationResponse> {
    // TODO: Implement WebSocket connection to evaluation endpoint
    // For now, throw error to indicate not implemented
    throw new Error('WebSocket evaluation not implemented. Using stub mode.');
  }

  /**
   * Modify trigger point in YAML strategy
   * Randomly adjusts trigger condition by ±2-5%
   */
  private modifyTriggerPoint(yamlContent: string): string {
    try {
      const strategy = YAML.parse(yamlContent);

      // Parse the trigger condition
      const trigger = strategy.rules?.trigger;
      if (!trigger) {
        return yamlContent;
      }

      // Look for numeric values in trigger condition and adjust them
      const adjustmentFactor = 1 + (Math.random() * 0.06 - 0.02); // ±2-5%

      // Match standalone numbers (not part of variable names like ema20)
      // Only match numbers that appear after operators or spaces, not after alphanumeric chars
      const modifiedTrigger = trigger.replace(/([<>=!&|(\s,])(\s*)(\d+\.?\d*)(?![a-zA-Z_\d])/g, (match: string, prefix: string, space: string, num: string) => {
        const numValue = parseFloat(num);
        const adjusted = numValue * adjustmentFactor;
        return `${prefix}${space}${adjusted.toFixed(2)}`;
      });

      strategy.rules.trigger = modifiedTrigger;

      // Add comment to meta indicating adjustment
      if (!strategy.meta.description) {
        strategy.meta.description = '';
      }
      strategy.meta.description += ` [Auto-adjusted: trigger ${((adjustmentFactor - 1) * 100).toFixed(1)}%]`;

      return YAML.stringify(strategy);
    } catch (error) {
      console.warn('Failed to modify trigger point, returning original YAML:', error);
      return yamlContent;
    }
  }

  /**
   * Close connection (for future WebSocket implementation)
   */
  async close(): Promise<void> {
    // No-op for stub mode
  }
}
