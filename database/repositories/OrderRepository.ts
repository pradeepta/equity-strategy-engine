/**
 * Order Repository
 * Handles all database operations for orders and fills
 */

import { PrismaClient, Order, OrderStatus, OrderSide, OrderType } from '@prisma/client';

export class OrderRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create order
   */
  async create(params: {
    strategyId: string;
    brokerOrderId?: string;
    planId: string;
    symbol: string;
    side: OrderSide;
    qty: number;
    type: OrderType;
    limitPrice?: number;
    stopPrice?: number;
    parentOrderId?: string;
    isParent?: boolean;
  }): Promise<Order> {
    return this.prisma.order.create({
      data: params,
    });
  }

  /**
   * Update order status
   */
  async updateStatus(orderId: string, status: OrderStatus): Promise<Order> {
    const updates: any = { status };

    if (status === 'SUBMITTED') {
      updates.submittedAt = new Date();
    } else if (status === 'FILLED') {
      updates.filledAt = new Date();
    } else if (status === 'CANCELLED') {
      updates.cancelledAt = new Date();
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: updates,
    });
  }

  /**
   * Record fill
   */
  async recordFill(orderId: string, qty: number, price: number, commission?: number): Promise<Order> {
    return this.prisma.$transaction(async (tx) => {
      // Create fill record
      await tx.fill.create({
        data: {
          orderId,
          qty,
          price,
          commission,
          filledAt: new Date(),
        },
      });

      // Update order
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const newFilledQty = order.filledQty + qty;
      const isFullyFilled = newFilledQty >= order.qty;

      return tx.order.update({
        where: { id: orderId },
        data: {
          filledQty: newFilledQty,
          status: isFullyFilled ? 'FILLED' : 'PARTIALLY_FILLED',
          avgFillPrice: price, // Simplified; should calculate weighted average
          filledAt: isFullyFilled ? new Date() : undefined,
        },
      });
    });
  }

  /**
   * Get orders by strategy
   */
  async getByStrategy(strategyId: string, limit: number = 100): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { strategyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        fills: true,
        childOrders: true,
      },
    });
  }

  /**
   * Get open orders by strategy
   */
  async getOpenByStrategy(strategyId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: {
        strategyId,
        status: { in: ['PENDING', 'SUBMITTED', 'PARTIALLY_FILLED'] },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Find by broker order ID
   */
  async findByBrokerOrderId(brokerOrderId: string): Promise<Order | null> {
    return this.prisma.order.findFirst({
      where: { brokerOrderId },
    });
  }

  /**
   * Find by ID
   */
  async findById(orderId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        fills: true,
        childOrders: true,
        parentOrder: true,
      },
    });
  }

  /**
   * Update broker order ID (after submission to broker)
   */
  async updateBrokerOrderId(orderId: string, brokerOrderId: string): Promise<Order> {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { brokerOrderId },
    });
  }

  /**
   * Mark order as rejected
   */
  async markRejected(orderId: string, errorMessage: string): Promise<Order> {
    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'REJECTED',
        errorMessage,
      },
    });
  }

  /**
   * Get all fills for an order
   */
  async getFills(orderId: string) {
    return this.prisma.fill.findMany({
      where: { orderId },
      orderBy: { filledAt: 'asc' },
    });
  }

  /**
   * Get order statistics for a strategy
   */
  async getStrategyOrderStats(strategyId: string) {
    const orders = await this.prisma.order.groupBy({
      by: ['status'],
      where: { strategyId },
      _count: true,
    });

    return orders.reduce(
      (acc, item) => {
        acc[item.status] = item._count;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  /**
   * Cancel all open orders for a strategy
   */
  async cancelOpenOrders(strategyId: string): Promise<number> {
    const result = await this.prisma.order.updateMany({
      where: {
        strategyId,
        status: { in: ['PENDING', 'SUBMITTED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
      },
    });

    return result.count;
  }
}
