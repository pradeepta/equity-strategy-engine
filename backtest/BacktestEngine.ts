/**
 * Backtesting Engine
 * Runs strategy against historical bars and tracks performance
 */

import { StrategyCompiler } from '../compiler/compile';
import { createStandardRegistry } from '../features/registry';
import { StrategyEngine } from '../runtime/engine';
import { Bar, CompiledIR, Order } from '../spec/types';
import { BaseBrokerAdapter } from '../broker/broker';
import { OrderPlan, BrokerEnvironment, CancellationResult } from '../spec/types';

/**
 * Mock broker adapter for backtesting
 * Simulates order fills based on price action
 */
class MockBacktestBroker extends BaseBrokerAdapter {
  private mockOrders: Map<string, Order> = new Map();
  private fills: Array<{
    orderId: string;
    price: number;
    qty: number;
    timestamp: number;
    side: 'buy' | 'sell';
  }> = [];

  async submitOrderPlan(plan: OrderPlan, env: BrokerEnvironment): Promise<Order[]> {
    const orders: Order[] = [];

    // Create entry order
    const entryOrder: Order = {
      id: this.generateOrderId('entry'),
      planId: plan.id,
      symbol: plan.symbol,
      side: plan.side,
      qty: plan.qty,
      type: 'limit',
      limitPrice: plan.targetEntryPrice,
      status: 'pending',
    };
    orders.push(entryOrder);
    this.mockOrders.set(entryOrder.id, entryOrder);

    // Create bracket orders if specified
    if (plan.brackets && plan.brackets.length > 0) {
      for (const bracket of plan.brackets) {
        const partialQty = Math.floor(plan.qty * bracket.ratioOfPosition);

        // Take profit
        const tpOrder: Order = {
          id: this.generateOrderId('tp'),
          planId: plan.id,
          symbol: plan.symbol,
          side: plan.side === 'buy' ? 'sell' : 'buy',
          qty: partialQty,
          type: 'limit',
          limitPrice: bracket.price,
          status: 'pending',
        };
        orders.push(tpOrder);
        this.mockOrders.set(tpOrder.id, tpOrder);
      }

      // Stop loss (use limit type with stopPrice)
      const slOrder: Order = {
        id: this.generateOrderId('sl'),
        planId: plan.id,
        symbol: plan.symbol,
        side: plan.side === 'buy' ? 'sell' : 'buy',
        qty: plan.qty,
        type: 'limit',
        stopPrice: plan.stopPrice,
        status: 'pending',
      };
      orders.push(slOrder);
      this.mockOrders.set(slOrder.id, slOrder);
    }

    return orders;
  }

  async submitMarketOrder(
    symbol: string,
    qty: number,
    side: 'buy' | 'sell',
    env: BrokerEnvironment
  ): Promise<Order> {
    const order: Order = {
      id: this.generateOrderId('market'),
      planId: 'market-order',
      symbol,
      side,
      qty,
      type: 'market',
      status: 'pending',
    };
    this.mockOrders.set(order.id, order);
    return order;
  }

  async cancelOpenEntries(
    symbol: string,
    orders: Order[],
    env: BrokerEnvironment
  ): Promise<CancellationResult> {
    const succeeded: string[] = [];
    const failed: Array<{ orderId: string; reason: string }> = [];

    for (const order of orders) {
      if (this.mockOrders.has(order.id)) {
        const mockOrder = this.mockOrders.get(order.id)!;
        mockOrder.status = 'cancelled';
        succeeded.push(order.id);
      } else {
        failed.push({ orderId: order.id, reason: 'Order not found' });
      }
    }

    return { succeeded, failed };
  }

  async getOpenOrders(symbol: string, env: BrokerEnvironment): Promise<Order[]> {
    return Array.from(this.mockOrders.values()).filter(
      (o) => o.symbol === symbol && o.status === 'pending'
    );
  }

  /**
   * Simulate order fills based on bar price action
   */
  processBar(bar: Bar): void {
    for (const [orderId, order] of this.mockOrders.entries()) {
      if (order.status !== 'pending') continue;

      let filled = false;
      let fillPrice = 0;

      // Check if order would be filled by this bar
      if (order.type === 'limit' && order.limitPrice) {
        if (order.side === 'buy' && bar.low <= order.limitPrice) {
          filled = true;
          fillPrice = order.limitPrice;
        } else if (order.side === 'sell' && bar.high >= order.limitPrice) {
          filled = true;
          fillPrice = order.limitPrice;
        }
      } else if (order.stopPrice) {
        // Stop order logic (even if type is 'limit', stopPrice indicates stop behavior)
        if (order.side === 'buy' && bar.high >= order.stopPrice) {
          filled = true;
          fillPrice = order.stopPrice;
        } else if (order.side === 'sell' && bar.low <= order.stopPrice) {
          filled = true;
          fillPrice = order.stopPrice;
        }
      } else if (order.type === 'market') {
        filled = true;
        fillPrice = bar.close;
      }

      if (filled) {
        order.status = 'filled';
        this.fills.push({
          orderId,
          price: fillPrice,
          qty: order.qty,
          timestamp: bar.timestamp,
          side: order.side,
        });
      }
    }
  }

  getFills() {
    return this.fills;
  }

  reset() {
    this.mockOrders.clear();
    this.fills = [];
  }
}

/**
 * Backtest result containing all performance metrics
 */
export interface BacktestResult {
  symbol: string;
  strategyName: string;
  timeframe: string;
  barsProcessed: number;

  // State tracking
  stateTransitions: Array<{
    bar: number;
    timestamp: number;
    from: string;
    to: string;
    price: number;
  }>;
  finalState: string;

