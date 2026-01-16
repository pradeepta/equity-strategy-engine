/**
 * Broker interface (abstract)
 */
import { OrderPlan, Order, BrokerAdapter, BrokerEnvironment, CancellationResult } from '../spec/types';

/**
 * Base broker adapter - defines the contract all adapters must implement
 */
export abstract class BaseBrokerAdapter implements BrokerAdapter {
  abstract submitOrderPlan(plan: OrderPlan, env: BrokerEnvironment): Promise<Order[]>;
  abstract submitMarketOrder(
    symbol: string,
    qty: number,
    side: 'buy' | 'sell',
    env: BrokerEnvironment
  ): Promise<Order>;
  abstract cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<CancellationResult>;
  abstract getOpenOrders(symbol: string, env: BrokerEnvironment): Promise<Order[]>;

  /**
   * Enforce broker-level safety checks for new order plans.
   */
  protected enforceOrderConstraints(plan: OrderPlan, env: BrokerEnvironment): void {
    if (env.allowLiveOrders === false) {
      throw new Error('Live order submission is disabled by kill switch');
    }

    if (env.maxOrderQty !== undefined && plan.qty > env.maxOrderQty) {
      throw new Error(
        `Order qty ${plan.qty} exceeds maxOrderQty ${env.maxOrderQty}`
      );
    }

    if (env.maxNotionalPerSymbol !== undefined) {
      const notional = plan.qty * plan.targetEntryPrice;
      if (notional > env.maxNotionalPerSymbol) {
        throw new Error(
          `Order notional ${notional.toFixed(2)} exceeds maxNotionalPerSymbol ${env.maxNotionalPerSymbol}`
        );
      }
    }
  }

  /**
   * Helper: Generate unique order IDs
   */
  protected generateOrderId(prefix: string = 'ord'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Helper: Convert split bracket plan into individual bracket orders
   */
  protected expandSplitBracket(plan: OrderPlan): Array<{
    entryOrder: Order;
    takeProfit: Order;
    stopLoss: Order;
  }> {
    const orders: Array<{
      entryOrder: Order;
      takeProfit: Order;
      stopLoss: Order;
    }> = [];

    for (const bracket of plan.brackets) {
      const partialQty = Math.floor(plan.qty * bracket.ratioOfPosition);

      const entryOrder: Order = {
        id: this.generateOrderId('entry'),
        planId: plan.id,
        symbol: plan.symbol,
        side: plan.side,
        qty: partialQty,
        type: 'limit',
        limitPrice: plan.targetEntryPrice,
        status: 'pending',
      };

      const takeProfitOrder: Order = {
        id: this.generateOrderId('tp'),
        planId: plan.id,
        symbol: plan.symbol,
        side: plan.side === 'buy' ? 'sell' : 'buy',
        qty: partialQty,
        type: 'limit',
        limitPrice: bracket.price,
        status: 'pending',
      };

      const stopLossOrder: Order = {
        id: this.generateOrderId('sl'),
        planId: plan.id,
        symbol: plan.symbol,
        side: plan.side === 'buy' ? 'sell' : 'buy',
        qty: partialQty,
        type: 'limit',
        stopPrice: plan.stopPrice,  // FIXED: Use stopPrice, not limitPrice
        status: 'pending',
      };

      orders.push({ entryOrder, takeProfit: takeProfitOrder, stopLoss: stopLossOrder });
    }

    return orders;
  }

  /**
   * Pretty-print bracket structure
   */
  protected formatBracketPayload(plan: OrderPlan): string {
    const expanded = this.expandSplitBracket(plan);
    const lines: string[] = [];
    lines.push(`Bracket Order Plan: ${plan.name}`);
    lines.push(`Symbol: ${plan.symbol}, Side: ${plan.side}`);
    lines.push(`Total Qty: ${plan.qty}, Entry Price: ${plan.targetEntryPrice}`);
    lines.push(`Stop Loss: ${plan.stopPrice}`);
    lines.push('');
    lines.push('Brackets:');

    for (const bracket of expanded) {
      lines.push(`  Entry: ${bracket.entryOrder.qty} @ ${bracket.entryOrder.limitPrice}`);
      lines.push(
        `    ├─ TP: ${bracket.takeProfit.qty} @ ${bracket.takeProfit.limitPrice}`
      );
      lines.push(`    └─ SL: ${bracket.stopLoss.qty} @ ${bracket.stopLoss.stopPrice || bracket.stopLoss.limitPrice}`);
    }

    return lines.join('\n');
  }
}
