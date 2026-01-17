/**
 * Portfolio API Server
 * Simple HTTP server that exposes portfolio metrics for the web dashboard
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create Prisma adapter
const adapter = new PrismaPg(pool);

// Initialize Prisma with adapter (matching your project's pattern)
const prisma = new PrismaClient({
  adapter,
  log: ['error', 'warn'],
});

const PORT = process.env.PORTFOLIO_API_PORT || 3002;

// Enable CORS for web client
const setCORSHeaders = (res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

// Helper to send JSON response
const sendJSON = (res: ServerResponse, data: any, status: number = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

// Calculate P&L from orders
const calculatePnL = async () => {
  const allOrders = await prisma.order.findMany({
    where: {
      status: { in: ['FILLED', 'PARTIALLY_FILLED'] },
    },
    include: {
      fills: true,
    },
    orderBy: { filledAt: 'asc' },
  });

  let realizedPnL = 0;
  const positionsBySymbol: Record<string, { qty: number; avgPrice: number; symbol: string }> = {};

  // Calculate realized P&L and current positions
  for (const order of allOrders) {
    const symbol = order.symbol;
    const isBuy = order.side === 'BUY';

    if (!positionsBySymbol[symbol]) {
      positionsBySymbol[symbol] = { qty: 0, avgPrice: 0, symbol };
    }

    const position = positionsBySymbol[symbol];
    const fillQty = order.filledQty;
    const fillPrice = order.avgFillPrice || 0;

    if (isBuy) {
      // Add to position
      const newQty = position.qty + fillQty;
      position.avgPrice = ((position.avgPrice * position.qty) + (fillPrice * fillQty)) / newQty;
      position.qty = newQty;
    } else {
      // Reduce position and calculate realized P&L
      const closedQty = Math.min(fillQty, position.qty);
      realizedPnL += closedQty * (fillPrice - position.avgPrice);
      position.qty -= closedQty;

      if (position.qty < 0) {
        // Went short - adjust avg price
        position.avgPrice = fillPrice;
        position.qty = Math.abs(position.qty);
      }
    }
  }

  // Filter out zero positions
  const currentPositions = Object.values(positionsBySymbol).filter(p => p.qty > 0);

  return {
    realizedPnL: parseFloat(realizedPnL.toFixed(2)),
    currentPositions,
    totalPositions: currentPositions.length,
  };
};

// Get strategy performance metrics
const getStrategyMetrics = async () => {
  const strategies = await prisma.strategy.findMany({
    where: {
      status: { in: ['ACTIVE', 'CLOSED'] },
    },
    include: {
      orders: {
        where: {
          status: { in: ['FILLED', 'PARTIALLY_FILLED'] },
        },
        include: {
          fills: true,
        },
      },
      evaluations: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  return strategies.map(strategy => {
    const filledOrders = strategy.orders;
    const totalTrades = filledOrders.length;

    // Calculate wins/losses (simplified)
    let wins = 0;
    let losses = 0;
    let totalPnL = 0;

    for (const order of filledOrders) {
      if (order.side === 'SELL') {
        // Simplified: assume sell orders close positions for profit/loss
        const pnl = (order.avgFillPrice || 0) * order.filledQty;
        totalPnL += pnl;
        if (pnl > 0) wins++;
        else losses++;
      }
    }

    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const latestEvaluation = strategy.evaluations[0];

    const statusUpdatedAt = (() => {
      switch (strategy.status) {
        case 'ACTIVE':
          return strategy.activatedAt || strategy.updatedAt;
        case 'CLOSED':
          return strategy.closedAt || strategy.updatedAt;
        case 'ARCHIVED':
          return strategy.archivedAt || strategy.updatedAt;
        default:
          return strategy.updatedAt;
      }
    })();

    return {
      id: strategy.id,
      name: strategy.name,
      symbol: strategy.symbol,
      status: strategy.status,
      timeframe: strategy.timeframe,
      totalTrades,
      wins,
      losses,
      winRate: parseFloat(winRate.toFixed(2)),
      totalPnL: parseFloat(totalPnL.toFixed(2)),
      latestRecommendation: latestEvaluation?.recommendation || null,
      activatedAt: strategy.activatedAt,
      closedAt: strategy.closedAt,
      archivedAt: strategy.archivedAt,
      createdAt: strategy.createdAt,
      updatedAt: statusUpdatedAt,
      yamlContent: strategy.yamlContent,
    };
  });
};

// Get recent trades
const getRecentTrades = async (limit: number = 20) => {
  const orders = await prisma.order.findMany({
    where: {
      status: { in: ['FILLED', 'PARTIALLY_FILLED'] },
    },
    orderBy: { filledAt: 'desc' },
    take: limit,
    include: {
      strategy: {
        select: {
          name: true,
          symbol: true,
        },
      },
      fills: true,
    },
  });

  return orders.map(order => ({
    id: order.id,
    strategyName: order.strategy.name,
    symbol: order.symbol,
    side: order.side,
    qty: order.filledQty,
    price: order.avgFillPrice,
    type: order.type,
    status: order.status,
    filledAt: order.filledAt,
    totalFills: order.fills.length,
  }));
};

// Get order statistics
const getOrderStats = async () => {
  const stats = await prisma.order.groupBy({
    by: ['status'],
    _count: true,
  });

  return stats.reduce((acc, item) => {
    acc[item.status] = item._count;
    return acc;
  }, {} as Record<string, number>);
};

// Get audit trail
const getAuditTrail = async (limit: number = 50) => {
  try {
    const auditLogs = await prisma.$queryRaw<any[]>`
      SELECT
        oal.id,
        oal."orderId",
        oal."brokerOrderId",
        oal."strategyId",
        COALESCE(s.name, 'Unknown') AS "strategyName",
        COALESCE(s.symbol, 'N/A') AS "symbol",
        oal."eventType",
        oal."oldStatus",
        oal."newStatus",
        oal.quantity,
        oal.price,
        oal."errorMessage",
        oal.metadata,
        oal."createdAt"
      FROM order_audit_log oal
      LEFT JOIN strategies s ON s.id = oal."strategyId"
      ORDER BY oal."createdAt" DESC
      LIMIT ${limit}
    `;

    if (auditLogs.length > 0) {
      return auditLogs;
    }
  } catch (error) {
    console.warn('[portfolio-api] Raw audit log query failed, falling back.', error);
  }

  const auditLogs = await prisma.orderAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // Fetch strategy details for all logs
  const strategyIds = [...new Set(auditLogs.map(log => log.strategyId))];
  const strategies = await prisma.strategy.findMany({
    where: { id: { in: strategyIds } },
    select: { id: true, name: true, symbol: true },
  });

  const strategyMap = new Map(strategies.map(s => [s.id, s]));

  return auditLogs.map(log => {
    const strategy = strategyMap.get(log.strategyId);
    return {
      id: log.id,
      orderId: log.orderId,
      brokerOrderId: log.brokerOrderId,
      strategyId: log.strategyId,
      strategyName: strategy?.name || 'Unknown',
      symbol: strategy?.symbol || 'N/A',
      eventType: log.eventType,
      oldStatus: log.oldStatus,
      newStatus: log.newStatus,
      quantity: log.quantity,
      price: log.price,
      errorMessage: log.errorMessage,
      metadata: log.metadata,
      createdAt: log.createdAt,
    };
  });
};

// Get system logs
const getSystemLogs = async (params: {
  limit?: number;
  level?: string;
  component?: string;
  strategyId?: string;
  since?: string;
}) => {
  const { limit = 100, level, component, strategyId, since } = params;

  const where: any = {};
  if (level) where.level = level;
  if (component) where.component = component;
  if (strategyId) where.strategyId = strategyId;
  if (since) where.createdAt = { gte: new Date(since) };

  const logs = await prisma.systemLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return logs;
};

// Get log statistics
const getLogStats = async () => {
  const [byLevel, byComponent, recentErrors] = await Promise.all([
    prisma.systemLog.groupBy({
      by: ['level'],
      _count: true,
    }),
    prisma.systemLog.groupBy({
      by: ['component'],
      _count: true,
      orderBy: {
        _count: {
          component: 'desc',
        },
      },
      take: 10,
    }),
    prisma.systemLog.findMany({
      where: { level: 'ERROR' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        component: true,
        message: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    byLevel: byLevel.reduce((acc, item) => {
      acc[item.level] = item._count;
      return acc;
    }, {} as Record<string, number>),
    byComponent: byComponent.map((item) => ({
      component: item.component,
      count: item._count,
    })),
    recentErrors,
  };
};

// Request handler
const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  setCORSHeaders(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  console.log(`[portfolio-api] ${req.method} ${pathname}`);

  try {
    if (pathname === '/api/portfolio/overview') {
      const [pnlData, strategies, recentTrades, orderStats, auditTrail] = await Promise.all([
        calculatePnL(),
        getStrategyMetrics(),
        getRecentTrades(20),
        getOrderStats(),
        getAuditTrail(50),
      ]);

      sendJSON(res, {
        pnl: pnlData,
        strategies,
        recentTrades,
        orderStats,
        auditTrail,
        timestamp: new Date().toISOString(),
      });
    } else if (pathname === '/api/portfolio/positions') {
      const pnlData = await calculatePnL();
      sendJSON(res, {
        positions: pnlData.currentPositions,
        totalPositions: pnlData.totalPositions,
      });
    } else if (pathname === '/api/portfolio/strategies') {
      const strategies = await getStrategyMetrics();
      sendJSON(res, { strategies });
    } else if (pathname === '/api/portfolio/trades') {
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const trades = await getRecentTrades(limit);
      sendJSON(res, { trades });
    } else if (pathname === '/api/portfolio/stats') {
      const orderStats = await getOrderStats();
      sendJSON(res, { orderStats });
    } else if (pathname === '/api/logs') {
      // Get system logs with filters
      const params = {
        limit: parseInt(url.searchParams.get('limit') || '100', 10),
        level: url.searchParams.get('level') || undefined,
        component: url.searchParams.get('component') || undefined,
        strategyId: url.searchParams.get('strategyId') || undefined,
        since: url.searchParams.get('since') || undefined,
      };
      const logs = await getSystemLogs(params);
      sendJSON(res, { logs, count: logs.length });
    } else if (pathname === '/api/logs/stats') {
      // Get log statistics
      const stats = await getLogStats();
      sendJSON(res, { stats });
    } else if (pathname === '/health') {
      sendJSON(res, { status: 'ok', timestamp: new Date().toISOString() });
    } else {
      sendJSON(res, { error: 'Not Found' }, 404);
    }
  } catch (error: any) {
    console.error('[portfolio-api] Error:', error);
    sendJSON(res, { error: error.message || 'Internal Server Error' }, 500);
  }
};

// Start server
const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`[portfolio-api] Server running on http://localhost:${PORT}`);
  console.log(`[portfolio-api] Available endpoints:`);
  console.log(`  GET /api/portfolio/overview - Complete portfolio overview`);
  console.log(`  GET /api/portfolio/positions - Current positions`);
  console.log(`  GET /api/portfolio/strategies - Strategy performance metrics`);
  console.log(`  GET /api/portfolio/trades?limit=20 - Recent trades`);
  console.log(`  GET /api/portfolio/stats - Order statistics`);
  console.log(`  GET /api/logs - System logs (filters: limit, level, component, strategyId, since)`);
  console.log(`  GET /api/logs/stats - Log statistics`);
  console.log(`  GET /health - Health check`);
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('[portfolio-api] Shutting down...');
  await prisma.$disconnect();
  await pool.end();
  server.close();
  process.exit(0);
});