  // Order tracking
  ordersPlaced: number;
  ordersFilled: number;
  ordersCancelled: number;

  // Performance metrics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  realizedPnL: number;

  // Stop loss tracking
  stopLossHits: number;

  // Invalidations
  invalidations: number;
  invalidationReasons: string[];

  // Detailed fills
  fills: Array<{
    orderId: string;
    price: number;
    qty: number;
    timestamp: number;
    side: 'buy' | 'sell';
  }>;

  // Price tracking
  priceAtArm: number | null;
  priceAtEntry: number | null;
  priceAtExit: number | null;

  // Market context
  startPrice: number;
  endPrice: number;
  priceChange: number;
  priceChangePercent: number;
}

/**
 * Backtest Engine - runs strategies against historical data
 */
export class BacktestEngine {
  private compiler: StrategyCompiler;
  private registry = createStandardRegistry();
  private broker: MockBacktestBroker;

  constructor() {
    this.compiler = new StrategyCompiler(this.registry);
    this.broker = new MockBacktestBroker();
  }

  /**
   * Run backtest on a compiled strategy IR
   */
  async runBacktest(ir: CompiledIR, bars: Bar[]): Promise<BacktestResult> {
    // Reset broker state
    this.broker.reset();

    // Create engine for backtesting
    // Note: allowLiveOrders must be true to allow order submission to MockBroker
    // The MockBroker doesn't actually send orders anywhere - it just simulates fills
    const engine = new StrategyEngine(ir, this.registry, this.broker, {
      dryRun: true,
      allowLiveOrders: true,  // Must be true for backtest order simulation
      allowCancelEntries: true,
    });

    // Track metrics
    const stateTransitions: BacktestResult['stateTransitions'] = [];
    const invalidationReasons: string[] = [];
    let priceAtArm: number | null = null;
    let priceAtEntry: number | null = null;
    let priceAtExit: number | null = null;
    let invalidations = 0;

    // Process each bar
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const prevState = engine.getState().currentState;

      // Process bar (NOT in replay mode - we want orders to be submitted to MockBroker)
      // allowLiveOrders: false prevents real broker submission
      await engine.processBar(bar);

      // Simulate fills after bar processing
      this.broker.processBar(bar);

      const currState = engine.getState().currentState;

      // Track state transitions
      if (prevState !== currState) {
        stateTransitions.push({
          bar: i + 1,
          timestamp: bar.timestamp,
          from: prevState,
          to: currState,
          price: bar.close,
        });

        // Track key prices
        if (currState === 'ARMED' && !priceAtArm) {
          priceAtArm = bar.close;
        }
        if (currState === 'PLACED' && !priceAtEntry) {
          priceAtEntry = bar.close;
        }
        if (currState === 'EXITED') {
          if (!priceAtExit) {
            priceAtExit = bar.close;
          }

          // Check if it was an invalidation
          if (prevState === 'MANAGING') {
            invalidations++;
            invalidationReasons.push(`Bar ${i + 1}: Price at ${bar.close.toFixed(2)}`);
          }
        }
      }
    }

    // Calculate performance metrics
    const fills = this.broker.getFills();
    const finalState = engine.getState();

    // Calculate P&L from fills
    let realizedPnL = 0;
    let position = 0;
    let avgCost = 0;
    let totalTrades = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let stopLossHits = 0;

    for (const fill of fills) {
      if (fill.side === 'buy') {
        const newQty = position + fill.qty;
        avgCost = ((avgCost * position) + (fill.price * fill.qty)) / newQty;
        position = newQty;
      } else {
        // Sell - realize P&L
        const closedQty = Math.min(fill.qty, position);
        const tradePnL = closedQty * (fill.price - avgCost);
        realizedPnL += tradePnL;
        position -= closedQty;

        totalTrades++;
        if (tradePnL > 0) {
          winningTrades++;
        } else if (tradePnL < 0) {
          losingTrades++;
          // Heuristic: if loss is close to expected stop loss, count it
          const expectedStopLoss = ir.orderPlans[0]?.stopPrice;
          if (expectedStopLoss && Math.abs(fill.price - expectedStopLoss) < 0.5) {
            stopLossHits++;
          }
        }
      }
    }

    // Count order statuses
    let ordersPlaced = 0;
    let ordersFilled = 0;
    let ordersCancelled = 0;

    for (const fill of fills) {
      ordersPlaced++;
      ordersFilled++;
    }

    // Market context
    const startPrice = bars[0].close;
    const endPrice = bars[bars.length - 1].close;
    const priceChange = endPrice - startPrice;
    const priceChangePercent = (priceChange / startPrice) * 100;

    return {
      symbol: ir.symbol,
      strategyName: 'Backtest Strategy',
      timeframe: ir.timeframe || '5m',
      barsProcessed: bars.length,
      stateTransitions,
      finalState: finalState.currentState,
      ordersPlaced,
      ordersFilled,
      ordersCancelled,
      totalTrades,
      winningTrades,
      losingTrades,
      winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
      realizedPnL,
      stopLossHits,
      invalidations,
      invalidationReasons,
      fills,
      priceAtArm,
      priceAtEntry,
      priceAtExit,
      startPrice,
      endPrice,
      priceChange,
      priceChangePercent,
    };
  }

  /**
   * Run backtest from YAML string
   */
  async runBacktestFromYAML(yamlContent: string, bars: Bar[]): Promise<BacktestResult> {
    const ir = this.compiler.compileFromYAML(yamlContent);
    return this.runBacktest(ir, bars);
  }
}
