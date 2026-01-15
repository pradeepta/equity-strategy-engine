/**
 * CLI: Add Strategy
 * Creates a new strategy from YAML file and marks it as PENDING
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as YAML from 'yaml';
import { getRepositoryFactory } from '../database/RepositoryFactory';

dotenv.config();

interface StrategyYAML {
  meta?: {
    symbol?: string;
    name?: string;
    timeframe?: string;
  };
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let userId: string | undefined;
  let filePath: string | undefined;
  let accountId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--user=')) {
      userId = args[i].split('=')[1];
    } else if (args[i].startsWith('--file=')) {
      filePath = args[i].split('=')[1];
    } else if (args[i].startsWith('--account=')) {
      accountId = args[i].split('=')[1];
    }
  }

  // Validate arguments
  if (!userId) {
    console.error('Error: --user=<userId> is required');
    console.log('');
    console.log('Usage: npm run strategy:add -- --user=<userId> --file=<yamlPath> [--account=<accountId>]');
    console.log('');
    console.log('Example: npm run strategy:add -- --user=user123 --file=./aapl-momentum.yaml');
    process.exit(1);
  }

  if (!filePath) {
    console.error('Error: --file=<yamlPath> is required');
    console.log('');
    console.log('Usage: npm run strategy:add -- --user=<userId> --file=<yamlPath> [--account=<accountId>]');
    process.exit(1);
  }

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  // Read YAML file
  const yamlContent = await fs.promises.readFile(filePath, 'utf-8');

  // Parse YAML to extract metadata
  let parsed: StrategyYAML;
  try {
    parsed = YAML.parse(yamlContent) as StrategyYAML;
  } catch (error: any) {
    console.error('Error: Failed to parse YAML:', error.message);
    process.exit(1);
  }

  if (!parsed.meta?.symbol) {
    console.error('Error: YAML must contain meta.symbol');
    process.exit(1);
  }

  if (!parsed.meta?.name) {
    console.error('Error: YAML must contain meta.name');
    process.exit(1);
  }

  if (!parsed.meta?.timeframe) {
    console.error('Error: YAML must contain meta.timeframe');
    process.exit(1);
  }

  const symbol = parsed.meta.symbol;
  const name = parsed.meta.name;
  const timeframe = parsed.meta.timeframe;

  // Create strategy in database
  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  try {
    console.log('');
    console.log('📋 Creating strategy...');
    console.log(`   User: ${userId}`);
    console.log(`   Symbol: ${symbol}`);
    console.log(`   Name: ${name}`);
    console.log(`   Timeframe: ${timeframe}`);
    if (accountId) {
      console.log(`   Account: ${accountId}`);
    }

    const strategy = await strategyRepo.createWithVersion({
      userId,
      accountId,
      symbol,
      name,
      timeframe,
      yamlContent,
      changeReason: 'Initial creation via CLI',
    });

    // Mark as PENDING so orchestrator will pick it up
    const updatedStrategy = await factory.getPrisma().strategy.update({
      where: { id: strategy.id },
      data: { status: 'PENDING' },
    });

    console.log('');
    console.log(`✅ Strategy created successfully!`);
    console.log(`   Strategy ID: ${updatedStrategy.id}`);
    console.log(`   Status: ${updatedStrategy.status}`);
    console.log('');
    console.log('The strategy is now PENDING and will be picked up by the orchestrator.');
    console.log('');

    await factory.disconnect();
  } catch (error: any) {
    console.error('');
    console.error('❌ Failed to create strategy:', error.message);
    console.error('');
    await factory.disconnect();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
