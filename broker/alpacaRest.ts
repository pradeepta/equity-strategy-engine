/**
 * Alpaca REST API Adapter
 * Converts order plans into Alpaca API calls
 */
import * as https from 'https';
import { OrderPlan, Order, BrokerEnvironment, CancellationResult } from '../spec/types';
import { BaseBrokerAdapter } from './broker';

interface AlpacaOrderRequest {
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  time_in_force: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok';
  limit_price?: number;
  stop_price?: number;
  order_class?: 'simple' | 'bracket' | 'oco' | 'oto';
  take_profit?: {
    limit_price: number;
  };
  stop_loss?: {
    stop_price: number;
    limit_price?: number;
  };
}

interface AlpacaOrderResponse {
  id: string;
  symbol: string;
  qty: number;
  side: string;
  type: string;
  limit_price?: number;
  stop_price?: number;
  status: string;
  created_at: string;
}

/**
 * Alpaca REST broker adapter
 * Submits orders via REST API (or stub for demo)
 */
export class AlpacaRestAdapter extends BaseBrokerAdapter {
  private baseUrl: string;
  private apiKey: string;
  private apiSecret: string;

  constructor(baseUrl: string = 'https://api.alpaca.markets', apiKey?: string, apiSecret?: string) {
    super();
    this.baseUrl = baseUrl;
    this.apiKey = apiKey || process.env.ALPACA_API_KEY || '';
    this.apiSecret = apiSecret || process.env.ALPACA_API_SECRET || '';
  }

  /**
   * Submit an order plan to Alpaca
   */
  async submitOrderPlan(plan: OrderPlan, env: BrokerEnvironment): Promise<Order[]> {
    console.log('\n' + '='.repeat(60));
    console.log('ALPACA REST ADAPTER: ORDER PLAN SUBMISSION');
    console.log('='.repeat(60));

    this.enforceOrderConstraints(plan, env);

    // Print the bracket structure
    console.log(this.formatBracketPayload(plan));
    console.log('');

    const expanded = this.expandSplitBracket(plan);
    const submittedOrders: Order[] = [];

    try {
      for (let i = 0; i < expanded.length; i++) {
        const bracket = expanded[i];
        console.log(`\nSubmitting bracket ${i + 1}/${expanded.length}:`);

        // In production: use the actual Alpaca REST client
        // For demo: show the API payload shape
        const alpacaOrderRequest = this.buildAlpacaBracketRequest(bracket, plan);

        console.log('POST /v2/orders');
        console.log('Payload:');
        console.log(JSON.stringify(alpacaOrderRequest, null, 2));

        if (env.dryRun) {
          // Stub: pretend submission succeeds
          console.log('→ DRY RUN: Order would be submitted (not actually sent)');
          submittedOrders.push(bracket.entryOrder);
        } else {
          // Real submission (would call actual Alpaca API)
          const response = await this.submitBracketToAlpaca(alpacaOrderRequest, env);
          console.log('← Response: 200 OK');
          console.log(JSON.stringify(response, null, 2));

          // Map response to Order objects
          submittedOrders.push(bracket.entryOrder);
          env.auditEvent?.({
            component: 'AlpacaRestAdapter',
            level: 'info',
            message: 'Bracket submitted',
            metadata: {
              symbol: plan.symbol,
              planId: plan.id,
            },
          });
        }
      }
    } catch (e) {
      const err = e as Error;
      console.error(`✗ Failed to submit bracket: ${err.message}`);
      env.auditEvent?.({
        component: 'AlpacaRestAdapter',
        level: 'error',
        message: 'Bracket submission failed',
        metadata: {
          symbol: plan.symbol,
          planId: plan.id,
          error: err.message,
        },
      });

      if (submittedOrders.length > 0) {
        console.warn('⚠️  Rolling back submitted orders due to failure...');
        await this.cancelOpenEntries(plan.symbol, submittedOrders, env);
      }

      throw err;
    }

    console.log('='.repeat(60) + '\n');
    return submittedOrders;
  }

  /**
   * Submit a market order to close a position
   */
  async submitMarketOrder(
    symbol: string,
    qty: number,
    side: 'buy' | 'sell',
    env: BrokerEnvironment
  ): Promise<Order> {
    console.log('\n' + '='.repeat(60));
    console.log('ALPACA REST ADAPTER: MARKET ORDER');
    console.log('='.repeat(60));
    console.log(`Symbol: ${symbol}, Side: ${side}, Qty: ${qty}`);

    const order: Order = {
      id: this.generateOrderId('market'),
      planId: `market-exit-${Date.now()}`,
      symbol,
      side,
      qty,
      type: 'market',
      status: env.dryRun ? 'submitted' : 'pending',
    };

    if (env.dryRun) {
      console.log('→ DRY RUN: Market order would be submitted (not actually sent)');
      console.log('='.repeat(60));
      return order;
    }

    const alpacaOrderRequest: AlpacaOrderRequest = {
      symbol,
      qty,
      side,
      type: 'market',
      time_in_force: 'day',
      order_class: 'simple',
    };

    console.log('POST /v2/orders');
    console.log('Payload:');
    console.log(JSON.stringify(alpacaOrderRequest, null, 2));

    await this.submitBracketToAlpaca(alpacaOrderRequest, env);
    order.status = 'submitted';
    env.auditEvent?.({
      component: 'AlpacaRestAdapter',
      level: 'info',
      message: 'Market order submitted',
      metadata: {
        symbol,
        qty,
        side,
      },
    });
    console.log('='.repeat(60));
    return order;
  }

