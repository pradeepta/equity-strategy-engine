/**
 * Portfolio API Server
 * Simple HTTP server that exposes portfolio metrics for the web dashboard
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { BacktestEngine } from './backtest/BacktestEngine';
import { StrategyCompiler } from './compiler/compile';
import { getChatRepo, getRepositoryFactory } from './database/RepositoryFactory';
import { StrategyEvaluatorClient } from './evaluation/StrategyEvaluatorClient';
import { createStandardRegistry } from './features/registry';
import { generateDSLDocumentation } from './lib/dslDocGenerator';
import { generateImageKey, getStorageProvider } from './lib/storage';
import { BarCacheServiceV2 } from './live/cache/BarCacheServiceV2';

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

// Auto-swap service state
let autoSwapEnabled = false;
let autoSwapParallel = true; // Default to parallel mode
let autoSwapInterval: NodeJS.Timeout | null = null;
let isAutoSwapping = false; // Prevent overlapping executions
const MAX_CONCURRENT_EVALUATIONS = 5; // Process max 5 strategies at a time in parallel mode

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

  return await Promise.all(strategies.map(async strategy => {
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

    // Get runtime state from database (persisted by orchestrator on state transitions)
    const currentState = strategy.runtimeState || 'UNKNOWN';

    // Count open orders from database
    const openOrderCount = await prisma.order.count({
      where: {
        strategyId: strategy.id,
        status: { in: ['SUBMITTED', 'PENDING', 'PARTIALLY_FILLED'] },
      },
    });

    // Fetch open order details for display in UI
    const openOrders = await prisma.order.findMany({
      where: {
        strategyId: strategy.id,
        status: { in: ['SUBMITTED', 'PENDING', 'PARTIALLY_FILLED'] },
      },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true,
        brokerOrderId: true,
        planId: true,
        symbol: true,
        side: true,
        qty: true,
        type: true,
        limitPrice: true,
        stopPrice: true,
        status: true,
        submittedAt: true,
        errorMessage: true,
      },
    });

    return {
      id: strategy.id,
      name: strategy.name,
      symbol: strategy.symbol,
      status: strategy.status,
      currentState, // Runtime FSM state (IDLE, ARMED, PLACED, MANAGING, EXITED)
      timeframe: strategy.timeframe,
      totalTrades,
      wins,
      losses,
      winRate: parseFloat(winRate.toFixed(2)),
      totalPnL: parseFloat(totalPnL.toFixed(2)),
      openOrderCount, // Current open orders from runtime
      openOrders, // Open order details for UI display
      latestRecommendation: latestEvaluation?.recommendation || null,
      activatedAt: strategy.activatedAt,
      closedAt: strategy.closedAt,
      archivedAt: strategy.archivedAt,
      createdAt: strategy.createdAt,
      updatedAt: statusUpdatedAt,
      yamlContent: strategy.yamlContent,
    };
  }));
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

// Convert TradeCheck analysis to YAML strategy using Claude Code via AI Gateway
const convertTradeCheckToYAML = async (
  analysis: any,
  marketRegime: any,
  maxRisk: number = 350
): Promise<{ yaml: string; warnings: string[] }> => {

  const gatewayUrl = process.env.ACP_GATEWAY_URL || 'ws://localhost:8787/acp';
  const cwd = process.env.ACP_CWD || process.cwd();

  console.log(`[portfolio-api] Connecting to AI Gateway at ${gatewayUrl}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayUrl);
    let requestId = 1;
    let sessionId: string | null = null;
    let buffer = '';
    let responseText = '';
    const warnings: string[] = [];
    let hasReceivedAnyMessage = false;

    const timeout = setTimeout(() => {
      console.error('[portfolio-api] Timeout - hasReceivedAnyMessage:', hasReceivedAnyMessage);
      console.error('[portfolio-api] Timeout - responseText length:', responseText.length);
      ws.close();
      reject(new Error('AI Gateway timeout after 60 seconds'));
    }, 60000);

    ws.on('open', () => {
      console.log('[portfolio-api] AI Gateway WebSocket connected');

      // Send session/new request with persona
      const sessionNewMsg = {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'session/new',
        params: {
          cwd,
          persona: 'blackrock_advisor',  // Use the trading strategy persona
          mcpServers: [{
            name: 'stocks-mcp',
            type: 'stdio',
            command: 'node',
            args: [process.env.MCP_SERVER_PATH || './dist/mcp-server.js'],
            env: []
          }]
        }
      };

      console.log('[portfolio-api] Sending session/new with payload:', JSON.stringify(sessionNewMsg, null, 2));
      ws.send(JSON.stringify(sessionNewMsg));
    });

    ws.on('message', (data) => {
      hasReceivedAnyMessage = true;
      const dataStr = data.toString();
      console.log('[portfolio-api] Received message:', dataStr.substring(0, 500));

      buffer += dataStr;

      // Try to parse as complete JSON first (non-newline-delimited)
      try {
        const msg = JSON.parse(buffer);
        console.log('[portfolio-api] Parsed complete message:', JSON.stringify(msg, null, 2).substring(0, 500));
        buffer = ''; // Clear buffer on successful parse
        handleMessage(msg);
        return;
      } catch (e) {
        // Not a complete JSON object yet, try newline-delimited parsing
      }

      // Try to parse newline-delimited JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);
          console.log('[portfolio-api] Parsed line message:', JSON.stringify(msg, null, 2).substring(0, 500));
          handleMessage(msg);
        } catch (parseError) {
          // Ignore JSON parse errors for individual lines
        }
      }
    });

    function handleMessage(msg: any) {
      // Session created
      if (msg.result?.sessionId && !sessionId) {
        sessionId = msg.result.sessionId;
        console.log('[portfolio-api] Session created:', sessionId);

        // Send the prompt
        const userPrompt = `Convert this TradeCheck analysis to a valid trading strategy YAML.

Analysis Data:
${JSON.stringify({ analysis, marketRegime, maxRiskPerTrade: maxRisk }, null, 2)}

WORKFLOW (FOLLOW EXACTLY):
1. FIRST: Call get_dsl_schema tool to see the exact YAML schema
2. SECOND: Create the YAML strategy following the schema exactly
3. THIRD: Call compile_strategy tool with your YAML to validate it
4. FOURTH: If compilation fails, fix the errors and call compile_strategy again
5. FIFTH: Only after compilation succeeds, return the final YAML

YAML Requirements:
- timeframe: 5m
- qty: floor(${maxRisk} / abs(entry - stop))
- Features must have 'type' field (builtin/indicator)
- entryZone must be array format: [low, high]
- Use stopPrice (not stopLoss)
- Targets need ratioOfPosition field

OUTPUT FORMAT:
- Return ONLY the raw YAML that passed compile_strategy validation
- Start with "meta:" - nothing before it
- NO explanations, NO markdown fences
- Just the compiled YAML text`;

        const promptMsg = {
          jsonrpc: '2.0',
          id: requestId++,
          method: 'session/prompt',
          params: {
            sessionId,
            stream: true,
            prompt: [{ type: 'text', text: userPrompt }]
          }
        };

        console.log('[portfolio-api] Sending prompt');
        ws.send(JSON.stringify(promptMsg));
      }

      // Streaming update
      if (msg.method === 'session/update') {
        const update = msg.params?.update;
        const text = extractText(update?.textContent || update?.content);
        if (text) {
          responseText += text;
          console.log('[portfolio-api] Accumulated response length:', responseText.length);
        }
      }

      // Stop reason (done)
      if (msg.result?.stopReason) {
        console.log('[portfolio-api] Response complete, stopReason:', msg.result.stopReason);
        console.log('[portfolio-api] Full response text:\n', responseText);
        clearTimeout(timeout);
        ws.close();

        // Clean up response - extract YAML
        let yaml = responseText.trim();

        // Try to extract YAML starting with 'meta:' (preferred, since we asked for raw YAML)
        const yamlMatch = yaml.match(/(meta:[\s\S]+)/);
        if (yamlMatch) {
          yaml = yamlMatch[1].trim();
          console.log('[portfolio-api] Extracted YAML starting with meta:');
        } else {
          // Fallback: try code fences if Claude ignored instructions
          const yamlFenceMatch = yaml.match(/```ya?ml\n?([\s\S]+?)```/);
          if (yamlFenceMatch) {
            yaml = yamlFenceMatch[1].trim();
            console.log('[portfolio-api] Extracted YAML from code fence (fallback)');
          } else {
            // Last resort: clean up any markdown
            yaml = yaml.replace(/```ya?ml\n?/g, '').replace(/```\n?/g, '').trim();
            console.log('[portfolio-api] Using cleaned response text');
          }
        }

        // Validate compilation
        try {
          const registry = createStandardRegistry();
          const compiler = new StrategyCompiler(registry);
          compiler.compileFromYAML(yaml);
          console.log('[portfolio-api] YAML compilation successful');
        } catch (compileError: any) {
          console.error('[portfolio-api] YAML compilation failed:', compileError.message);
          reject(new Error(`YAML compilation failed: ${compileError.message}`));
          return;
        }

        resolve({ yaml, warnings });
      }

      // Error
      if (msg.error?.message) {
        console.error('[portfolio-api] AI Gateway error:', msg.error.message);
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`AI Gateway error: ${msg.error.message}`));
      }
    }

    ws.on('error', (error) => {
      console.error('[portfolio-api] WebSocket error:', error);
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${error.message}`));
    });

    ws.on('close', () => {
      console.log('[portfolio-api] WebSocket closed');
      clearTimeout(timeout);
    });

    // Helper to extract text from content
    function extractText(content: any): string | undefined {
      if (!content) return undefined;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .join('');
      }
      if (typeof content?.text === 'string') return content.text;
      return undefined;
    }
  });
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
// Helper: Process array in batches with concurrency limit
async function processBatch<T>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<any>
): Promise<PromiseSettledResult<any>[]> {
  const results: PromiseSettledResult<any>[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    console.log(`[auto-swap] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(items.length / batchSize)} (${batch.length} strategies)`);

    const batchResults = await Promise.allSettled(
      batch.map(item => processor(item))
    );

    results.push(...batchResults);

    // Small delay between batches to let other requests process
    if (i + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}

// Auto-swap execution function
async function executeAutoSwap() {
  if (isAutoSwapping) {
    console.log('[auto-swap] Skipping - previous cycle still in progress');
    return;
  }

  isAutoSwapping = true;
  console.log(`[auto-swap] Starting evaluation cycle (mode: ${autoSwapParallel ? 'parallel' : 'serial'})`);

  try {
    const factory = getRepositoryFactory();

    // Get all active strategies (across all users)
    const activeStrategies = await prisma.strategy.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
      },
      orderBy: { activatedAt: 'asc' },
    });

    if (activeStrategies.length === 0) {
      console.log('[auto-swap] No active strategies to evaluate');
      return;
    }

    console.log(`[auto-swap] Evaluating ${activeStrategies.length} active strategies...`);

    if (autoSwapParallel) {
      // Parallel mode: evaluate in batches to avoid overwhelming the server
      const results = await processBatch(
        activeStrategies,
        MAX_CONCURRENT_EVALUATIONS,
        evaluateAndSwapStrategy
      );

      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      console.log(`[auto-swap] Completed (parallel): ${succeeded} succeeded, ${failed} failed`);
    } else {
      // Serial mode: evaluate one at a time
      let succeeded = 0;
      let failed = 0;

      for (const strategy of activeStrategies) {
        try {
          await evaluateAndSwapStrategy(strategy);
          succeeded++;
        } catch (error: any) {
          console.error(`[auto-swap] Error evaluating ${strategy.name}:`, error.message);
          failed++;
        }
      }

      console.log(`[auto-swap] Completed (serial): ${succeeded} succeeded, ${failed} failed`);
    }
  } catch (error: any) {
    console.error('[auto-swap] Execution error:', error);
  } finally {
    isAutoSwapping = false;
  }
}

// Evaluate and swap a single strategy
async function evaluateAndSwapStrategy(strategy: any) {
  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  console.log(`[auto-swap] Evaluating ${strategy.name} (${strategy.symbol})`);

  try {
    // Get market data
    const barCache = getBarCacheService();
    const bars = await barCache.getBars(strategy.symbol, strategy.timeframe, 100);
    const latestBar = bars[bars.length - 1];

    // Build evaluation prompt
    const prompt = `Review this trading strategy and provide a recommendation.

**Strategy Details:**
- Name: ${strategy.name}
- Symbol: ${strategy.symbol}
- Timeframe: ${strategy.timeframe}
- Status: ${strategy.status}

**Strategy YAML:**
\`\`\`yaml
${strategy.yamlContent}
\`\`\`

**Current Market (Last 5 bars):**
${bars.slice(-5).map((bar: any, i: number) => `Bar ${i + 1}: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`).join('\n')}

Current Price: $${latestBar.close}

**Task:** Analyze and recommend CONTINUE or SWAP.

Use MCP tools:
- get_live_portfolio_snapshot()
- get_market_data("${strategy.symbol}", "${strategy.timeframe}", 100)
- get_sector_info("${strategy.symbol}")

**Response format:**

**Recommendation: [CONTINUE/SWAP]**

**Analysis:**
[Your analysis]

**YAML (if SWAP):**
\`\`\`yaml
[Complete replacement strategy]
\`\`\``;

    // Use StrategyEvaluatorClient
    const evalEndpoint = process.env.STRATEGY_EVAL_WS_ENDPOINT || 'ws://localhost:8787/acp';
    const evaluatorClient = new StrategyEvaluatorClient(evalEndpoint, true);

    await evaluatorClient.ensureConnection();
    const analysisText = await evaluatorClient.sendPrompt(prompt, 120000);

    // Parse recommendation
    const recommendationMatch = analysisText.match(/\*\*Recommendation:\s*(CONTINUE|SWAP)\*\*/i);

    if (!recommendationMatch) {
      console.warn(`[auto-swap] Could not parse recommendation for ${strategy.name}`);
      return;
    }

    const recommendation = recommendationMatch[1].toUpperCase();

    if (recommendation === 'SWAP') {
      // Extract YAML
      const yamlMatch = analysisText.match(/```yaml\n([\s\S]*?)\n```/);

      if (!yamlMatch) {
        console.error(`[auto-swap] No YAML found for ${strategy.name}`);
        return;
      }

      const newYaml = yamlMatch[1];

      console.log(`[auto-swap] Swapping ${strategy.name}...`);

      // Validate and compile new strategy
      const compiler = new StrategyCompiler(createStandardRegistry());
      const compiled = compiler.compileFromYAML(newYaml);

      // Create new strategy
      const newStrategy = await strategyRepo.createWithVersion({
        userId: strategy.userId,
        accountId: strategy.accountId,
        symbol: compiled.symbol,
        name: `${strategy.name} (Auto-swapped)`,
        timeframe: compiled.timeframe,
        yamlContent: newYaml,
        changeReason: 'Auto-swap (background evaluation)',
      });

      // Mark new strategy as PENDING
      await factory.getPrisma().strategy.update({
        where: { id: newStrategy.id },
        data: { status: 'PENDING' },
      });

      // Close old strategy
      await strategyRepo.close(strategy.id, 'Auto-swapped by background evaluator');

      console.log(`[auto-swap] Successfully swapped ${strategy.name} → ${newStrategy.id}`);
    } else {
      console.log(`[auto-swap] ${strategy.name}: CONTINUE (no swap needed)`);
    }
  } catch (error: any) {
    console.error(`[auto-swap] Error evaluating ${strategy.name}:`, error.message);
    throw error;
  }
}

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
    } else if (pathname === '/api/portfolio/tws-snapshot') {
      // GET /api/portfolio/tws-snapshot?force_refresh=true - Get live TWS portfolio snapshot
      const forceRefresh = url.searchParams.get('force_refresh') === 'true';

      try {
        const { PortfolioDataFetcher } = await import('./broker/twsPortfolio');
        const twsHost = process.env.TWS_HOST || '127.0.0.1';
        const twsPort = parseInt(process.env.TWS_PORT || '7497', 10);
        const clientId = 5; // Client ID 5 for dashboard portfolio queries

        const fetcher = new PortfolioDataFetcher(twsHost, twsPort, clientId);
        await fetcher.connect();
        const snapshot = await fetcher.getPortfolioSnapshot(forceRefresh);
        await fetcher.disconnect();

        sendJSON(res, {
          success: true,
          snapshot: {
            accountId: snapshot.accountId,
            totalValue: snapshot.totalValue,
            cash: snapshot.cash,
            buyingPower: snapshot.buyingPower,
            unrealizedPnL: snapshot.unrealizedPnL,
            realizedPnL: snapshot.realizedPnL,
            positions: snapshot.positions.map(pos => ({
              symbol: pos.symbol,
              quantity: pos.quantity,
              avgCost: pos.avgCost,
              currentPrice: pos.currentPrice,
              marketValue: pos.marketValue,
              unrealizedPnL: pos.unrealizedPnL,
            })),
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        console.error('[portfolio-api] Failed to fetch TWS snapshot:', error);
        sendJSON(res, {
          success: false,
          error: 'Failed to fetch TWS portfolio snapshot',
          message: error.message,
          note: 'Make sure TWS/IB Gateway is running and connected',
        }, 500);
      }
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
    } else if (pathname === '/api/portfolio/rejections') {
      // GET /api/portfolio/rejections?since=ISO_TIMESTAMP - Get recent rejected orders
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 5 * 60 * 1000); // Default: last 5 minutes

      try {
        // Query order_audit_log for REJECTED events
        const rejectedOrders = await prisma.orderAuditLog.findMany({
          where: {
            eventType: 'REJECTED',
            createdAt: { gte: since },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });

        // Fetch strategy details for each rejection
        const strategyIds = [...new Set(rejectedOrders.map(log => log.strategyId))];
        const strategies = await prisma.strategy.findMany({
          where: { id: { in: strategyIds } },
          select: { id: true, name: true, symbol: true },
        });

        const strategyMap = new Map(strategies.map(s => [s.id, s]));

        // Enrich rejections with strategy info
        const enrichedRejections = rejectedOrders.map(log => {
          const strategy = strategyMap.get(log.strategyId);
          return {
            id: log.id,
            orderId: log.orderId,
            brokerOrderId: log.brokerOrderId,
            strategyId: log.strategyId,
            strategyName: strategy?.name || 'Unknown',
            symbol: strategy?.symbol || 'N/A',
            errorMessage: log.errorMessage || 'Unknown reason',
            createdAt: log.createdAt,
            metadata: log.metadata,
          };
        });

        sendJSON(res, {
          rejections: enrichedRejections,
          count: enrichedRejections.length,
          since: since.toISOString(),
        });
      } catch (error: any) {
        console.error('[portfolio-api] Error fetching rejected orders:', error);
        sendJSON(res, { error: error.message || 'Failed to fetch rejected orders' }, 500);
      }
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
          limit,
          { forceRefresh: true } // Always get fresh data for chart
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
    } else if (pathname.startsWith('/api/portfolio/strategies/') && !pathname.endsWith('/close') && !pathname.endsWith('/reopen') && !pathname.endsWith('/force-deploy') && !pathname.endsWith('/backtest') && !pathname.endsWith('/bars') && !pathname.endsWith('/review') && !pathname.endsWith('/swap')) {
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
    } else if (pathname.startsWith('/api/portfolio/strategies/') && pathname.endsWith('/force-deploy')) {
      // POST /api/portfolio/strategies/:id/force-deploy
      if (req.method !== 'POST') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id/force-deploy
      const body = await parseBody(req);
      const reason = body.reason || '';

      // Validate reason is provided
      if (!reason.trim()) {
        sendJSON(res, { error: 'Reason is required' }, 400);
        return;
      }

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();
      const execHistoryRepo = factory.getExecutionHistoryRepo();

      let portfolioFetcher: any = null; // Declare outside try block for cleanup

      try {
        // 1. Get strategy and validate state
        const strategy = await prisma.strategy.findUnique({
          where: { id: strategyId },
        });

        if (!strategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        if (strategy.status !== 'ACTIVE') {
          sendJSON(res, { error: 'Only ACTIVE strategies can be force deployed' }, 400);
          return;
        }

        // 2. Validate that no orders have been placed yet (check DB)
        const openOrderCount = await prisma.order.count({
          where: {
            strategyId,
            status: { in: ['SUBMITTED', 'PENDING', 'PARTIALLY_FILLED'] },
          },
        });

        if (openOrderCount > 0) {
          sendJSON(res, {
            error: `Cannot force deploy - strategy already has ${openOrderCount} open order(s)`
          }, 400);
          return;
        }

        // 3. Compile strategy YAML to get IR and extract order plan
        const { StrategyCompiler } = await import('./compiler/compile');
        const { createStandardRegistry } = await import('./features/registry');
        const registry = createStandardRegistry();
        const compiler = new StrategyCompiler(registry);
        const ir = compiler.compileFromYAML(strategy.yamlContent);
        const armedTransition = ir.transitions.find(
          t => t.from === 'ARMED' && t.to === 'PLACED'
        );

        if (!armedTransition) {
          sendJSON(res, { error: 'No entry transition found in strategy' }, 400);
          return;
        }

        const submitAction = armedTransition.actions.find(
          a => a.type === 'submit_order_plan'
        );

        if (!submitAction || !submitAction.planId) {
          sendJSON(res, { error: 'No order plan found in entry transition' }, 400);
          return;
        }

        const orderPlan = ir.orderPlans.find(p => p.id === submitAction.planId);
        if (!orderPlan) {
          sendJSON(res, { error: 'Order plan not found in compiled IR' }, 400);
          return;
        }

        // 5. Fetch current bar data
        const barCache = getBarCacheService();
        const bars = await barCache.getBars(strategy.symbol, strategy.timeframe, 1);

        if (bars.length === 0) {
          sendJSON(res, { error: 'No market data available' }, 500);
          return;
        }

        const currentBar = bars[bars.length - 1];

        // 6. Fetch portfolio snapshot for position sizing
        const { PortfolioDataFetcher } = await import('./broker/twsPortfolio');
        portfolioFetcher = new PortfolioDataFetcher(
          process.env.TWS_HOST || '127.0.0.1',
          parseInt(process.env.TWS_PORT || '7497'),
          3 // Portfolio client ID
        );

        let portfolioSnapshot;
        try {
          await portfolioFetcher.connect();
          portfolioSnapshot = await portfolioFetcher.getPortfolioSnapshot(true); // Force refresh
          console.log('[portfolio-api] Portfolio snapshot fetched', {
            totalValue: portfolioSnapshot.totalValue,
            buyingPower: portfolioSnapshot.buyingPower,
          });
        } catch (error) {
          console.warn('[portfolio-api] Failed to fetch portfolio snapshot, continuing without position sizing', error);
        }

        // 7. Create broker adapter and environment (same config as orchestrator)
        const { TwsAdapter } = await import('./broker/twsAdapter');
        const twsHost = process.env.TWS_HOST || '127.0.0.1';
        const twsPort = parseInt(process.env.TWS_PORT || '7497');
        const twsClientId = 1; // Use different client ID from orchestrator (0)
        const brokerAdapter = new TwsAdapter(twsHost, twsPort, twsClientId);

        const brokerEnv = {
          accountId: process.env.TWS_ACCOUNT_ID || 'paper',
          dryRun: !(process.env.LIVE === 'true' || process.env.LIVE === '1'),
          allowLiveOrders: process.env.ALLOW_LIVE_ORDERS !== 'false',
          allowCancelEntries: process.env.ALLOW_CANCEL_ENTRIES === 'true',
          maxOrdersPerSymbol: process.env.MAX_ORDERS_PER_SYMBOL
            ? parseInt(process.env.MAX_ORDERS_PER_SYMBOL)
            : undefined,
          maxOrderQty: process.env.MAX_ORDER_QTY
            ? parseInt(process.env.MAX_ORDER_QTY)
            : undefined,
          maxNotionalPerSymbol: process.env.MAX_NOTIONAL_PER_SYMBOL
            ? parseFloat(process.env.MAX_NOTIONAL_PER_SYMBOL)
            : undefined,
          dailyLossLimit: process.env.DAILY_LOSS_LIMIT
            ? parseFloat(process.env.DAILY_LOSS_LIMIT)
            : undefined,
          // Dynamic position sizing configuration
          enableDynamicSizing: process.env.ENABLE_DYNAMIC_SIZING === 'true',
          buyingPowerFactor: process.env.BUYING_POWER_FACTOR
            ? parseFloat(process.env.BUYING_POWER_FACTOR)
            : 0.75,
          // Portfolio values from snapshot
          accountValue: portfolioSnapshot?.totalValue,
          buyingPower: portfolioSnapshot?.buyingPower,
        };

        // 7. Submit order plan via broker adapter
        const orders = await brokerAdapter.submitOrderPlan(
          orderPlan,
          brokerEnv
        );

        // 8. Persist orders to database (CRITICAL: prevents reconciliation from canceling them as orphans)
        const orderRepo = factory.getOrderRepo();
        for (const order of orders) {
          try {
            // Map broker order type (lowercase) to Prisma OrderType (uppercase)
            const orderType = order.type.toUpperCase() as 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

            const dbOrder = await orderRepo.create({
              strategyId,
              brokerOrderId: order.id,
              planId: orderPlan.id,
              symbol: order.symbol,
              side: order.side === 'buy' ? 'BUY' : 'SELL',
              qty: order.qty,
              type: orderType,
              limitPrice: order.limitPrice,
              stopPrice: order.stopPrice,
            });

            await orderRepo.createAuditLog({
              orderId: dbOrder.id,
              brokerOrderId: order.id,
              strategyId,
              eventType: 'SUBMITTED',
              newStatus: 'SUBMITTED',
              quantity: order.qty,
              metadata: {
                source: 'force_deploy',
                orderPlanId: orderPlan.id,
              },
            });
          } catch (error) {
            console.error(`Failed to persist order ${order.id} to database:`, error);
            // Continue with other orders - don't fail the entire operation
          }
        }

        // 9. Create audit logs
        const currentState = strategy.runtimeState || 'UNKNOWN';
        await strategyRepo.createForceDeployAudit({
          strategyId,
          changedBy: 'user', // TODO: Get actual user ID from auth
          reason,
          metadata: {
            currentState,
            currentPrice: currentBar.close,
            orderPlanId: orderPlan.id,
            barTimestamp: currentBar.timestamp,
          },
        });

        await execHistoryRepo.createForceEntry({
          strategyId,
          currentState,
          orderPlanId: orderPlan.id,
          currentPrice: currentBar.close,
          currentVolume: BigInt(currentBar.volume),
          barTimestamp: new Date(currentBar.timestamp),
          orderCount: orders.length,
          initiatedBy: 'user',
          reason,
        });

        console.log(`[portfolio-api] Force deployed strategy ${strategyId}: ${strategy.name} (${strategy.symbol}) - ${orders.length} orders submitted`);

        // Cleanup portfolio fetcher
        if (portfolioFetcher) {
          await portfolioFetcher.disconnect();
        }

        sendJSON(res, {
          success: true,
          strategy,
          ordersSubmitted: orders.length,
          message: `Force deployed ${orders.length} order(s) for ${strategy.name}`,
        });
      } catch (error: any) {
        console.error('[portfolio-api] Error force deploying strategy:', error);

        // Cleanup portfolio fetcher on error
        if (portfolioFetcher) {
          try {
            await portfolioFetcher.disconnect();
          } catch (cleanupError) {
            console.error('[portfolio-api] Error cleaning up portfolio fetcher:', cleanupError);
          }
        }

        sendJSON(res, { error: error.message || 'Failed to force deploy strategy' }, 500);
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
    } else if (pathname.startsWith('/api/portfolio/strategies/') && pathname.endsWith('/review')) {
      // POST /api/portfolio/strategies/:id/review - AI-powered strategy review
      if (req.method !== 'POST') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id/review

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();

      try {
        // Get strategy
        const strategy = await strategyRepo.findById(strategyId);

        if (!strategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        console.log(`[review] Starting AI review for strategy ${strategy.id} (${strategy.name})`);

        // Gather market data
        const barCache = getBarCacheService();
        const bars = await barCache.getBars(strategy.symbol, strategy.timeframe, 100);
        const latestBar = bars[bars.length - 1];

        // Build review prompt
        const prompt = `I need you to review this trading strategy and provide a recommendation.

**Strategy Details:**
- ID: ${strategy.id}
- Name: ${strategy.name}
- Symbol: ${strategy.symbol}
- Timeframe: ${strategy.timeframe}
- Status: ${strategy.status}
- Activated: ${strategy.activatedAt ? new Date(strategy.activatedAt).toLocaleString() : 'Not activated'}

**Strategy Configuration (YAML):**
\`\`\`yaml
${strategy.yamlContent}
\`\`\`

**Current Market Data (Last 5 bars):**
${bars.slice(-5).map((bar: any, i: number) => `Bar ${i + 1}: O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`).join('\n')}

Current Price: $${latestBar.close}

**Your Task:**
Analyze this strategy based on:
1. Current market trend and volatility (use the bar data provided)
2. Strategy parameters alignment with current conditions
3. Entry zone feasibility given current price
4. Risk/reward profile

**Use MCP tools for additional context:**
- get_live_portfolio_snapshot() - Check current portfolio state
- get_market_data("${strategy.symbol}", "${strategy.timeframe}", 100) - Analyze market conditions
- get_sector_info("${strategy.symbol}") - Understand sector context

**IMPORTANT: Provide a clear recommendation - CONTINUE or SWAP only (never recommend stopping)**
- **CONTINUE**: Strategy is well-aligned with current conditions and should keep running
- **SWAP**: Strategy needs improvement - provide a better replacement strategy with optimized parameters

**If the current strategy has ANY issues (misaligned entry zones, poor risk/reward, unfavorable market conditions, etc.), you MUST recommend SWAP and provide a complete replacement YAML.**

**Never recommend stopping the strategy. Always provide an alternative if the current one isn't optimal.**

**Format your response EXACTLY as:**

**Recommendation: [CONTINUE/SWAP]**

**Analysis:**
[Your detailed analysis here - explain trend, price action, and why this recommendation makes sense]

**YAML (if SWAP):**
\`\`\`yaml
[Complete replacement strategy YAML here - REQUIRED if recommending SWAP]
\`\`\`

Be concise but thorough. Focus on actionable insights. If swapping, ensure the new strategy addresses the specific issues you identified.`;

        // Use StrategyEvaluatorClient's WebSocket connection to ACP
        const evalEndpoint = process.env.STRATEGY_EVAL_WS_ENDPOINT || 'ws://localhost:8787/acp';
        const evaluatorClient = new StrategyEvaluatorClient(evalEndpoint, true);

        console.log('[review] Connecting to ACP gateway...');

        // Ensure WebSocket connection is established
        await evaluatorClient.ensureConnection();

        console.log('[review] Sending prompt to AI...');

        // Send prompt through ACP gateway (which has access to MCP tools)
        const analysisText = await evaluatorClient.sendPrompt(prompt, 120000); // 2 minute timeout

        console.log('[review] Received AI analysis');
        console.log(`[review] AI review completed for strategy ${strategy.id}`);

        sendJSON(res, {
          success: true,
          analysis: analysisText,
          prompt: prompt, // Also return the prompt so frontend can optionally send it
          strategy: {
            id: strategy.id,
            name: strategy.name,
            symbol: strategy.symbol,
          },
        });
      } catch (error: any) {
        console.error('[review] Error running AI review:', error);
        sendJSON(res, { error: error.message || 'Failed to run AI review' }, 500);
      }
    } else if (pathname.startsWith('/api/portfolio/strategies/') && pathname.endsWith('/swap')) {
      // POST /api/portfolio/strategies/:id/swap - Swap strategy with new YAML
      if (req.method !== 'POST') {
        sendJSON(res, { error: 'Method not allowed' }, 405);
        return;
      }

      const strategyId = pathname.split('/')[4]; // Extract ID from /api/portfolio/strategies/:id/swap
      const body = await parseBody(req);
      const { yamlContent, reason } = body;

      if (!yamlContent) {
        sendJSON(res, { error: 'yamlContent is required' }, 400);
        return;
      }

      const factory = getRepositoryFactory();
      const strategyRepo = factory.getStrategyRepo();

      try {
        // Get old strategy
        const oldStrategy = await strategyRepo.findById(strategyId);
        if (!oldStrategy) {
          sendJSON(res, { error: 'Strategy not found' }, 404);
          return;
        }

        console.log(`[swap] Starting manual swap for strategy ${strategyId} (${oldStrategy.name})`);

        // Validate new YAML compiles
        let compiled;
        try {
          const registry = createStandardRegistry();
          const compiler = new StrategyCompiler(registry);
          compiled = compiler.compileFromYAML(yamlContent);
          console.log(`[swap] New YAML validation successful for ${compiled.symbol}`);
        } catch (compileError: any) {
          console.error('[swap] YAML validation failed:', compileError.message);
          sendJSON(res, {
            success: false,
            error: `YAML validation failed: ${compileError.message}`
          }, 400);
          return;
        }

        // Create new strategy in database
        const newStrategy = await strategyRepo.createWithVersion({
          userId: oldStrategy.userId,
          symbol: compiled.symbol,
          name: `${oldStrategy.name} (Swapped)`,
          timeframe: compiled.timeframe,
          yamlContent: yamlContent,
          changeReason: reason || 'Manual swap via UI review',
        });

        console.log(`[swap] Created new strategy ${newStrategy.id}`);

        // Mark new strategy as PENDING so orchestrator picks it up
        await factory.getPrisma().strategy.update({
          where: { id: newStrategy.id },
          data: { status: 'PENDING' },
        });

        // Close old strategy
        await strategyRepo.close(
          oldStrategy.id,
          reason || 'Replaced with improved strategy via manual review',
          'user'
        );

        console.log(`[swap] Closed old strategy ${oldStrategy.id}, new strategy ${newStrategy.id} is PENDING`);

        sendJSON(res, {
          success: true,
          oldStrategyId: oldStrategy.id,
          newStrategyId: newStrategy.id,
          newStrategyName: newStrategy.name,
          symbol: newStrategy.symbol,
          status: 'PENDING',
          message: 'Strategy swap successful. New strategy will be activated automatically.'
        });

      } catch (error: any) {
        console.error('[swap] Error swapping strategy:', error);
        sendJSON(res, { error: error.message || 'Failed to swap strategy' }, 500);
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
      const factory = getRepositoryFactory();
      const prisma = factory.getPrisma();
      const chatRepo = getChatRepo();

      // Ensure user exists (create if missing)
      await prisma.user.upsert({
        where: { id: userId },
        update: {}, // No update needed if exists
        create: {
          id: userId,
          email: process.env.USER_EMAIL || `user-${userId}@example.com`,
          name: process.env.USER_NAME || 'Trading User',
        },
      });

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

    } else if (pathname === '/api/strategies/deploy' && req.method === 'POST') {
      // POST /api/strategies/deploy - Deploy YAML strategy directly (no conversion)
      try {
        const body = await parseBody(req);
        const { yaml, name, symbol } = body;

        if (!yaml) {
          sendJSON(res, { error: 'Missing required field: yaml' }, 400);
          return;
        }

        const userId = process.env.USER_ID;
        if (!userId) {
          sendJSON(res, { error: 'USER_ID not configured' }, 500);
          return;
        }

        console.log(`[portfolio-api] Deploying strategy: ${name || symbol}`);

        // Validate YAML compiles and extract metadata
        let compiled;
        try {
          const registry = createStandardRegistry();
          const compiler = new StrategyCompiler(registry);
          compiled = compiler.compileFromYAML(yaml);
          console.log(`[portfolio-api] YAML validation successful for ${compiled.symbol}`);
        } catch (compileError: any) {
          console.error('[portfolio-api] YAML validation failed:', compileError.message);
          sendJSON(res, {
            success: false,
            error: `YAML validation failed: ${compileError.message}`
          }, 400);
          return;
        }

        // Deploy to database
        const factory = getRepositoryFactory();
        const strategyRepo = factory.getStrategyRepo();

        const strategy = await strategyRepo.createWithVersion({
          userId,
          yamlContent: yaml,
          name: name || `Strategy ${compiled.symbol}`,
          symbol: symbol || compiled.symbol,
          timeframe: compiled.timeframe,
          changeReason: 'Deployed via API',
        });

        // Mark as PENDING so orchestrator will pick it up
        const updatedStrategy = await factory.getPrisma().strategy.update({
          where: { id: strategy.id },
          data: { status: 'PENDING' },
        });

        console.log(`[portfolio-api] Strategy deployed with ID: ${updatedStrategy.id}, status: ${updatedStrategy.status}`);

        sendJSON(res, {
          success: true,
          strategyId: updatedStrategy.id,
          strategyName: updatedStrategy.name,
          symbol: updatedStrategy.symbol,
          status: updatedStrategy.status,
          message: 'Strategy deployed successfully. Orchestrator will activate it automatically.'
        }, 201);

      } catch (error: any) {
        console.error('[portfolio-api] Error deploying strategy:', error);
        sendJSON(res, {
          success: false,
          error: error.message || 'Failed to deploy strategy'
        }, 500);
      }

    } else if (pathname === '/api/tradecheck/convert' && req.method === 'POST') {
      // POST /api/tradecheck/convert - Convert TradeCheck analysis to YAML strategy (no deployment)
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

      // Extract parameters outside try block for error handling
      const symbol = pathname.split('/')[3]; // Extract symbol from /api/chart-data/:symbol
      const startDate = url.searchParams.get('start_date');
      const endDate = url.searchParams.get('end_date');
      const period = url.searchParams.get('period') || '5m'; // Default to 5-minute bars
      const session = url.searchParams.get('session') as 'rth' | 'all' || 'rth'; // Default to rth
      const what = url.searchParams.get('what') as 'trades' | 'midpoint' | 'bid' | 'ask' || 'trades';

      try {

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
        console.error('[portfolio-api] Error fetching chart data for', symbol, error);

        // Return structured error with symbol info
        sendJSON(res, {
          error: error.message || 'Failed to fetch chart data',
          symbol: symbol.toUpperCase(),
          start_date: startDate,
          end_date: endDate,
          period,
          session,
          what,
          details: error.stack,
          suggestion: symbol.toUpperCase() === 'VIX'
            ? 'VIX might not be available as 5m bars. Try period=1d or check symbol format (^VIX, VX)'
            : 'Check if symbol exists and TWS has data for this period'
        }, 500);
      }

    } else if (pathname.match(/^\/api\/bars\/[^/]+$/) && req.method === 'GET') {
      // GET /api/bars/:symbol?limit=100&period=5m&session=rth&what=trades
      // Simple endpoint to fetch recent bars using BarCacheServiceV2
      // Returns most recent N bars for a symbol

      // Extract parameters outside try block for error handling
      const symbol = pathname.split('/')[3]; // Extract symbol from /api/bars/:symbol
      const limitParam = url.searchParams.get('limit');
      const period = url.searchParams.get('period') || '5m'; // Default to 5-minute bars
      const session = url.searchParams.get('session') as 'rth' | 'all' || 'rth'; // Default to rth
      const what = url.searchParams.get('what') as 'trades' | 'midpoint' | 'bid' | 'ask' || 'trades';
      const limit = limitParam ? parseInt(limitParam, 10) : 100;

      try {

        if (!symbol) {
          sendJSON(res, { error: 'Symbol is required' }, 400);
          return;
        }

        // Validate limit
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
        console.error('[portfolio-api] Error fetching bars for', symbol, error);

        // Return structured error with symbol info
        sendJSON(res, {
          error: error.message || 'Failed to fetch bars',
          symbol: symbol.toUpperCase(),
          period,
          session,
          what,
          limit,
          details: error.stack,
          suggestion: symbol.toUpperCase() === 'VIX'
            ? 'VIX might not be available as 5m bars. Try period=1d or check symbol format (^VIX, VX)'
            : 'Check if symbol exists and TWS has data for this period'
        }, 500);
      }

    } else if (pathname === '/api/portfolio/auto-swap/enable' && req.method === 'POST') {
      // Enable auto-swap with configuration
      const body = await parseBody(req);
      const parallel = body.parallel !== undefined ? body.parallel : true;

      autoSwapEnabled = true;
      autoSwapParallel = parallel;

      // Clear existing interval if any
      if (autoSwapInterval) {
        clearInterval(autoSwapInterval);
      }

      // Start new interval (every 30 minutes)
      autoSwapInterval = setInterval(executeAutoSwap, 30 * 60 * 1000);

      // Run immediately
      executeAutoSwap().catch(err => console.error('[auto-swap] Initial execution error:', err));

      console.log(`[auto-swap] Enabled (mode: ${parallel ? 'parallel' : 'serial'})`);

      sendJSON(res, {
        success: true,
        enabled: true,
        parallel,
        message: 'Auto-swap enabled',
      });
    } else if (pathname === '/api/portfolio/auto-swap/disable' && req.method === 'POST') {
      // Disable auto-swap
      autoSwapEnabled = false;

      if (autoSwapInterval) {
        clearInterval(autoSwapInterval);
        autoSwapInterval = null;
      }

      console.log('[auto-swap] Disabled');

      sendJSON(res, {
        success: true,
        enabled: false,
        message: 'Auto-swap disabled',
      });
    } else if (pathname === '/api/portfolio/auto-swap/status' && req.method === 'GET') {
      // Get auto-swap status
      sendJSON(res, {
        enabled: autoSwapEnabled,
        parallel: autoSwapParallel,
        isRunning: isAutoSwapping,
      });
    } else if (pathname === '/api/portfolio/auto-swap/execute' && req.method === 'POST') {
      // Manual trigger (for testing)
      if (isAutoSwapping) {
        sendJSON(res, {
          success: false,
          error: 'Auto-swap cycle already in progress',
        }, 409);
        return;
      }

      // Execute in background
      executeAutoSwap().catch(err => console.error('[auto-swap] Manual execution error:', err));

      sendJSON(res, {
        success: true,
        message: 'Auto-swap execution started',
      });
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
  console.log(`  GET /api/portfolio/tws-snapshot?force_refresh=true - Live TWS portfolio snapshot`);
  console.log(`  GET /api/portfolio/strategy-audit?limit=100 - Strategy audit logs`);
  console.log(`  GET /api/logs - System logs (filters: limit, level, component, strategyId, since)`);
  console.log(`  GET /api/logs/stats - Log statistics`);
  console.log(`  GET /api/portfolio/rejections?since=ISO_TIMESTAMP - Recent rejected orders`);
  console.log(`  Strategy Actions:`);
  console.log(`    POST /api/portfolio/strategies/:id/close - Close a strategy`);
  console.log(`    POST /api/portfolio/strategies/:id/reopen - Reopen a closed strategy`);
  console.log(`    POST /api/portfolio/strategies/:id/force-deploy - Force deploy pending strategy`);
  console.log(`    POST /api/portfolio/strategies/:id/backtest - Run backtest (last 180 bars)`);
  console.log(`    POST /api/portfolio/strategies/:id/review - Get AI review context data`);
  console.log(`  Market Data:`);
  console.log(`    GET /api/bars/:symbol?limit=100&period=5m&session=rth&what=trades - Fetch recent bars`);
  console.log(`    GET /api/chart-data/:symbol?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&period=5m - Fetch bars by date range`);
  console.log(`  DSL & TradeCheck:`);
  console.log(`    GET  /api/dsl/schema - Get DSL schema (dynamically from feature registry)`);
  console.log(`    POST /api/tradecheck/convert - Convert TradeCheck analysis to YAML strategy`);
  console.log(`    POST /api/tradecheck/analyze-and-convert - Fetch from TradeCheck + convert to YAML`);
  console.log(`  Auto-Swap (Background Service):`);
  console.log(`    POST /api/portfolio/auto-swap/enable - Enable auto-swap (body: {parallel: true/false})`);
  console.log(`    POST /api/portfolio/auto-swap/disable - Disable auto-swap`);
  console.log(`    GET  /api/portfolio/auto-swap/status - Get auto-swap status`);
  console.log(`    POST /api/portfolio/auto-swap/execute - Manual trigger (for testing)`);
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
