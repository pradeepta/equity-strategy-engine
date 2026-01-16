/**
 * Alpaca MCP (Model Context Protocol) Adapter
 * Demonstrates how to call MCP tools for order execution
 * (Stub: shows the interface structure but doesn't actually call MCP)
 */
import {
  OrderPlan,
  Order,
  BrokerEnvironment,
  CancellationResult,
} from "../spec/types";
import { BaseBrokerAdapter } from "./broker";

/**
 * Mock MCP Client interface (would be real in production)
 */
interface MCPClient {
  callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ result: unknown; error?: string }>;
}

/**
 * Alpaca MCP adapter - delegates to MCP tools
 * Useful for: LLM-driven execution, remote servers, etc.
 */
export class AlpacaMcpAdapter extends BaseBrokerAdapter {
  constructor(private mcpClient: MCPClient) {
    super();
  }

  /**
   * Submit order plan via MCP tool call
   */
  async submitOrderPlan(
    plan: OrderPlan,
    env: BrokerEnvironment
  ): Promise<Order[]> {
    console.log("\n" + "=".repeat(60));
    console.log("ALPACA MCP ADAPTER: ORDER PLAN SUBMISSION");
    console.log("=".repeat(60));

    this.enforceOrderConstraints(plan, env);

    console.log(this.formatBracketPayload(plan));
    console.log("");

    const expanded = this.expandSplitBracket(plan);
    const submittedOrders: Order[] = [];

    try {
      for (let i = 0; i < expanded.length; i++) {
        const bracket = expanded[i];
        console.log(`\nSubmitting bracket ${i + 1}/${expanded.length} via MCP:`);

      const toolName = "alpaca_submit_bracket_order";
      const args = {
        symbol: plan.symbol,
        qty: bracket.entryOrder.qty,
        side: plan.side,
        entry_price: plan.targetEntryPrice,
        take_profit_price: bracket.takeProfit.limitPrice,
        stop_loss_price: bracket.stopLoss.limitPrice,
        time_in_force: "day",
      };

      console.log(`\nMCP Tool Call: ${toolName}`);
      console.log("Arguments:");
      console.log(JSON.stringify(args, null, 2));

        if (env.dryRun) {
          console.log(
            "→ DRY RUN: MCP tool would be called (not actually called)"
          );
          submittedOrders.push(bracket.entryOrder);
        } else {
          console.log("→ Calling MCP tool...");
          const response = await this.mcpClient.callTool(toolName, args);

          if (response.error) {
            throw new Error(response.error);
          }

          console.log("← MCP Response:");
          console.log(JSON.stringify(response.result, null, 2));
          submittedOrders.push(bracket.entryOrder);
        }
      }
    } catch (e) {
      const err = e as Error;
      console.error(`✗ Failed to submit bracket: ${err.message}`);

      if (submittedOrders.length > 0) {
        console.warn("⚠️  Rolling back submitted orders due to failure...");
        await this.cancelOpenEntries(plan.symbol, submittedOrders, env);
      }

      throw err;
    }

    console.log("=".repeat(60) + "\n");
    return submittedOrders;
  }

  /**
   * Submit a market order to close a position via MCP
   */
  async submitMarketOrder(
    symbol: string,
    qty: number,
    side: "buy" | "sell",
    env: BrokerEnvironment
  ): Promise<Order> {
    console.log("\n" + "=".repeat(60));
    console.log("ALPACA MCP ADAPTER: MARKET ORDER");
    console.log("=".repeat(60));
    console.log(`Symbol: ${symbol}, Side: ${side}, Qty: ${qty}`);

    const order: Order = {
      id: this.generateOrderId("market"),
      planId: `market-exit-${Date.now()}`,
      symbol,
      side,
      qty,
      type: "market",
      status: env.dryRun ? "submitted" : "pending",
    };

    const toolName = "alpaca_submit_market_order";
    const args = {
      symbol,
      qty,
      side,
      time_in_force: "day",
    };

    console.log(`\nMCP Tool Call: ${toolName}`);
    console.log("Arguments:");
    console.log(JSON.stringify(args, null, 2));

    if (env.dryRun) {
      console.log("→ DRY RUN: MCP tool would be called (not actually called)");
      console.log("=".repeat(60));
      return order;
    }

    console.log("→ Calling MCP tool...");
    const response = await this.mcpClient.callTool(toolName, args);
    if (response.error) {
      throw new Error(response.error);
    }

    console.log("← MCP Response:");
    console.log(JSON.stringify(response.result, null, 2));
    order.status = "submitted";
    console.log("=".repeat(60));
    return order;
  }

  /**
   * Cancel entries via MCP
   */
  async cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<CancellationResult> {
    console.log(`\nALPACA MCP: Cancelling ${orders.length} orders via MCP`);

    const result: CancellationResult = {
      succeeded: [],
      failed: [],
    };

    for (const order of orders) {
      const toolName = "alpaca_cancel_order";
      const args = {
        order_id: order.id,
        symbol,
      };

      console.log(`\nMCP Tool Call: ${toolName}`);
      console.log("Arguments:");
      console.log(JSON.stringify(args, null, 2));

      if (env.dryRun) {
        console.log("→ DRY RUN: Would call MCP tool");
        result.succeeded.push(order.id);
      } else {
        try {
          console.log("→ Calling MCP tool...");
          const response = await this.mcpClient.callTool(toolName, args);

          if (response.error) {
            const reason = `MCP Error: ${response.error}`;
            console.error(`✗ ${reason}`);
            result.failed.push({ orderId: order.id, reason });
            // FAIL FAST: Throw immediately on MCP error
            throw new Error(`Failed to cancel order ${order.id}: ${reason}`);
          } else {
            console.log("← Cancelled via MCP");
            result.succeeded.push(order.id);
          }
        } catch (e) {
          const err = e as Error;
          const reason = `MCP call failed: ${err.message}`;
          console.error(`✗ ${reason}`);
          result.failed.push({ orderId: order.id, reason });
          // FAIL FAST: Throw immediately on exception
          throw new Error(`Failed to cancel order ${order.id}: ${reason}`);
        }
      }
    }

    console.log(
      `Cancellation result: ${result.succeeded.length} succeeded, ${result.failed.length} failed`
    );
    return result;
  }

  /**
   * Get open orders via MCP
   */
  async getOpenOrders(
    symbol: string,
    env: BrokerEnvironment
  ): Promise<Order[]> {
    const toolName = "alpaca_get_open_orders";
    const args = { symbol };

    console.log(`\nALPACA MCP: Fetching open orders for ${symbol}`);
    console.log(`MCP Tool Call: ${toolName}`);
    console.log("Arguments:");
    console.log(JSON.stringify(args, null, 2));

    if (env.dryRun) {
      console.log("→ DRY RUN: Would call MCP tool");
      return [];
    }

    try {
      console.log("→ Calling MCP tool...");
      const response = await this.mcpClient.callTool(toolName, args);

      if (response.error) {
        console.error(`✗ MCP Error: ${response.error}`);
        return [];
      }

      console.log("← MCP Response:");
      console.log(JSON.stringify(response.result, null, 2));

      // Map MCP response to Order objects
      // In production: parse response.result
      return [];
    } catch (e) {
      const err = e as Error;
      console.error(`Failed to fetch orders via MCP: ${err.message}`);
      return [];
    }
  }
}
