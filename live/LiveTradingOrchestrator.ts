/**
 * Live Trading Orchestrator
 * Main orchestrator for multi-strategy trading system
 */

import * as fs from 'fs';
import { MultiStrategyManager } from './MultiStrategyManager';
import { StrategyLifecycleManager } from './StrategyLifecycleManager';
import { FilesystemWatcher } from './FilesystemWatcher';
import { PortfolioDataFetcher } from '../broker/twsPortfolio';
import { StrategyEvaluatorClient } from '../evaluation/StrategyEvaluatorClient';
import { BaseBrokerAdapter } from '../broker/broker';
import { BrokerEnvironment } from '../spec/types';

export interface OrchestratorConfig {
  brokerAdapter: BaseBrokerAdapter;
  brokerEnv: BrokerEnvironment;
  liveDir: string;
  closedDir: string;
  archiveDir: string;
  evalEndpoint: string;
  evalEnabled: boolean;
  maxConcurrentStrategies: number;
  watchInterval: number;
  twsHost?: string;
  twsPort?: number;
}

export class LiveTradingOrchestrator {
  private multiStrategyManager: MultiStrategyManager;
  private lifecycleManager: StrategyLifecycleManager;
  private filesystemWatcher: FilesystemWatcher;
  private portfolioFetcher: PortfolioDataFetcher;
  private evaluatorClient: StrategyEvaluatorClient;
  private config: OrchestratorConfig;
  private running: boolean = false;
  private mainLoopInterval?: NodeJS.Timeout;
  private swappingSymbols: Set<string> = new Set();  // Track symbols being swapped
  private deployedFiles: Set<string> = new Set();  // Track files deployed by swaps

  constructor(config: OrchestratorConfig) {
    this.config = config;

    // Initialize components
    this.multiStrategyManager = new MultiStrategyManager(config.brokerAdapter, config.brokerEnv);

    const twsHost = config.twsHost || process.env.TWS_HOST || '127.0.0.1';
    const twsPort = config.twsPort || parseInt(process.env.TWS_PORT || '7497');

    this.portfolioFetcher = new PortfolioDataFetcher(twsHost, twsPort, 3);
    this.evaluatorClient = new StrategyEvaluatorClient(config.evalEndpoint, config.evalEnabled);

    this.lifecycleManager = new StrategyLifecycleManager(
      this.multiStrategyManager,
      this.evaluatorClient,
      this.portfolioFetcher,
      config.liveDir,
      config.closedDir,
      config.archiveDir
    );

    // Set orchestrator reference for locking during swaps
    this.lifecycleManager.setOrchestrator(this);

    this.filesystemWatcher = new FilesystemWatcher(config.liveDir, config.watchInterval);
  }

