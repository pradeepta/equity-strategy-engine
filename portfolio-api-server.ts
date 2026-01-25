/**
 * Portfolio API Server
 * Simple HTTP server that exposes portfolio metrics for the web dashboard
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getRepositoryFactory, getChatRepo } from './database/RepositoryFactory';
import { BarCacheServiceV2 } from './live/cache/BarCacheServiceV2';
import { BacktestEngine } from './backtest/BacktestEngine';
import { getStorageProvider, generateImageKey } from './lib/storage';
import OpenAI from 'openai';
import { StrategyCompiler } from './compiler/compile';
import { createStandardRegistry } from './features/registry';
import { generateDSLDocumentation, generateConversionSystemPrompt } from './lib/dslDocGenerator';
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

let barCacheService: BarCacheServiceV2 | null = null;

function getBarCacheService(): BarCacheServiceV2 {
  if (!barCacheService) {
    const twsHost = process.env.TWS_HOST || "127.0.0.1";
    const twsPort = parseInt(process.env.TWS_PORT || "7497", 10);
    const twsClientId = parseInt(process.env.TWS_CLIENT_ID || "2000", 10) + Math.floor(Math.random() * 1000);

    barCacheService = new BarCacheServiceV2(
      pool,
      { host: twsHost, port: twsPort, clientId: twsClientId },
      {
        enabled: true,
        session: (process.env.BAR_CACHE_SESSION as 'rth' | 'all') || 'rth',
        what: (process.env.BAR_CACHE_WHAT as 'trades' | 'midpoint' | 'bid' | 'ask') || 'trades',
      }
    );
  }
  return barCacheService;
}

// Enable CORS for web client
const setCORSHeaders = (res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

// Helper to send JSON response
const sendJSON = (res: ServerResponse, data: any, status: number = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

// Helper to parse request body
const parseBody = (req: IncomingMessage): Promise<any> => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
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

// Convert TradeCheck analysis to YAML strategy using Claude
// DSL System Prompt is generated dynamically from the feature registry
const convertTradeCheckToYAML = async (
  analysis: any,
  marketRegime: any,
  maxRisk: number = 350
): Promise<{ yaml: string; warnings: string[] }> => {

  // Validate required Azure OpenAI environment variables
  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    throw new Error('AZURE_OPENAI_ENDPOINT not set in environment');
  }
  if (!process.env.AZURE_OPENAI_API_KEY) {
    throw new Error('AZURE_OPENAI_API_KEY not set in environment');
  }
  if (!process.env.AZURE_OPENAI_DEPLOYMENT) {
    throw new Error('AZURE_OPENAI_DEPLOYMENT not set in environment');
  }

  // Initialize Azure OpenAI client
  const client = new OpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
    defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview' },
    defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY }
  });

  // Build user prompt
  const userPrompt = `
Convert this TradeCheck analysis to valid YAML:

${JSON.stringify({ analysis, marketRegime, maxRiskPerTrade: maxRisk }, null, 2)}

Requirements:
- Use timeframe: 5m (5-minute bars)
- Calculate qty: floor(${maxRisk} / abs(entry - stop))
- Validate stop loss is on correct side of entry
- Validate targets are on correct side of entry
- Infer appropriate features from patterns and key_levels
- Create meaningful arm/trigger/invalidate rules
- Output ONLY YAML, no markdown or explanations
`;

  try {
    // Generate DSL system prompt dynamically from feature registry
    const dslSystemPrompt = generateConversionSystemPrompt();

    // Call Azure OpenAI API
    const response = await client.chat.completions.create({
      model: process.env.AZURE_OPENAI_DEPLOYMENT!,
      messages: [
        { role: 'system', content: dslSystemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_completion_tokens: 4096,
      temperature: 0.7
    });

    // Extract YAML from response
    let yaml = response.choices[0]?.message?.content || '';

    // Remove markdown code fences if present
    yaml = yaml.replace(/```ya?ml\n?/g, '').replace(/```\n?/g, '').trim();

    // Validate compilation
    const warnings: string[] = [];
    try {
      const registry = createStandardRegistry();
      const compiler = new StrategyCompiler(registry);
      compiler.compileFromYAML(yaml);
    } catch (compileError: any) {
      throw new Error(`YAML compilation failed: ${compileError.message}`);
    }

    return { yaml, warnings };

  } catch (error: any) {
    if (error.message?.includes('YAML compilation failed')) {
      throw error; // Re-throw compilation errors
    }
    throw new Error(`LLM conversion failed: ${error.message}`);
  }
};

// Fetch analysis from TradeCheck backend
const fetchTradeCheckAnalysis = async (
  symbol: string,
  timeframe: string = '5m',
  limit: number = 100
): Promise<{ market_regime: any; analyses: any[] }> => {
  const tradeCheckUrl = process.env.TRADECHECK_API_URL || 'http://localhost:8000';
  const url = `${tradeCheckUrl}/api/analyze`;

  // Calculate date range based on limit
  // For 5m bars: limit bars * 5 minutes
  // For 1d bars: limit days
  const endDate = new Date();
  const startDate = new Date();

  if (timeframe === '1d') {
    startDate.setDate(endDate.getDate() - limit);
  } else {
    // For intraday: approximate days needed (assuming 6.5 hour trading day = 390 minutes)
    const minutesPerBar = timeframe === '5m' ? 5 : timeframe === '15m' ? 15 : timeframe === '1h' ? 60 : 5;
    const daysNeeded = Math.ceil((limit * minutesPerBar) / 390) + 5; // Add buffer days
    startDate.setDate(endDate.getDate() - daysNeeded);
  }

  const requestBody = {
    tickers: [symbol],
    start_date: startDate.toISOString().split('T')[0],
    end_date: endDate.toISOString().split('T')[0],
    timeframe,
    limit
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TradeCheck API returned ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return data as { market_regime: any; analyses: any[] };
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
    } else if (pathname.startsWith('/api/portfolio/strategies/') && pathname.endsWith('/bars')) {
      // GET /api/portfolio/strategies/:id/bars - Get historical bars for chart from cache
      if (req.method !== 'GET') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id/bars
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();

      try {
        const strategy = await strategyRepo.findById(strategyId);

        if (!strategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        // Use BarCacheServiceV2 for consistent, gap-filled, up-to-date bars
        // This ensures web dashboard shows same data that strategies trade on
        // Gap detection and backfilling are now built-in
        const barCacheService = getBarCacheService();
        const cachedBars = await barCacheService.getBars(
          strategy.symbol,
          strategy.timeframe,
          limit
        );

        // Convert to API format (Bar already has correct structure, just format timestamp)
        const bars = cachedBars.map(bar => ({
          timestamp: new Date(bar.timestamp).toISOString(),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        }));

        sendJSON(res, {
          bars,
          symbol: strategy.symbol,
          timeframe: strategy.timeframe,
          count: bars.length,
          cached: true, // Indicate data is from cache
        });
      } catch (error: any) {
        console.error('[portfolio-api] Error fetching bars:', error);
        sendJSON(res, { error: error.message || 'Failed to fetch chart data' }, 500);
      }
    } else if (pathname.startsWith('/api/portfolio/strategies/') && !pathname.endsWith('/close') && !pathname.endsWith('/reopen') && !pathname.endsWith('/backtest') && !pathname.endsWith('/bars')) {
      // GET /api/portfolio/strategies/:id - Get single strategy details
      if (req.method !== 'GET') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();

      try {
        const strategy = await strategyRepo.findByIdWithRelations(strategyId);

        if (!strategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        sendJSON(res, { strategy });
      } catch (error: any) {
        console.error('[portfolio-api] Error fetching strategy details:', error);
        sendJSON(res, { error: error.message || 'Failed to fetch strategy details' }, 500);
      }
    } else if (pathname.startsWith('/api/portfolio/strategies/') && pathname.endsWith('/close')) {
      // POST /api/portfolio/strategies/:id/close
      if (req.method !== 'POST') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id/close
      const body = await parseBody(req);
      const reason = body.reason || 'Closed via UI';

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();
      const execHistoryRepo = factory.getExecutionHistoryRepo();

      try {
        // Get strategy
        const strategy = await strategyRepo.findById(strategyId);

        if (!strategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        if (strategy.status === 'CLOSED') {
          sendJSON(res, { error: 'Strategy is already closed' }, 400);
          return;
        }

        // Close strategy
        await strategyRepo.close(strategyId, reason);

        // Log deactivation
        await execHistoryRepo.logDeactivation(strategyId, reason);

        console.log(`[portfolio-api] Closed strategy ${strategyId}: ${strategy.name} (${strategy.symbol})`);

        sendJSON(res, {
          success: true,
          message: 'Strategy closed successfully',
          strategy: {
            id: strategyId,
            symbol: strategy.symbol,
            name: strategy.name,
            closedAt: new Date().toISOString(),
            closeReason: reason,
          },
        });
      } catch (error: any) {
        console.error('[portfolio-api] Error closing strategy:', error);
        sendJSON(res, { error: error.message || 'Failed to close strategy' }, 500);
      }
    } else if (pathname.startsWith('/api/portfolio/strategies/') && pathname.endsWith('/reopen')) {
      // POST /api/portfolio/strategies/:id/reopen
      if (req.method !== 'POST') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id/reopen
      const body = await parseBody(req);
      const reason = body.reason || 'Reopened via UI';

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();
      const execHistoryRepo = factory.getExecutionHistoryRepo();
      const operationQueue = factory.getOperationQueueService();

      try {
        // Get strategy
        const strategy = await strategyRepo.findById(strategyId);

        if (!strategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        if (strategy.status !== 'CLOSED') {
          sendJSON(res, { error: 'Only CLOSED strategies can be reopened' }, 400);
          return;
        }

        // Reopen strategy (sets to PENDING, orchestrator will pick it up)
        await strategyRepo.reopen(strategyId, reason, 'user');

        // Invalidate completed CLOSE operations to allow evaluator to close again if needed
        await operationQueue.invalidateCloseOperations(strategyId);

        // Log activation
        await execHistoryRepo.logActivation(strategyId);

        console.log(`[portfolio-api] Reopened strategy ${strategyId}: ${strategy.name} (${strategy.symbol})`);

        sendJSON(res, {
          success: true,
          message: 'Strategy reopened successfully and set to PENDING. Orchestrator will activate it.',
          strategy: {
            id: strategyId,
            symbol: strategy.symbol,
            name: strategy.name,
            status: 'PENDING',
            reopenedAt: new Date().toISOString(),
          },
        });
      } catch (error: any) {
        console.error('[portfolio-api] Error reopening strategy:', error);
        sendJSON(res, { error: error.message || 'Failed to reopen strategy' }, 500);
      }
    } else if (pathname === '/api/portfolio/strategy-audit') {
      // GET /api/portfolio/strategy-audit?limit=100
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();

      try {
        // Fetch audit logs
        const auditLogs = await strategyRepo.getAllAuditLogs(limit);

        // Fetch strategy details for each unique strategyId
        const uniqueStrategyIds = [...new Set(auditLogs.map((log: any) => log.strategyId))];
        const strategies = await Promise.all(
          uniqueStrategyIds.map((id: string) => strategyRepo.findById(id))
        );

        // Create a map of strategyId -> strategy
        const strategyMap = new Map();
        strategies.forEach((strategy: any) => {
          if (strategy) {
            strategyMap.set(strategy.id, {
              name: strategy.name,
              symbol: strategy.symbol,
              timeframe: strategy.timeframe,
            });
          }
        });

        // Enrich audit logs with strategy info
        const enrichedLogs = auditLogs.map((log: any) => ({
          ...log,
          strategy: strategyMap.get(log.strategyId) || null,
        }));

        sendJSON(res, {
          auditLogs: enrichedLogs,
          count: enrichedLogs.length,
        });
      } catch (error: any) {
        console.error('[portfolio-api] Error fetching strategy audit logs:', error);
        sendJSON(res, { error: error.message || 'Failed to fetch strategy audit logs' }, 500);
      }
    } else if (pathname.startsWith('/api/portfolio/strategies/') && pathname.endsWith('/backtest')) {
      // POST /api/portfolio/strategies/:id/backtest
      if (req.method !== 'POST') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id/backtest

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();

      try {
        // Get strategy
        const strategy = await strategyRepo.findById(strategyId);

        if (!strategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        // Parse timeframe to determine bar count (default 180 bars)
        const timeframe = strategy.timeframe || '5m';
        const barCount = 180;

        // Fetch historical bars via cache (DB → TWS fallback)
        const barCache = getBarCacheService();
        console.log(`[backtest] Fetching ${barCount} bars for ${strategy.symbol} @ ${timeframe}`);

        const bars = await barCache.getBars(strategy.symbol, timeframe, barCount);

        if (bars.length === 0) {
          sendJSON(res, { error: 'No historical data available' }, 500);
          return;
        }

        // Take last 180 bars
        const barsToTest = bars.slice(-barCount);

        console.log(`[backtest] Running backtest with ${barsToTest.length} bars`);

        // Run backtest
        const backtestEngine = new BacktestEngine();
        const result = await backtestEngine.runBacktestFromYAML(strategy.yamlContent, barsToTest);

        console.log(`[backtest] Backtest complete: ${result.totalTrades} trades, P&L: ${result.realizedPnL.toFixed(2)}`);

        sendJSON(res, {
          success: true,
          backtest: result,
        });
      } catch (error: any) {
        console.error('[backtest] Error running backtest:', error);
        sendJSON(res, { error: error.message || 'Failed to run backtest' }, 500);
      }
    // ============================================================================
    // CHAT HISTORY ENDPOINTS
    // ============================================================================
    } else if (pathname === '/api/chat/sessions' && req.method === 'GET') {
      // GET /api/chat/sessions?limit=50&offset=0
      const userId = process.env.USER_ID;
      if (!userId) {
        sendJSON(res, { error: 'USER_ID not configured' }, 500);
        return;
      }

      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);

      const chatRepo = getChatRepo();

      const [sessions, total] = await Promise.all([
        chatRepo.findSessionsByUser(userId, { limit, offset }),
        chatRepo.countUserSessions(userId),
      ]);

      sendJSON(res, { sessions, total });

    } else if (pathname === '/api/chat/sessions' && req.method === 'POST') {
      // POST /api/chat/sessions - Create new session
      const userId = process.env.USER_ID;
      if (!userId) {
        sendJSON(res, { error: 'USER_ID not configured' }, 500);
        return;
      }

      const body = await parseBody(req);
      const chatRepo = getChatRepo();

      const session = await chatRepo.createSession({
        userId,
        title: body.title,
        gatewaySessionId: body.gatewaySessionId,
        agentSessionId: body.agentSessionId,
        persona: body.persona,
      });

      sendJSON(res, { session }, 201);

    } else if (pathname.match(/^\/api\/chat\/sessions\/[^/]+$/) && req.method === 'GET') {
      // GET /api/chat/sessions/:id?includeMessages=true&messageLimit=500
      const sessionId = pathname.split('/')[4];
      const includeMessages = url.searchParams.get('includeMessages') === 'true';
      const messageLimit = parseInt(url.searchParams.get('messageLimit') || '500', 10);

      const chatRepo = getChatRepo();

      const session = includeMessages
        ? await chatRepo.getSessionWithMessages(sessionId, messageLimit)
        : await chatRepo.findSessionById(sessionId);

      if (!session) {
        sendJSON(res, { error: 'Session not found' }, 404);
        return;
      }

      sendJSON(res, { session });

    } else if (pathname.match(/^\/api\/chat\/sessions\/[^/]+$/) && req.method === 'PUT') {
      // PUT /api/chat/sessions/:id - Update session
      const sessionId = pathname.split('/')[4];
      const body = await parseBody(req);

      const chatRepo = getChatRepo();

      try {
        const session = await chatRepo.updateSession(sessionId, {
          title: body.title,
          gatewaySessionId: body.gatewaySessionId,
          agentSessionId: body.agentSessionId,
          isActive: body.isActive,
        });

        sendJSON(res, { session });
      } catch (error: any) {
        console.error('[portfolio-api] Error updating chat session:', error);
        sendJSON(res, { error: error.message || 'Failed to update session' }, 500);
      }

    } else if (pathname.match(/^\/api\/chat\/sessions\/[^/]+$/) && req.method === 'DELETE') {
      // DELETE /api/chat/sessions/:id - Soft delete session
      const sessionId = pathname.split('/')[4];

      const chatRepo = getChatRepo();

      try {
        await chatRepo.softDeleteSession(sessionId);
        sendJSON(res, { success: true });
      } catch (error: any) {
        console.error('[portfolio-api] Error deleting chat session:', error);
        sendJSON(res, { error: error.message || 'Failed to delete session' }, 500);
      }

    } else if (pathname.match(/^\/api\/chat\/sessions\/[^/]+\/messages$/) && req.method === 'POST') {
      // POST /api/chat/sessions/:id/messages - Add message
      const sessionId = pathname.split('/')[4];
      const body = await parseBody(req);

      if (!body.role || !body.content) {
        sendJSON(res, { error: 'role and content are required' }, 400);
        return;
      }

      const chatRepo = getChatRepo();
      const storage = getStorageProvider();

      try {
        // Create message first (without images)
        const message = await chatRepo.addMessage({
          chatSessionId: sessionId,
          role: body.role,
          content: body.content,
          imageUrls: [],
        });

        // Handle image uploads if any
        if (body.images?.length) {
          const imageUrls: string[] = [];

          for (let i = 0; i < body.images.length; i++) {
            const img = body.images[i];
            const buffer = Buffer.from(img.data, 'base64');
            const key = generateImageKey(sessionId, message.id, i, img.mimeType);
            const result = await storage.save(key, buffer, { mimeType: img.mimeType });
            imageUrls.push(result.url);
          }

          // Update message with image URLs
          await chatRepo.updateMessageImages(message.id, imageUrls);
          message.imageUrls = imageUrls;
        }

        sendJSON(res, { message }, 201);
      } catch (error: any) {
        console.error('[portfolio-api] Error adding chat message:', error);
        sendJSON(res, { error: error.message || 'Failed to add message' }, 500);
      }

    } else if (pathname === '/api/chat/search' && req.method === 'GET') {
      // GET /api/chat/search?q=search+query
      const userId = process.env.USER_ID;
      if (!userId) {
        sendJSON(res, { error: 'USER_ID not configured' }, 500);
        return;
      }

      const query = url.searchParams.get('q') || '';
      if (!query) {
        sendJSON(res, { error: 'Query parameter "q" is required' }, 400);
        return;
      }

      const chatRepo = getChatRepo();

      try {
        const results = await chatRepo.searchSessions(userId, query);
        sendJSON(res, { results, count: results.length });
      } catch (error: any) {
        console.error('[portfolio-api] Error searching chat sessions:', error);
        sendJSON(res, { error: error.message || 'Failed to search sessions' }, 500);
      }

    } else if (pathname.match(/^\/api\/chat\/images\/.*/) && req.method === 'GET') {
      // GET /api/chat/images/:sessionId/:filename - Serve stored images
      const imagePath = pathname.replace('/api/chat/images/', '');
      const storage = getStorageProvider();

      try {
        const data = await storage.get(imagePath);
        if (!data) {
          sendJSON(res, { error: 'Image not found' }, 404);
          return;
        }

        const metadata = await storage.getMetadata(imagePath);
        const mimeType = metadata?.mimeType || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': mimeType });
        res.end(data);
      } catch (error: any) {
        console.error('[portfolio-api] Error serving image:', error);
        sendJSON(res, { error: error.message || 'Failed to serve image' }, 500);
      }

    } else if (pathname === '/api/dsl/schema' && req.method === 'GET') {
      // GET /api/dsl/schema - Get DSL schema documentation (dynamically generated from feature registry)
      try {
        const dslDocs = generateDSLDocumentation();
        sendJSON(res, {
          success: true,
          schema: dslDocs,
          generatedAt: new Date().toISOString()
        });
      } catch (error: any) {
        console.error('[portfolio-api] Error generating DSL schema:', error);
        sendJSON(res, { error: error.message || 'Failed to generate DSL schema' }, 500);
      }

    } else if (pathname === '/api/tradecheck/convert' && req.method === 'POST') {
      // POST /api/tradecheck/convert - Convert TradeCheck analysis to YAML strategy
      try {
        const body = await parseBody(req);
        const { analysis, market_regime, max_risk_per_trade } = body;

        if (!analysis) {
          sendJSON(res, { error: 'Missing required field: analysis' }, 400);
          return;
        }

        if (!market_regime) {
          sendJSON(res, { error: 'Missing required field: market_regime' }, 400);
          return;
        }

        console.log(`[portfolio-api] Converting TradeCheck analysis for ${analysis.ticker}`);

        const result = await convertTradeCheckToYAML(
          analysis,
          market_regime,
          max_risk_per_trade || 350
        );

        sendJSON(res, {
          success: true,
          yaml: result.yaml,
          warnings: result.warnings,
          analysisId: analysis.id,
          ticker: analysis.ticker,
          setupType: analysis.setup_type
        });

      } catch (error: any) {
        console.error('[portfolio-api] Error converting TradeCheck analysis:', error);
        sendJSON(res, {
          success: false,
          error: error.message || 'Failed to convert analysis'
        }, 500);
      }

    } else if (pathname === '/api/tradecheck/analyze-and-convert' && req.method === 'POST') {
      // POST /api/tradecheck/analyze-and-convert - Fetch analysis from TradeCheck and convert to YAML
      try {
        const body = await parseBody(req);
        const { symbol, timeframe = '5m', limit = 100, max_risk_per_trade = 350 } = body;

        if (!symbol) {
          sendJSON(res, {
            success: false,
            error: 'Missing required field: symbol',
            step: 'validation'
          }, 400);
          return;
        }

        console.log(`[portfolio-api] Analyzing ${symbol} on ${timeframe}...`);

        // Step 1: Fetch analysis from TradeCheck
        let tradeCheckResponse;
        try {
          tradeCheckResponse = await fetchTradeCheckAnalysis(symbol, timeframe, limit);
        } catch (error: any) {
          console.error('[portfolio-api] TradeCheck fetch failed:', error);
          sendJSON(res, {
            success: false,
            error: `TradeCheck analysis failed: ${error.message}`,
            step: 'fetch_analysis'
          }, 500);
          return;
        }

        // Validate response has analyses
        if (!tradeCheckResponse.analyses || tradeCheckResponse.analyses.length === 0) {
          sendJSON(res, {
            success: false,
            error: 'No analyses returned from TradeCheck',
            step: 'fetch_analysis',
            tradeCheckResponse
          }, 400);
          return;
        }

        // Use first analysis (or could support selecting by confidence)
        const analysis = tradeCheckResponse.analyses[0];
        const market_regime = tradeCheckResponse.market_regime;

        console.log(`[portfolio-api] Converting analysis ${analysis.id} to YAML...`);

        // Step 2: Convert to YAML
        let conversionResult;
        try {
          conversionResult = await convertTradeCheckToYAML(
            analysis,
            market_regime,
            max_risk_per_trade
          );
        } catch (error: any) {
          console.error('[portfolio-api] YAML conversion failed:', error);
          sendJSON(res, {
            success: false,
            error: `YAML conversion failed: ${error.message}`,
            step: 'convert_yaml',
            analysis
          }, 500);
          return;
        }

        // Step 3: Return combined result
        sendJSON(res, {
          success: true,
          symbol,
          timeframe,
          analysisId: analysis.id,
          setupType: analysis.setup_type,
          confidence: analysis.confidence,
          analysis,
          market_regime,
          yaml: conversionResult.yaml,
          warnings: conversionResult.warnings,
          generatedAt: new Date().toISOString()
        });

      } catch (error: any) {
        console.error('[portfolio-api] Unexpected error:', error);
        sendJSON(res, {
          success: false,
          error: error.message || 'Unexpected error during analysis and conversion'
        }, 500);
      }

    } else if (pathname.match(/^\/api\/chart-data\/[^/]+$/) && req.method === 'GET') {
      // GET /api/chart-data/:symbol?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&period=5m
      // Returns historical OHLCV data compatible with TradeCheck backend format
      // Auto-fetches and caches missing data using BarCacheServiceV2
      try {
        const symbol = pathname.split('/')[3]; // Extract symbol from /api/chart-data/:symbol
        const startDate = url.searchParams.get('start_date');
        const endDate = url.searchParams.get('end_date');
        const period = url.searchParams.get('period') || '5m'; // Default to 5-minute bars
        const session = url.searchParams.get('session') as 'rth' | 'all' || 'rth'; // Default to rth
        const what = url.searchParams.get('what') as 'trades' | 'midpoint' | 'bid' | 'ask' || 'trades';

        if (!symbol) {
          sendJSON(res, { error: 'Symbol is required' }, 400);
          return;
        }

        if (!startDate || !endDate) {
          sendJSON(res, { error: 'start_date and end_date query parameters are required (format: YYYY-MM-DD)' }, 400);
          return;
        }

        // Convert dates to timestamps
        const startTimestamp = new Date(startDate + 'T00:00:00Z').getTime();
        const endTimestamp = new Date(endDate + 'T23:59:59.999Z').getTime();

        if (isNaN(startTimestamp) || isNaN(endTimestamp)) {
          sendJSON(res, { error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
          return;
        }

        // Calculate number of bars needed based on date range and period
        const daysDiff = Math.ceil((endTimestamp - startTimestamp) / (1000 * 60 * 60 * 24));
        let estimatedBars: number;

        // Estimate bars per day based on period (for RTH: 6.5 hours = 390 minutes per day)
        const minutesPerDay = session === 'rth' ? 390 : 1440; // RTH vs 24h
        switch (period) {
          case '5m':
            estimatedBars = Math.ceil((daysDiff * minutesPerDay) / 5);
            break;
          case '15m':
            estimatedBars = Math.ceil((daysDiff * minutesPerDay) / 15);
            break;
          case '1h':
            estimatedBars = Math.ceil((daysDiff * minutesPerDay) / 60);
            break;
          case '1d':
            estimatedBars = daysDiff;
            break;
          default:
            estimatedBars = 100; // Fallback
        }

        // Add buffer for safety (50% more)
        const limit = Math.ceil(estimatedBars * 1.5);

        console.log(`[portfolio-api] Fetching ${symbol} bars: ${period}, session=${session}, limit=${limit}, days=${daysDiff}`);

        // Use BarCacheServiceV2 to fetch (auto-caches if missing)
        const barCache = getBarCacheService();
        const cachedBars = await barCache.getBars(
          symbol.toUpperCase(),
          period,
          limit,
          { session, what }
        );

        console.log(`[portfolio-api] Retrieved ${cachedBars.length} bars for ${symbol}`);

        // Filter bars to requested date range and convert to TradeCheck format
        const bars = cachedBars
          .filter(bar => bar.timestamp >= startTimestamp && bar.timestamp <= endTimestamp)
          .map(bar => ({
            timestamp: bar.timestamp,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume
          }));

        sendJSON(res, {
          symbol: symbol.toUpperCase(),
          start_date: startDate,
          end_date: endDate,
          period,
          session,
          what,
          bar_count: bars.length,
          bars
        });

      } catch (error: any) {
        console.error('[portfolio-api] Error fetching chart data:', error);
        sendJSON(res, {
          error: error.message || 'Failed to fetch chart data',
          details: error.stack
        }, 500);
      }

    } else if (pathname.match(/^\/api\/bars\/[^/]+$/) && req.method === 'GET') {
      // GET /api/bars/:symbol?limit=100&period=5m&session=rth&what=trades
      // Simple endpoint to fetch recent bars using BarCacheServiceV2
      // Returns most recent N bars for a symbol
      try {
        const symbol = pathname.split('/')[3]; // Extract symbol from /api/bars/:symbol
        const limitParam = url.searchParams.get('limit');
        const period = url.searchParams.get('period') || '5m'; // Default to 5-minute bars
        const session = url.searchParams.get('session') as 'rth' | 'all' || 'rth'; // Default to rth
        const what = url.searchParams.get('what') as 'trades' | 'midpoint' | 'bid' | 'ask' || 'trades';

        if (!symbol) {
          sendJSON(res, { error: 'Symbol is required' }, 400);
          return;
        }

        // Parse and validate limit
        const limit = limitParam ? parseInt(limitParam, 10) : 100;
        if (isNaN(limit) || limit < 1 || limit > 5000) {
          sendJSON(res, { error: 'Invalid limit. Must be between 1 and 5000' }, 400);
          return;
        }

        // Validate period
        const validPeriods = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
        if (!validPeriods.includes(period)) {
          sendJSON(res, { error: `Invalid period. Must be one of: ${validPeriods.join(', ')}` }, 400);
          return;
        }

        console.log(`[portfolio-api] Fetching ${symbol} bars: limit=${limit}, period=${period}, session=${session}, what=${what}`);

        // Use BarCacheServiceV2 to fetch (auto-caches if missing)
        const barCache = getBarCacheService();
        const bars = await barCache.getBars(
          symbol.toUpperCase(),
          period,
          limit,
          { session, what }
        );

        console.log(`[portfolio-api] Retrieved ${bars.length} bars for ${symbol}`);

        // Calculate time range from bars
        const timeRange = bars.length > 0
          ? {
              start: new Date(bars[0].timestamp).toISOString(),
              end: new Date(bars[bars.length - 1].timestamp).toISOString()
            }
          : null;

        sendJSON(res, {
          symbol: symbol.toUpperCase(),
          period,
          session,
          what,
          limit,
          count: bars.length,
          timeRange,
          bars
        });

      } catch (error: any) {
        console.error('[portfolio-api] Error fetching bars:', error);
        sendJSON(res, {
          error: error.message || 'Failed to fetch bars',
          details: error.stack
        }, 500);
      }

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
  console.log(`  GET /api/portfolio/strategy-audit?limit=100 - Strategy audit logs`);
  console.log(`  GET /api/logs - System logs (filters: limit, level, component, strategyId, since)`);
  console.log(`  GET /api/logs/stats - Log statistics`);
  console.log(`  Market Data:`);
  console.log(`    GET /api/bars/:symbol?limit=100&period=5m&session=rth&what=trades - Fetch recent bars`);
  console.log(`    GET /api/chart-data/:symbol?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&period=5m - Fetch bars by date range`);
  console.log(`  DSL & TradeCheck:`);
  console.log(`    GET  /api/dsl/schema - Get DSL schema (dynamically from feature registry)`);
  console.log(`    POST /api/tradecheck/convert - Convert TradeCheck analysis to YAML strategy`);
  console.log(`    POST /api/tradecheck/analyze-and-convert - Fetch from TradeCheck + convert to YAML`);
  console.log(`  Chat History:`);
  console.log(`    GET  /api/chat/sessions - List chat sessions`);
  console.log(`    POST /api/chat/sessions - Create chat session`);
  console.log(`    GET  /api/chat/sessions/:id - Get session with messages`);
  console.log(`    PUT  /api/chat/sessions/:id - Update session`);
  console.log(`    DEL  /api/chat/sessions/:id - Delete session`);
  console.log(`    POST /api/chat/sessions/:id/messages - Add message`);
  console.log(`    GET  /api/chat/search?q=query - Search sessions`);
  console.log(`    GET  /api/chat/images/:path - Serve images`);
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
