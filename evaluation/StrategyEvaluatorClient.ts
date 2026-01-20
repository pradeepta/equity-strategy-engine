/**
 * Strategy Evaluator Client
 * WebSocket client for strategy evaluation with stub mode
 */

import * as YAML from "yaml";
import { EvaluationRequest, EvaluationResponse } from "./types";
import { getMarketHoursInfo, calculateTradingTime } from "../utils/marketHours";

export class StrategyEvaluatorClient {
  private endpoint: string;
  private stubMode: boolean;
  private enabled: boolean;
  private wsImpl: any = (globalThis as any).WebSocket;
  private ws: any = null;
  private wsBuffer = "";
  private sessionId: string | null = null;
  private connecting: Promise<void> | null = null;
  private requestIdCounter = 1;
  private pendingSessionNew: {
    id: number;
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  private pendingPrompt: {
    id: number;
    resolve: (text: string) => void;
    reject: (err: Error) => void;
    buffer: string;
  } | null = null;

  constructor(endpoint: string, enabled: boolean = true) {
    this.endpoint = endpoint;
    this.enabled = enabled;
    // Always use stub mode for now (until real WebSocket endpoint is implemented)
    this.stubMode = true;
  }

  /**
   * Evaluate strategy appropriateness
   */
  async evaluate(
    request: EvaluationRequest,
    options: { timeout?: number } = {}
  ): Promise<EvaluationResponse> {
    if (!this.enabled) {
      // Evaluation disabled, return 'keep' recommendation
      return {
        timestamp: Date.now(),
        symbol: request.currentStrategy.symbol,
        recommendation: "keep",
        confidence: 1.0,
        reason: "Evaluation disabled in configuration",
      };
    }

    const timeout = options.timeout || 50000;

    try {
      if (this.stubMode) {
        return await this.evaluateStub(request);
      } else {
        return await this.evaluateWebSocket(request, timeout);
      }
    } catch (error: any) {
      console.warn(
        `⚠️ Evaluation failed: ${error.message}. Continuing with current strategy.`
      );
      // Return 'keep' recommendation on failure
      return {
        timestamp: Date.now(),
        symbol: request.currentStrategy.symbol,
        recommendation: "keep",
        confidence: 0.5,
        reason: `Evaluation error: ${error.message}`,
      };
    }
  }

  /**
   * Stub evaluation for testing (no external service needed)
   */
  private async evaluateStub(
    request: EvaluationRequest
  ): Promise<EvaluationResponse> {
    await this.ensureConnection();

    if (!this.sessionId) {
      throw new Error("Evaluation session not initialized");
    }

    const prompt = this.buildEvaluationPrompt(request);
    const responseText = await this.sendPrompt(prompt, 120000);
    const parsed = this.extractJson(responseText);

    const recommendation =
      parsed.recommendation as EvaluationResponse["recommendation"];
    if (
      !recommendation ||
      !["keep", "swap", "close"].includes(recommendation)
    ) {
      throw new Error(`Invalid recommendation: ${String(recommendation)}`);
    }

    return {
      timestamp: Date.now(),
      symbol: request.currentStrategy.symbol,
      recommendation,
      confidence: Number(parsed.confidence ?? 0.5),
      reason: String(parsed.reason ?? "No reason provided"),
      suggestedStrategy: parsed.suggestedStrategy,
    };
  }

  /**
   * Real WebSocket evaluation (not implemented yet)
   */
  private async evaluateWebSocket(
    request: EvaluationRequest,
    timeout: number
  ): Promise<EvaluationResponse> {
    // TODO: Implement WebSocket connection to evaluation endpoint
    // For now, throw error to indicate not implemented
    throw new Error("WebSocket evaluation not implemented. Using stub mode.");
  }

  private async ensureConnection(): Promise<void> {
    if (!this.wsImpl) {
      throw new Error(
        "WebSocket is not available in this Node runtime. Install a ws polyfill."
      );
    }
    if (this.ws && this.ws.readyState === this.wsImpl.OPEN && this.sessionId) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise((resolve, reject) => {
      const ws = new this.wsImpl(this.endpoint);
      this.ws = ws;

      const handleError = (err: Error) => {
        if (this.connecting) {
          this.connecting = null;
        }
        reject(err);
      };

      ws.addEventListener("open", () => {
        this.sendSessionNew()
          .then(() => {
            this.connecting = null;
            resolve();
          })
          .catch(handleError);
      });

      ws.addEventListener("message", (event: any) => {
        const data =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf-8");
        this.handleInbound(data);
      });

      ws.addEventListener("close", () => {
        this.sessionId = null;
        this.ws = null;
      });

      ws.addEventListener("error", () => {
        handleError(new Error("WebSocket error"));
      });
    });

    return this.connecting;
  }

  private async sendSessionNew(): Promise<void> {
    const id = this.nextRequestId();
    return new Promise((resolve, reject) => {
      this.pendingSessionNew = { id, resolve, reject };
      this.sendJson({
        jsonrpc: "2.0",
        id,
        method: "session/new",
        params: {
          cwd: process.cwd(),
          mcpServers: [
            {
              name: "stocks-mcp",
              type: "stdio",
              command: "node",
              args: [require.resolve("../dist/mcp-server.js")],
              env: [],
            },
          ],
        },
      });
      setTimeout(() => {
        if (this.pendingSessionNew?.id === id) {
          this.pendingSessionNew = null;
          reject(new Error("session/new timeout"));
        }
      }, 30000);
    });
  }

  private async sendPrompt(prompt: string, timeoutMs: number): Promise<string> {
    const id = this.nextRequestId();
    return new Promise((resolve, reject) => {
      this.pendingPrompt = { id, resolve, reject, buffer: "" };
      this.sendJson({
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: {
          sessionId: this.sessionId,
          stream: true,
          prompt: [{ type: "text", text: prompt }],
        },
      });
      setTimeout(() => {
        if (this.pendingPrompt?.id === id) {
          this.pendingPrompt = null;
          reject(new Error("session/prompt timeout"));
        }
      }, timeoutMs);
    });
  }

  private handleInbound(chunk: string): void {
    this.wsBuffer += chunk;

    if (this.tryHandleJson(this.wsBuffer)) {
      this.wsBuffer = "";
      return;
    }

    const parts = this.wsBuffer.split("\n");
    this.wsBuffer = parts.pop() || "";

    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      if (this.tryHandleJson(line)) {
        continue;
      }
    }
  }

