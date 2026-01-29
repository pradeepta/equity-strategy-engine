/**
 * Multi-Strategy Manager
 * Manages multiple StrategyInstance objects, coordinates bar distribution
 * Refactored to support multiple strategies per symbol using strategy ID as primary key
 */

import { StrategyInstance } from './StrategyInstance';
import { BaseBrokerAdapter } from '../broker/broker';
import { Bar, BrokerEnvironment } from '../spec/types';
import { StrategyRepository } from '../database/repositories/StrategyRepository';
import { ExecutionHistoryRepository } from '../database/repositories/ExecutionHistoryRepository';
import { BarCacheServiceV2 } from './cache/BarCacheServiceV2';
import { RealtimeBarClient } from './streaming/RealtimeBarClient';

export class MultiStrategyManager {
  private instances: Map<string, StrategyInstance>;  // strategyId -> instance
  private symbolIndex: Map<string, Set<string>>;    // symbol -> Set<strategyId>
  private brokerAdapter: BaseBrokerAdapter;
  private brokerEnv: BrokerEnvironment;
  private strategyRepo: StrategyRepository;
  private execHistoryRepo: ExecutionHistoryRepository;
  private barCache?: BarCacheServiceV2;  // Optional bar cache service V2
  private realtimeBarClient: RealtimeBarClient | null = null;  // Streaming client reference

  constructor(
    adapter: BaseBrokerAdapter,
    brokerEnv: BrokerEnvironment,
    strategyRepo: StrategyRepository,
    execHistoryRepo: ExecutionHistoryRepository,
    barCache?: BarCacheServiceV2
  ) {
    this.instances = new Map();
    this.symbolIndex = new Map();
    this.brokerAdapter = adapter;
    this.brokerEnv = brokerEnv;
    this.strategyRepo = strategyRepo;
    this.execHistoryRepo = execHistoryRepo;
    this.barCache = barCache;

    if (this.barCache) {
      console.log('✓ MultiStrategyManager initialized with bar caching enabled');
    }
  }

  /**
   * Load a strategy from database by ID
   */
  async loadStrategy(strategyId: string): Promise<StrategyInstance> {
    console.log(`Loading strategy from database: ${strategyId}`);

    // Fetch strategy from database
    const strategy = await this.strategyRepo.findByIdWithRelations(strategyId);

    if (!strategy || strategy.deletedAt) {
      throw new Error(`Strategy not found: ${strategyId}`);
    }

    // REMOVED: Duplicate symbol check - now allowed

    // Create strategy instance
    const instance = new StrategyInstance(
      strategy.id,
      strategy.userId,
      strategy.yamlContent,
      strategy.symbol,
      strategy.name,
      this.brokerAdapter,
      this.brokerEnv,
      this.strategyRepo,  // Pass repository for state persistence
      this.execHistoryRepo,  // Pass execution history repository for audit logs
      strategy.activatedAt || undefined  // Pass activation timestamp
    );

    // Initialize (compiles YAML, creates engine)
    await instance.initialize();

    // Set streaming client if available
    if (this.realtimeBarClient) {
      instance.setStreamingClient(this.realtimeBarClient);
    }

    // Store instance by strategy ID
    this.instances.set(strategy.id, instance);

    // Update symbol index
    if (!this.symbolIndex.has(strategy.symbol)) {
      this.symbolIndex.set(strategy.symbol, new Set());
    }
    this.symbolIndex.get(strategy.symbol)!.add(strategy.id);

    console.log(`✓ Loaded strategy: ${instance.strategyName} for ${instance.symbol} (ID: ${strategyId})`);

    return instance;
  }

  /**
   * Remove a strategy by ID
   */
  async removeStrategy(strategyId: string): Promise<void> {
    const instance = this.instances.get(strategyId);
    if (!instance) {
      console.warn(`Strategy ${strategyId} not found`);
      return;
    }

    const symbol = instance.symbol;
    console.log(`Removing strategy ${strategyId} for ${symbol}...`);

    // Shutdown strategy
    await instance.shutdown();

    // Remove from instances map
    this.instances.delete(strategyId);

    // Update symbol index
    const strategyIds = this.symbolIndex.get(symbol);
    if (strategyIds) {
      strategyIds.delete(strategyId);
      // If no more strategies for this symbol, clean up symbol index
      if (strategyIds.size === 0) {
        this.symbolIndex.delete(symbol);
      }
    }

    console.log(`✓ Removed strategy ${strategyId} for ${symbol}`);
  }

