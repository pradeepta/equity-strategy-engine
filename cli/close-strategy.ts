/**
 * CLI: Close Strategy
 * Closes an active strategy
 */

import * as dotenv from 'dotenv';
import { getRepositoryFactory } from '../database/RepositoryFactory';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let strategyId: string | undefined;
  let reason: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--id=')) {
      strategyId = args[i].split('=')[1];
    } else if (args[i].startsWith('--reason=')) {
      reason = args[i].substring('--reason='.length);
    }
  }

  // Validate arguments
  if (!strategyId) {
    console.error('Error: --id=<strategyId> is required');
    console.log('');
    console.log('Usage: npm run strategy:close -- --id=<strategyId> [--reason="<reason>"]');
    console.log('');
    console.log('Example: npm run strategy:close -- --id=clfx123 --reason="Market conditions unfavorable"');
    process.exit(1);
  }

  // Close strategy
  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();
  const execHistoryRepo = factory.getExecutionHistoryRepo();

  try {
    // Get strategy
    const strategy = await strategyRepo.findById(strategyId);

    if (!strategy) {
      console.error(`Error: Strategy not found: ${strategyId}`);
      await factory.disconnect();
      process.exit(1);
    }

    if (strategy.status === 'CLOSED') {
      console.error(`Error: Strategy is already closed`);
      await factory.disconnect();
      process.exit(1);
    }

    console.log('');
    console.log('🛑 Closing strategy...');
    console.log(`   Strategy ID: ${strategyId}`);
    console.log(`   Symbol: ${strategy.symbol}`);
    console.log(`   Name: ${strategy.name}`);
    if (reason) {
      console.log(`   Reason: ${reason}`);
    }

    // Close strategy
    await strategyRepo.close(strategyId, reason);

    // Log deactivation
    await execHistoryRepo.logDeactivation(strategyId, reason);

    console.log('');
    console.log('✅ Strategy closed successfully!');
    console.log('');

    await factory.disconnect();
  } catch (error: any) {
    console.error('');
    console.error('❌ Failed to close strategy:', error.message);
    console.error('');
    await factory.disconnect();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
