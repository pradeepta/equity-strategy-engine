/**
 * Multi-Strategy Manager
 * Manages multiple StrategyInstance objects, coordinates bar distribution
 * Updated to work with database instead of filesystem
 */

import { StrategyInstance } from './StrategyInstance';
import { TwsMarketDataClient } from '../broker/twsMarketData';
import { BaseBrokerAdapter } from '../broker/broker';
import { Bar, BrokerEnvironment } from '../spec/types';
import { StrategyRepository } from '../database/repositories/StrategyRepository';

export class MultiStrategyManager {
  private instances: Map<string, StrategyInstance>;  // symbol -> instance
  private brokerAdapter: BaseBrokerAdapter;
  private brokerEnv: BrokerEnvironment;
  private marketDataClients: Map<string, TwsMarketDataClient>;  // symbol -> client
  private clientIdCounter: number = 10;  // Start at 10 to avoid conflicts with main clients
  private strategyRepo: StrategyRepository;

  constructor(adapter: BaseBrokerAdapter, brokerEnv: BrokerEnvironment, strategyRepo: StrategyRepository) {
    this.instances = new Map();
    this.brokerAdapter = adapter;
    this.brokerEnv = brokerEnv;
    this.marketDataClients = new Map();
    this.strategyRepo = strategyRepo;
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

    // Check for duplicate symbol
    if (this.instances.has(strategy.symbol)) {
      throw new Error(
        `Strategy for ${strategy.symbol} already loaded. Remove existing first or use swapStrategyById().`
      );
    }

    // Create strategy instance
    const instance = new StrategyInstance(
      strategy.id,
      strategy.userId,
      strategy.yamlContent,
      strategy.symbol,
      strategy.name,
      this.brokerAdapter,
      this.brokerEnv
    );

    // Initialize (compiles YAML, creates engine)
    await instance.initialize();

    // Store instance
    this.instances.set(strategy.symbol, instance);

    // Create market data client for this symbol
    const clientId = this.clientIdCounter++;
    const twsHost = process.env.TWS_HOST || '127.0.0.1';
    const twsPort = parseInt(process.env.TWS_PORT || '7497');
    const marketDataClient = new TwsMarketDataClient(twsHost, twsPort, clientId);
    this.marketDataClients.set(instance.symbol, marketDataClient);

    console.log(`✓ Loaded strategy: ${instance.strategyName} for ${instance.symbol} (ID: ${strategyId})`);

    return instance;
  }

  /**
   * Remove a strategy by symbol
   */
  async removeStrategy(symbol: string): Promise<void> {
    const instance = this.instances.get(symbol);
    if (!instance) {
      console.warn(`Strategy for ${symbol} not found`);
      return;
    }

    console.log(`Removing strategy for ${symbol}...`);

    // Shutdown strategy
    await instance.shutdown();

    // Remove from map
    this.instances.delete(symbol);

    // Remove market data client
    this.marketDataClients.delete(symbol);

    console.log(`✓ Removed strategy for ${symbol}`);
  }

  /**
   * Swap strategy for a symbol by ID (remove old, load new)
   */
  async swapStrategyById(symbol: string, newStrategyId: string): Promise<void> {
    console.log(`Swapping strategy for ${symbol}...`);

    // Cancel orders on old strategy
    const oldInstance = this.instances.get(symbol);
    if (oldInstance) {
      await oldInstance.cancelAllOrders();
      await this.removeStrategy(symbol);
    }

    // Load new strategy from database
    await this.loadStrategy(newStrategyId);

    // Fetch and process latest bar for new strategy immediately
    console.log(`Fetching latest bar for newly swapped ${symbol} strategy...`);
    const latestBars = await this.fetchLatestBarsForSymbols([symbol]);
    const bars = latestBars.get(symbol);
    if (bars && bars.length > 0) {
      const newInstance = this.instances.get(symbol);
      if (newInstance) {
        newInstance.markBarsFetched();
        for (const bar of bars) {
          await newInstance.processBar(bar);
        }
        console.log(`✓ Processed ${bars.length} bar(s) for newly swapped ${symbol} strategy`);
      }
    }

    console.log(`✓ Swapped strategy for ${symbol}`);
  }

  /**
   * Process bar for a specific symbol
   */
  async processBarForSymbol(symbol: string, bar: Bar): Promise<void> {
    const instance = this.instances.get(symbol);
    if (!instance) {
      console.warn(`No strategy for ${symbol}`);
      return;
    }

    await instance.processBar(bar);
  }

  /**
   * Fetch latest bars for all active strategies
   * Returns map of symbol -> bars
   */
  async fetchLatestBars(): Promise<Map<string, Bar[]>> {
    const results = new Map<string, Bar[]>();

    // Fetch bars for each symbol concurrently
    const promises = Array.from(this.instances.entries()).map(async ([symbol, instance]) => {
      try {
        const client = this.marketDataClients.get(symbol);
        if (!client) {
          console.warn(`No market data client for ${symbol}`);
          return;
        }

        const timeframe = instance.getTimeframe();
        const bars = await client.getHistoricalBars(symbol, 2, timeframe);

        results.set(symbol, bars);
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
   */
  async fetchLatestBarsForSymbols(symbols: string[]): Promise<Map<string, Bar[]>> {
    const results = new Map<string, Bar[]>();

    // Fetch bars for each symbol concurrently
    const promises = symbols.map(async (symbol) => {
      try {
        const instance = this.instances.get(symbol);
        if (!instance) {
          console.warn(`No strategy instance for ${symbol}`);
          return;
        }

        const client = this.marketDataClients.get(symbol);
        if (!client) {
          console.warn(`No market data client for ${symbol}`);
          return;
        }

        const timeframe = instance.getTimeframe();
        const bars = await client.getHistoricalBars(symbol, 2, timeframe);

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
   * Get strategy by symbol
   */
  getStrategyBySymbol(symbol: string): StrategyInstance | undefined {
    return this.instances.get(symbol);
  }

  /**
   * Get count of active strategies
   */
  getActiveCount(): number {
    return this.instances.size;
  }

  /**
   * Shutdown all strategies
   */
  async shutdownAll(): Promise<void> {
    console.log('Shutting down all strategies...');

    const promises = Array.from(this.instances.keys()).map(symbol =>
      this.removeStrategy(symbol)
    );

    await Promise.all(promises);

    console.log('✓ All strategies shut down');
  }
}
