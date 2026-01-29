/**
 * Check Strategy States
 * Shows current FSM state for all active strategies
 */

import { globalOrchestrator } from './live/LiveTradingOrchestrator';
import { RepositoryFactory } from './database/RepositoryFactory';

async function checkStrategyStates() {
  const factory = new RepositoryFactory();
  const strategyRepo = factory.getStrategyRepo();

  // Get all active strategies from database
  const strategies = await strategyRepo.findByStatus('user-id', 'ACTIVE'); // Replace with your USER_ID

  console.log(`\n📊 Active Strategy States:\n`);
  console.log('═'.repeat(80));

  for (const strategy of strategies) {
    // Get runtime state from orchestrator
    let currentState = 'NOT_LOADED';
    let openOrders = 0;

    if (globalOrchestrator) {
      try {
        const instance = globalOrchestrator.getStrategyInstance(strategy.id);
        if (instance) {
          const runtimeState = instance.getState();
          currentState = runtimeState.currentState;
          openOrders = runtimeState.openOrders.length;
        }
      } catch (error) {
        currentState = 'ERROR';
      }
    } else {
      currentState = 'ORCHESTRATOR_NOT_RUNNING';
    }

    const stateEmoji = {
      IDLE: '😴',
      ARMED: '🎯',
      PLACED: '📤',
      MANAGING: '📈',
      EXITED: '✅',
    }[currentState] || '❓';

    console.log(`${stateEmoji} ${strategy.name.padEnd(30)} | ${strategy.symbol.padEnd(6)} | ${currentState.padEnd(12)} | ${openOrders} orders`);
  }

  console.log('═'.repeat(80));
  console.log(`\nTotal: ${strategies.length} active strategies\n`);

  await factory.disconnect();
}

checkStrategyStates().catch(console.error);