  /**
   * Cancel open entries
   */
  async cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<CancellationResult> {
    console.log(`\nALPACA: Cancelling ${orders.length} orders for ${symbol}`);

    const result: CancellationResult = {
      succeeded: [],
      failed: [],
    };

    for (const order of orders) {
      console.log(`DELETE /v2/orders/${order.id}`);

      if (!env.dryRun) {
        try {
          await this.cancelOrderAtAlpaca(order.id, env);
          console.log('✓ Cancelled');
          result.succeeded.push(order.id);
          env.auditEvent?.({
            component: 'AlpacaRestAdapter',
            level: 'info',
            message: 'Order cancelled',
            metadata: {
              symbol,
              orderId: order.id,
            },
          });
        } catch (e) {
          const err = e as Error;
          const reason = `Alpaca API error: ${err.message}`;
          console.error(`✗ Failed to cancel order ${order.id}: ${reason}`);
          result.failed.push({ orderId: order.id, reason });
          env.auditEvent?.({
            component: 'AlpacaRestAdapter',
            level: 'error',
            message: 'Order cancellation failed',
            metadata: {
              symbol,
              orderId: order.id,
              reason,
            },
          });
          // FAIL FAST: Throw immediately on first failure
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
   * Cancel an order at Alpaca
   */
  private async cancelOrderAtAlpaca(orderId: string, env: BrokerEnvironment): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(`/v2/orders/${orderId}`, this.baseUrl);

      const options: https.RequestOptions = {
        method: 'DELETE',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'APCA-API-KEY-ID': this.apiKey,
          'APCA-API-SECRET-KEY': process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '',
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve();
          } else {
            reject(new Error(`Alpaca API error (${res.statusCode}): ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Get open orders
   */
  async getOpenOrders(symbol: string, env: BrokerEnvironment): Promise<Order[]> {
    console.log(`\nALPACA: Fetching open orders for ${symbol}`);

    if (env.dryRun) {
      console.log('→ DRY RUN: Returning empty list');
      return [];
    }

    try {
      const orders = await this.fetchOpenOrdersFromAlpaca(symbol, env);
      console.log(`✓ Got ${orders.length} open orders`);
      return orders;
    } catch (e) {
      const err = e as Error;
      console.error(`✗ Failed to fetch orders: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch open orders from Alpaca
   */
  private async fetchOpenOrdersFromAlpaca(symbol: string, env: BrokerEnvironment): Promise<Order[]> {
    return new Promise((resolve, reject) => {
      const url = new URL('/v2/orders', this.baseUrl);
      url.searchParams.append('status', 'open');
      url.searchParams.append('symbols', symbol);

      const options: https.RequestOptions = {
        method: 'GET',
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          'APCA-API-KEY-ID': this.apiKey,
          'APCA-API-SECRET-KEY': process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '',
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const responses = JSON.parse(data) as AlpacaOrderResponse[];
            const orders: Order[] = responses.map((r) => ({
              id: r.id,
              planId: 'alpaca-' + r.id,
              symbol: r.symbol,
              qty: r.qty,
              side: r.side as 'buy' | 'sell',
              type: (r.type === 'limit' ? 'limit' : 'market') as 'limit' | 'market',
              limitPrice: r.limit_price,
              stopPrice: r.stop_price,
              status: r.status as any,
            }));
            resolve(orders);
          } catch (e) {
            reject(new Error(`Failed to parse open orders response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Build Alpaca bracket order request
   */
  private buildAlpacaBracketRequest(
    bracket: {
      entryOrder: Order;
      takeProfit: Order;
      stopLoss: Order;
    },
    plan: OrderPlan
  ): AlpacaOrderRequest {
    return {
      symbol: plan.symbol,
      qty: bracket.entryOrder.qty,
      side: plan.side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: plan.targetEntryPrice,
      order_class: 'bracket',
      take_profit: {
        limit_price: bracket.takeProfit.limitPrice!,
      },
      stop_loss: {
        stop_price: bracket.stopLoss.limitPrice!,
        limit_price: bracket.stopLoss.limitPrice,
      },
    };
  }

  /**
   * Actually submit to Alpaca via REST API
   */
  private async submitBracketToAlpaca(
    request: AlpacaOrderRequest,
    env: BrokerEnvironment
  ): Promise<AlpacaOrderResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL('/v2/orders', this.baseUrl);
      const body = JSON.stringify(request);

      const options: https.RequestOptions = {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'APCA-API-KEY-ID': this.apiKey,
          'APCA-API-SECRET-KEY': process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || '',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const response = JSON.parse(data) as AlpacaOrderResponse;
            if (res.statusCode === 200 || res.statusCode === 201) {
              resolve(response);
            } else {
              reject(new Error(`Alpaca API error (${res.statusCode}): ${(response as any).message || data}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse Alpaca response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Build auth headers for Alpaca API
   */
  private buildAuthHeaders(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.apiKey,
      'Content-Type': 'application/json',
    };
  }
}
