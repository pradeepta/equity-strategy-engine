/**
 * CLI: List Strategies
 * Lists all strategies for a user with optional status filter
 */

import * as dotenv from 'dotenv';
import { getRepositoryFactory } from '../database/RepositoryFactory';
import { StrategyStatus } from '@prisma/client';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let userId: string | undefined;
  let statusFilter: StrategyStatus | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--user=')) {
      userId = args[i].split('=')[1];
    } else if (args[i].startsWith('--status=')) {
      statusFilter = args[i].split('=')[1] as StrategyStatus;
    }
  }

  // Validate arguments
  if (!userId) {
    console.error('Error: --user=<userId> is required');
    console.log('');
    console.log('Usage: npm run strategy:list -- --user=<userId> [--status=<status>]');
    console.log('');
    console.log('Status options: DRAFT, PENDING, ACTIVE, CLOSED, ARCHIVED, FAILED');
    console.log('');
    console.log('Example: npm run strategy:list -- --user=user123 --status=ACTIVE');
    process.exit(1);
  }

  // Get strategies
  const factory = getRepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  try {
    let strategies;

    if (statusFilter === 'ACTIVE') {
      strategies = await strategyRepo.findActiveByUser(userId);
    } else {
      const prisma = factory.getPrisma();
      strategies = await prisma.strategy.findMany({
        where: {
          userId,
          ...(statusFilter ? { status: statusFilter } : {}),
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`STRATEGIES FOR USER: ${userId}`);
    if (statusFilter) {
      console.log(`STATUS FILTER: ${statusFilter}`);
    }
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

    if (strategies.length === 0) {
      console.log('No strategies found.');
      console.log('');
      await factory.disconnect();
      return;
    }

    for (const strategy of strategies) {
      console.log(`ID: ${strategy.id}`);
      console.log(`  Symbol: ${strategy.symbol}`);
      console.log(`  Name: ${strategy.name}`);
      console.log(`  Timeframe: ${strategy.timeframe}`);
      console.log(`  Status: ${strategy.status}`);
      console.log(`  Created: ${strategy.createdAt.toLocaleString()}`);

      if (strategy.activatedAt) {
        console.log(`  Activated: ${strategy.activatedAt.toLocaleString()}`);
      }

      if (strategy.closedAt) {
        console.log(`  Closed: ${strategy.closedAt.toLocaleString()}`);
        if (strategy.closeReason) {
          console.log(`  Close Reason: ${strategy.closeReason}`);
        }
      }

      if (strategy.archivedAt) {
        console.log(`  Archived: ${strategy.archivedAt.toLocaleString()}`);
      }

      console.log('');
    }

    console.log(`Total: ${strategies.length} strategy(ies)`);
    console.log('');

    await factory.disconnect();
  } catch (error: any) {
    console.error('');
    console.error('❌ Failed to list strategies:', error.message);
    console.error('');
    await factory.disconnect();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
