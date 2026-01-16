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

    // 80% chance to recommend swap (for testing)
    const shouldSwap = Math.random() > 0.2;

    if (shouldSwap) {
      // Modify strategy with current market price
      const currentPrice = request.marketData.currentBar.close;
      const modifiedYaml = this.modifyStrategy(request.currentStrategy.yamlContent, currentPrice);

      const baseName = this.stripAdjustmentSuffix(
        request.currentStrategy.name
      );

      return {
        timestamp: Date.now(),
        symbol: request.currentStrategy.symbol,
        recommendation: 'swap',
        confidence: 0.7,
        reason: 'Market volatility increased; adjusting entry zone',
        suggestedStrategy: {
          yamlContent: modifiedYaml,
          name: `${baseName}-adjusted-${Date.now()}`,
          reasoning: 'Adjusted trigger and order prices based on current market price'
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
   * Modify strategy with adjusted trigger conditions and order prices
   * Adjusts trigger by ±2-5% and scales order prices to current market price
   */
  private modifyStrategy(yamlContent: string, currentPrice: number): string {
    try {
      const strategy = YAML.parse(yamlContent);

      // Adjustment factor for trigger condition (±2-5%)
      const triggerAdjustmentFactor = 1 + (Math.random() * 0.06 - 0.02);

      // Adjust trigger condition
      const trigger = strategy.rules?.trigger;
      if (trigger) {
        // Match standalone numbers (not part of variable names like ema20)
        const modifiedTrigger = trigger.replace(/([<>=!&|(\s,])(\s*)(\d+\.?\d*)(?![a-zA-Z_\d])/g, (_match: string, prefix: string, space: string, num: string) => {
          const numValue = parseFloat(num);
          const adjusted = numValue * triggerAdjustmentFactor;
          return `${prefix}${space}${adjusted.toFixed(2)}`;
        });
        strategy.rules.trigger = modifiedTrigger;
      }

      // Adjust order prices based on current market price
      if (strategy.orderPlans && Array.isArray(strategy.orderPlans)) {
        for (const plan of strategy.orderPlans) {
          // Calculate scale factor ONCE using ORIGINAL entry zone midpoint
          let scaleFactor = 1.0;
          if (plan.entryZone && Array.isArray(plan.entryZone)) {
            const oldMidpoint = (plan.entryZone[0] + plan.entryZone[1]) / 2;
            scaleFactor = currentPrice / oldMidpoint;

            // Scale entry zone to current price
            plan.entryZone = [
              parseFloat((plan.entryZone[0] * scaleFactor).toFixed(2)),
              parseFloat((plan.entryZone[1] * scaleFactor).toFixed(2))
            ];
          }

          // Adjust stopPrice using the SAME scale factor
          if (typeof plan.stopPrice === 'number') {
            plan.stopPrice = parseFloat((plan.stopPrice * scaleFactor).toFixed(2));
          }

          // Adjust targets using the SAME scale factor
          if (plan.targets && Array.isArray(plan.targets)) {
            for (const target of plan.targets) {
              if (typeof target.price === 'number') {
                target.price = parseFloat((target.price * scaleFactor).toFixed(2));
              }
            }
          }
        }
      }

      // Add comment to meta indicating adjustment
      if (!strategy.meta.description) {
        strategy.meta.description = '';
      }
      strategy.meta.description += ` [Auto-adjusted: trigger ${((triggerAdjustmentFactor - 1) * 100).toFixed(1)}%, prices scaled to $${currentPrice.toFixed(2)}]`;

      return YAML.stringify(strategy);
    } catch (error) {
      console.warn('Failed to modify strategy, returning original YAML:', error);
      return yamlContent;
    }
  }

  private stripAdjustmentSuffix(name: string): string {
    return name.replace(/(-adjusted-\d+)+$/, '');
  }

  /**
   * Close connection (for future WebSocket implementation)
   */
  async close(): Promise<void> {
    // No-op for stub mode
  }
}
