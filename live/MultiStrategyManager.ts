/**
 * Multi-Strategy Manager
 * Manages multiple StrategyInstance objects, coordinates bar distribution
 */

import * as fs from 'fs';
import * as path from 'path';
import { StrategyInstance } from './StrategyInstance';
import { TwsMarketDataClient } from '../broker/twsMarketData';
import { BaseBrokerAdapter } from '../broker/broker';
import { Bar, BrokerEnvironment } from '../spec/types';

export class MultiStrategyManager {
  private instances: Map<string, StrategyInstance>;  // symbol -> instance
  private brokerAdapter: BaseBrokerAdapter;
  private brokerEnv: BrokerEnvironment;
  private marketDataClients: Map<string, TwsMarketDataClient>;  // symbol -> client
  private clientIdCounter: number = 10;  // Start at 10 to avoid conflicts with main clients

  constructor(adapter: BaseBrokerAdapter, brokerEnv: BrokerEnvironment) {
    this.instances = new Map();
    this.brokerAdapter = adapter;
    this.brokerEnv = brokerEnv;
    this.marketDataClients = new Map();
  }

  /**
   * Load a strategy from YAML file
   */
  async loadStrategy(yamlPath: string): Promise<StrategyInstance> {
    // Check if file exists
    if (!fs.existsSync(yamlPath)) {
      throw new Error(`Strategy file not found: ${yamlPath}`);
    }

    console.log(`Loading strategy from: ${yamlPath}`);

    // Create strategy instance
    const instance = new StrategyInstance(yamlPath, this.brokerAdapter, this.brokerEnv);

    // Initialize (loads YAML, compiles, creates engine)
    await instance.initialize();

    // Check for duplicate symbol
    if (this.instances.has(instance.symbol)) {
      throw new Error(
        `Strategy for ${instance.symbol} already loaded. Remove existing first or use swapStrategy().`
      );
    }

    // Store instance
    this.instances.set(instance.symbol, instance);

    // Create market data client for this symbol
    const clientId = this.clientIdCounter++;
    const twsHost = process.env.TWS_HOST || '127.0.0.1';
    const twsPort = parseInt(process.env.TWS_PORT || '7497');
    const marketDataClient = new TwsMarketDataClient(twsHost, twsPort, clientId);
    this.marketDataClients.set(instance.symbol, marketDataClient);

    console.log(`✓ Loaded strategy: ${instance.strategyName} for ${instance.symbol}`);

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
   * Swap strategy for a symbol (remove old, load new)
   */
  async swapStrategy(symbol: string, newYamlPath: string): Promise<void> {
    console.log(`Swapping strategy for ${symbol}...`);

    // Cancel orders on old strategy
    const oldInstance = this.instances.get(symbol);
    if (oldInstance) {
      await oldInstance.cancelAllOrders();
      await this.removeStrategy(symbol);
    }

    // Load new strategy
    await this.loadStrategy(newYamlPath);

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