  /**
   * Swap strategy by ID (remove old, load new)
   * Now supports swapping one strategy while others on same symbol continue
   */
  async swapStrategyById(
    oldStrategyId: string,
    newStrategyId: string,
    options?: { skipOrderCancel?: boolean }
  ): Promise<void> {
    const oldInstance = this.instances.get(oldStrategyId);
    if (!oldInstance) {
      console.warn(`Old strategy ${oldStrategyId} not found, loading new strategy directly`);
      await this.loadStrategy(newStrategyId);
      return;
    }

    const symbol = oldInstance.symbol;
    console.log(`Swapping strategy ${oldStrategyId} for ${symbol}...`);

    // Cancel orders on old strategy
    if (!options?.skipOrderCancel) {
      // CRITICAL: Verify cancellation succeeded before proceeding with swap
      const cancelResult = await oldInstance.cancelAllOrders();

      if (cancelResult.failed.length > 0) {
        const failedIds = cancelResult.failed.map(f => f.orderId).join(', ');
        const reasons = cancelResult.failed.map(f => f.reason).join('; ');
        const errorMsg = `Cannot swap strategy ${oldStrategyId} for ${symbol} - failed to cancel orders: ${failedIds}. Reasons: ${reasons}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      console.log(`✓ Cancelled ${cancelResult.succeeded.length} orders for strategy ${oldStrategyId}`);
    }

    // Remove old strategy
    await this.removeStrategy(oldStrategyId);

    // Load new strategy from database
    await this.loadStrategy(newStrategyId);

    // Fetch and process latest bar for new strategy immediately
    console.log(`Fetching latest bar for newly swapped ${symbol} strategy...`);
    const latestBars = await this.fetchLatestBarsForSymbols([symbol]);
    const bars = latestBars.get(symbol);
    if (bars && bars.length > 0) {
      const newInstance = this.instances.get(newStrategyId);
      if (newInstance) {
        newInstance.markBarsFetched();
        if (bars.length === 1) {
          await newInstance.processBar(bars[0]);
          console.log(`✓ Processed 1 bar for newly swapped ${symbol} strategy`);
        } else {
          const warmupBars = bars.slice(0, -1);
          const liveBar = bars[bars.length - 1];

          for (const bar of warmupBars) {
            await newInstance.processBar(bar, { replay: true });
          }

          // Process the most recent bar live so the strategy can act immediately
          await newInstance.processBar(liveBar);
          console.log(
            `✓ Warmed up ${warmupBars.length} bar(s) and processed latest bar for ${symbol}`
          );
        }
      }
    }

    console.log(`✓ Swapped strategy ${oldStrategyId} -> ${newStrategyId} for ${symbol}`);
  }

  /**
   * Process bar for a specific symbol
   * Now distributes to ALL strategies for that symbol
   */
  async processBar(symbol: string, bar: Bar): Promise<void> {
    const strategies = this.getStrategiesForSymbol(symbol);
    if (strategies.length === 0) {
      console.warn(`No strategies for ${symbol}`);
      return;
    }

    // Process bar for all strategies on this symbol
    for (const instance of strategies) {
      try {
        await instance.processBar(bar);
      } catch (error) {
        console.error(`Error processing bar for strategy ${instance.strategyId} (${symbol}):`, error);
      }
    }
  }

  /**
   * Deprecated: Use processBar() instead
   * Kept for backward compatibility
   */
  async processBarForSymbol(symbol: string, bar: Bar): Promise<void> {
    return this.processBar(symbol, bar);
  }

  /**
   * Fetch latest bars for all active strategies
   * Returns map of symbol -> bars
   */
  async fetchLatestBars(): Promise<Map<string, Bar[]>> {
    const results = new Map<string, Bar[]>();

    // Get unique symbols from symbol index
    const symbols = Array.from(this.symbolIndex.keys());

    // Fetch bars for each symbol concurrently
    const promises = symbols.map(async (symbol) => {
      try {
        if (!this.barCache) {
          throw new Error('BarCacheService is required for market data. Enable BAR_CACHE_ENABLED=true.');
        }

        // Get any instance for this symbol to get timeframe
        const strategyIds = this.symbolIndex.get(symbol);
        if (!strategyIds || strategyIds.size === 0) {
          return;
        }
        const firstStrategyId = Array.from(strategyIds)[0];
        const instance = this.instances.get(firstStrategyId);
        if (!instance) {
          return;
        }

        const timeframe = instance.getTimeframe();
        const bars = await this.barCache.getBars(symbol, timeframe, 100);

        // Filter new bars for the first instance (all share same bars)
        const newBars = instance.filterNewBars(bars);

        results.set(symbol, newBars);
      } catch (error) {
        console.error(`Failed to fetch bars for ${symbol}:`, error);
      }
    });

    await Promise.all(promises);

    return results;
  }

  /**
   * Fetch latest bars for specific symbols only
   * Returns map of symbol -> bars
   *
   * If bar cache is enabled, uses BarCacheService for efficient fetching.
   * Otherwise, falls back to direct TWS client calls.
   */
  async fetchLatestBarsForSymbols(symbols: string[], options?: { forceRefresh?: boolean; includeForming?: boolean }): Promise<Map<string, Bar[]>> {
    const results = new Map<string, Bar[]>();

    // Fetch bars for each symbol concurrently
    const promises = symbols.map(async (symbol) => {
      try {
        const strategies = this.getStrategiesForSymbol(symbol);
        if (strategies.length === 0) {
          console.warn(`No strategy instances for ${symbol}`);
          return;
        }

        // Use first strategy to get timeframe
        const firstInstance = strategies[0];
        const timeframe = firstInstance.getTimeframe();

        let bars: Bar[];

        if (!this.barCache) {
          throw new Error('BarCacheService is required for market data. Enable BAR_CACHE_ENABLED=true.');
        }

        bars = await this.barCache.getBars(symbol, timeframe, 100, {
          forceRefresh: options?.forceRefresh || false,
          includeForming: options?.includeForming || false
        });
        results.set(symbol, bars);
      } catch (error) {
        console.error(`Failed to fetch bars for ${symbol}:`, error);
      }
    });

    await Promise.all(promises);

    return results;
  }

  /**
   * Get all active strategies
   */
  getActiveStrategies(): StrategyInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get strategies for a specific symbol
   * Returns array of all strategies trading that symbol
   */
  getStrategiesForSymbol(symbol: string): StrategyInstance[] {
    const strategyIds = this.symbolIndex.get(symbol);
    if (!strategyIds || strategyIds.size === 0) {
      return [];
    }

    return Array.from(strategyIds)
      .map(id => this.instances.get(id))
      .filter(instance => instance !== undefined) as StrategyInstance[];
  }

  /**
   * Get strategy by ID
   */
  getStrategyById(strategyId: string): StrategyInstance | undefined {
    return this.instances.get(strategyId);
  }

  /**
   * Deprecated: Use getStrategiesForSymbol() instead
   * Returns first strategy for symbol for backward compatibility
   */
  getStrategyBySymbol(symbol: string): StrategyInstance | undefined {
    const strategies = this.getStrategiesForSymbol(symbol);
    return strategies.length > 0 ? strategies[0] : undefined;
  }

  /**
   * Get count of active strategies
   */
  getActiveCount(): number {
    return this.instances.size;
  }

  /**
   * Get count of strategies for a specific symbol
   */
  getActiveCountForSymbol(symbol: string): number {
    const strategyIds = this.symbolIndex.get(symbol);
    return strategyIds ? strategyIds.size : 0;
  }

  /**
   * Set real-time bar streaming client
   * Will be passed to all strategy instances
   */
  setStreamingClient(client: RealtimeBarClient | null): void {
    this.realtimeBarClient = client;

    // Update all existing instances
    for (const instance of this.instances.values()) {
      instance.setStreamingClient(client!);
    }

    if (client) {
      console.log(`✓ Real-time streaming client set for ${this.instances.size} strategy instance(s)`);
    }
  }

  /**
   * Shutdown all strategies
   */
  async shutdownAll(): Promise<void> {
    console.log('Shutting down all strategies...');

    const promises = Array.from(this.instances.keys()).map(strategyId =>
      this.removeStrategy(strategyId)
    );

    await Promise.all(promises);

    console.log('✓ All strategies shut down');
  }
}
