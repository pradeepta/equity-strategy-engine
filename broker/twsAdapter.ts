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
  rejectionReason?: string;
}

interface BracketOrderSet {
  parentOrderId: number;
  takeProfitOrderId: number;
  stopLossOrderId: number;
  symbol: string;
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
  private bracketOrders: Map<number, BracketOrderSet> = new Map(); // Maps parent order ID to bracket set
  private orderIdReady: boolean = false; // Track if we've received nextValidId
  private orderRejections: Map<number, { code: number; message: string }> = new Map(); // Track order rejections
  private orderStatusCallbacks: Map<number, Array<(status: string) => void>> = new Map(); // Callbacks for status changes
  private executions: Map<number, Array<{ execId: string; time: string; qty: number; price: number; side: string }>> = new Map(); // Track executions per order
  private commissions: Map<string, { commission: number; currency: string }> = new Map(); // Track commissions per execId
  private auditEvent?: BrokerEnvironment['auditEvent'];

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
        const infoText = err?.message?.toLowerCase?.() || '';
        const isInfoText =
          infoText.includes('market data farm connection is ok') ||
          infoText.includes('hmds data farm connection is ok') ||
          infoText.includes('sec-def data farm connection is ok');

        // Order rejection error codes
        const orderRejectionCodes = [201, 202, 104, 110, 103, 105, 161, 162, 200, 203, 399];

