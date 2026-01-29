/**
 * Database Poller
 * Polls database for new/pending strategies
 */

import { Strategy } from '@prisma/client';
import { StrategyRepository } from '../database/repositories/StrategyRepository';

export class DatabasePoller {
  private strategyRepo: StrategyRepository;
  private userId: string;
  private pollInterval: number;
  private knownStrategies: Set<string> = new Set(); // Track strategy IDs that are PENDING/ACTIVE
  private callbacks: Array<(strategy: Strategy) => void> = [];
  private intervalId?: NodeJS.Timeout;
  private running: boolean = false;

  constructor(strategyRepo: StrategyRepository, userId: string, pollInterval: number = 30000) {
    this.strategyRepo = strategyRepo;
    this.userId = userId;
    this.pollInterval = pollInterval;
  }

  /**
   * Start polling for new strategies
   */
  start(): void {
    if (this.running) {
      console.warn('DatabasePoller is already running');
      return;
    }

    console.log(`📊 Starting database poller (interval: ${this.pollInterval}ms)`);
    this.running = true;

    // Initial scan
    this.detectNewStrategies().catch(err => {
      console.error('Error in initial strategy detection:', err);
    });

    // Set up polling
    this.intervalId = setInterval(() => {
      this.detectNewStrategies().catch(err => {
        console.error('Error detecting new strategies:', err);
      });
    }, this.pollInterval);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.running = false;
    console.log('📊 Database poller stopped');
  }

  /**
   * Register callback for when new strategies are detected
   */
  onNewStrategy(callback: (strategy: Strategy) => void): void {
    this.callbacks.push(callback);
  }

  /**
   * Check if poller is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Detect new strategies with status=PENDING
   */
  private async detectNewStrategies(): Promise<void> {
    try {
      // Query for pending strategies
      const pendingStrategies = await this.strategyRepo.findPending(this.userId);

      // Build set of currently pending strategy IDs
      const currentPendingIds = new Set(pendingStrategies.map(s => s.id));

      // Remove strategies from knownStrategies if they're no longer pending
      // (they were either activated or closed, so if they become PENDING again, we'll detect them)
      for (const knownId of this.knownStrategies) {
        if (!currentPendingIds.has(knownId)) {
          this.knownStrategies.delete(knownId);
        }
      }

      // Check for new strategies we haven't seen before (or that were closed and reopened)
      for (const strategy of pendingStrategies) {
        // Skip MANUAL strategies (auto-generated for orphaned order import)
        if (strategy.isManual) {
          console.log(`⏭️  Skipping MANUAL strategy: ${strategy.name} (never executed by orchestrator)`);
          continue;
        }

        if (!this.knownStrategies.has(strategy.id)) {
          console.log(`📋 New strategy detected: ${strategy.name} (${strategy.symbol})`);
          this.knownStrategies.add(strategy.id);

          // Notify all callbacks
          this.callbacks.forEach(callback => {
            try {
              callback(strategy);
            } catch (error) {
              console.error(`Error in strategy callback for ${strategy.id}:`, error);
            }
          });
        }
      }
    } catch (error) {
      console.error('Error querying for pending strategies:', error);
      throw error;
    }
  }

  /**
   * Force immediate check for new strategies
   */
  async checkNow(): Promise<void> {
    await this.detectNewStrategies();
  }

  /**
   * Reset known strategies (useful for testing)
   */
  resetKnownStrategies(): void {
    this.knownStrategies.clear();
  }

  /**
   * Get count of known strategies
   */
  getKnownStrategyCount(): number {
    return this.knownStrategies.size;
  }
}
