#!/usr/bin/env node

/**
 * MCP Server for Algorithmic Trading System
 *
 * Exposes trading strategy compilation, backtesting, and execution capabilities
 * via Model Context Protocol (MCP).
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from multiple possible locations
// Try current directory first, then parent directory (for when running from dist/)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ============================================================================
// Winston File Logger (for stdio mode where stderr isn't visible)
// ============================================================================
import { Logger } from './logging/logger';

const mcpLogger = new Logger({
  component: 'MCP-Server',
  enableConsole: true,
  enableDatabase: false, // No DB for MCP server
  enableFile: true,
  logFilePath: path.join(process.cwd(), 'mcp-server.log'),
  logLevel: process.env.LOG_LEVEL || 'debug',
});

mcpLogger.info('MCP Server starting', { pid: process.pid, cwd: process.cwd() });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StrategyCompiler } from './compiler/compile';
import { StrategyEngine } from './runtime/engine';
import { createStandardRegistry } from './features/registry';
import { validateStrategyDSL } from './spec/schema';
import { getRepositoryFactory } from './database/RepositoryFactory';
import * as yaml from 'yaml';
import * as fs from 'fs';
import express from 'express';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Server Setup
// ============================================================================

function createServer(): Server {
  const server = new Server(
    {
      name: 'stocks-trading-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  registerHandlers(server);
  return server;
}

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS: Tool[] = [
  {
    name: 'compile_strategy',
    description: 'Compile a trading strategy from YAML DSL to type-safe intermediate representation (IR). Provide either yaml_content OR yaml_file_path.',
    inputSchema: {
      type: 'object',
      properties: {
        yaml_content: {
          type: 'string',
          description: 'YAML strategy definition (use this OR yaml_file_path)',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file (use this OR yaml_content)',
        },
      },
    },
  },
  {
    name: 'validate_strategy',
    description: 'Validate a trading strategy YAML against the schema. Provide either yaml_content OR yaml_file_path.',
    inputSchema: {
      type: 'object',
      properties: {
        yaml_content: {
          type: 'string',
          description: 'YAML strategy definition to validate (use this OR yaml_file_path)',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file (use this OR yaml_content)',
        },
      },
    },
  },
  {
    name: 'backtest_strategy',
    description: 'Backtest a compiled strategy against historical data. Provide: (compiled_ir OR yaml_content OR yaml_file_path) AND (historical_data OR data_file_path).',
    inputSchema: {
      type: 'object',
      properties: {
        compiled_ir: {
          type: 'object',
          description: 'Compiled strategy IR from compile_strategy (use this OR yaml_content OR yaml_file_path)',
        },
        yaml_content: {
          type: 'string',
          description: 'YAML strategy that will be compiled automatically (use this OR compiled_ir OR yaml_file_path)',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file that will be compiled automatically (use this OR compiled_ir OR yaml_content)',
        },
        historical_data: {
          type: 'array',
          description: 'Array of historical bar data with OHLCV fields (use this OR data_file_path)',
          items: {
            type: 'object',
            properties: {
              timestamp: { type: 'number' },
              open: { type: 'number' },
              high: { type: 'number' },
              low: { type: 'number' },
              close: { type: 'number' },
              volume: { type: 'number' },
            },
            required: ['timestamp', 'open', 'high', 'low', 'close', 'volume'],
          },
        },
        data_file_path: {
          type: 'string',
          description: 'Path to JSON file containing historical data (use this OR historical_data)',
        },
      },
    },
  },
  {
    name: 'list_strategy_types',
    description: 'List all available strategy types and indicators (RSI, MACD, Bollinger Bands, etc.)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_dsl_schema',
    description: 'Get the complete DSL schema documentation with all field definitions, types, and examples. Use this FIRST when creating strategies to understand the exact format required.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Optional: Get specific section (meta, features, rules, orderPlans, risk). If omitted, returns full schema.',
          enum: ['full', 'meta', 'features', 'rules', 'orderPlans', 'risk'],
        },
      },
    },
  },
  {
    name: 'get_strategy_template',
    description: 'Get a YAML template for a specific strategy type',
    inputSchema: {
      type: 'object',
      properties: {
        strategy_type: {
          type: 'string',
          description: 'Type of strategy (e.g., "rsi", "macd", "bollinger_bands")',
          enum: [
            'rsi',
            'macd',
            'bollinger_bands',
            'ema_crossover',
            'volume_breakout',
            'momentum',
            'mean_reversion',
          ],
        },
      },
      required: ['strategy_type'],
    },
  },
  {
    name: 'analyze_strategy_performance',
    description: 'Analyze backtest results and calculate performance metrics',
    inputSchema: {
      type: 'object',
      properties: {
        backtest_results: {
          type: 'object',
          description: 'Results from backtest_strategy tool',
        },
      },
      required: ['backtest_results'],
    },
  },
  {
    name: 'deploy_strategy',
    description: 'Deploy a strategy to the live trading system. Creates a database record with status PENDING so the orchestrator picks it up. User and account are automatically loaded from environment variables (USER_ID and TWS_ACCOUNT_ID). Account association is optional - if account does not exist in database, strategy will be created without account link.',
    inputSchema: {
      type: 'object',
      properties: {
        yaml_content: {
          type: 'string',
          description: 'YAML strategy content (use this OR yaml_file_path)',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file (use this OR yaml_content)',
        },
        user_id: {
          type: 'string',
          description: 'Optional: Override user ID (auto-loaded from USER_ID env or defaults to "default-user")',
        },
        account_id: {
          type: 'string',
          description: 'Optional: Override account ID (auto-loaded from TWS_ACCOUNT_ID env). If account does not exist, strategy will be created without account association.',
        },
      },
    },
  },
  {
    name: 'create_live_engine',
    description: 'Create a live trading engine instance for real-time execution (dry-run by default). Provide compiled_ir OR yaml_content OR yaml_file_path.',
    inputSchema: {
      type: 'object',
      properties: {
        compiled_ir: {
          type: 'object',
          description: 'Compiled strategy IR (use this OR yaml_content OR yaml_file_path)',
        },
        yaml_content: {
          type: 'string',
          description: 'YAML strategy that will be compiled automatically (use this OR compiled_ir OR yaml_file_path)',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file that will be compiled automatically (use this OR compiled_ir OR yaml_content)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Run in dry-run mode (no actual orders)',
          default: true,
        },
      },
    },
  },
  {
    name: 'get_portfolio_overview',
    description: 'Get current portfolio data including positions, active strategies, P&L, recent trades, and order statistics. Use this before deploying strategies to understand current portfolio state.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_market_data',
    description: 'Get recent market data (OHLCV bars) for a symbol. Use this to understand current market conditions before deploying a strategy.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading symbol (e.g., "AAPL", "GOOGL")',
        },
        timeframe: {
          type: 'string',
          description: 'Bar timeframe (e.g., "1m", "5m", "1h")',
          default: '5m',
        },
        limit: {
          type: 'number',
          description: 'Number of bars to fetch (default: 100)',
          default: 100,
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_active_strategies',
    description: 'Get list of currently active strategies with their symbols, timeframes, and performance metrics. Use this to check for conflicts before deploying.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_live_portfolio_snapshot',
    description: 'Get real-time portfolio snapshot from TWS broker including account value, cash, buying power, positions with current prices and unrealized P&L. This is the SAME data used by automated strategy swaps. Use this for deployment decisions requiring live portfolio context.',
    inputSchema: {
      type: 'object',
      properties: {
        force_refresh: {
          type: 'boolean',
          description: 'Force refresh (bypass 30s cache). Default: false',
          default: false,
        },
      },
    },
  },
  {
    name: 'get_sector_info',
    description: 'Get sector/industry classification for a symbol using TWS contract details. Returns industry, category, and subcategory information.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading symbol (e.g., "AAPL", "GOOGL")',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_sector_peers',
    description: 'Get peer stocks in the same sector as a reference symbol. Uses TWS to identify sector, then finds other stocks in that sector.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Reference trading symbol (e.g., "AAPL")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of peer stocks to return (default: 10)',
          default: 10,
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_portfolio_sector_concentration',
    description: 'Analyze sector concentration/diversification of current portfolio positions. Fetches live portfolio from TWS, maps each position to its sector, and calculates sector exposure percentages. Use this to assess portfolio risk and diversification before deploying new strategies.',
    inputSchema: {
      type: 'object',
      properties: {
        force_refresh: {
          type: 'boolean',
          description: 'Force refresh portfolio data (bypass 30s cache). Default: false',
          default: false,
        },
      },
    },
  },
  {
    name: 'propose_deterministic_strategy',
    description: 'Generate a deterministic trading strategy using quantitative metrics and hard risk gates (NO vibe trading). This tool: 1) Fetches market data, 2) Computes metrics (ATR, trend, range), 3) Generates candidates from multiple strategy families (breakout/bounce/reclaim), 4) Enforces hard gates (risk, R:R, entry distance), 5) Returns ranked strategies with YAML. Use this when you want a systematic, math-based strategy without subjective analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Trading symbol (e.g., "AAPL", "NVDA")',
        },
        timeframe: {
          type: 'string',
          description: 'Bar timeframe (default: "5m")',
          default: '5m',
        },
        limit: {
          type: 'number',
          description: 'Number of bars to fetch for analysis (default: 100, min: 50)',
          default: 100,
        },
        maxRiskPerTrade: {
          type: 'number',
          description: 'Maximum dollar risk per trade (used for position sizing)',
        },
        rrTarget: {
          type: 'number',
          description: 'Target risk:reward ratio (default: 3.0)',
          default: 3.0,
        },
        maxEntryDistancePct: {
          type: 'number',
          description: 'Maximum distance from current price to entry zone as percentage (default: 3.0)',
          default: 3.0,
        },
        entryTimeoutBars: {
          type: 'number',
          description: 'Number of bars before entry timeout (default: 10)',
          default: 10,
        },
        rthOnly: {
          type: 'boolean',
          description: 'Trade only during regular trading hours (default: true)',
          default: true,
        },
      },
      required: ['symbol', 'maxRiskPerTrade'],
    },
  },
];

// ============================================================================
// Tool Handlers
// ============================================================================

/**
 * Load YAML content from file or direct input
 */
