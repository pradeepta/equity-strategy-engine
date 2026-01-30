#!/usr/bin/env node
/**
 * Deploy Phase 1 Adaptive Strategies (Simplified)
 * Uses propose_deterministic_strategy directly via import
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

dotenv.config();

// Symbols to deploy (high liquidity)
const SYMBOLS = ['AAPL', 'NVDA', 'TSLA', 'SPY'];

// Strategy configuration
const MAX_RISK = 250;
const STRATEGIES_PER_SYMBOL = 3;

async function main() {
  console.log('🚀 Phase 1: Deploying Adaptive Strategies');
  console.log('==========================================\n');

  const deployedStrategies: string[] = [];
  const userId = process.env.USER_ID || 'default-user';

  for (const symbol of SYMBOLS) {
    console.log(`\n📊 ${symbol}: Deploying ${STRATEGIES_PER_SYMBOL} strategies...`);

    for (let i = 0; i < STRATEGIES_PER_SYMBOL; i++) {
      try {
        console.log(`\n   🎯 Strategy ${i + 1}/${STRATEGIES_PER_SYMBOL}: Generating...`);

        // Create a temporary script to call the MCP tool
        const scriptContent = `
const { proposeDeterministic } = require('./src/strategy/mcp-integration');
const { BarCacheServiceV2 } = require('./live/cache/BarCacheServiceV2');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');

async function generateAndDeploy() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const twsHost = process.env.TWS_HOST || "127.0.0.1";
  const twsPort = parseInt(process.env.TWS_PORT || "7497", 10);
  const twsClientId = 3000 + Math.floor(Math.random() * 1000);

  const barCache = new BarCacheServiceV2(
    pool,
    { host: twsHost, port: twsPort, clientId: twsClientId },
    { enabled: true }
  );

  const prisma = new PrismaClient();

  try {
    // Fetch bars
    const bars = await barCache.getBars('${symbol}', '5m', 100);

    const barsFormatted = bars.map(b => ({
      timestamp: new Date(b.date).getTime(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    // Generate strategy
    const proposal = proposeDeterministic({
      symbol: '${symbol}',
      timeframe: '5m',
      bars: barsFormatted,
      maxRiskPerTrade: ${MAX_RISK},
      rrTarget: 3.0,
      maxEntryDistancePct: 3.0,
      entryTimeoutBars: 30,
      rthOnly: true,
    });

    if (!proposal.success || !proposal.result) {
      console.error('Generation failed:', proposal.error);
      process.exit(1);
    }

    const { best, yaml } = proposal.result;

    console.log(JSON.stringify({
      name: best.name,
      family: best.family,
      side: best.side,
      entryLow: best.entryLow,
      entryHigh: best.entryHigh,
      stop: best.stop,
      target: best.target,
      rrWorst: best.rrWorst,
      qty: best.qty,
      dollarRisk: best.dollarRiskWorst,
    }));

    // Save YAML to temp file
    const fs = require('fs');
    const yamlPath = '/tmp/strategy_${symbol}_${i}.yaml';
    fs.writeFileSync(yamlPath, yaml);
    console.log('YAML_PATH:' + yamlPath);

    await prisma.$disconnect();
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  }
}

generateAndDeploy();
`;

        // Write temp script
        const tempScript = `/tmp/deploy_${symbol}_${i}.js`;
        fs.writeFileSync(tempScript, scriptContent);

        // Run the script
        const output = execSync(`node ${tempScript}`, {
          encoding: 'utf-8',
          cwd: process.cwd(),
          env: process.env,
        });

        // Parse output
        const lines = output.trim().split('\n');
        const jsonLine = lines.find(l => l.startsWith('{'));
        const yamlLine = lines.find(l => l.startsWith('YAML_PATH:'));

        if (!jsonLine || !yamlLine) {
          throw new Error('Failed to parse script output');
        }

        const strategyInfo = JSON.parse(jsonLine);
        const yamlPath = yamlLine.replace('YAML_PATH:', '');

        console.log(`      ✅ Generated: ${strategyInfo.name} (${strategyInfo.family})`);
        console.log(`         Side: ${strategyInfo.side.toUpperCase()}`);
        console.log(`         Entry: [${strategyInfo.entryLow.toFixed(2)}, ${strategyInfo.entryHigh.toFixed(2)}]`);
        console.log(`         Stop: ${strategyInfo.stop.toFixed(2)}`);
        console.log(`         Target: ${strategyInfo.target.toFixed(2)}`);
        console.log(`         R:R: ${strategyInfo.rrWorst.toFixed(2)}`);
        console.log(`         Qty: ${strategyInfo.qty}`);
        console.log(`         Risk: $${strategyInfo.dollarRisk.toFixed(2)}`);

        // Deploy using CLI tool
        const deployCmd = `npm run strategy:add -- --user="${userId}" --file="${yamlPath}"`;
        console.log(`      📤 Deploying to database...`);

        try {
          execSync(deployCmd, {
            encoding: 'utf-8',
            cwd: process.cwd(),
            stdio: 'pipe',
          });
          console.log(`      ✅ Deployed successfully`);
          deployedStrategies.push(`${symbol} - ${strategyInfo.name}`);
        } catch (deployErr: any) {
          console.error(`      ❌ Deployment failed: ${deployErr.message}`);
        }

        // Clean up temp files
        fs.unlinkSync(tempScript);
        // Keep YAML for inspection: fs.unlinkSync(yamlPath);

      } catch (err: any) {
        console.error(`   ❌ Error: ${err.message}`);
      }
    }
  }

  console.log('\n==========================================');
  console.log('📈 Deployment Summary');
  console.log('==========================================');
  console.log(`✅ Deployed: ${deployedStrategies.length} strategies`);
  console.log('\nStrategies:');
  deployedStrategies.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

  if (deployedStrategies.length > 0) {
    console.log('\n✅ Phase 1 deployment complete!');
    console.log('   Next steps:');
    console.log('   1. Start orchestrator: npm run live:multi');
    console.log('   2. Monitor activation in logs');
    console.log('   3. Watch for order triggers');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