  private tryHandleJson(payload: string): boolean {
    let msg: any;
    try {
      msg = JSON.parse(payload);
    } catch {
      return false;
    }

    if (msg?.result?.sessionId && !msg.method && this.pendingSessionNew) {
      if (msg.id === this.pendingSessionNew.id) {
        this.sessionId = msg.result.sessionId;
        this.pendingSessionNew.resolve();
        this.pendingSessionNew = null;
      }
      return true;
    }

    if (
      msg?.error &&
      this.pendingSessionNew &&
      msg.id === this.pendingSessionNew.id
    ) {
      this.pendingSessionNew.reject(
        new Error(msg.error.message || "session/new failed")
      );
      this.pendingSessionNew = null;
      return true;
    }

    if (msg?.method === "session/update" && this.pendingPrompt) {
      const update = msg.params?.update;
      const text = this.extractText(update?.textContent || update?.content);
      if (text !== undefined) {
        this.pendingPrompt.buffer += text;
      }
      return true;
    }

    if (msg?.result?.stopReason && this.pendingPrompt) {
      const done = this.pendingPrompt;
      this.pendingPrompt = null;
      done.resolve(done.buffer);
      return true;
    }

    return true;
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== this.wsImpl.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private nextRequestId(): number {
    return this.requestIdCounter++;
  }

  private extractText(content: any): string | undefined {
    if (!content) return undefined;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => (typeof item?.text === "string" ? item.text : ""))
        .join("");
    }
    if (typeof content?.text === "string") return content.text;
    return undefined;
  }

  private extractJson(text: string): any {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in response");
    }
    const candidate = text.slice(start, end + 1);
    return JSON.parse(candidate);
  }

  private buildEvaluationPrompt(request: EvaluationRequest): string {
    // Calculate market hours context
    const marketInfo = getMarketHoursInfo();
    const tradingTime = calculateTradingTime(
      request.performance.barsActive,
      request.currentStrategy.timeframe
    );

    return [
      "You are a trading strategy evaluator.",
      "Return ONLY valid JSON with this schema:",
      '{ "recommendation": "keep|swap|close", "confidence": number, "reason": string, "suggestedStrategy"?: { "yamlContent": string, "name": string, "reasoning": string } }',
      'If recommendation is "swap", include suggestedStrategy.',
      "No extra text outside JSON.",
      "",
      "CRITICAL: MARKET HOURS CONTEXT",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `Current Time: ${marketInfo.currentTimeET} ET (${marketInfo.currentDayOfWeek})`,
      `Market Status: ${marketInfo.description}`,
      `Market Hours: ${marketInfo.marketOpen} - ${marketInfo.marketClose}, Monday-Friday`,
      "",
      "STRATEGY ACTIVITY ANALYSIS:",
      `Total Bars: ${tradingTime.totalBars} bars (${request.currentStrategy.timeframe} timeframe)`,
      `Bars Per Trading Day: ${tradingTime.barsPerDay} bars`,
      `Estimated Trading Days: ${tradingTime.estimatedTradingDays.toFixed(1)} days`,
      `Estimated Market Hours: ${tradingTime.estimatedTradingHours.toFixed(1)} hours`,
      `Total Calendar Time: ${tradingTime.totalCalendarHours.toFixed(1)} hours (includes weekends/nights)`,
      "",
      "⚠️ IMPORTANT: When evaluating strategy staleness, ONLY consider MARKET HOURS:",
      `- A strategy with ${tradingTime.totalBars} bars has been active for ${tradingTime.estimatedTradingHours.toFixed(1)} hours of actual trading time`,
      `- This equals ${tradingTime.estimatedTradingDays.toFixed(1)} trading days (NOT calendar days)`,
      "- Breakout strategies typically need 1-3 trading days (78-234 bars @ 5m) to materialize",
      "- Mean reversion strategies typically need 0.5-2 trading days (39-156 bars @ 5m)",
      `- DO NOT close a strategy just because it includes weekend/overnight hours in bar count`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "SUPPORTED INDICATORS (you MUST only use these in suggested strategies):",
      "",
      "Moving Averages:",
      "- ema20, ema50 (Exponential Moving Average)",
      "- sma50, sma150, sma200 (Simple Moving Average)",
      "- sma50_rising, sma150_rising, sma200_rising (Trend detection)",
      "- vwap (Volume Weighted Average Price)",
      "",
      "Momentum & Oscillators:",
      "- rsi (Relative Strength Index 14-period)",
      "- macd, macd_signal, macd_histogram (MACD)",
      "- stochastic_k, stochastic_d (Stochastic Oscillator 14-period)",
      "- cci (Commodity Channel Index 20-period)",
      "- williams_r (Williams %R 14-period)",
      "",
      "Volatility & Range:",
      "- bb_upper, bb_middle, bb_lower (Bollinger Bands)",
      "- atr (Average True Range 14-period)",
      "",
      "Trend Strength:",
      "- adx (Average Directional Index 14-period)",
      "",
      "Volume Indicators:",
      "- volume_zscore (Volume Z-Score)",
      "- volume_sma (Simple Moving Average of Volume 20-period)",
      "- volume_ema (Exponential Moving Average of Volume 20-period)",
      "- obv (On Balance Volume)",
      "",
      "Price Levels:",
      "- lod, hod (Low/High of Day)",
      "- fifty_two_week_high, fifty_two_week_low",
      "",
      "Pattern Recognition:",
      "- cup_handle_confidence (Cup & Handle pattern score 0-100)",
      "",
      "Microstructure:",
      "- delta, absorption",
      "",
      "IMPORTANT: Only use indicators from the list above. Do NOT invent new ones.",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "CRITICAL: DSL SYNTAX VALIDATION",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "⚠️ NEVER ASSUME DSL SYNTAX IS INVALID - ALWAYS VERIFY FIRST!",
      "",
      "You have access to the validate_strategy MCP tool. Use it to:",
      "1. Verify if a strategy's YAML syntax is valid",
      "2. Check if expressions compile correctly",
      "3. Get definitive validation results instead of guessing",
      "",
      "BEFORE recommending CLOSE due to syntax errors:",
      "→ Call validate_strategy({ yaml_content: \"...\" })",
      "→ Only cite syntax errors if validation actually fails",
      "→ Include the actual validation error message in your reason",
      "",
      "The DSL fully supports:",
      "• ✅ Array indexing: feature[1] (previous bar), feature[2] (2 bars ago), etc.",
      "• ✅ Dot notation: macd.histogram automatically converts to macd_histogram",
      "• ✅ Combined syntax: macd.histogram[1] works (converts to macd_histogram[1])",
      "• ✅ Crossover patterns: macd_histogram > 0 && macd_histogram[1] <= 0",
      "• ✅ Multi-bar comparisons: close > close[1] && close[1] > close[2]",
      "• ✅ History: 100 bars stored, index 0=current to 99=oldest",
      "",
      "If you see these patterns, they are VALID - but use validate_strategy to confirm!",
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "CRITICAL: ENTRY ZONE EVALUATION LOGIC",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "When evaluating entry zone feasibility, you MUST understand order side semantics:",
      "",
      "FOR BUY ORDERS:",
      "- Entry zone [X, Y] means we want to BUY when price rises INTO this zone",
      "- If current price < entry zone LOW: NEUTRAL (waiting for price to rise)",
      "- If current price is within entry zone: GOOD (strategy is armed/triggered)",
      "- If current price > entry zone HIGH: May have missed entry (but not necessarily a problem)",
      "- ONLY problematic if price drops significantly below stop loss with no recovery",
      "",
      "FOR SELL ORDERS:",
      "- Entry zone [X, Y] means we want to SELL when price falls INTO this zone",
      "- If current price > entry zone HIGH: NEUTRAL (waiting for price to fall)",
      "- If current price is within entry zone: GOOD (strategy is armed/triggered)",
      "- If current price < entry zone LOW: May have missed entry (but not necessarily a problem)",
      "- ONLY problematic if price rises significantly above stop loss with no recovery",
      "",
      "⚠️ COMMON MISTAKE TO AVOID:",
      "DO NOT say \"price is below entry zone\" is a problem for BUY orders - that's just WAITING",
      "DO NOT say \"price is above entry zone\" is a problem for SELL orders - that's just WAITING",
      "",
      "PRIMARY CLOSURE REASONS:",
      "1. Strategy is in EXITED state (invalidation rules triggered)",
      "2. Zero orders placed after multiple trading days (strategy never armed/triggered)",
      "3. Market conditions have fundamentally changed (extreme volatility, news events)",
      "4. Price has moved so far away from entry that recovery is impossible (beyond stop loss)",
      "",
      "EvaluationRequest JSON:",
      JSON.stringify(request),
    ].join("\n");
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
        const modifiedTrigger = trigger.replace(
          /([<>=!&|(\s,])(\s*)(\d+\.?\d*)(?![a-zA-Z_\d])/g,
          (_match: string, prefix: string, space: string, num: string) => {
            const numValue = parseFloat(num);
            const adjusted = numValue * triggerAdjustmentFactor;
            return `${prefix}${space}${adjusted.toFixed(2)}`;
          }
        );
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
              parseFloat((plan.entryZone[1] * scaleFactor).toFixed(2)),
            ];
          }

          // Adjust stopPrice using the SAME scale factor
          if (typeof plan.stopPrice === "number") {
            plan.stopPrice = parseFloat(
              (plan.stopPrice * scaleFactor).toFixed(2)
            );
          }

          // Adjust targets using the SAME scale factor
          if (plan.targets && Array.isArray(plan.targets)) {
            for (const target of plan.targets) {
              if (typeof target.price === "number") {
                target.price = parseFloat(
                  (target.price * scaleFactor).toFixed(2)
                );
              }
            }
          }
        }
      }

      // Add comment to meta indicating adjustment
      if (!strategy.meta.description) {
        strategy.meta.description = "";
      }
      strategy.meta.description += ` [Auto-adjusted: trigger ${(
        (triggerAdjustmentFactor - 1) *
        100
      ).toFixed(1)}%, prices scaled to $${currentPrice.toFixed(2)}]`;

      return YAML.stringify(strategy);
    } catch (error) {
      console.warn(
        "Failed to modify strategy, returning original YAML:",
        error
      );
      return yamlContent;
    }
  }

  private stripAdjustmentSuffix(name: string): string {
    return name.replace(/(-adjusted-\d+)+$/, "");
  }

  /**
   * Close connection (for future WebSocket implementation)
   */
  async close(): Promise<void> {
    // No-op for stub mode
  }
}