function loadYamlContent(args: any): string {
  if (args.yaml_content) {
    return args.yaml_content;
  }
  if (args.yaml_file_path) {
    const filePath = path.resolve(args.yaml_file_path);
    return fs.readFileSync(filePath, 'utf-8');
  }
  throw new Error('Either yaml_content or yaml_file_path must be provided');
}

/**
 * Compile strategy handler
 */
async function handleCompileStrategy(args: any) {
  mcpLogger.info('compile_strategy - INPUT', {
    has_yaml_content: !!args.yaml_content,
    yaml_content_length: args.yaml_content?.length,
    yaml_file_path: args.yaml_file_path,
  });

  const yamlContent = loadYamlContent(args);

  // Compile
  const registry = createStandardRegistry();
  const compiler = new StrategyCompiler(registry);

  try {
    const compiled = compiler.compileFromYAML(yamlContent);
    const result = {
      success: true,
      compiled_ir: compiled,
      metadata: {
        strategy_name: compiled.symbol,
        symbol: compiled.symbol,
        timeframe: compiled.timeframe,
        features_count: compiled.featurePlan.length,
        transitions_count: compiled.transitions.length,
        order_plans_count: compiled.orderPlans.length,
      },
    };
    mcpLogger.info('compile_strategy - OUTPUT', {
      success: true,
      symbol: compiled.symbol,
      timeframe: compiled.timeframe,
      features_count: compiled.featurePlan.length,
    });
    return result;
  } catch (error: any) {
    const result = {
      success: false,
      error: 'Compilation failed',
      message: error.message,
      stack: error.stack,
    };
    mcpLogger.error('compile_strategy - ERROR', error, {
      success: false,
    });
    return result;
  }
}

/**
 * Validate strategy handler
 */