        if (!this.connected && code === 502) {
          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'error',
            message: 'TWS connection failed',
            metadata: {
              host: this.host,
              port: this.port,
              code,
              message: err.message,
            },
          });
          reject(new Error(`Cannot connect to TWS at ${this.host}:${this.port}. Make sure TWS/IB Gateway is running.`));
        } else if (orderRejectionCodes.includes(code)) {
          // Track order-specific rejection
          console.error(`🚨 ORDER REJECTION [${code}]: ${err.message} (orderId: ${reqId})`);
          this.orderRejections.set(reqId, { code, message: err.message });
          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'error',
            message: 'Order rejected',
            metadata: {
              orderId: reqId?.toString?.() || String(reqId),
              code,
              message: err.message,
            },
          });

          // Update order status if we have it tracked
          const order = this.pendingOrders.get(reqId);
          if (order) {
            order.status = 'Rejected';
            order.rejectionReason = `[${code}] ${err.message}`;
          }
        } else if (!infoMessages.includes(code) && !isInfoText) {
          console.error(`TWS Error [${code}]: ${err.message} (reqId: ${reqId})`);
        }
      });

      this.client.on('nextValidId', (orderId: number) => {
        this.nextOrderId = orderId;
        this.orderIdReady = true;
        console.log(`✅ TWS assigned next valid order ID: ${orderId}`);
      });

      this.client.on('orderStatus', (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number, permId: number, parentId: number, lastFillPrice: number, clientId: number, whyHeld: string) => {
        const timestamp = new Date().toISOString();
        const statusEmoji = status === 'Filled' ? '✅' : status === 'Cancelled' ? '❌' : status === 'Submitted' ? '📤' : '📊';
        console.log(`[${timestamp}] ${statusEmoji} Order ${orderId} status: ${status} (filled: ${filled}, remaining: ${remaining}, avg: ${avgFillPrice}${whyHeld ? `, whyHeld: ${whyHeld}` : ''})`);

        const order = this.pendingOrders.get(orderId);
        if (order) {
          order.status = status;

          // Capture rejection reason if status indicates rejection
          if ((status === 'Cancelled' || status === 'Inactive') && whyHeld) {
            order.rejectionReason = whyHeld;
            console.error(`🚨 Order ${orderId} rejected/cancelled: ${whyHeld}`);
          }

          // Check if we have additional rejection info from error handler
          const rejection = this.orderRejections.get(orderId);
          if (rejection && !order.rejectionReason) {
            order.rejectionReason = rejection.message;
          }
        }

        // Trigger any status callbacks registered for this order
        const callbacks = this.orderStatusCallbacks.get(orderId);
        if (callbacks) {
          callbacks.forEach(cb => cb(status));
        }

        this.auditEvent?.({
          component: 'TwsAdapter',
          level: status === 'Cancelled' || status === 'Inactive' ? 'warn' : 'info',
          message: 'Order status update',
          metadata: {
            orderId: orderId.toString(),
            status,
            filled,
            remaining,
            avgFillPrice,
            whyHeld: whyHeld || undefined,
          },
        });
      });

      this.client.on('openOrder', (orderId: number, contract: any, order: any, orderState: any) => {
        console.log(`Open order ${orderId}: ${contract.symbol} ${order.action} ${order.totalQuantity} @ ${order.lmtPrice || 'MKT'}`);
        this.pendingOrders.set(orderId, {
          orderId,
          symbol: contract.symbol,
          qty: order.totalQuantity,
          side: order.action as 'BUY' | 'SELL',
          orderType: order.orderType,
          limitPrice: order.lmtPrice,
          stopPrice: order.auxPrice,
          status: orderState?.status || 'Submitted',
        });
      });

      // Handle execution details (fills)
      this.client.on('execDetails', (reqId: number, contract: any, execution: any) => {
        const timestamp = new Date().toISOString();
        const orderId = execution.orderId;
        const execId = execution.execId;
        const qty = execution.shares;
        const price = execution.price;
        const side = execution.side;
        const time = execution.time;

        console.log(`[${timestamp}] 💰 FILL: Order ${orderId} - ${qty} shares @ $${price} (execId: ${execId}, side: ${side})`);

        // Store execution details
        if (!this.executions.has(orderId)) {
          this.executions.set(orderId, []);
        }
        this.executions.get(orderId)!.push({
          execId,
          time,
          qty,
          price,
          side,
        });

        // Update pending order with partial fill info
        const order = this.pendingOrders.get(orderId);
        if (order) {
          // Calculate total filled quantity
          const fills = this.executions.get(orderId) || [];
          const totalFilled = fills.reduce((sum, fill) => sum + fill.qty, 0);
          const avgPrice = fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / totalFilled;

          console.log(`   ℹ️  Total filled for order ${orderId}: ${totalFilled}/${order.qty} @ avg $${avgPrice.toFixed(2)}`);

          // Update order status based on fill
          if (totalFilled >= order.qty) {
            order.status = 'Filled';
            console.log(`   ✅ Order ${orderId} completely filled`);
          } else {
            order.status = 'PartiallyFilled';
            console.log(`   ⏳ Order ${orderId} partially filled (${totalFilled}/${order.qty})`);
          }
        }

        this.auditEvent?.({
          component: 'TwsAdapter',
          level: 'info',
          message: 'Order execution received',
          metadata: {
            orderId: orderId.toString(),
            execId,
            symbol: contract?.symbol,
            qty,
            price,
            side,
            time,
          },
        });
      });

      // Handle commission reports
      this.client.on('commissionReport', (commissionReport: any) => {
        const execId = commissionReport.execId;
        const commission = commissionReport.commission;
        const currency = commissionReport.currency;

        console.log(`💸 COMMISSION: execId ${execId} - $${commission} ${currency}`);

        // Store commission
        this.commissions.set(execId, { commission, currency });

        this.auditEvent?.({
          component: 'TwsAdapter',
          level: 'info',
          message: 'Commission report received',
          metadata: {
            execId,
            commission,
            currency,
          },
        });
      });

      this.client.on('disconnected', () => {
        console.log('Disconnected from TWS');
        this.connected = false;
        this.auditEvent?.({
          component: 'TwsAdapter',
          level: 'warn',
          message: 'TWS connection lost',
          metadata: {
            host: this.host,
            port: this.port,
            timestamp: new Date().toISOString(),
          },
        });
      });

      // Connect to TWS
      console.log(`Connecting to TWS at ${this.host}:${this.port}...`);
      this.client.connect();

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!this.connected) {
          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'error',
            message: 'TWS connection timeout',
            metadata: {
              host: this.host,
              port: this.port,
              timeoutMs: 10000,
            },
          });
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
   * Restore orderIdMap from database (for restart recovery)
   * Call this after connecting to rebuild the order ID mapping
   */
  async restoreOrderIdMapFromDB(orders: Array<{ id: string; brokerOrderId: string | null }>): Promise<void> {
    let restoredCount = 0;

    for (const order of orders) {
      if (order.brokerOrderId) {
        const brokerOrderIdNum = parseInt(order.brokerOrderId);
        if (!isNaN(brokerOrderIdNum)) {
          this.orderIdMap.set(order.id, brokerOrderIdNum);
          restoredCount++;
        }
      }
    }

    console.log(`✓ Restored ${restoredCount} order ID mappings from database`);
    this.auditEvent?.({
      component: 'TwsAdapter',
      level: 'info',
      message: 'Order ID mappings restored from database',
      metadata: {
        restoredCount,
        totalOrders: orders.length,
      },
    });
  }

  /**
   * Wait for TWS to provide the next valid order ID
   */
  private async waitForOrderId(timeoutMs: number = 5000): Promise<void> {
    if (this.orderIdReady) {
      return;
    }

    const startTime = Date.now();
    while (!this.orderIdReady) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error('Timeout waiting for TWS to provide next valid order ID');
      }
      await this.sleep(100);
    }
  }

  /**
   * Submit an order plan to TWS
   */
  async submitOrderPlan(plan: OrderPlan, env: BrokerEnvironment): Promise<Order[]> {
    console.log('\n' + '='.repeat(60));
    console.log('TWS ADAPTER: ORDER PLAN SUBMISSION');
    console.log('='.repeat(60));

    this.auditEvent = env.auditEvent;

    // Apply buying power-based position sizing if enabled
    let adjustedPlan = plan;
    if (env.enableDynamicSizing && env.buyingPower) {
      const buyingPowerFactor = env.buyingPowerFactor || 0.75;
      const adjustedBuyingPower = env.buyingPower * buyingPowerFactor;
      const entryPrice = plan.targetEntryPrice;

      // Calculate max shares based on adjusted buying power
      let maxSharesByBuyingPower = Math.floor(adjustedBuyingPower / entryPrice);
      const limits: string[] = [];

      // Apply YAML max shares
      const originalQty = plan.qty;
      if (maxSharesByBuyingPower > plan.qty) {
        maxSharesByBuyingPower = plan.qty;
        limits.push(`YAML max (${plan.qty})`);
      } else {
        limits.push(`${(buyingPowerFactor * 100).toFixed(0)}% buying power`);
      }

      // Apply MAX_ORDER_QTY if set
      if (env.maxOrderQty !== undefined && maxSharesByBuyingPower > env.maxOrderQty) {
        maxSharesByBuyingPower = env.maxOrderQty;
        limits.push(`MAX_ORDER_QTY (${env.maxOrderQty})`);
      }

      // Apply MAX_NOTIONAL if set
      if (env.maxNotionalPerSymbol !== undefined) {
        const maxSharesByNotional = Math.floor(env.maxNotionalPerSymbol / entryPrice);
        if (maxSharesByBuyingPower > maxSharesByNotional) {
          maxSharesByBuyingPower = maxSharesByNotional;
          limits.push(`MAX_NOTIONAL ($${env.maxNotionalPerSymbol})`);
        }
      }

      // Check if we have at least 1 share
      if (maxSharesByBuyingPower < 1) {
        const error = `Position sizing resulted in 0 shares (adjusted buying power: $${adjustedBuyingPower.toFixed(2)}, entry: $${entryPrice.toFixed(2)})`;
        console.log(`❌ ${error}`);
        throw new Error(error);
      }

      const notionalValue = maxSharesByBuyingPower * entryPrice;
      const utilizationPercent = (notionalValue / env.buyingPower) * 100;

      // Create adjusted plan
      adjustedPlan = { ...plan, qty: maxSharesByBuyingPower };

      // Alert about adjustment
      const wasAdjusted = maxSharesByBuyingPower !== originalQty;
      if (wasAdjusted) {
        console.log(`⚠️  POSITION SIZE ADJUSTED:`);
        console.log(`   Original Qty: ${originalQty} shares`);
        console.log(`   Adjusted Qty: ${maxSharesByBuyingPower} shares`);
        console.log(`   Notional: $${notionalValue.toFixed(2)} (${utilizationPercent.toFixed(1)}% of buying power)`);
        console.log(`   Applied Limits: ${limits.join(', ')}`);
        console.log(`   Reason: Respecting portfolio buying power`);

        env.auditEvent?.({
          component: 'TwsAdapter',
          level: 'warn',
          message: `Position size adjusted from ${originalQty} to ${maxSharesByBuyingPower} to respect buying power`,
          metadata: {
            symbol: plan.symbol,
            originalQty,
            adjustedQty: maxSharesByBuyingPower,
            notionalValue,
            buyingPower: env.buyingPower,
            adjustedBuyingPower,
            buyingPowerFactor,
            utilizationPercent,
            appliedLimits: limits,
          },
        });
      } else {
        console.log(`✅ Position size within limits: ${maxSharesByBuyingPower} shares`);
      }
    } else if (env.buyingPower) {
      // Even if dynamic sizing disabled, validate buying power
      const requiredCapital = plan.qty * plan.targetEntryPrice;
      if (requiredCapital > env.buyingPower) {
        const error = `Insufficient buying power: Need $${requiredCapital.toFixed(2)} but only $${env.buyingPower.toFixed(2)} available`;
        console.log(`❌ ${error}`);
        throw new Error(error);
      }
    }

    this.enforceOrderConstraints(adjustedPlan, env);

    // Print the bracket structure
    console.log(this.formatBracketPayload(adjustedPlan));
    console.log('');

    if (!env.dryRun) {
      // Ensure we're connected
      await this.connect();
    }

    const expanded = this.expandSplitBracket(adjustedPlan);
    const submittedOrders: Order[] = [];

    try {
      for (let i = 0; i < expanded.length; i++) {
        const bracket = expanded[i];
        console.log(`\nSubmitting bracket ${i + 1}/${expanded.length}:`);

        if (env.dryRun) {
          // Stub: pretend submission succeeds
          console.log('→ DRY RUN: Bracket order would be submitted (not actually sent)');
          console.log(`  Entry: ${bracket.entryOrder.qty} @ ${bracket.entryOrder.limitPrice}`);
          console.log(`  Take Profit: ${bracket.takeProfit.qty} @ ${bracket.takeProfit.limitPrice}`);
          console.log(`  Stop Loss: ${bracket.stopLoss.qty} @ ${bracket.stopLoss.limitPrice}`);

          // Push all three orders in dry-run mode too
          submittedOrders.push(bracket.entryOrder);
          submittedOrders.push(bracket.takeProfit);
          submittedOrders.push(bracket.stopLoss);
        } else {
          // Real submission to TWS
          // Save original order ID before submitting
          const originalOrderId = bracket.entryOrder.id;

          const parentOrder = await this.submitBracketToTWS(bracket, adjustedPlan);
          console.log('← Response: Bracket order submitted successfully');
          console.log(`  Parent Order ID: ${parentOrder.orderId}`);
          console.log(`  Order ID mapping: ${originalOrderId} -> ${parentOrder.orderId}`);

          // Map original order ID to TWS order ID for cancellation
          this.orderIdMap.set(originalOrderId, parentOrder.orderId);

          // Get bracket set with all three order IDs
          const bracketSet = this.bracketOrders.get(parentOrder.orderId);
          if (!bracketSet) {
            throw new Error(`Bracket set not found for parent order ${parentOrder.orderId}`);
          }

          // Store TWS order IDs in brokerOrderId field (keep original IDs intact)
          // This allows us to rebuild orderIdMap from database on restart
          const entryOriginalId = bracket.entryOrder.id;
          const tpOriginalId = bracket.takeProfit.id;
          const slOriginalId = bracket.stopLoss.id;

          // Set broker order IDs (for database persistence)
          bracket.entryOrder.brokerOrderId = parentOrder.orderId.toString();
          bracket.entryOrder.status = 'submitted';

          bracket.takeProfit.brokerOrderId = bracketSet.takeProfitOrderId.toString();
          bracket.takeProfit.status = 'submitted';

          bracket.stopLoss.brokerOrderId = bracketSet.stopLossOrderId.toString();
          bracket.stopLoss.status = 'submitted';

          // Map all three original IDs to TWS IDs for cancellation
          this.orderIdMap.set(entryOriginalId, parentOrder.orderId);
          this.orderIdMap.set(tpOriginalId, bracketSet.takeProfitOrderId);
          this.orderIdMap.set(slOriginalId, bracketSet.stopLossOrderId);

          // Push all three orders to submittedOrders for database persistence
          submittedOrders.push(bracket.entryOrder);
          submittedOrders.push(bracket.takeProfit);
          submittedOrders.push(bracket.stopLoss);

          console.log(`  ✅ All three bracket orders added to submittedOrders: ${bracket.entryOrder.id}, ${bracket.takeProfit.id}, ${bracket.stopLoss.id}`);

          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'info',
            message: 'Bracket submitted',
            metadata: {
              symbol: plan.symbol,
              parentOrderId: parentOrder.orderId,
              planId: plan.id,
            },
          });
        }
      }
    } catch (e) {
      const err = e as Error;
      console.error(`✗ Failed to submit bracket: ${err.message}`);

      // Audit log for order submission failure
      this.auditEvent?.({
        component: 'TwsAdapter',
        level: 'error',
        message: 'Order plan submission failed',
        metadata: {
          symbol: plan.symbol,
          planId: plan.id,
          error: err.message,
          submittedOrdersCount: submittedOrders.length,
          rollback: submittedOrders.length > 0,
          stackTrace: err.stack,
        },
      });

      if (submittedOrders.length > 0) {
        console.warn('⚠️  Rolling back submitted orders due to failure...');
        await this.cancelOpenEntries(plan.symbol, submittedOrders, env);
      }

      throw err;
    }

    console.log('='.repeat(60));

    // Report any rejections after a delay to capture async rejection messages
    setTimeout(() => {
      const rejected = this.getRejectedOrders();
      if (rejected.length > 0) {
        console.log('\n⚠️  ORDER REJECTIONS DETECTED:');
        console.log('='.repeat(60));
        for (const rej of rejected) {
          console.error(`   ❌ Order ${rej.orderId} (${rej.symbol}): ${rej.reason}`);
        }
        console.log('='.repeat(60) + '\n');
      }
    }, 2000);

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
    console.log('TWS ADAPTER: MARKET ORDER');
    console.log('='.repeat(60));
    console.log(`Symbol: ${symbol}, Side: ${side}, Qty: ${qty}`);

    this.auditEvent = env.auditEvent;
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

    if (!this.connected) {
      await this.connect();
    }

    await this.waitForOrderId();

    const contract = {
      symbol,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    };

    const orderId = this.nextOrderId++;
    const ibOrder = {
      action: side === 'buy' ? 'BUY' : 'SELL',
      orderType: 'MKT',
      totalQuantity: qty,
      transmit: true,
      outsideRth: true,
      tif: 'GTC',
    };

    console.log(`\n🔵 PLACING MARKET ORDER for ${symbol}:`);
    console.log(`   📊 Order ID: ${orderId}`);
    console.log(`      action=${ibOrder.action}, qty=${ibOrder.totalQuantity}, orderType=${ibOrder.orderType}, tif=${ibOrder.tif}`);

    this.client.placeOrder(orderId, contract, ibOrder);

    this.pendingOrders.set(orderId, {
      orderId,
      symbol,
      qty,
      side: ibOrder.action as 'BUY' | 'SELL',
      orderType: 'MKT',
      status: 'Submitted',
    });

    // Store original ID and map to TWS order ID
    const originalOrderId = order.id;
    order.brokerOrderId = orderId.toString();
    order.status = 'submitted';
    this.orderIdMap.set(originalOrderId, orderId);

    this.auditEvent?.({
      component: 'TwsAdapter',
      level: 'info',
      message: 'Market order submitted',
      metadata: {
        symbol,
        orderId: orderId.toString(),
        qty,
        side,
      },
    });

    console.log('='.repeat(60));
    return order;
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

    // Wait for TWS to provide next valid order ID
    await this.waitForOrderId();

    // Create contract
    const contract = {
      symbol: plan.symbol,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    };

    // Allocate THREE fresh order IDs for this bracket
    const parentOrderId = this.nextOrderId++;
    const takeProfitOrderId = this.nextOrderId++;
    const stopLossOrderId = this.nextOrderId++;

    console.log(`\n🔵 ALLOCATING BRACKET IDs for ${plan.symbol}: Parent=${parentOrderId}, TakeProfit=${takeProfitOrderId}, StopLoss=${stopLossOrderId}`);

    // Safety check: ensure we're not reusing IDs
    if (this.pendingOrders.has(parentOrderId) || this.bracketOrders.has(parentOrderId)) {
      console.error(`⚠️  WARNING: Reusing order ID ${parentOrderId}! This will cause TWS to reject or overwrite orders.`);
    }
    if (this.pendingOrders.has(takeProfitOrderId)) {
      console.error(`⚠️  WARNING: Reusing order ID ${takeProfitOrderId}! This will cause TWS to reject or overwrite orders.`);
    }
    if (this.pendingOrders.has(stopLossOrderId)) {
      console.error(`⚠️  WARNING: Reusing order ID ${stopLossOrderId}! This will cause TWS to reject or overwrite orders.`);
    }

    // Round all prices to 2 decimals (minimum tick size for stocks)
    const roundPrice = (price: number) => Math.round(price * 100) / 100;

    // Parent order (entry)
    const parentOrder = {
      action: plan.side === 'buy' ? 'BUY' : 'SELL',
      orderType: 'LMT',
      totalQuantity: bracket.entryOrder.qty,
      lmtPrice: roundPrice(plan.targetEntryPrice),
      transmit: false, // Don't transmit parent until children are attached
      outsideRth: true, // Allow order to be active outside regular trading hours
      tif: 'GTC', // Good Till Cancel - required for after-hours trading
    };

    // Take profit order
    const takeProfitOrder = {
      action: plan.side === 'buy' ? 'SELL' : 'BUY',
      orderType: 'LMT',
      totalQuantity: bracket.takeProfit.qty,
      lmtPrice: roundPrice(bracket.takeProfit.limitPrice!),
      parentId: parentOrderId,
      transmit: false,
      outsideRth: true, // Allow order to be active outside regular trading hours
      tif: 'GTC', // Good Till Cancel - required for after-hours trading
    };

    // Stop loss order
    const stopLossOrder = {
      action: plan.side === 'buy' ? 'SELL' : 'BUY',
      orderType: 'STP',
      totalQuantity: bracket.stopLoss.qty,
      auxPrice: roundPrice(bracket.stopLoss.stopPrice || plan.stopPrice), // FIXED: Use stopPrice field
      parentId: parentOrderId,
      transmit: true, // Transmit entire bracket when stop loss is placed
      outsideRth: true, // Allow stop order to trigger outside regular trading hours
      tif: 'GTC', // Good Till Cancel - required for after-hours trading
    };

    // Log detailed order information
    console.log(`\n🔵 PLACING BRACKET for ${plan.symbol}:`);
    console.log(`   📋 clientId=${this.clientId}, permId will be assigned by TWS`);
    console.log(`   📊 Parent Order ID: ${parentOrderId}`);
    console.log(`      action=${parentOrder.action}, qty=${parentOrder.totalQuantity}, lmtPrice=$${plan.targetEntryPrice.toFixed(2)}, transmit=${parentOrder.transmit}, outsideRth=${parentOrder.outsideRth}, tif=${parentOrder.tif}`);
    console.log(`   📊 Take Profit Order ID: ${takeProfitOrderId}`);
    console.log(`      action=${takeProfitOrder.action}, qty=${takeProfitOrder.totalQuantity}, lmtPrice=$${bracket.takeProfit.limitPrice?.toFixed(2)}, parentId=${takeProfitOrder.parentId}, transmit=${takeProfitOrder.transmit}, outsideRth=${takeProfitOrder.outsideRth}, tif=${takeProfitOrder.tif}`);
    console.log(`   📊 Stop Loss Order ID: ${stopLossOrderId}`);
    console.log(`      action=${stopLossOrder.action}, qty=${stopLossOrder.totalQuantity}, auxPrice=$${(bracket.stopLoss.stopPrice || plan.stopPrice).toFixed(2)}, parentId=${stopLossOrder.parentId}, transmit=${stopLossOrder.transmit}, outsideRth=${stopLossOrder.outsideRth}, tif=${stopLossOrder.tif}`);

    // Place orders
    this.client.placeOrder(parentOrderId, contract, parentOrder);
    this.client.placeOrder(takeProfitOrderId, contract, takeProfitOrder);
    this.client.placeOrder(stopLossOrderId, contract, stopLossOrder);

    // Store all three orders in pending orders map
    this.pendingOrders.set(parentOrderId, {
      orderId: parentOrderId,
      symbol: plan.symbol,
      qty: bracket.entryOrder.qty,
      side: plan.side === 'buy' ? 'BUY' : 'SELL',
      orderType: 'LMT',
      limitPrice: plan.targetEntryPrice,
      status: 'Submitted',
    });

    this.pendingOrders.set(takeProfitOrderId, {
      orderId: takeProfitOrderId,
      symbol: plan.symbol,
      qty: bracket.takeProfit.qty,
      side: plan.side === 'buy' ? 'SELL' : 'BUY',
      orderType: 'LMT',
      limitPrice: bracket.takeProfit.limitPrice,
      status: 'Submitted',
    });

    this.pendingOrders.set(stopLossOrderId, {
      orderId: stopLossOrderId,
      symbol: plan.symbol,
      qty: bracket.stopLoss.qty,
      side: plan.side === 'buy' ? 'SELL' : 'BUY',
      orderType: 'STP',
      stopPrice: bracket.stopLoss.stopPrice || plan.stopPrice,
      status: 'Submitted',
    });

    // Return parent order info
    const ibOrder: IBOrder = {
      orderId: parentOrderId,
      symbol: plan.symbol,
      qty: bracket.entryOrder.qty,
      side: plan.side === 'buy' ? 'BUY' : 'SELL',
      orderType: 'LMT',
      limitPrice: plan.targetEntryPrice,
      status: 'Submitted',
    };

    // Store bracket order set for cancellation
    const bracketSet: BracketOrderSet = {
      parentOrderId,
      takeProfitOrderId,
      stopLossOrderId,
      symbol: plan.symbol,
    };
    this.bracketOrders.set(parentOrderId, bracketSet);

    console.log(`✅ BRACKET PLACED for ${plan.symbol} successfully with orders: ${parentOrderId}, ${takeProfitOrderId}, ${stopLossOrderId}\n`);

    // 🔍 PHASE 2: Wait for initial status and validate all legs succeeded
    console.log(`⏳ Validating bracket submission (waiting for TWS confirmation)...`);
    await this.sleep(2000); // Wait 2 seconds for initial status updates

    // Check if any orders were rejected
    const rejectedOrders: Array<{ id: number; reason: string }> = [];

    const checkOrder = (orderId: number, legName: string) => {
      const order = this.pendingOrders.get(orderId);
      const rejection = this.orderRejections.get(orderId);

      if (rejection) {
        rejectedOrders.push({
          id: orderId,
          reason: `${legName}: [${rejection.code}] ${rejection.message}`,
        });
        return false;
      }

      if (order && (order.status === 'Rejected' || order.status === 'Cancelled' || order.status === 'Inactive')) {
        rejectedOrders.push({
          id: orderId,
          reason: `${legName}: Status=${order.status}${order.rejectionReason ? `, Reason: ${order.rejectionReason}` : ''}`,
        });
        return false;
      }

      return true;
    };

    const parentOk = checkOrder(parentOrderId, 'Parent');
    const tpOk = checkOrder(takeProfitOrderId, 'TakeProfit');
    const slOk = checkOrder(stopLossOrderId, 'StopLoss');

    // If any leg failed, rollback the entire bracket
    if (rejectedOrders.length > 0) {
      console.error(`\n🚨 BRACKET VALIDATION FAILED - ${rejectedOrders.length}/3 leg(s) rejected:`);
      for (const rej of rejectedOrders) {
        console.error(`   ❌ Order ${rej.id}: ${rej.reason}`);
      }

      // Attempt to cancel any successfully placed orders
      const orderIdsToCancel = [
        parentOk ? parentOrderId : null,
        tpOk ? takeProfitOrderId : null,
        slOk ? stopLossOrderId : null,
      ].filter((id): id is number => id !== null);

      if (orderIdsToCancel.length > 0) {
        console.warn(`🔄 Rolling back ${orderIdsToCancel.length} successfully placed order(s)...`);
        for (const orderId of orderIdsToCancel) {
          try {
            this.client.cancelOrder(orderId);
            this.pendingOrders.delete(orderId);
            console.log(`   ✓ Cancelled order ${orderId}`);
          } catch (rollbackErr) {
            console.error(`   ✗ Failed to cancel order ${orderId}:`, rollbackErr);
          }
        }
      }

      // Clean up tracking
      this.bracketOrders.delete(parentOrderId);
      this.orderRejections.delete(parentOrderId);
      this.orderRejections.delete(takeProfitOrderId);
      this.orderRejections.delete(stopLossOrderId);

      // Throw error with all rejection reasons
      throw new Error(
        `Bracket submission failed - ${rejectedOrders.length}/3 leg(s) rejected:\n` +
        rejectedOrders.map(r => `  - Order ${r.id}: ${r.reason}`).join('\n')
      );
    }

    console.log(`✅ All 3 bracket legs validated successfully\n`);

    return ibOrder;
  }

  /**
   * Wait for an order to reach a specific status
   * @param orderId Order ID to wait for
   * @param targetStatus Status to wait for (e.g., 'Cancelled', 'Filled')
   * @param timeoutMs Maximum time to wait in milliseconds
   * @returns true if status reached, false if timeout
   */
  private async waitForOrderStatus(
    orderId: number,
    targetStatus: string,
    timeoutMs: number = 5000
  ): Promise<boolean> {
    const order = this.pendingOrders.get(orderId);

    // Check if already at target status
    if (order && order.status === targetStatus) {
      return true;
    }

    // Wait for status change
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        // Remove callback on timeout
        const callbacks = this.orderStatusCallbacks.get(orderId);
        if (callbacks) {
          const index = callbacks.indexOf(statusCallback);
          if (index > -1) callbacks.splice(index, 1);
        }
        resolve(false);
      }, timeoutMs);

      const statusCallback = (status: string) => {
        if (status === targetStatus) {
          clearTimeout(timeout);
          // Remove this callback
          const callbacks = this.orderStatusCallbacks.get(orderId);
          if (callbacks) {
            const index = callbacks.indexOf(statusCallback);
            if (index > -1) callbacks.splice(index, 1);
          }
          resolve(true);
        }
      };

      // Register callback
      if (!this.orderStatusCallbacks.has(orderId)) {
        this.orderStatusCallbacks.set(orderId, []);
      }
      this.orderStatusCallbacks.get(orderId)!.push(statusCallback);
    });
  }

  /**
   * Wait for a bracket order to be fully cancelled (all three legs)
   * @param parentOrderId Parent order ID
   * @param timeoutMs Maximum time to wait
   * @returns true if all cancelled, false if timeout or partial failure
   */
  private async waitForBracketCancellation(
    parentOrderId: number,
    timeoutMs: number = 10000
  ): Promise<boolean> {
    const bracketSet = this.bracketOrders.get(parentOrderId);

    if (!bracketSet) {
      // Single order, not a bracket
      return await this.waitForOrderStatus(parentOrderId, 'Cancelled', timeoutMs);
    }

    console.log(`⏳ Waiting for bracket cancellation confirmation (timeout: ${timeoutMs}ms)...`);
    const startTime = Date.now();

    // Wait for all three legs to be cancelled
    const parentCancelled = await this.waitForOrderStatus(
      bracketSet.parentOrderId,
      'Cancelled',
      timeoutMs
    );

    const remainingTime = timeoutMs - (Date.now() - startTime);
    const tpCancelled = await this.waitForOrderStatus(
      bracketSet.takeProfitOrderId,
      'Cancelled',
      Math.max(1000, remainingTime)
    );

    const remainingTime2 = timeoutMs - (Date.now() - startTime);
    const slCancelled = await this.waitForOrderStatus(
      bracketSet.stopLossOrderId,
      'Cancelled',
      Math.max(1000, remainingTime2)
    );

    const allCancelled = parentCancelled && tpCancelled && slCancelled;

    if (allCancelled) {
      console.log(`✅ Bracket fully cancelled: ${bracketSet.parentOrderId}, ${bracketSet.takeProfitOrderId}, ${bracketSet.stopLossOrderId}`);
    } else {
      console.error(`⚠️  Bracket cancellation incomplete after ${Date.now() - startTime}ms:`);
      console.error(`   Parent ${bracketSet.parentOrderId}: ${parentCancelled ? '✓' : '✗'}`);
      console.error(`   TakeProfit ${bracketSet.takeProfitOrderId}: ${tpCancelled ? '✓' : '✗'}`);
      console.error(`   StopLoss ${bracketSet.stopLossOrderId}: ${slCancelled ? '✓' : '✗'}`);
    }

    return allCancelled;
  }

  /**
   * Cancel a bracket order (parent + take profit + stop loss)
   */
  private async cancelBracketOrder(parentOrderId: number): Promise<void> {
    // Check if this is a bracket order
    const bracketSet = this.bracketOrders.get(parentOrderId);

    if (bracketSet) {
      // Clear message about what we're cancelling
      console.log(`\n🔴 CANCELLING BRACKET for ${bracketSet.symbol} with orders: Parent=${bracketSet.parentOrderId}, TakeProfit=${bracketSet.takeProfitOrderId}, StopLoss=${bracketSet.stopLossOrderId}`);

      // Cancel parent order
      console.log(`   → Cancelling parent order ${parentOrderId}`);
      this.client.cancelOrder(parentOrderId);
      this.pendingOrders.delete(parentOrderId);

      // Cancel take profit order
      console.log(`   → Cancelling take profit order ${bracketSet.takeProfitOrderId}`);
      this.client.cancelOrder(bracketSet.takeProfitOrderId);
      this.pendingOrders.delete(bracketSet.takeProfitOrderId);

      // Cancel stop loss order
      console.log(`   → Cancelling stop loss order ${bracketSet.stopLossOrderId}`);
      this.client.cancelOrder(bracketSet.stopLossOrderId);
      this.pendingOrders.delete(bracketSet.stopLossOrderId);

      // Remove bracket from tracking
      this.bracketOrders.delete(parentOrderId);

      console.log(`✅ BRACKET CANCELLED for ${bracketSet.symbol} successfully with orders: ${bracketSet.parentOrderId}, ${bracketSet.takeProfitOrderId}, ${bracketSet.stopLossOrderId}\n`);
    } else {
      // Not a bracket order, just cancel the single order
      console.log(`\n🔴 CANCELLING SINGLE ORDER: ${parentOrderId}`);
      this.client.cancelOrder(parentOrderId);
      this.pendingOrders.delete(parentOrderId);
      console.log(`✅ SINGLE ORDER CANCELLED: ${parentOrderId}\n`);
    }
  }

  /**
   * Cancel open entries with TWO-PHASE verification
   * Phase A: Send cancellation requests and WAIT for confirmation
   * Phase B: Only return success after all orders are confirmed cancelled
   */
  async cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<CancellationResult> {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`TWS: TWO-PHASE CANCELLATION FOR ${orders.length} ORDER(S) - ${symbol}`);
    console.log(`${'='.repeat(70)}`);

    this.auditEvent = env.auditEvent;
    const result: CancellationResult = {
      succeeded: [],
      failed: [],
    };

    if (!env.dryRun && !this.connected) {
      await this.connect();
    }

    // Track order IDs that need cancellation verification
    const ordersToVerify: Array<{ originalId: string; twsOrderId: number }> = [];

    // PHASE A: Send cancellation requests
    console.log('\n📤 PHASE A: Sending cancellation requests...');
    for (const order of orders) {
      if (env.dryRun) {
        console.log(`→ DRY RUN: Would cancel order ${order.id}`);
        result.succeeded.push(order.id);
        continue;
      }

      // Try direct lookup first (order.id is already TWS ID)
      const orderIdNum = parseInt(order.id);
      if (!isNaN(orderIdNum) && this.pendingOrders.has(orderIdNum)) {
        try {
          await this.cancelBracketOrder(orderIdNum);
          console.log(`✓ Sent cancellation for TWS order ${orderIdNum}`);
          ordersToVerify.push({ originalId: order.id, twsOrderId: orderIdNum });
        } catch (e) {
          const err = e as Error;
          const reason = `Direct cancellation failed: ${err.message}`;
          console.error(`✗ ${reason}`);
          result.failed.push({ orderId: order.id, reason });
          // Audit log for cancellation failure
          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'error',
            message: 'Order cancellation failed (direct)',
            metadata: {
              symbol,
              orderId: order.id,
              twsOrderId: orderIdNum,
              error: err.message,
              phase: 'A_SEND_REQUEST',
            },
          });
          // DON'T FAIL FAST - Continue attempting remaining cancellations
        }
        continue;
      }

      // Try mapping lookup (order.id is original ID)
      const ibOrderId = this.orderIdMap.get(order.id);
      if (ibOrderId !== undefined) {
        try {
          await this.cancelBracketOrder(ibOrderId);
          console.log(`✓ Sent cancellation for mapped order ${order.id} -> ${ibOrderId}`);
          ordersToVerify.push({ originalId: order.id, twsOrderId: ibOrderId });
        } catch (e) {
          const err = e as Error;
          const reason = `Mapped cancellation failed: ${err.message}`;
          console.error(`✗ ${reason}`);
          result.failed.push({ orderId: order.id, reason });
          // Audit log for cancellation failure
          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'error',
            message: 'Order cancellation failed (mapped)',
            metadata: {
              symbol,
              orderId: order.id,
              twsOrderId: ibOrderId,
              error: err.message,
              phase: 'A_SEND_REQUEST',
            },
          });
          // DON'T FAIL FAST - Continue attempting remaining cancellations
        }
      } else {
        // Order not found - this is a failure condition
        const reason = 'Order not found in TWS (not in pendingOrders or orderIdMap)';
        console.error(`✗ Order ${order.id}: ${reason}`);
        result.failed.push({ orderId: order.id, reason });
        // Audit log for cancellation failure
        this.auditEvent?.({
          component: 'TwsAdapter',
          level: 'error',
          message: 'Order cancellation failed - order not found',
          metadata: {
            symbol,
            orderId: order.id,
            reason,
            phase: 'A_SEND_REQUEST',
            pendingOrdersCount: this.pendingOrders.size,
            orderIdMapSize: this.orderIdMap.size,
          },
        });
        // DON'T FAIL FAST - Continue attempting remaining cancellations
      }
    }

    // PHASE B: Wait for cancellation confirmation
    if (ordersToVerify.length > 0 && !env.dryRun) {
      console.log(`\n⏳ PHASE B: Waiting for cancellation confirmation (${ordersToVerify.length} bracket(s))...`);
      const verificationStartTime = Date.now();

      for (const { originalId, twsOrderId } of ordersToVerify) {
        const verified = await this.waitForBracketCancellation(twsOrderId, 10000);

        if (verified) {
          console.log(`✅ Verified cancellation: ${originalId} (TWS ${twsOrderId})`);
          result.succeeded.push(originalId);
          this.orderIdMap.delete(originalId);
          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'info',
            message: 'Order cancelled',
            metadata: {
              symbol,
              orderId: originalId,
              twsOrderId,
            },
          });
        } else {
          const reason = 'Cancellation timeout - order may still be active';
          console.error(`⚠️  ${originalId} (TWS ${twsOrderId}): ${reason}`);
          result.failed.push({ orderId: originalId, reason });
          // Audit log for cancellation verification timeout
          this.auditEvent?.({
            component: 'TwsAdapter',
            level: 'error',
            message: 'Order cancellation verification timeout',
            metadata: {
              symbol,
              orderId: originalId,
              twsOrderId,
              reason,
              phase: 'B_VERIFY_CANCELLATION',
              verificationTimeoutMs: 10000,
            },
          });
          // DON'T FAIL FAST - Continue verifying remaining orders
        }
      }

      const verificationTime = Date.now() - verificationStartTime;
      console.log(`\n✅ Phase B complete: ${ordersToVerify.length} bracket(s) processed in ${verificationTime}ms`);
      console.log(`   Succeeded: ${result.succeeded.length}, Failed: ${result.failed.length}`);
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`SUMMARY: Cancelled ${result.succeeded.length}/${orders.length} order(s) for ${symbol}`);
    if (result.failed.length > 0) {
      console.error(`⚠️  Failed to cancel ${result.failed.length} order(s):`);
      for (const failure of result.failed) {
        console.error(`   - ${failure.orderId}: ${failure.reason}`);
      }
    }
    console.log(`${'='.repeat(70)}\n`);

    // Throw error if any cancellations failed (after attempting all)
    if (result.failed.length > 0) {
      throw new Error(
        `Failed to cancel ${result.failed.length}/${orders.length} order(s) for ${symbol}: ` +
        result.failed.map(f => `${f.orderId}(${f.reason})`).join(', ')
      );
    }

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
      const collected: Order[] = [];
      let completed = false;

      const onOpenOrder = (orderId: number, contract: any, order: any, orderState: any) => {
        if (contract?.symbol !== symbol) {
          return;
        }
        const status = orderState?.status || order?.status || 'Submitted';
        collected.push({
          id: orderId.toString(),
          planId: `tws-${orderId}`,
          symbol: contract.symbol,
          qty: order.totalQuantity,
          side: order.action === 'BUY' ? 'buy' : 'sell',
          type: order.orderType === 'LMT' ? 'limit' : 'market',
          limitPrice: order.lmtPrice,
          stopPrice: order.auxPrice,
          status: this.mapTWSStatus(status),
        });
      };

      const onOpenOrderEnd = () => {
        completed = true;
      };

      this.client.on('openOrder', onOpenOrder);
      this.client.once('openOrderEnd', onOpenOrderEnd);

      // Request all open orders and wait briefly for callbacks
      this.client.reqAllOpenOrders();
      const start = Date.now();
      while (!completed && Date.now() - start < 1500) {
        await this.sleep(50);
      }

      this.client.off('openOrder', onOpenOrder);
      this.client.off('openOrderEnd', onOpenOrderEnd);

      // Fallback to pendingOrders if broker didn't emit open orders
      const orders: Order[] = collected.length > 0 ? collected : [];
      if (orders.length === 0) {
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
   * Get rejection details for an order
   */
  getOrderRejectionDetails(orderId: number): { code: number; message: string } | undefined {
    return this.orderRejections.get(orderId);
  }

  /**
   * Get all rejected orders with details
   */
  getRejectedOrders(): Array<{ orderId: number; symbol: string; reason: string }> {
    const rejected: Array<{ orderId: number; symbol: string; reason: string }> = [];

    for (const [orderId, order] of this.pendingOrders.entries()) {
      if (order.status === 'Rejected' || order.status === 'Cancelled' || order.status === 'Inactive') {
        rejected.push({
          orderId,
          symbol: order.symbol,
          reason: order.rejectionReason || 'Unknown reason',
        });
      }
    }

    return rejected;
  }

  /**
   * Get execution details for an order
   */
  getOrderExecutions(orderId: number): Array<{ execId: string; time: string; qty: number; price: number; side: string }> {
    return this.executions.get(orderId) || [];
  }

  /**
   * Get all orders with executions
   */
  getAllExecutions(): Map<number, Array<{ execId: string; time: string; qty: number; price: number; side: string }>> {
    return new Map(this.executions);
  }

  /**
   * Get commission for an execution
   */
  getCommission(execId: string): { commission: number; currency: string } | undefined {
    return this.commissions.get(execId);
  }

  /**
   * Calculate total filled quantity and average price for an order
   */
  getOrderFillSummary(orderId: number): { totalFilled: number; avgPrice: number; executions: number } | null {
    const fills = this.executions.get(orderId);
    if (!fills || fills.length === 0) {
      return null;
    }

    const totalFilled = fills.reduce((sum, fill) => sum + fill.qty, 0);
    const avgPrice = fills.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / totalFilled;

    return {
      totalFilled,
      avgPrice,
      executions: fills.length,
    };
  }

  /**
   * Helper: sleep for ms
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
