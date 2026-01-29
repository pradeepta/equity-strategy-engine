/**
 * Order Repository
 * Handles all database operations for orders and fills
 */

import {
  PrismaClient,
  Order,
  OrderStatus,
  OrderSide,
  OrderType,
  Prisma,
} from "@prisma/client";

export class OrderRepository {
  constructor(private prisma: PrismaClient) {}

  /**
   * Find orders by plan ID (for idempotency check)
   */
  async findByPlanId(planId: string, strategyId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: {
        planId,
        strategyId,
      },
    });
  }

  /**
   * Create order with idempotency check (with audit log for new orders)
   * If orders with the same planId + strategyId exist, returns existing orders instead
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
    // Check for existing order with same planId + strategyId (idempotency)
    const existing = await this.prisma.order.findFirst({
      where: {
        planId: params.planId,
        strategyId: params.strategyId,
        qty: params.qty,
        side: params.side,
      },
    });

    if (existing) {
      console.log(`ℹ️  Idempotency: Order with planId=${params.planId} already exists (id=${existing.id})`);
      return existing;
    }

    // Create new order
    const order = await this.prisma.order.create({
      data: params,
    });

    // Create audit log for new order
    await this.createAuditLog({
      orderId: order.id,
      brokerOrderId: params.brokerOrderId,
      strategyId: params.strategyId,
      eventType: 'SUBMITTED',
      newStatus: 'PENDING',
      quantity: params.qty,
      price: params.limitPrice,
      metadata: {
        source: 'order_creation',
        planId: params.planId,
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        limitPrice: params.limitPrice,
        stopPrice: params.stopPrice,
        isParent: params.isParent,
      },
    });

    return order;
  }

  /**
   * Create order audit log entry
   */
  async createAuditLog(params: {
    orderId?: string;
    brokerOrderId?: string;
    strategyId: string;
    eventType:
      | "SUBMITTED"
      | "CANCELLED"
      | "FILLED"
      | "PARTIALLY_FILLED"
      | "REJECTED"
      | "RECONCILED"
      | "ORPHANED"
      | "MISSING";
    oldStatus?:
      | "PENDING"
      | "SUBMITTED"
      | "FILLED"
      | "PARTIALLY_FILLED"
      | "CANCELLED"
      | "REJECTED";
    newStatus?:
      | "PENDING"
      | "SUBMITTED"
      | "FILLED"
      | "PARTIALLY_FILLED"
      | "CANCELLED"
      | "REJECTED";
    quantity?: number;
    price?: number;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.orderAuditLog.create({
      data: {
        ...params,
        quantity: params.quantity,
        price: params.price,
        metadata: (params.metadata ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
      },
    });
  }

  /**
   * Map OrderStatus to OrderEventType for audit logs
   */
  private mapStatusToEventType(status: OrderStatus): "SUBMITTED" | "CANCELLED" | "FILLED" | "PARTIALLY_FILLED" | "REJECTED" {
    const mapping: Record<OrderStatus, "SUBMITTED" | "CANCELLED" | "FILLED" | "PARTIALLY_FILLED" | "REJECTED"> = {
      PENDING: "SUBMITTED",
      SUBMITTED: "SUBMITTED",
      FILLED: "FILLED",
      PARTIALLY_FILLED: "PARTIALLY_FILLED",
      CANCELLED: "CANCELLED",
      REJECTED: "REJECTED",
    };
    return mapping[status];
  }

  /**
   * Update order status (with audit log)
   */
  async updateStatus(orderId: string, status: OrderStatus, metadata?: Record<string, unknown>): Promise<Order> {
    // Fetch current order state
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    const oldStatus = order.status;

    // Build updates
    const updates: any = { status };

    if (status === "SUBMITTED") {
      updates.submittedAt = new Date();
    } else if (status === "FILLED") {
      updates.filledAt = new Date();
    } else if (status === "CANCELLED") {
      updates.cancelledAt = new Date();
    }

    // Update order
    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: updates,
    });

    // Create audit log
    await this.createAuditLog({
      orderId,
      brokerOrderId: order.brokerOrderId ?? undefined,
      strategyId: order.strategyId,
      eventType: this.mapStatusToEventType(status),
      oldStatus: oldStatus,
      newStatus: status,
      quantity: order.qty,
      metadata: {
        source: 'status_update',
        ...metadata,
      },
    });

    return updatedOrder;
  }

  /**
   * Record fill
   */
  async recordFill(
    orderId: string,
    qty: number,
    price: number,
    commission?: number
  ): Promise<Order> {
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
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      const newFilledQty = order.filledQty + qty;
      const isFullyFilled = newFilledQty >= order.qty;
      const newStatus = isFullyFilled ? "FILLED" : "PARTIALLY_FILLED";

      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          filledQty: newFilledQty,
          status: newStatus,
          avgFillPrice: price, // Simplified; should calculate weighted average
          filledAt: isFullyFilled ? new Date() : undefined,
        },
      });

      // Create audit log for fill event
      await tx.orderAuditLog.create({
        data: {
          orderId,
          brokerOrderId: order.brokerOrderId || undefined,
          strategyId: order.strategyId,
          eventType: isFullyFilled ? "FILLED" : "PARTIALLY_FILLED",
          oldStatus: order.status,
          newStatus: newStatus,
          quantity: qty,
          price: price,
          metadata: {
            commission: commission || 0,
            filledQty: newFilledQty,
            totalQty: order.qty,
            fillPercentage: ((newFilledQty / order.qty) * 100).toFixed(2),
          },
        },
      });

      return updatedOrder;
    });
  }

  /**
   * Get orders by strategy
   */
  async getByStrategy(
    strategyId: string,
    limit: number = 100
  ): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { strategyId },
      orderBy: { createdAt: "desc" },
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
        status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
      },
      orderBy: { createdAt: "asc" },
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
  async updateBrokerOrderId(
    orderId: string,
    brokerOrderId: string
  ): Promise<Order> {
    return this.prisma.order.update({
      where: { id: orderId },
      data: { brokerOrderId },
    });
  }

  /**
   * Mark order as rejected (with audit log)
   */
  async markRejected(orderId: string, errorMessage: string): Promise<Order> {
    // Fetch current order state
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    const oldStatus = order.status;

    // Update order
    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: "REJECTED",
        errorMessage,
      },
    });

    // Create audit log
    await this.createAuditLog({
      orderId,
      brokerOrderId: order.brokerOrderId ?? undefined,
      strategyId: order.strategyId,
      eventType: 'REJECTED',
      oldStatus,
      newStatus: 'REJECTED',
      errorMessage,
      quantity: order.qty,
      metadata: {
        source: 'rejection',
        rejectionReason: errorMessage,
        symbol: order.symbol,
      },
    });

    return updatedOrder;
  }

  /**
   * Get all fills for an order
   */
  async getFills(orderId: string) {
    return this.prisma.fill.findMany({
      where: { orderId },
      orderBy: { filledAt: "asc" },
    });
  }

  /**
   * Get order statistics for a strategy
   */
  async getStrategyOrderStats(strategyId: string) {
    const orders = await this.prisma.order.groupBy({
      by: ["status"],
      where: { strategyId },
      _count: true,
    });

    return orders.reduce((acc, item) => {
      acc[item.status] = item._count;
      return acc;
    }, {} as Record<string, number>);
  }

  /**
   * Find open market-exit order for a strategy+symbol
   */
  async findOpenMarketExit(symbol: string): Promise<Order | null> {
    return this.prisma.order.findFirst({
      where: {
        symbol,
        planId: { startsWith: "market-exit-" },
        status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Cancel all open orders for a strategy (with audit logs for each order)
   */
  async cancelOpenOrders(strategyId: string, reason?: string): Promise<number> {
    // Fetch orders first so we can create audit logs
    const orders = await this.prisma.order.findMany({
      where: {
        strategyId,
        status: { in: ["PENDING", "SUBMITTED"] },
      },
    });

    // Cancel each order individually with audit log
    let cancelledCount = 0;
    for (const order of orders) {
      const oldStatus = order.status;

      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
        },
      });

      // Create audit log
      await this.createAuditLog({
        orderId: order.id,
        brokerOrderId: order.brokerOrderId ?? undefined,
        strategyId: order.strategyId,
        eventType: 'CANCELLED',
        oldStatus,
        newStatus: 'CANCELLED',
        quantity: order.qty,
        metadata: {
          source: 'bulk_cancellation',
          reason: reason || 'Bulk cancellation',
          symbol: order.symbol,
          planId: order.planId,
        },
      });

      cancelledCount++;
    }

    return cancelledCount;
  }

  /**
   * Find open orders by symbol (for reconciliation)
   */
  async findOpenBySymbol(symbol: string): Promise<
    Array<{
      id: string;
      planId: string;
      symbol: string;
      side: "buy" | "sell";
      qty: number;
      type: "limit" | "market";
      status:
        | "pending"
        | "submitted"
        | "filled"
        | "partially_filled"
        | "cancelled"
        | "rejected";
      limitPrice?: number;
      stopPrice?: number;
      filledQty?: number;
      strategyId: string;
      brokerOrderId?: string | null;
    }>
  > {
    const orders = await this.prisma.order.findMany({
      where: {
        symbol,
        status: { in: ["PENDING", "SUBMITTED", "PARTIALLY_FILLED"] },
      },
      orderBy: { createdAt: "desc" },
    });

    return orders.map((order) => ({
      id: order.id,
      planId: order.planId,
      symbol: order.symbol,
      side: order.side.toLowerCase() as "buy" | "sell",
      qty: order.qty,
      type: order.type.toLowerCase() as "limit" | "market",
      status: order.status.toLowerCase() as
        | "pending"
        | "submitted"
        | "filled"
        | "partially_filled"
        | "cancelled"
        | "rejected",
      limitPrice: order.limitPrice ?? undefined,
      stopPrice: order.stopPrice ?? undefined,
      filledQty: order.filledQty ?? undefined,
      strategyId: order.strategyId,
      brokerOrderId: order.brokerOrderId ?? undefined,
    }));
  }
}
