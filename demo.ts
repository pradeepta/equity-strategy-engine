/**
 * Demo: Complete Trading Strategy DSL → Compiler → Runtime flow
 *
 * This demonstrates:
 * 1. Loading a strategy YAML
 * 2. Compiling to IR (with type checking and feature DAG)
 * 3. Simulating bar processing in the runtime engine
 * 4. Showing broker order placement (REST + MCP stubs)
 * 5. Logging state transitions and actions
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyCompiler } from './compiler/compile';
import { createStandardRegistry } from './features/registry';
import { StrategyEngine } from './runtime/engine';
import { AlpacaRestAdapter } from './broker/alpacaRest';
import { AlpacaMcpAdapter } from './broker/alpacaMcp';
import { Bar } from './spec/types';

// ============================================================================
// Mock data: simulated 5-min bars for NFLX
// ============================================================================

function generateMockBars(): Bar[] {
  const bars: Bar[] = [];
  let timestamp = 1704067200000; // 2024-01-01 00:00:00

  // Scenario: price rallies toward VWAP, then fails
  const barData = [
    { open: 90.05, high: 90.15, low: 89.95, close: 90.10, volume: 1200000 },
    { open: 90.10, high: 90.25, low: 90.05, close: 90.22, volume: 1100000 },
    { open: 90.22, high: 90.35, low: 90.15, close: 90.32, volume: 950000 },
    { open: 90.32, high: 90.40, low: 90.25, close: 90.30, volume: 1050000 },
    { open: 90.30, high: 90.35, low: 90.18, close: 90.20, volume: 2300000 }, // Trigger begins
    { open: 90.20, high: 90.25, low: 90.05, close: 90.08, volume: 1500000 }, // Likely trigger
    { open: 90.08, high: 90.15, low: 89.95, close: 90.00, volume: 1200000 }, // After entry
    { open: 90.00, high: 90.05, low: 89.70, close: 89.80, volume: 1600000 }, // Toward first target
    { open: 89.80, high: 89.85, low: 89.55, close: 89.60, volume: 1400000 }, // First target hit
    { open: 89.60, high: 89.75, low: 89.35, close: 89.50, volume: 1300000 }, // Second target area
  ];

  for (const data of barData) {
    bars.push({
      timestamp,
      ...data,
    });
    timestamp += 5 * 60 * 1000; // 5 min increments
  }

  return bars;
}

// ============================================================================
// Main demo
// ============================================================================

async function main() {
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('║' + 'TRADING STRATEGY DSL → COMPILER → RUNTIME DEMO'.padEnd(58) + '║');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝\n');

  try {
    // ========================================================================
    // Step 1: Load YAML strategy
    // ========================================================================
    console.log('\n📋 STEP 1: Load Strategy YAML\n');
    const strategyPath = path.join(__dirname, 'strategies', 'fade-vwap-reclaim.yaml');
    const yamlContent = fs.readFileSync(strategyPath, 'utf-8');
    console.log(`Loaded: ${strategyPath}`);
    console.log(`  Size: ${yamlContent.length} bytes\n`);

    // ========================================================================
    // Step 2: Compile to IR
    // ========================================================================
    console.log('\n🔧 STEP 2: Compile to IR\n');
    const featureRegistry = createStandardRegistry();
    const compiler = new StrategyCompiler(featureRegistry);

    console.log('Compiling strategy...');
    const ir = compiler.compileFromYAML(yamlContent);

    console.log(`✓ Compilation successful`);
    console.log(`  Initial state: ${ir.initialState}`);
    console.log(`  Features: ${ir.featurePlan.length}`);
    console.log(`  Transitions: ${ir.transitions.length}`);
    console.log(`  Order plans: ${ir.orderPlans.length}`);
    console.log(`  Entry timeout: ${ir.execution.entryTimeoutBars} bars`);
    console.log(`  Max risk: $${ir.risk.maxRiskPerTrade}\n`);

    // Print IR details
    console.log('IR Details:\n');
    console.log(JSON.stringify(ir, (_, v) => {
      if (v && typeof v === 'object' && 'type' in v && 'operator' in v) {
        return `[ExprNode: ${(v as any).type}]`;
      }
      return v;
    }, 2));

    // ========================================================================
    // Step 3: Generate mock bars
    // ========================================================================
    console.log('\n📊 STEP 3: Generate Mock Bar Data\n');
    const bars = generateMockBars();
    console.log(`Generated ${bars.length} mock 5-min bars`);
    console.log('Bar data:');
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      console.log(
        `  Bar ${i + 1}: O=${(bar.open as number).toFixed(2)} H=${(bar.high as number).toFixed(2)} ` +
          `L=${(bar.low as number).toFixed(2)} C=${(bar.close as number).toFixed(2)} V=${bar.volume}`
      );
    }

    // ========================================================================
    // Step 4: Initialize runtime engine with REST adapter
    // ========================================================================
    console.log('\n⚙️  STEP 4: Initialize Runtime Engine (REST Adapter)\n');
    const restAdapter = new AlpacaRestAdapter(
      'https://api.alpaca.markets',
      'mock_key',
      'mock_secret'
    );

    const engine = new StrategyEngine(ir, featureRegistry, restAdapter, {
      dryRun: true, // Don't actually call Alpaca API
      baseUrl: 'https://api.alpaca.markets',
    });

    console.log('✓ Engine initialized\n');

    // ========================================================================
    // Step 5: Process bars through runtime
    // ========================================================================
    console.log('\n▶️  STEP 5: Process Bars Through Runtime\n');
    console.log('Starting bar processing...\n');

    for (const bar of bars) {
      console.log(`\n${'─'.repeat(60)}`);
      await engine.processBar(bar);
      const state = engine.getState();
      console.log(`State: ${state.currentState}`);
      const close = state.features.get('close');
      const vwap = state.features.get('vwap');
      const ema20 = state.features.get('ema20');
      console.log(`Features: {close: ${typeof close === 'number' ? close.toFixed(2) : 'N/A'}, ` +
        `vwap: ${typeof vwap === 'number' ? vwap.toFixed(2) : 'N/A'}, ` +
        `ema20: ${typeof ema20 === 'number' ? ema20.toFixed(2) : 'N/A'}}`);
    }

    // ========================================================================
    // Step 6: Final state and logs
    // ========================================================================
    console.log('\n\n📋 STEP 6: Final Engine State\n');
    const finalState = engine.getState();

    console.log(`Final state: ${finalState.currentState}`);
    console.log(`Bars processed: ${finalState.barCount}`);
    console.log(`Open orders: ${finalState.openOrders.length}`);
    console.log(`Log entries: ${finalState.log.length}\n`);

    console.log('Log Summary:');
    for (const entry of finalState.log.slice(-10)) {
      const timestamp = new Date(entry.timestamp).toISOString();
      console.log(`  [Bar ${entry.barNum}] [${entry.level.toUpperCase()}] ${entry.message}`);
    }

    // ========================================================================
    // Step 7: Demo MCP adapter
    // ========================================================================
    console.log('\n\n🔌 STEP 7: Demo MCP Adapter\n');
    const mockMcpClient = {
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        console.log(`[MOCK MCP] Tool called: ${toolName}`);
        console.log(`[MOCK MCP] Args: ${JSON.stringify(args)}`);
        return {
          result: { order_id: `mcp_${Date.now()}`, status: 'pending' },
        };
      },
    };

    const mcpAdapter = new AlpacaMcpAdapter(mockMcpClient);
    console.log('MCP adapter would use these tools:');
    console.log('  - alpaca_submit_bracket_order(symbol, qty, side, entry_price, ...)');
    console.log('  - alpaca_cancel_order(order_id, symbol)');
    console.log('  - alpaca_get_open_orders(symbol)\n');

    // ========================================================================
    // Summary
    // ========================================================================
    console.log('\n' + '═'.repeat(60));
    console.log('DEMO SUMMARY');
    console.log('═'.repeat(60));
    console.log(`✓ DSL loaded and validated`);
    console.log(`✓ Compiled to typed IR with:
  - Feature DAG (topologically sorted)
  - State transitions
  - Type-checked expressions
  - Order plan templates`);
    console.log(`✓ Runtime engine processed ${finalState.barCount} bars`);
    console.log(`✓ State transitions executed: ${finalState.log.length} actions`);
    console.log(`✓ Broker adapters ready:
  - Alpaca REST (shows API payloads)
  - Alpaca MCP (delegates to tools)`);
    console.log(`✓ Safe expression evaluation (no eval, whitelisted operators)\n`);
    console.log('═'.repeat(60) + '\n');

  } catch (e) {
    const err = e as Error;
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

// Run demo
main().catch(console.error);
