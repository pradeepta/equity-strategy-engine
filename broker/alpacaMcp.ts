/**
 * Alpaca MCP (Model Context Protocol) Adapter
 * Demonstrates how to call MCP tools for order execution
 * (Stub: shows the interface structure but doesn't actually call MCP)
 */
import { OrderPlan, Order, BrokerEnvironment } from '../spec/types';
import { BaseBrokerAdapter } from './broker';

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
  async submitOrderPlan(plan: OrderPlan, env: BrokerEnvironment): Promise<Order[]> {
    console.log('\n' + '='.repeat(60));
    console.log('ALPACA MCP ADAPTER: ORDER PLAN SUBMISSION');
    console.log('='.repeat(60));

    console.log(this.formatBracketPayload(plan));
    console.log('');

    const expanded = this.expandSplitBracket(plan);
    const submittedOrders: Order[] = [];

    for (let i = 0; i < expanded.length; i++) {
      const bracket = expanded[i];
      console.log(`\nSubmitting bracket ${i + 1}/${expanded.length} via MCP:`);

      const toolName = 'alpaca_submit_bracket_order';
      const args = {
        symbol: plan.symbol,
        qty: bracket.entryOrder.qty,
        side: plan.side,
        entry_price: plan.targetEntryPrice,
        take_profit_price: bracket.takeProfit.limitPrice,
        stop_loss_price: bracket.stopLoss.limitPrice,
        time_in_force: 'day',
      };

      console.log(`\nMCP Tool Call: ${toolName}`);
      console.log('Arguments:');
      console.log(JSON.stringify(args, null, 2));

      if (env.dryRun) {
        console.log('→ DRY RUN: MCP tool would be called (not actually called)');
        submittedOrders.push(bracket.entryOrder);
      } else {
        try {
          console.log('→ Calling MCP tool...');
          const response = await this.mcpClient.callTool(toolName, args);

          if (response.error) {
            console.error(`✗ MCP Error: ${response.error}`);
          } else {
            console.log('← MCP Response:');
            console.log(JSON.stringify(response.result, null, 2));
            submittedOrders.push(bracket.entryOrder);
          }
        } catch (e) {
          const err = e as Error;
          console.error(`✗ Failed to call MCP tool: ${err.message}`);
        }
      }
    }

    console.log('='.repeat(60) + '\n');
    return submittedOrders;
  }

  /**
   * Cancel entries via MCP
   */
  async cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<void> {
    console.log(`\nALPACA MCP: Cancelling ${orders.length} orders via MCP`);

    for (const order of orders) {
      const toolName = 'alpaca_cancel_order';
      const args = {
        order_id: order.id,
        symbol,
      };

      console.log(`\nMCP Tool Call: ${toolName}`);
      console.log('Arguments:');
      console.log(JSON.stringify(args, null, 2));

      if (env.dryRun) {
        console.log('→ DRY RUN: Would call MCP tool');
      } else {
        try {
          console.log('→ Calling MCP tool...');
          const response = await this.mcpClient.callTool(toolName, args);

          if (response.error) {
            console.error(`✗ MCP Error: ${response.error}`);
          } else {
            console.log('← Cancelled via MCP');
          }
        } catch (e) {
          const err = e as Error;
          console.error(`Failed to cancel via MCP: ${err.message}`);
        }
      }
    }
  }

  /**
   * Get open orders via MCP
   */
  async getOpenOrders(symbol: string, env: BrokerEnvironment): Promise<Order[]> {
    const toolName = 'alpaca_get_open_orders';
    const args = { symbol };

    console.log(`\nALPACA MCP: Fetching open orders for ${symbol}`);
    console.log(`MCP Tool Call: ${toolName}`);
    console.log('Arguments:');
    console.log(JSON.stringify(args, null, 2));

    if (env.dryRun) {
      console.log('→ DRY RUN: Would call MCP tool');
      return [];
    }

    try {
      console.log('→ Calling MCP tool...');
      const response = await this.mcpClient.callTool(toolName, args);

      if (response.error) {
        console.error(`✗ MCP Error: ${response.error}`);
        return [];
      }

      console.log('← MCP Response:');
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
