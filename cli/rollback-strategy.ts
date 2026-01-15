/**
 * CLI: Rollback Strategy
 * Rolls back a strategy to a previous version
 */

import * as dotenv from 'dotenv';
import { getRepositoryFactory } from '../database/RepositoryFactory';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let strategyId: string | undefined;
  let versionNumber: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--id=')) {
      strategyId = args[i].split('=')[1];
    } else if (args[i].startsWith('--version=')) {
      versionNumber = parseInt(args[i].split('=')[1]);
    }
  }

  // Validate arguments
  if (!strategyId) {
    console.error('Error: --id=<strategyId> is required');
    console.log('');
    console.log('Usage: npm run strategy:rollback -- --id=<strategyId> --version=<versionNumber>');
    console.log('');
    console.log('Example: npm run strategy:rollback -- --id=clfx123 --version=3');
    process.exit(1);
  }

  if (!versionNumber || isNaN(versionNumber)) {
    console.error('Error: --version=<versionNumber> is required and must be a number');
    console.log('');
    console.log('Usage: npm run strategy:rollback -- --id=<strategyId> --version=<versionNumber>');
    process.exit(1);
  }

  // Rollback strategy
  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  try {
    // Get strategy
    const strategy = await strategyRepo.findById(strategyId);

    if (!strategy) {
      console.error(`Error: Strategy not found: ${strategyId}`);
      await factory.disconnect();
      process.exit(1);
    }

    // Get version history
    const versions = await strategyRepo.getVersionHistory(strategyId);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`VERSION HISTORY FOR: ${strategy.name} (${strategy.symbol})`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

    for (const version of versions) {
      console.log(`Version ${version.versionNumber}:`);
      console.log(`  Name: ${version.name}`);
      console.log(`  Change Type: ${version.changeType}`);
      console.log(`  Created: ${version.createdAt.toLocaleString()}`);
      if (version.changeReason) {
        console.log(`  Reason: ${version.changeReason}`);
      }
      console.log('');
    }

    // Check if version exists
    const targetVersion = versions.find((v) => v.versionNumber === versionNumber);

    if (!targetVersion) {
      console.error(`Error: Version ${versionNumber} not found`);
      await factory.disconnect();
      process.exit(1);
    }

    // Perform rollback
    console.log('🔄 Rolling back strategy...');
    console.log(`   From: Current version`);
    console.log(`   To: Version ${versionNumber}`);
    console.log('');

    await strategyRepo.rollbackToVersion(strategyId, versionNumber);

    console.log('✅ Strategy rolled back successfully!');
    console.log('');

    await factory.disconnect();
  } catch (error: any) {
    console.error('');
    console.error('❌ Failed to rollback strategy:', error.message);
    console.error('');
    await factory.disconnect();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