  /**
   * Initialize orchestrator
   */
  async initialize(): Promise<void> {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║                                                          ║');
    console.log('║          MULTI-STRATEGY LIVE TRADING SYSTEM              ║');
    console.log('║                                                          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    // Ensure directories exist
    await this.ensureDirectories();

    // Connect to TWS for portfolio data
    console.log('📡 Connecting to TWS for portfolio data...');
    await this.portfolioFetcher.connect();

    // Fetch and display portfolio value
    try {
      const portfolio = await this.portfolioFetcher.getPortfolioSnapshot();
      console.log('');
      console.log('💰 Portfolio Summary:');
      console.log(`   Account ID: ${portfolio.accountId}`);
      console.log(`   Total Value: $${portfolio.totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      console.log(`   Cash: $${portfolio.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      console.log(`   Buying Power: $${portfolio.buyingPower.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      console.log(`   Unrealized P&L: $${portfolio.unrealizedPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      console.log(`   Realized P&L: $${portfolio.realizedPnL.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      if (portfolio.positions.length > 0) {
        console.log(`   Open Positions: ${portfolio.positions.length}`);
        portfolio.positions.forEach(pos => {
          console.log(`      ${pos.symbol}: ${pos.quantity} shares @ $${pos.currentPrice.toFixed(2)} (P&L: $${pos.unrealizedPnL.toFixed(2)})`);
        });
      }
      console.log('');
    } catch (error) {
      console.warn('⚠️  Could not fetch portfolio data:', error);
    }

    // Load existing strategies from live directory
    await this.loadExistingStrategies();

    // Register filesystem watcher callback
    this.filesystemWatcher.onNewFile(async (filePath) => {
      await this.handleNewStrategyFile(filePath);
    });

    console.log('✓ Orchestrator initialized');
    console.log('');
  }

  /**
   * Start orchestrator
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('Orchestrator already running');
      return;
    }

    this.running = true;

    // Start filesystem watcher
    this.filesystemWatcher.start();

    console.log('════════════════════════════════════════════════════════════');
    console.log('RUNNING MULTI-STRATEGY TRADING LOOP');
    console.log('════════════════════════════════════════════════════════════');
    console.log('');

    // Run main loop
    await this.mainLoop();
  }

  /**
   * Stop orchestrator
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    console.log('');
    console.log('🛑 Stopping orchestrator...');

    this.running = false;

    // Stop filesystem watcher
    this.filesystemWatcher.stop();

    // Clear main loop interval
    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = undefined;
    }

    // Shutdown all strategies
    await this.multiStrategyManager.shutdownAll();

    // Disconnect portfolio fetcher
    await this.portfolioFetcher.disconnect();

    // Close evaluator client
    await this.evaluatorClient.close();

    console.log('✓ Orchestrator stopped');
  }

  /**
   * Main trading loop
   */
  private async mainLoop(): Promise<void> {
    while (this.running) {
      try {
        // Check if market is open
        if (!this.isMarketOpen()) {
          console.log('📴 Market is closed. Exiting orchestrator.');
          await this.stop();
          return;
        }

        // Get all active strategies
        const activeStrategies = this.multiStrategyManager.getActiveStrategies();

        if (activeStrategies.length === 0) {
          console.log('⏸️  No active strategies. Waiting for strategies to be added...');
          await this.sleep(30000); // Wait 30 seconds
          continue;
        }

        console.log(`🔄 Processing bars for ${activeStrategies.length} active strategy(ies)...`);

        // Fetch latest bars for all symbols
        const latestBars = await this.multiStrategyManager.fetchLatestBars();

        // Process bars for each strategy
        for (const [symbol, bars] of latestBars.entries()) {
          const instance = this.multiStrategyManager.getStrategyBySymbol(symbol);
          if (!instance) continue;

          // Process each bar
          for (const bar of bars) {
            await instance.processBar(bar);
          }

          // Check if evaluation is due (every bar for now)
          if (instance.shouldEvaluate(1)) {
            await this.lifecycleManager.evaluateStrategy(instance);
          }
        }

        // Calculate sleep interval (based on shortest timeframe)
        const sleepInterval = this.calculateSleepInterval(activeStrategies);
        console.log(`⏰ Next check in ${Math.round(sleepInterval / 1000)} seconds...`);
        console.log('');

        await this.sleep(sleepInterval);
      } catch (error) {
        console.error('Error in main loop:', error);
        await this.sleep(60000); // Wait 1 minute on error
      }
    }
  }

  /**
   * Handle new strategy file detected by watcher
   */
  private async handleNewStrategyFile(filePath: string): Promise<void> {
    console.log(`📥 New strategy file detected: ${filePath}`);

    try {
      // Check if this file was deployed by a swap operation
      if (this.deployedFiles.has(filePath)) {
        console.log(`⏸️  File ${filePath} was deployed by swap. Skipping auto-load (already loaded).`);
        this.deployedFiles.delete(filePath);  // Clean up
        return;
      }

      // Extract symbol from filename to check if it's being swapped
      const filename = filePath.split('/').pop() || '';
      const symbolMatch = filename.match(/^([A-Z]+)-/);
      const symbol = symbolMatch ? symbolMatch[1] : null;

      // Check if this symbol is currently being swapped
      if (symbol && this.swappingSymbols.has(symbol)) {
        console.log(`⏸️  Symbol ${symbol} is currently being swapped. Skipping auto-load (swap will handle it).`);
        return;
      }

      // Check max concurrent strategies
      if (this.multiStrategyManager.getActiveCount() >= this.config.maxConcurrentStrategies) {
        console.warn(
          `⚠️ Max concurrent strategies (${this.config.maxConcurrentStrategies}) reached. Ignoring new file.`
        );
        return;
      }

      // Load strategy
      await this.multiStrategyManager.loadStrategy(filePath);

      console.log(`✓ Successfully loaded new strategy from ${filePath}`);
    } catch (error: any) {
      console.error(`Failed to load strategy from ${filePath}:`, error.message);

      // Move to archive if invalid
      try {
        const archivedPath = await this.lifecycleManager.moveToArchive(filePath, 'invalid');
        console.log(`📦 Moved invalid strategy to: ${archivedPath}`);
      } catch (archiveError) {
        console.error('Failed to archive invalid strategy:', archiveError);
      }
    }
  }

  /**
   * Load existing strategies from live directory
   */
  private async loadExistingStrategies(): Promise<void> {
    console.log(`📂 Loading existing strategies from: ${this.config.liveDir}`);

    // Check if directory exists
    if (!fs.existsSync(this.config.liveDir)) {
      console.log(`⚠️  Live directory does not exist: ${this.config.liveDir}`);
      return;
    }

    // Read directory
    const files = await fs.promises.readdir(this.config.liveDir);
    const yamlFiles = files.filter(file => file.endsWith('.yaml'));

    console.log(`Found ${yamlFiles.length} strategy file(s)`);

    // Load each strategy
    for (const file of yamlFiles) {
      const filePath = `${this.config.liveDir}/${file}`;

      try {
        await this.multiStrategyManager.loadStrategy(filePath);
      } catch (error: any) {
        console.error(`Failed to load ${file}:`, error.message);

        // Move to archive
        try {
          const archivedPath = await this.lifecycleManager.moveToArchive(filePath, 'invalid');
          console.log(`📦 Moved invalid strategy to: ${archivedPath}`);
        } catch (archiveError) {
          console.error('Failed to archive invalid strategy:', archiveError);
        }
      }
    }

    console.log(`✓ Loaded ${this.multiStrategyManager.getActiveCount()} strategy(ies)`);
  }

  /**
   * Ensure all required directories exist
   */
  private async ensureDirectories(): Promise<void> {
    const dirs = [this.config.liveDir, this.config.closedDir, this.config.archiveDir];

    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    console.log('✓ Ensured directory structure exists');
  }

  /**
   * Check if market is open (9:30 AM - 4:00 PM ET)
   */
  private isMarketOpen(): boolean {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const timeMinutes = hours * 60 + minutes;

    const marketOpen = 9 * 60 + 30; // 9:30 AM
    const marketClose = 16 * 60; // 4:00 PM

    return timeMinutes >= marketOpen && timeMinutes < marketClose;
  }

  /**
   * Calculate sleep interval based on shortest timeframe
   */
  private calculateSleepInterval(strategies: any[]): number {
    // For now, use a fixed 5-second interval
    // TODO: Calculate based on shortest timeframe
    return 5000;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Lock a symbol during swap operation
   */
  lockSymbol(symbol: string): void {
    this.swappingSymbols.add(symbol);
  }

  /**
   * Unlock a symbol after swap operation
   */
  unlockSymbol(symbol: string): void {
    this.swappingSymbols.delete(symbol);
  }

  /**
   * Mark a file as deployed by swap operation (to prevent auto-load)
   */
  markFileAsDeployed(filePath: string): void {
    this.deployedFiles.add(filePath);
  }
}
