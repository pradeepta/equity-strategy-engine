/**
 * Interactive Brokers TWS API Adapter
 * Converts order plans into IB TWS API calls for paper trading
 */
import { OrderPlan, Order, BrokerEnvironment, CancellationResult } from '../spec/types';
import { BaseBrokerAdapter } from './broker';

const IB = require('ib');

interface IBOrder {
  orderId: number;
  symbol: string;
  qty: number;
  side: 'BUY' | 'SELL';
  orderType: 'LMT' | 'MKT' | 'STP';
  limitPrice?: number;
  stopPrice?: number;
  status: string;
}

/**
 * TWS broker adapter for Interactive Brokers
 * Connects to TWS/IB Gateway via socket API
 */
export class TwsAdapter extends BaseBrokerAdapter {
  private client: any;
  private connected: boolean = false;
  private nextOrderId: number = 1;
  private orderIdMap: Map<string, number> = new Map();
  private pendingOrders: Map<number, IBOrder> = new Map();

  private host: string;
  private port: number;
  private clientId: number;

  constructor(host: string = '127.0.0.1', port: number = 7497, clientId: number = 0) {
    super();
    this.host = host;
    this.port = port; // 7497 for paper trading, 7496 for live
    this.clientId = clientId;
  }

  /**
   * Connect to TWS/IB Gateway
   */
  private async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.client = new IB({
        clientId: this.clientId,
        host: this.host,
        port: this.port,
      });

      // Set up event handlers
      this.client.on('connected', () => {
        console.log(`✓ Connected to TWS at ${this.host}:${this.port}`);
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err: Error, code: number, reqId: number) => {
        // Filter out informational messages (codes 2104, 2106, 2107, 2108, 2158)
        const infoMessages = [2104, 2106, 2107, 2108, 2158];
        if (!this.connected && code === 502) {
          reject(new Error(`Cannot connect to TWS at ${this.host}:${this.port}. Make sure TWS/IB Gateway is running.`));
        } else if (!infoMessages.includes(code)) {
          console.error(`TWS Error [${code}]: ${err.message} (reqId: ${reqId})`);
        }
      });

      this.client.on('nextValidId', (orderId: number) => {
        this.nextOrderId = orderId;
        console.log(`Next valid order ID: ${orderId}`);
      });

      this.client.on('orderStatus', (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number) => {
        console.log(`Order ${orderId} status: ${status} (filled: ${filled}, remaining: ${remaining}, avg: ${avgFillPrice})`);
        const order = this.pendingOrders.get(orderId);
        if (order) {
          order.status = status;
        }
      });

      this.client.on('openOrder', (orderId: number, contract: any, order: any, orderState: any) => {
        console.log(`Open order ${orderId}: ${contract.symbol} ${order.action} ${order.totalQuantity} @ ${order.lmtPrice || 'MKT'}`);
      });

      this.client.on('disconnected', () => {
        console.log('Disconnected from TWS');
        this.connected = false;
      });

