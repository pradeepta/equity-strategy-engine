#!/usr/bin/env node

/**
 * MCP Server for Algorithmic Trading System
 *
 * Exposes trading strategy compilation, backtesting, and execution capabilities
 * via Model Context Protocol (MCP).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { StrategyCompiler } from './compiler/compile';
import { StrategyEngine } from './runtime/engine';
import { createStandardRegistry } from './features/registry';
import { validateStrategyDSL } from './spec/schema';
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Server Setup
// ============================================================================

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

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS: Tool[] = [
  {
    name: 'compile_strategy',
    description: 'Compile a trading strategy from YAML DSL to type-safe intermediate representation (IR)',
    inputSchema: {
      type: 'object',
      properties: {
        yaml_content: {
          type: 'string',
          description: 'YAML strategy definition',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file (alternative to yaml_content)',
        },
      },
      oneOf: [
        { required: ['yaml_content'] },
        { required: ['yaml_file_path'] },
      ],
    },
  },
  {
    name: 'validate_strategy',
    description: 'Validate a trading strategy YAML against the schema',
    inputSchema: {
      type: 'object',
      properties: {
        yaml_content: {
          type: 'string',
          description: 'YAML strategy definition to validate',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file (alternative to yaml_content)',
        },
      },
      oneOf: [
        { required: ['yaml_content'] },
        { required: ['yaml_file_path'] },
      ],
    },
  },
  {
    name: 'backtest_strategy',
    description: 'Backtest a compiled strategy against historical data',
    inputSchema: {
      type: 'object',
      properties: {
        compiled_ir: {
          type: 'object',
          description: 'Compiled strategy IR (from compile_strategy)',
        },
        yaml_content: {
          type: 'string',
          description: 'YAML strategy (will be compiled automatically)',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file (will be compiled automatically)',
        },
        historical_data: {
          type: 'array',
          description: 'Array of historical bar data (OHLCV)',
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
          description: 'Path to JSON file containing historical data',
        },
      },
      oneOf: [
        { required: ['compiled_ir', 'historical_data'] },
        { required: ['compiled_ir', 'data_file_path'] },
        { required: ['yaml_content', 'historical_data'] },
        { required: ['yaml_content', 'data_file_path'] },
        { required: ['yaml_file_path', 'historical_data'] },
        { required: ['yaml_file_path', 'data_file_path'] },
      ],
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
    name: 'create_live_engine',
    description: 'Create a live trading engine instance for real-time execution (dry-run by default)',
    inputSchema: {
      type: 'object',
      properties: {
        compiled_ir: {
          type: 'object',
          description: 'Compiled strategy IR',
        },
        yaml_content: {
          type: 'string',
          description: 'YAML strategy (will be compiled automatically)',
        },
        yaml_file_path: {
          type: 'string',
          description: 'Path to YAML file (will be compiled automatically)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Run in dry-run mode (no actual orders)',
          default: true,
        },
      },
      oneOf: [
        { required: ['compiled_ir'] },
        { required: ['yaml_content'] },
        { required: ['yaml_file_path'] },
      ],
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
  const yamlContent = loadYamlContent(args);

  // Compile
  const registry = createStandardRegistry();
  const compiler = new StrategyCompiler(registry);

  try {
    const compiled = compiler.compileFromYAML(yamlContent);
    return {
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
  } catch (error: any) {
    return {
      success: false,
      error: 'Compilation failed',
      message: error.message,
      stack: error.stack,
    };
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
    if (!compileResult.success) {
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
 * Create live engine handler
 */
async function handleCreateLiveEngine(args: any) {
  // Compile strategy if needed
  let compiled = args.compiled_ir;
  if (!compiled) {
    const compileResult = await handleCompileStrategy(args);
    if (!compileResult.success) {
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

// ============================================================================
// Request Handlers
// ============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
      case 'get_strategy_template':
        result = await handleGetStrategyTemplate(args);
        break;
      case 'analyze_strategy_performance':
        result = await handleAnalyzePerformance(args);
        break;
      case 'create_live_engine':
        result = await handleCreateLiveEngine(args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            stack: error.stack,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// Server Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Stocks Trading MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