async function handleValidateStrategy(args: any) {
  const yamlContent = loadYamlContent(args);
  const dsl = yaml.parse(yamlContent);

  try {
    const validated = validateStrategyDSL(dsl);
    return {
      valid: true,
      message: 'Strategy is valid',
      strategy: {
        name: validated.meta.name,
        symbol: validated.meta.symbol,
        timeframe: validated.meta.timeframe,
        features: validated.features.length,
        order_plans: validated.orderPlans.length,
      },
    };
  } catch (error: any) {
    // Zod validation error
    if (error.errors) {
      return {
        valid: false,
        error: 'Validation failed',
        issues: error.errors.map((issue: any) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      };
    }
    return {
      valid: false,
      error: 'Validation failed',
      message: error.message,
    };
  }
}

/**
 * Backtest strategy handler
 */
async function handleBacktestStrategy(args: any) {
  // Compile strategy if needed
  let compiled = args.compiled_ir;
  if (!compiled) {
    const compileResult = await handleCompileStrategy(args);
    if (!compileResult.success || !('compiled_ir' in compileResult)) {
      return compileResult;
    }
    compiled = compileResult.compiled_ir;
  }

  // Load historical data
  let historicalData = args.historical_data;
  if (!historicalData && args.data_file_path) {
    const dataPath = path.resolve(args.data_file_path);
    historicalData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  }

  if (!historicalData || !Array.isArray(historicalData)) {
    return {
      success: false,
      error: 'Invalid historical data',
    };
  }

  // Create mock broker adapter for backtesting
  const mockBroker = {
    async submitOrderPlan(plan: any, _env: any) {
      return [{
        id: `order_${Date.now()}`,
        planId: plan.id,
        symbol: plan.symbol,
        side: plan.side,
        qty: plan.qty,
        type: 'market' as const,
        status: 'filled' as const,
        filledQty: plan.qty,
        filledPrice: plan.targetEntryPrice,
      }];
    },
    async submitMarketOrder(
      symbol: string,
      qty: number,
      side: 'buy' | 'sell',
      _env: any
    ) {
      return {
        id: `order_${Date.now()}`,
        planId: `market-exit-${Date.now()}`,
        symbol,
        side,
        qty,
        type: 'market' as const,
        status: 'filled' as const,
        filledQty: qty,
        filledPrice: 0,
      };
    },
    async cancelOpenEntries(_symbol: string, _orders: any[], _env: any) {
      return {
        succeeded: [],
        failed: [],
      };
    },
    async getOpenOrders(_symbol: string, _env: any) {
      return [];
    },
  };

  const brokerEnv = {
    dryRun: true,
    paperTrading: true,
  };

  // Create engine and run backtest
  const registry = createStandardRegistry();
  const engine = new StrategyEngine(compiled, registry, mockBroker, brokerEnv);

  const results: any[] = [];
  const stateLogs: any[] = [];

  try {
    for (const bar of historicalData) {
      await engine.processBar(bar);
      const state = engine.getState();

      results.push({
        timestamp: bar.timestamp,
        state: state.currentState,
        features: Object.fromEntries(state.features),
      });

      // Log state transitions
      if (state.log.length > 0) {
        const recentLogs = state.log.slice(-5); // Last 5 logs
        stateLogs.push({
          timestamp: bar.timestamp,
          state: state.currentState,
          logs: recentLogs,
          features: Object.fromEntries(state.features),
        });
      }
    }

    const finalState = engine.getState();

    return {
      success: true,
      results: {
        total_bars: historicalData.length,
        state_transitions: stateLogs.length,
        final_state: finalState.currentState,
        detailed_logs: stateLogs,
        summary: results,
        all_logs: finalState.log,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      error: 'Backtest execution failed',
      message: error.message,
      stack: error.stack,
    };
  }
}

/**
 * List strategy types handler
 */
async function handleListStrategyTypes() {
  return {
    strategy_types: [
      {
        name: 'RSI',
        description: 'Relative Strength Index - momentum oscillator',
        indicators: ['rsi'],
        typical_params: { period: 14, overbought: 70, oversold: 30 },
      },
      {
        name: 'MACD',
        description: 'Moving Average Convergence Divergence',
        indicators: ['macd', 'macd_signal', 'macd_histogram'],
        typical_params: { fast: 12, slow: 26, signal: 9 },
      },
      {
        name: 'Bollinger Bands',
        description: 'Volatility bands around moving average',
        indicators: ['bb_upper', 'bb_middle', 'bb_lower'],
        typical_params: { period: 20, std_dev: 2 },
      },
      {
        name: 'EMA Crossover',
        description: 'Exponential Moving Average crossover strategy',
        indicators: ['ema_fast', 'ema_slow'],
        typical_params: { fast_period: 9, slow_period: 21 },
      },
      {
        name: 'Volume Breakout',
        description: 'Volume-based breakout detection',
        indicators: ['volume', 'avg_volume', 'volume_ratio'],
        typical_params: { volume_threshold: 1.5, lookback: 20 },
      },
      {
        name: 'Momentum',
        description: 'Rate of change momentum indicator',
        indicators: ['momentum', 'roc'],
        typical_params: { period: 14 },
      },
      {
        name: 'Mean Reversion',
        description: 'Price reversion to mean',
        indicators: ['sma', 'price_distance', 'z_score'],
        typical_params: { period: 20, threshold: 2 },
      },
    ],
    available_features: [
      'VWAP', 'EMA', 'SMA', 'RSI', 'MACD', 'Bollinger Bands',
      'Volume Z-Score', 'Delta', 'Absorption', 'LOD (Limit Order Depth)',
      '52-Week High/Low', 'Cup & Handle Pattern',
    ],
  };
}

/**
 * Get strategy template handler
 */
async function handleGetStrategyTemplate(args: any) {
  const templates: Record<string, string> = {
    rsi: `name: "RSI Strategy"
description: "Buy oversold, sell overbought"
symbols: ["AAPL"]

features:
  rsi:
    type: rsi
    params:
      period: 14

states:
  watching:
    entry:
      - log: "Watching for RSI signals"
    transitions:
      - to: buy_signal
        when: "rsi < 30"

  buy_signal:
    entry:
      - log: "RSI oversold - buy signal"
    order_plan:
      side: buy
      qty: 100
      stop_loss_percent: 2
      take_profit_percent: 5
    transitions:
      - to: watching
        when: "rsi > 70"
`,
    macd: `name: "MACD Strategy"
description: "MACD crossover strategy"
symbols: ["AAPL"]

features:
  macd:
    type: macd
    params:
      fast: 12
      slow: 26
      signal: 9

states:
  watching:
    transitions:
      - to: long_signal
        when: "macd > macd_signal"
      - to: short_signal
        when: "macd < macd_signal"

  long_signal:
    order_plan:
      side: buy
      qty: 100
      stop_loss_percent: 2
      take_profit_percent: 4
    transitions:
      - to: watching
        when: "macd < macd_signal"
`,
    bollinger_bands: `name: "Bollinger Bands Strategy"
description: "Mean reversion with Bollinger Bands"
symbols: ["AAPL"]

features:
  bb_upper:
    type: bb_upper
    params:
      period: 20
      std_dev: 2
  bb_lower:
    type: bb_lower
    params:
      period: 20
      std_dev: 2

states:
  watching:
    transitions:
      - to: oversold
        when: "close < bb_lower"
      - to: overbought
        when: "close > bb_upper"

  oversold:
    order_plan:
      side: buy
      qty: 100
      take_profit_percent: 3
    transitions:
      - to: watching
        when: "close > bb_lower"
`,
  };

  const template = templates[args.strategy_type];
  if (!template) {
    return {
      success: false,
      error: `Unknown strategy type: ${args.strategy_type}`,
      available_types: Object.keys(templates),
    };
  }

  return {
    success: true,
    strategy_type: args.strategy_type,
    yaml_template: template,
  };
}

/**
 * Get DSL schema documentation handler
 */
async function handleGetDSLSchema(args: any) {
  const section = args.section || 'full';

  const schemaDocs = {
    full: `# Trading Strategy DSL Schema

## Complete Structure

\`\`\`yaml
meta:
  name: string            # Strategy name
  symbol: string          # Trading symbol (e.g., "AAPL", "GOOGL")
  timeframe: string       # Bar timeframe (e.g., "1m", "5m", "1h", "1d")
  description: string     # Optional description

features:                 # Array of features (indicators, built-ins, microstructure)
  - name: string          # Unique feature name
    type: builtin|indicator|microstructure
    params:               # Optional parameters (specific to feature type)
      key: value

rules:
  arm: string            # Optional: Expression to arm (enable) the strategy
  trigger: string        # Optional: Expression that triggers order execution
  invalidate:            # Optional: Conditions to invalidate armed state
    when_any:
      - string           # Array of invalidation expressions

orderPlans:              # Array of order plans
  - name: string         # Order plan name
    side: buy|sell       # Order side
    entryZone:           # Entry price zone [min, max]
      - number
      - number
    qty: number          # Quantity (positive number)
    stopPrice: number    # Stop loss price
    targets:             # Array of profit targets
      - price: number
        ratioOfPosition: number  # Ratio of position (0-1)

execution:               # Optional execution settings
  entryTimeoutBars: number     # Bars to wait before timeout (default: 10)
  rthOnly: boolean             # Regular trading hours only (default: false)

risk:
  maxRiskPerTrade: number      # Maximum risk per trade (positive number)
\`\`\`

## Field Details

### meta
- **name**: Human-readable strategy name
- **symbol**: Stock symbol to trade
- **timeframe**: Candle period - "1m", "5m", "15m", "30m", "1h", "4h", "1d"
- **description**: Optional strategy description

### features
Array of features that calculate indicators or extract data:
- **name**: Unique identifier used in expressions
- **type**:
  - \`builtin\`: Built-in features (close, open, high, low, volume, timestamp, dayOfWeek, hour, minute)
  - \`indicator\`: Technical indicators (rsi, macd, ema, sma, bbands, atr, adx, etc.)
  - \`microstructure\`: Market microstructure features
- **params**: Type-specific parameters (e.g., \`period: 14\` for RSI)

### rules
State machine rules:
- **arm**: Expression that enables the strategy (e.g., \`rsi < 30\`)
- **trigger**: Expression that fires orders (e.g., \`close > ema20\`)
- **invalidate.when_any**: Array of expressions that disable armed state

### orderPlans
- **name**: Descriptive name for the order
- **side**: "buy" or "sell"
- **entryZone**: [minPrice, maxPrice] - acceptable entry range
- **qty**: Number of shares
- **stopPrice**: Stop loss price
- **targets**: Array of profit targets with price and position ratio

### execution (optional)
- **entryTimeoutBars**: How many bars to wait before canceling entry (default: 10)
- **rthOnly**: Only trade during regular trading hours (default: false)

### risk
- **maxRiskPerTrade**: Maximum $ risk per trade

## Example Strategy

\`\`\`yaml
meta:
  name: "RSI Mean Reversion"
  symbol: "AAPL"
  timeframe: "5m"
  description: "Buy oversold, sell overbought"

features:
  - name: rsi
    type: indicator
    params:
      period: 14
  - name: ema20
    type: indicator
    params:
      period: 20

rules:
  arm: "rsi < 30"
  trigger: "close > ema20"
  invalidate:
    when_any:
      - "rsi > 70"

orderPlans:
  - name: "long_entry"
    side: buy
    entryZone: [99, 101]
    qty: 100
    stopPrice: 95
    targets:
      - price: 105
        ratioOfPosition: 0.5
      - price: 110
        ratioOfPosition: 0.5

risk:
  maxRiskPerTrade: 500
\`\`\``,

    meta: `### meta Section
\`\`\`yaml
meta:
  name: string            # Strategy name
  symbol: string          # Trading symbol
  timeframe: string       # Bar timeframe
  description: string     # Optional
\`\`\`

Timeframe values: "1m", "5m", "15m", "30m", "1h", "4h", "1d"`,

    features: `### features Section

**IMPORTANT**: Features are pre-registered with fixed names. Use the exact feature names below.

\`\`\`yaml
features:
  - name: <feature_name>  # Use exact name from list below
\`\`\`

**Available Features** (use exact names):

**Built-in OHLCV**:
- close, open, high, low, volume, price

**Indicators**:
- rsi (14-period RSI)
- macd, macd_signal, macd_histogram (12,26,9 MACD)
- ema20, ema50 (20 and 50-period EMAs)
- sma50, sma150, sma200 (50, 150, 200-period SMAs)
- sma50_rising, sma150_rising, sma200_rising (trend detection)
- bb_upper, bb_middle, bb_lower (Bollinger Bands)
- vwap (Volume Weighted Average Price)

**Momentum & Oscillators**:
- stochastic_k, stochastic_d (Stochastic Oscillator 14-period)
- cci (Commodity Channel Index 20-period)
- williams_r (Williams %R 14-period)

**Volatility & Range**:
- atr (Average True Range 14-period)

**Trend Strength**:
- adx (Average Directional Index 14-period)

**Volume Indicators**:
- volume_zscore (Z-score of volume vs historical average)
- volume_sma (20-period Simple Moving Average of volume)
- volume_ema (20-period Exponential Moving Average of volume)
- obv (On Balance Volume)

**Price Levels**:
- lod, hod (Low/High of Day)
- fifty_two_week_high, fifty_two_week_low

**Pattern Recognition**:
- cup_handle_confidence (Cup & Handle pattern score 0-100)

**Microstructure**:
- delta, absorption

**Example** (use exact feature names):
\`\`\`yaml
features:
  - name: rsi          # 14-period RSI
  - name: ema20        # 20-period EMA
  - name: ema50        # 50-period EMA
  - name: atr          # 14-period ATR
  - name: adx          # 14-period ADX
  - name: volume_sma   # 20-period volume SMA
  - name: stochastic_k # Stochastic %K
\`\`\``,

    rules: `### rules Section
\`\`\`yaml
rules:
  arm: string            # Expression to arm strategy
  trigger: string        # Expression to trigger orders
  invalidate:
    when_any:
      - string          # Invalidation conditions
\`\`\`

Expressions use feature names and operators:
- Comparisons: <, >, <=, >=, ==, !=
- Logic: &&, ||, !
- Math: +, -, *, /, %

**Example**:
\`\`\`yaml
rules:
  arm: "rsi < 30 && close > ema20"
  trigger: "close > open"
  invalidate:
    when_any:
      - "rsi > 70"
      - "close < ema20"
\`\`\``,

    orderPlans: `### orderPlans Section
\`\`\`yaml
orderPlans:
  - name: string
    side: buy|sell
    entryZone: [number, number]
    qty: number
    stopPrice: number
    targets:
      - price: number
        ratioOfPosition: number
\`\`\`

**Example**:
\`\`\`yaml
orderPlans:
  - name: "long_position"
    side: buy
    entryZone: [100, 102]
    qty: 100
    stopPrice: 95
    targets:
      - price: 110
        ratioOfPosition: 0.5
      - price: 115
        ratioOfPosition: 0.5
\`\`\``,

    risk: `### risk Section
\`\`\`yaml
risk:
  maxRiskPerTrade: number  # Maximum $ risk per trade
\`\`\`

**Example**:
\`\`\`yaml
risk:
  maxRiskPerTrade: 500  # Risk max $500 per trade
\`\`\``
  };

  const doc = schemaDocs[section as keyof typeof schemaDocs] || schemaDocs.full;

  return {
    success: true,
    section,
    documentation: doc,
    available_sections: Object.keys(schemaDocs),
  };
}

/**
 * Analyze performance handler
 */
async function handleAnalyzePerformance(args: any) {
  const results = args.backtest_results;

  if (!results || !results.detailed_logs) {
    return {
      success: false,
      error: 'Invalid backtest results',
    };
  }

  const logs = results.detailed_logs;
  const buyOrders = logs.flatMap((log: any) =>
    log.orders.filter((o: any) => o.side === 'buy')
  );
  const sellOrders = logs.flatMap((log: any) =>
    log.orders.filter((o: any) => o.side === 'sell')
  );

  return {
    success: true,
    metrics: {
      total_signals: logs.length,
      buy_signals: buyOrders.length,
      sell_signals: sellOrders.length,
      state_transitions: results.state_transitions,
      bars_processed: results.total_bars,
      final_state: results.final_state,
      signal_frequency: (logs.length / results.total_bars * 100).toFixed(2) + '%',
    },
    trades: {
      buy_orders: buyOrders,
      sell_orders: sellOrders,
    },
  };
}

/**
 * Deploy strategy handler - Add strategy directly to database
 */
async function handleDeployStrategy(args: any) {
  try {
    // Get YAML content
    const yamlContent = loadYamlContent(args);

    // Parse and validate
    const parsed = yaml.parse(yamlContent);
    const validated = validateStrategyDSL(parsed);

    // Extract metadata
    const { symbol, name, timeframe } = validated.meta;
    const userId = args.user_id || process.env.USER_ID || 'default-user';
    let accountId = args.account_id || process.env.TWS_ACCOUNT_ID;

    // Create strategy in database
    const factory = getRepositoryFactory();
    const strategyRepo = factory.getStrategyRepo();

    // Validate account exists if accountId is provided
    if (accountId) {
      const accountExists = await factory.getPrisma().account.findUnique({
        where: { id: accountId },
      });

      if (!accountExists) {
        console.warn(`[deploy_strategy] Account ${accountId} not found in database. Creating strategy without account association.`);
        accountId = undefined; // Don't use non-existent account
      }
    }

    // Note: accountId is optional - if not provided or account doesn't exist,
    // strategy will be created without account association (accountId: null)
    const strategy = await strategyRepo.createWithVersion({
      userId,
      accountId,
      symbol,
      name,
      timeframe,
      yamlContent,
      changeReason: 'Deployed via MCP',
    });

    // Mark as PENDING so orchestrator picks it up
    const updatedStrategy = await factory.getPrisma().strategy.update({
      where: { id: strategy.id },
      data: { status: 'PENDING' },
    });

    // NOTE: Do NOT disconnect - factory is a singleton reused across tool calls

    return {
      success: true,
      message: 'Strategy deployed successfully',
      strategy: {
        id: updatedStrategy.id,
        name: updatedStrategy.name,
        symbol: updatedStrategy.symbol,
        timeframe: updatedStrategy.timeframe,
        status: updatedStrategy.status,
      },
      instructions: 'Strategy is PENDING and will be picked up by the orchestrator automatically.',
    };
  } catch (error: any) {
    return {
      success: false,
      error: 'Deployment failed',
      message: error.message,
      details: error.errors || error.stack,
    };
  }
}

/**
 * Create live engine handler
 */
async function handleCreateLiveEngine(args: any) {
  // Compile strategy if needed
  let compiled = args.compiled_ir;
  if (!compiled) {
    const compileResult = await handleCompileStrategy(args);
    if (!compileResult.success || !('compiled_ir' in compileResult)) {
      return compileResult;
    }
    compiled = compileResult.compiled_ir;
  }

  const dryRun = args.dry_run !== false; // Default to true

  return {
    success: true,
    message: 'Live engine created',
    config: {
      dry_run: dryRun,
      strategy_name: compiled.name || 'unnamed',
      symbols: compiled.symbols || [],
    },
    instructions: dryRun
      ? 'Engine is in DRY-RUN mode. No actual orders will be placed.'
      : 'WARNING: Engine is in LIVE mode. Real orders will be placed!',
    compiled_ir: compiled,
  };
}

/**
 * Get portfolio overview handler
 */
async function handleGetPortfolioOverview() {
  try {
    const portfolioApiUrl = process.env.PORTFOLIO_API_URL || 'http://localhost:3002';
    const response = await fetch(`${portfolioApiUrl}/api/portfolio/overview`);

    if (!response.ok) {
      throw new Error(`Portfolio API returned ${response.status}`);
    }

    const data = await response.json() as any;

    return {
      success: true,
      portfolio: {
        realizedPnL: data.pnl.realizedPnL,
        totalPositions: data.pnl.totalPositions,
        currentPositions: data.pnl.currentPositions,
        activeStrategies: data.strategies.filter((s: any) => s.status === 'ACTIVE'),
        totalStrategies: data.strategies.length,
        recentTrades: data.recentTrades.slice(0, 10), // Last 10 trades
        orderStats: data.orderStats,
      },
      timestamp: data.timestamp,
    };
  } catch (error: any) {
    return {
      success: false,
      error: 'Failed to fetch portfolio overview',
      message: error.message,
      note: 'Make sure the portfolio API server is running on port 3002',
    };
  }
}

/**
 * Get market data handler
 */
async function handleGetMarketData(args: any) {
  mcpLogger.info('get_market_data - INPUT', {
    symbol: args.symbol,
    timeframe: args.timeframe || '5m',
    limit: args.limit || 100,
  });

  try {
    const { symbol, timeframe = '5m', limit = 100 } = args;

    // Import broker adapter
    const brokerType = process.env.BROKER || 'tws';

    if (brokerType === 'tws') {
      const { TwsMarketDataClient } = await import('./broker/twsMarketData');

      const client = new TwsMarketDataClient();
      const bars = await client.getHistoricalBars(symbol, limit, timeframe);

      return {
        success: true,
        symbol,
        timeframe,
        bars: bars.map((bar: any) => ({
          timestamp: bar.timestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        })),
        count: bars.length,
        latestPrice: bars.length > 0 ? bars[bars.length - 1].close : null,
      };
    } else {
      return {
        success: false,
        error: 'Market data fetching not implemented for this broker',
        broker: brokerType,
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: 'Failed to fetch market data',
      message: error.message,
      note: 'Make sure the broker connection is available',
    };
  }
}

/**
 * Get active strategies handler
 */
async function handleGetActiveStrategies() {
  try {
    const factory = getRepositoryFactory();
    const strategyRepo = factory.getStrategyRepo();
    const userId = process.env.USER_ID || 'default-user';

    const strategies = await strategyRepo.findByStatus(userId, 'ACTIVE');

    // NOTE: Do NOT disconnect - factory is a singleton reused across tool calls

    return {
      success: true,
      strategies: strategies.map(s => ({
        id: s.id,
        name: s.name,
        symbol: s.symbol,
        timeframe: s.timeframe,
        status: s.status,
        activatedAt: s.activatedAt,
        yamlContent: s.yamlContent,
      })),
      count: strategies.length,
    };
  } catch (error: any) {
    return {
      success: false,
      error: 'Failed to fetch active strategies',
      message: error.message,
    };
  }
}

/**
 * Get live portfolio snapshot from TWS handler
 */
async function handleGetLivePortfolioSnapshot(args: any) {
  try {
    const forceRefresh = args.force_refresh || false;
    const brokerType = process.env.BROKER || 'tws';

    if (brokerType !== 'tws') {
      return {
        success: false,
        error: 'Live portfolio snapshot only supported for TWS broker',
        broker: brokerType,
      };
    }

    // Import and use PortfolioDataFetcher (same as swap evaluation)
    const { PortfolioDataFetcher } = await import('./broker/twsPortfolio');

    const host = process.env.TWS_HOST || '127.0.0.1';
    const port = parseInt(process.env.TWS_PORT || '7497', 10);
    const clientId = 3; // Client ID 3 for portfolio data (same as swap evaluation)

    const fetcher = new PortfolioDataFetcher(host, port, clientId);
    const snapshot = await fetcher.getPortfolioSnapshot(forceRefresh);

    const result = {
      success: true,
      snapshot: {
        timestamp: snapshot.timestamp,
        accountId: snapshot.accountId,
        totalValue: snapshot.totalValue,
        cash: snapshot.cash,
        buyingPower: snapshot.buyingPower,
        unrealizedPnL: snapshot.unrealizedPnL,
        realizedPnL: snapshot.realizedPnL,
        positions: snapshot.positions.map(p => ({
          symbol: p.symbol,
          quantity: p.quantity,
          avgCost: p.avgCost,
          currentPrice: p.currentPrice,
          unrealizedPnL: p.unrealizedPnL,
          marketValue: p.marketValue,
        })),
      },
      note: 'This is the same real-time data used by automated strategy swap evaluations',
    };

    mcpLogger.info('get_live_portfolio_snapshot - OUTPUT', {
      success: true,
      account_id: snapshot.accountId,
      total_value: snapshot.totalValue,
      buying_power: snapshot.buyingPower,
      positions_count: snapshot.positions.length,
      unrealized_pnl: snapshot.unrealizedPnL,
    });

    return result;
  } catch (error: any) {
    const result = {
      success: false,
      error: 'Failed to fetch live portfolio snapshot',
      message: error.message,
      note: 'Make sure TWS/IB Gateway is running and connected',
    };
    mcpLogger.error('get_live_portfolio_snapshot - ERROR', error);
    return result;
  }
}

/**
 * Get sector info handler
 */
async function handleGetSectorInfo(args: any) {
  mcpLogger.info('get_sector_info - INPUT', {
    symbol: args.symbol,
    broker: process.env.BROKER || 'tws',
  });

  try {
    const { symbol } = args;
    const brokerType = process.env.BROKER || 'tws';

    if (brokerType !== 'tws') {
      return {
        success: false,
        error: 'Sector info only supported for TWS broker',
        broker: brokerType,
      };
    }

    const { TwsSectorDataClient } = await import('./broker/twsSectorData');

    const host = process.env.TWS_HOST || '127.0.0.1';
    const port = parseInt(process.env.TWS_PORT || '7497', 10);
    const clientId = 4; // Client ID 4 for sector data

    const client = new TwsSectorDataClient(host, port, clientId);
    const sectorInfo = await client.getSectorInfo(symbol);

    const result = {
      success: true,
      symbol: sectorInfo.symbol,
      industry: sectorInfo.industry,
      category: sectorInfo.category,
      subcategory: sectorInfo.subcategory,
    };

    mcpLogger.info('get_sector_info - OUTPUT', {
      success: true,
      symbol: sectorInfo.symbol,
      industry: sectorInfo.industry,
    });

    return result;
  } catch (error: any) {
    const result = {
      success: false,
      error: 'Failed to fetch sector info',
      message: error.message,
      symbol: args.symbol,
      note: 'Make sure TWS/IB Gateway is running and the symbol is valid',
    };
    mcpLogger.info('get_sector_info - OUTPUT', {
      success: false,
      symbol: args.symbol,
      error: error.message,
    });
    return result;
  }
}

/**
 * Get sector peers handler
 */
async function handleGetSectorPeers(args: any) {
  mcpLogger.info('get_sector_peers - INPUT', {
    symbol: args.symbol,
    limit: args.limit || 10,
    broker: process.env.BROKER || 'tws',
  });

  try {
    const { symbol, limit = 10 } = args;
    const brokerType = process.env.BROKER || 'tws';

    if (brokerType !== 'tws') {
      return {
        success: false,
        error: 'Sector peers only supported for TWS broker',
        broker: brokerType,
      };
    }

    const { TwsSectorDataClient } = await import('./broker/twsSectorData');

    const host = process.env.TWS_HOST || '127.0.0.1';
    const port = parseInt(process.env.TWS_PORT || '7497', 10);
    const clientId = 4; // Client ID 4 for sector data

    const client = new TwsSectorDataClient(host, port, clientId);
    const peers = await client.getSectorPeers(symbol, limit);

    const result = {
      success: true,
      referenceSymbol: symbol,
      peers,
      count: peers.length,
    };

    mcpLogger.info('get_sector_peers - OUTPUT', {
      success: true,
      reference_symbol: symbol,
      peers_count: peers.length,
      peers,
    });

    return result;
  } catch (error: any) {
    const result = {
      success: false,
      error: 'Failed to fetch sector peers',
      message: error.message,
      symbol: args.symbol,
      note: 'Make sure TWS/IB Gateway is running and the symbol is valid',
    };
    mcpLogger.info('get_sector_peers - OUTPUT', {
      success: false,
      symbol: args.symbol,
      error: error.message,
    });
    return result;
  }
}

/**
 * Propose deterministic strategy handler
 */
async function handleProposeDeterministicStrategy(args: any) {
  mcpLogger.info('propose_deterministic_strategy - INPUT', {
    symbol: args.symbol,
    timeframe: args.timeframe || '5m',
    limit: args.limit || 100,
    maxRiskPerTrade: args.maxRiskPerTrade,
    rrTarget: args.rrTarget || 3.0,
    maxEntryDistancePct: args.maxEntryDistancePct || 3.0,
  });

  try {
    const {
      symbol,
      timeframe = '5m',
      limit = 100,
      maxRiskPerTrade,
      rrTarget = 3.0,
      maxEntryDistancePct = 3.0,
      entryTimeoutBars = 10,
      rthOnly = true,
    } = args;

    // Validate required params
    if (!symbol) {
      return {
        success: false,
        error: 'symbol is required',
      };
    }

    if (!maxRiskPerTrade || maxRiskPerTrade <= 0) {
      return {
        success: false,
        error: 'maxRiskPerTrade must be a positive number',
      };
    }

    // Fetch market data first
    const marketDataResult = await handleGetMarketData({ symbol, timeframe, limit });

    if (!marketDataResult.success || !marketDataResult.bars) {
      return {
        success: false,
        error: 'Failed to fetch market data',
        message: marketDataResult.error || 'No bars returned',
      };
    }

    const bars = marketDataResult.bars;

    // Import the deterministic strategy generator
    const { proposeDeterministic } = await import('./src/strategy/mcp-integration');

    // Generate strategy proposal
    const proposal = proposeDeterministic({
      symbol,
      timeframe,
      bars,
      maxRiskPerTrade,
      rrTarget,
      maxEntryDistancePct,
      entryTimeoutBars,
      rthOnly,
    });

    if (proposal.success && proposal.result) {
      mcpLogger.info('propose_deterministic_strategy - OUTPUT', {
        success: true,
        symbol,
        best_strategy: {
          name: proposal.result.best.name,
          side: proposal.result.best.side,
          rr_worst: proposal.result.best.rrWorst,
          dollar_risk: proposal.result.best.dollarRiskWorst,
          entry_distance_pct: proposal.result.best.entryDistancePct,
        },
        alternatives_count: proposal.result.candidatesTop5.length,
        metrics: {
          atr: proposal.result.metrics.atr,
          trend20: proposal.result.metrics.trend20,
          current_price: proposal.result.metrics.currentPrice,
        },
      });
    } else {
      mcpLogger.info('propose_deterministic_strategy - OUTPUT', {
        success: false,
        error: proposal.error,
      });
    }

    return proposal;
  } catch (error: any) {
    const result = {
      success: false,
      error: 'Failed to generate deterministic strategy',
      message: error.message,
      stack: error.stack,
    };
    mcpLogger.info('propose_deterministic_strategy - OUTPUT', {
      success: false,
      error: error.message,
    });
    return result;
  }
}

/**
 * Get portfolio sector concentration handler
 */
async function handleGetPortfolioSectorConcentration(args: any) {
  mcpLogger.info('get_portfolio_sector_concentration - INPUT', {
    force_refresh: args.force_refresh || false,
    broker: process.env.BROKER || 'tws',
  });

  try {
    const forceRefresh = args.force_refresh || false;
    const brokerType = process.env.BROKER || 'tws';

    if (brokerType !== 'tws') {
      return {
        success: false,
        error: 'Portfolio sector concentration only supported for TWS broker',
        broker: brokerType,
      };
    }

    // Import both portfolio and sector clients
    const { PortfolioDataFetcher } = await import('./broker/twsPortfolio');
    const { TwsSectorDataClient } = await import('./broker/twsSectorData');

    const host = process.env.TWS_HOST || '127.0.0.1';
    const port = parseInt(process.env.TWS_PORT || '7497', 10);

    // Fetch portfolio snapshot
    const portfolioFetcher = new PortfolioDataFetcher(host, port, 3);
    const snapshot = await portfolioFetcher.getPortfolioSnapshot(forceRefresh);

    if (snapshot.positions.length === 0) {
      return {
        success: true,
        message: 'Portfolio has no positions',
        totalValue: snapshot.totalValue,
        positions: 0,
        sectors: {},
        sectorExposure: [],
      };
    }

    // Fetch sector info for each position
    const sectorClient = new TwsSectorDataClient(host, port, 4);
    const sectorMap: Record<string, { marketValue: number; positions: any[] }> = {};

    for (const position of snapshot.positions) {
      try {
        const sectorInfo = await sectorClient.getSectorInfo(position.symbol);
        const sector = sectorInfo.industry || 'Unknown';

        if (!sectorMap[sector]) {
          sectorMap[sector] = { marketValue: 0, positions: [] };
        }

        sectorMap[sector].marketValue += position.marketValue;
        sectorMap[sector].positions.push({
          symbol: position.symbol,
          marketValue: position.marketValue,
          quantity: position.quantity,
          unrealizedPnL: position.unrealizedPnL,
        });
      } catch (err: any) {
        // If sector info fails for a symbol, categorize as Unknown
        const sector = 'Unknown';
        if (!sectorMap[sector]) {
          sectorMap[sector] = { marketValue: 0, positions: [] };
        }
        sectorMap[sector].marketValue += position.marketValue;
        sectorMap[sector].positions.push({
          symbol: position.symbol,
          marketValue: position.marketValue,
          quantity: position.quantity,
          unrealizedPnL: position.unrealizedPnL,
        });
      }
    }

    // Calculate sector exposure percentages
    const totalPositionValue = snapshot.positions.reduce((sum, p) => sum + p.marketValue, 0);
    const sectorExposure = Object.entries(sectorMap)
      .map(([sector, data]) => ({
        sector,
        marketValue: data.marketValue,
        percentage: (data.marketValue / totalPositionValue) * 100,
        positionCount: data.positions.length,
        positions: data.positions,
      }))
      .sort((a, b) => b.marketValue - a.marketValue); // Sort by market value descending

    const result = {
      success: true,
      portfolio: {
        totalValue: snapshot.totalValue,
        totalPositionValue,
        cash: snapshot.cash,
        positionCount: snapshot.positions.length,
      },
      sectors: sectorMap,
      sectorExposure,
      diversificationScore: sectorExposure.length, // Simple score: number of sectors
      topSector: sectorExposure[0],
      note: 'Use this data to assess portfolio diversification risk before deploying new strategies',
    };

    mcpLogger.info('get_portfolio_sector_concentration - OUTPUT', {
      success: true,
      position_count: snapshot.positions.length,
      sectors_count: sectorExposure.length,
      top_sector: sectorExposure[0]?.sector,
      top_sector_pct: sectorExposure[0]?.percentage.toFixed(2),
    });

    return result;
  } catch (error: any) {
    const result = {
      success: false,
      error: 'Failed to analyze portfolio sector concentration',
      message: error.message,
      note: 'Make sure TWS/IB Gateway is running and connected',
    };
    mcpLogger.info('get_portfolio_sector_concentration - OUTPUT', {
      success: false,
      error: error.message,
    });
    return result;
  }
}

// ============================================================================
// Request Handlers
// ============================================================================

function registerHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Log tool invocation
    mcpLogger.info(`Tool invoked: ${name}`, { tool: name, args });

    try {
      let result;

      switch (name) {
        case 'compile_strategy':
          result = await handleCompileStrategy(args);
          break;
        case 'validate_strategy':
          result = await handleValidateStrategy(args);
          break;
        case 'backtest_strategy':
          result = await handleBacktestStrategy(args);
          break;
        case 'list_strategy_types':
          result = await handleListStrategyTypes();
          break;
        case 'get_dsl_schema':
          result = await handleGetDSLSchema(args);
          break;
        case 'get_strategy_template':
          result = await handleGetStrategyTemplate(args);
          break;
        case 'analyze_strategy_performance':
          result = await handleAnalyzePerformance(args);
          break;
        case 'deploy_strategy':
          result = await handleDeployStrategy(args);
          break;
        case 'create_live_engine':
          result = await handleCreateLiveEngine(args);
          break;
        case 'get_portfolio_overview':
          result = await handleGetPortfolioOverview();
          break;
        case 'get_market_data':
          result = await handleGetMarketData(args);
          break;
        case 'get_active_strategies':
          result = await handleGetActiveStrategies();
          break;
        case 'get_live_portfolio_snapshot':
          result = await handleGetLivePortfolioSnapshot(args);
          break;
        case 'get_sector_info':
          result = await handleGetSectorInfo(args);
          break;
        case 'get_sector_peers':
          result = await handleGetSectorPeers(args);
          break;
        case 'get_portfolio_sector_concentration':
          result = await handleGetPortfolioSectorConcentration(args);
          break;
        case 'propose_deterministic_strategy':
          result = await handleProposeDeterministicStrategy(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Log tool output
      mcpLogger.info(`Tool completed: ${name}`, { tool: name });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      // Log error output
      const errorResult = {
        success: false,
        error: error.message,
        stack: error.stack,
      };

      mcpLogger.error(`Tool failed: ${name}`, error);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(errorResult, null, 2),
          },
        ],
        isError: true,
      };
    }
  });
}

// ============================================================================
// Server Start
// ============================================================================

const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT || process.env.MCP_PORT || 3000);
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || '').toLowerCase();

function parseSessionIdHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

async function startHttpServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = parseSessionIdHeader(req.headers['mcp-session-id']);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        const id = transport?.sessionId;
        if (id) {
          transports.delete(id);
        }
      };
      const server = createServer();
      await server.connect(transport);
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
    }

    if (!transport) {
      res.status(400).json({ error: 'Missing or invalid MCP session' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = parseSessionIdHeader(req.headers['mcp-session-id']);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).end();
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.listen(MCP_HTTP_PORT, () => {
    mcpLogger.info(`MCP Server running (HTTP mode)`, {
      url: `http://localhost:${MCP_HTTP_PORT}/mcp`
    });
  });
}

async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLogger.info('MCP Server running (stdio mode)');
}

async function main() {
  if (MCP_TRANSPORT === 'http') {
    await startHttpServer();
    return;
  }
  await startStdioServer();
}

main().catch((error) => {
  mcpLogger.error('Fatal error in main()', error);
  process.exit(1);
});