      // Connect to TWS
      console.log(`Connecting to TWS at ${this.host}:${this.port}...`);
      this.client.connect();

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('Connection timeout. Make sure TWS/IB Gateway is running and accepting connections.'));
        }
      }, 10000);
    });
  }

  /**
   * Disconnect from TWS
   */
  disconnect(): void {
    if (this.client && this.connected) {
      this.client.disconnect();
      this.connected = false;
    }
  }

  /**
   * Submit an order plan to TWS
   */
  async submitOrderPlan(plan: OrderPlan, env: BrokerEnvironment): Promise<Order[]> {
    console.log('\n' + '='.repeat(60));
    console.log('TWS ADAPTER: ORDER PLAN SUBMISSION');
    console.log('='.repeat(60));

    // Print the bracket structure
    console.log(this.formatBracketPayload(plan));
    console.log('');

    if (!env.dryRun) {
      // Ensure we're connected
      await this.connect();
    }

    const expanded = this.expandSplitBracket(plan);
    const submittedOrders: Order[] = [];

    for (let i = 0; i < expanded.length; i++) {
      const bracket = expanded[i];
      console.log(`\nSubmitting bracket ${i + 1}/${expanded.length}:`);

      if (env.dryRun) {
        // Stub: pretend submission succeeds
        console.log('→ DRY RUN: Bracket order would be submitted (not actually sent)');
        console.log(`  Entry: ${bracket.entryOrder.qty} @ ${bracket.entryOrder.limitPrice}`);
        console.log(`  Take Profit: ${bracket.takeProfit.qty} @ ${bracket.takeProfit.limitPrice}`);
        console.log(`  Stop Loss: ${bracket.stopLoss.qty} @ ${bracket.stopLoss.limitPrice}`);
        submittedOrders.push(bracket.entryOrder);
      } else {
        // Real submission to TWS
        try {
          // Save original order ID before submitting
          const originalOrderId = bracket.entryOrder.id;

          const parentOrder = await this.submitBracketToTWS(bracket, plan);
          console.log('← Response: Bracket order submitted successfully');
          console.log(`  Parent Order ID: ${parentOrder.orderId}`);
          console.log(`  Order ID mapping: ${originalOrderId} -> ${parentOrder.orderId}`);

          // Map original order ID to TWS order ID for cancellation
          this.orderIdMap.set(originalOrderId, parentOrder.orderId);

          // Update order object with TWS order ID
          bracket.entryOrder.id = parentOrder.orderId.toString();
          bracket.entryOrder.status = 'submitted';
          submittedOrders.push(bracket.entryOrder);
        } catch (e) {
          const err = e as Error;
          console.error(`✗ Failed to submit bracket: ${err.message}`);
        }
      }
    }

    console.log('='.repeat(60) + '\n');
    return submittedOrders;
  }

  /**
   * Submit bracket order to TWS
   */
  private async submitBracketToTWS(
    bracket: {
      entryOrder: Order;
      takeProfit: Order;
      stopLoss: Order;
    },
    plan: OrderPlan
  ): Promise<IBOrder> {
    if (!this.connected) {
      throw new Error('Not connected to TWS');
    }

    // Create contract
    const contract = {
      symbol: plan.symbol,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    };

    // Parent order (entry)
    const parentOrderId = this.nextOrderId++;
    const parentOrder = {
      action: plan.side === 'buy' ? 'BUY' : 'SELL',
      orderType: 'LMT',
      totalQuantity: bracket.entryOrder.qty,
      lmtPrice: plan.targetEntryPrice,
      transmit: false, // Don't transmit parent until children are attached
    };

    // Take profit order
    const takeProfitOrderId = this.nextOrderId++;
    const takeProfitOrder = {
      action: plan.side === 'buy' ? 'SELL' : 'BUY',
      orderType: 'LMT',
      totalQuantity: bracket.takeProfit.qty,
      lmtPrice: bracket.takeProfit.limitPrice,
      parentId: parentOrderId,
      transmit: false,
    };

    // Stop loss order
    const stopLossOrderId = this.nextOrderId++;
    const stopLossOrder = {
      action: plan.side === 'buy' ? 'SELL' : 'BUY',
      orderType: 'STP',
      totalQuantity: bracket.stopLoss.qty,
      auxPrice: bracket.stopLoss.stopPrice || plan.stopPrice, // FIXED: Use stopPrice field
      parentId: parentOrderId,
      transmit: true, // Transmit entire bracket when stop loss is placed
    };

    // Place orders
    console.log(`Placing parent order ${parentOrderId}...`);
    this.client.placeOrder(parentOrderId, contract, parentOrder);

    console.log(`Placing take profit order ${takeProfitOrderId}...`);
    this.client.placeOrder(takeProfitOrderId, contract, takeProfitOrder);

    console.log(`Placing stop loss order ${stopLossOrderId}...`);
    this.client.placeOrder(stopLossOrderId, contract, stopLossOrder);

    // Store order info
    const ibOrder: IBOrder = {
      orderId: parentOrderId,
      symbol: plan.symbol,
      qty: bracket.entryOrder.qty,
      side: plan.side === 'buy' ? 'BUY' : 'SELL',
      orderType: 'LMT',
      limitPrice: plan.targetEntryPrice,
      status: 'Submitted',
    };

    this.pendingOrders.set(parentOrderId, ibOrder);

    // Wait a bit for confirmation
    await this.sleep(500);

    return ibOrder;
  }

  /**
   * Cancel open entries
   */
  async cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<CancellationResult> {
    console.log(`\nTWS: Cancelling ${orders.length} orders for ${symbol}`);
    console.log(`Available order mappings: ${Array.from(this.orderIdMap.entries()).map(([k, v]) => `${k}->${v}`).join(', ')}`);

    const result: CancellationResult = {
      succeeded: [],
      failed: [],
    };

    if (!env.dryRun && !this.connected) {
      await this.connect();
    }

    for (const order of orders) {
      console.log(`Cancelling order ${order.id}`);

      if (!env.dryRun) {
        // Try direct lookup first (order.id is already TWS ID)
        const orderIdNum = parseInt(order.id);
        if (!isNaN(orderIdNum) && this.pendingOrders.has(orderIdNum)) {
          try {
            this.client.cancelOrder(orderIdNum);
            console.log(`✓ Cancelled TWS order ${orderIdNum}`);
            this.pendingOrders.delete(orderIdNum);
            result.succeeded.push(order.id);
            continue;
          } catch (e) {
            const err = e as Error;
            const reason = `Direct cancellation failed: ${err.message}`;
            console.error(`✗ ${reason}`);
            result.failed.push({ orderId: order.id, reason });
            // FAIL FAST: Throw immediately on first failure
            throw new Error(`Failed to cancel order ${order.id}: ${reason}`);
          }
        }

        // Try mapping lookup (order.id is original ID)
        const ibOrderId = this.orderIdMap.get(order.id);
        if (ibOrderId !== undefined) {
          try {
            this.client.cancelOrder(ibOrderId);
            console.log(`✓ Cancelled (mapped ${order.id} -> ${ibOrderId})`);
            this.pendingOrders.delete(ibOrderId);
            this.orderIdMap.delete(order.id);
            result.succeeded.push(order.id);
          } catch (e) {
            const err = e as Error;
            const reason = `Mapped cancellation failed: ${err.message}`;
            console.error(`✗ ${reason}`);
            result.failed.push({ orderId: order.id, reason });
            // FAIL FAST: Throw immediately on first failure
            throw new Error(`Failed to cancel order ${order.id}: ${reason}`);
          }
        } else {
          // Order not found - this is a failure condition
          const reason = 'Order not found in TWS (not in pendingOrders or orderIdMap)';
          console.error(`✗ Order ${order.id}: ${reason}`);
          result.failed.push({ orderId: order.id, reason });
          // FAIL FAST: Throw immediately when order not found
          throw new Error(`Failed to cancel order ${order.id}: ${reason}`);
        }
      } else {
        console.log('→ DRY RUN: Would cancel');
        result.succeeded.push(order.id);
      }
    }

    console.log(`Cancellation result: ${result.succeeded.length} succeeded, ${result.failed.length} failed`);
    return result;
  }

  /**
   * Get open orders
   */
  async getOpenOrders(symbol: string, env: BrokerEnvironment): Promise<Order[]> {
    console.log(`\nTWS: Fetching open orders for ${symbol}`);

    if (env.dryRun) {
      console.log('→ DRY RUN: Returning empty list');
      return [];
    }

    if (!this.connected) {
      await this.connect();
    }

    try {
      // Request all open orders
      this.client.reqAllOpenOrders();

      // Wait for orders to be received
      await this.sleep(1000);

      // Filter orders for this symbol
      const orders: Order[] = [];
      for (const [orderId, ibOrder] of this.pendingOrders.entries()) {
        if (ibOrder.symbol === symbol && ibOrder.status !== 'Filled' && ibOrder.status !== 'Cancelled') {
          orders.push({
            id: orderId.toString(),
            planId: `tws-${orderId}`,
            symbol: ibOrder.symbol,
            qty: ibOrder.qty,
            side: ibOrder.side === 'BUY' ? 'buy' : 'sell',
            type: ibOrder.orderType === 'LMT' ? 'limit' : 'market',
            limitPrice: ibOrder.limitPrice,
            stopPrice: ibOrder.stopPrice,
            status: this.mapTWSStatus(ibOrder.status),
          });
        }
      }

      console.log(`✓ Got ${orders.length} open orders`);
      return orders;
    } catch (e) {
      const err = e as Error;
      console.error(`✗ Failed to fetch orders: ${err.message}`);
      return [];
    }
  }

  /**
   * Map TWS order status to our status type
   */
  private mapTWSStatus(twsStatus: string): Order['status'] {
    const statusMap: Record<string, Order['status']> = {
      'PendingSubmit': 'pending',
      'PendingCancel': 'pending',
      'PreSubmitted': 'pending',
      'Submitted': 'submitted',
      'Filled': 'filled',
      'Cancelled': 'cancelled',
      'Inactive': 'rejected',
    };

    return statusMap[twsStatus] || 'pending';
  }

  /**
   * Helper: sleep for ms
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
