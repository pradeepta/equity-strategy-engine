/**
 * Live Trading Orchestrator
 * Main orchestrator for multi-strategy trading system
 * Updated to use database instead of filesystem
 */

import { MultiStrategyManager } from "./MultiStrategyManager";
import { StrategyLifecycleManager } from "./StrategyLifecycleManager";
import { DatabasePoller } from "./DatabasePoller";
import { PortfolioDataFetcher } from "../broker/twsPortfolio";
import { StrategyEvaluatorClient } from "../evaluation/StrategyEvaluatorClient";
import { BaseBrokerAdapter } from "../broker/broker";
import { BrokerEnvironment } from "../spec/types";
import { RepositoryFactory } from "../database/RepositoryFactory";
import { Strategy } from "@prisma/client";
import { OperationQueueService } from "./queue/OperationQueueService";
import { DistributedLockService } from "./locking/DistributedLockService";
import { BrokerReconciliationService } from "./reconciliation/BrokerReconciliationService";
import { OrderAlertService } from "./alerts/OrderAlertService";
import { LoggerFactory } from "../logging/logger";
import { Logger } from "../logging/logger";

// Logger will be initialized in constructor after LoggerFactory is set up
let logger: Logger;

export interface OrchestratorConfig {
  brokerAdapter: BaseBrokerAdapter;
  brokerEnv: BrokerEnvironment;
  userId: string; // User ID for database queries
  evalEndpoint: string;
  evalEnabled: boolean;
  maxConcurrentStrategies: number;
  watchInterval: number;
  twsHost?: string;
  twsPort?: number;
  allowCrossSymbolSwap?: boolean;
}

export class LiveTradingOrchestrator {
  private multiStrategyManager: MultiStrategyManager;
  private lifecycleManager: StrategyLifecycleManager;
  private databasePoller: DatabasePoller;
  private portfolioFetcher: PortfolioDataFetcher;
  private evaluatorClient: StrategyEvaluatorClient;
  private repositoryFactory: RepositoryFactory;
  private operationQueue: OperationQueueService;
  private lockService: DistributedLockService;
  private reconciliationService: BrokerReconciliationService;
  private alertService: OrderAlertService;
  private config: OrchestratorConfig;
  private running: boolean = false;
  private mainLoopInterval?: NodeJS.Timeout;
  private currentSleepResolve?: () => void; // Resolve function to interrupt sleep
  private currentSleepTimeout?: NodeJS.Timeout; // Timeout reference to clear
  private lastReconciliationTime: number = 0;
  private reconciliationIntervalMs: number = 5 * 60 * 1000; // 5 minutes

  constructor(
    config: OrchestratorConfig,
    repositoryFactory?: RepositoryFactory
  ) {
    // Initialize logger first - LoggerFactory.setPrisma() must be called before this
    logger = LoggerFactory.getLogger('orchestrator');

    this.config = config;
    this.repositoryFactory = repositoryFactory || new RepositoryFactory();

    // Get repositories
    const strategyRepo = this.repositoryFactory.getStrategyRepo();
    const execHistoryRepo = this.repositoryFactory.getExecutionHistoryRepo();
    const orderRepo = this.repositoryFactory.getOrderRepo();
    const systemLogRepo = this.repositoryFactory.getSystemLogRepo();

    // Provide audit logger for runtime components
    if (!this.config.brokerEnv.auditEvent) {
      this.config.brokerEnv.auditEvent = (entry) => {
        const level = entry.level?.toUpperCase() || "INFO";
        systemLogRepo
          .create({
            level: level as "DEBUG" | "INFO" | "WARN" | "ERROR",
            component: entry.component,
            message: entry.message,
            metadata: entry.metadata,
          })
          .catch((error) => {
            logger.warn("Failed to write system log to database", error as Error);
          });
      };
    }

    // Initialize operation queue service
    this.operationQueue = new OperationQueueService(
      this.repositoryFactory.getPrisma()
    );

    // Initialize distributed lock service
    this.lockService = new DistributedLockService(
      this.repositoryFactory.getPool()
    );

    // Initialize alert service
    this.alertService = new OrderAlertService([
      { type: "console", enabled: true },
      // Add webhook/email channels as needed:
      // { type: 'webhook', enabled: true, config: { url: process.env.ALERT_WEBHOOK_URL } },
    ]);

    // Initialize reconciliation service
    this.reconciliationService = new BrokerReconciliationService(
      this.repositoryFactory.getOrderRepo(),
      this.alertService,
      this.repositoryFactory.getSystemLogRepo()
    );

    // Initialize components
    this.multiStrategyManager = new MultiStrategyManager(
      config.brokerAdapter,
      config.brokerEnv,
      strategyRepo
    );

    const twsHost = config.twsHost || process.env.TWS_HOST || "127.0.0.1";
    const twsPort = config.twsPort || parseInt(process.env.TWS_PORT || "7497");

    this.portfolioFetcher = new PortfolioDataFetcher(twsHost, twsPort, 3);
    this.evaluatorClient = new StrategyEvaluatorClient(
      config.evalEndpoint,
      config.evalEnabled
    );

    this.lifecycleManager = new StrategyLifecycleManager(
      this.multiStrategyManager,
      this.evaluatorClient,
      this.portfolioFetcher,
      strategyRepo,
      execHistoryRepo,
      orderRepo,
      systemLogRepo,
      this.operationQueue
    );

    // Set orchestrator reference for locking during swaps
    this.lifecycleManager.setOrchestrator(this);

    this.databasePoller = new DatabasePoller(
      strategyRepo,
      config.userId,
      config.watchInterval
    );
  }

  /**
   * Initialize orchestrator
   */
  async initialize(): Promise<void> {
    logger.info("Initializing Multi-Strategy Live Trading System");

    // Check database connection
    const dbHealthy = await this.repositoryFactory.healthCheck();
    if (!dbHealthy) {
      logger.error("Database connection failed");
      throw new Error("Database connection failed");
    }
    logger.info("Database connection verified");

    // Release stuck locks from crashed processes
    logger.info("Releasing stuck operation locks");
    const releasedCount = await this.operationQueue.releaseStuckLocks();
    if (releasedCount > 0) {
      logger.info(`Released stuck operation locks`, { releasedCount });
    }

    // Connect to TWS for portfolio data
    logger.info("Connecting to TWS for portfolio data", {
      host: this.config.twsHost,
      port: this.config.twsPort
    });
    await this.portfolioFetcher.connect();

    // Fetch and display portfolio value
    try {
      const portfolio = await this.portfolioFetcher.getPortfolioSnapshot();
      logger.info("Portfolio snapshot retrieved", {
        accountId: portfolio.accountId,
        totalValue: portfolio.totalValue,
        cash: portfolio.cash,
        buyingPower: portfolio.buyingPower,
        unrealizedPnL: portfolio.unrealizedPnL,
        realizedPnL: portfolio.realizedPnL,
        openPositions: portfolio.positions.length
      });

      if (portfolio.positions.length > 0) {
        portfolio.positions.forEach((pos) => {
          logger.debug("Open position", {
            symbol: pos.symbol,
            quantity: pos.quantity,
            currentPrice: pos.currentPrice,
            unrealizedPnL: pos.unrealizedPnL
          });
        });
      }
      logger.info("");
      logger.info("🛡️  Risk Controls:");
      logger.info("Risk controls configured", {
        allowLiveOrders: this.config.brokerEnv.allowLiveOrders !== false,
        allowCancelEntries: this.config.brokerEnv.allowCancelEntries === true
      });
      logger.info("Risk limits configured", {
        maxOrdersPerSymbol: this.config.brokerEnv.maxOrdersPerSymbol ?? "unset",
        maxOrderQty: this.config.brokerEnv.maxOrderQty ?? "unset",
        maxNotionalPerSymbol: this.config.brokerEnv.maxNotionalPerSymbol ?? "unset",
        dailyLossLimit: this.config.brokerEnv.dailyLossLimit ?? "unset"
      });
      logger.info("");
    } catch (error) {
      logger.warn("⚠️  Could not fetch portfolio data:", error as Error);
    }

    // Load existing strategies from database
    await this.loadExistingStrategies();

    // Run broker reconciliation on startup
    await this.runStartupReconciliation();

    // Register database poller callback
    this.databasePoller.onNewStrategy(async (strategy) => {
      await this.handleNewStrategyFromDB(strategy);
    });

    logger.info("✓ Orchestrator initialized");
    logger.info("");
  }

  /**
   * Start orchestrator
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn("Orchestrator already running");
      return;
    }

    this.running = true;

    // Start database poller
    this.databasePoller.start();

    logger.info("════════════════════════════════════════════════════════════");
    logger.info("RUNNING MULTI-STRATEGY TRADING LOOP");
    logger.info("════════════════════════════════════════════════════════════");
    logger.info("");

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

    logger.info("");
    logger.info("🛑 Stopping orchestrator...");

    this.running = false;

    // Stop database poller
    this.databasePoller.stop();

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

    logger.info("✓ Orchestrator stopped");
  }

  /**
   * Main trading loop
   */
  private async mainLoop(): Promise<void> {
    while (this.running) {
      try {
        // Check if market is open
        // if (!this.isMarketOpen()) {
        //   logger.info('📴 Market is closed. Exiting orchestrator.');
        //   await this.stop();
        //   return;
        // }

        // Get all active strategies
        const activeStrategies =
          this.multiStrategyManager.getActiveStrategies();

        if (activeStrategies.length === 0) {
          logger.info(
            "⏸️  No active strategies. Waiting for strategies to be added..."
          );
          await this.sleep(30000); // Wait 30 seconds
          continue;
        }

        // Update risk snapshot for broker environment
        try {
          const portfolio = await this.portfolioFetcher.getPortfolioSnapshot();
          const previousDailyPnL = this.config.brokerEnv.currentDailyPnL;
          this.config.brokerEnv.currentDailyPnL =
            portfolio.realizedPnL + portfolio.unrealizedPnL;

          // Audit log when daily loss limit is first breached
          if (
            this.config.brokerEnv.dailyLossLimit !== undefined &&
            this.config.brokerEnv.currentDailyPnL !== undefined &&
            this.config.brokerEnv.currentDailyPnL <= -this.config.brokerEnv.dailyLossLimit &&
            (previousDailyPnL === undefined ||
              previousDailyPnL > -this.config.brokerEnv.dailyLossLimit)
          ) {
            const systemLogRepo = this.repositoryFactory.getSystemLogRepo();
            await systemLogRepo.create({
              level: "ERROR",
              component: "LiveTradingOrchestrator",
              message: "Daily loss limit breached",
              metadata: {
                currentDailyPnL: this.config.brokerEnv.currentDailyPnL,
                dailyLossLimit: this.config.brokerEnv.dailyLossLimit,
                realizedPnL: portfolio.realizedPnL,
                unrealizedPnL: portfolio.unrealizedPnL,
                breachAmount:
                  Math.abs(this.config.brokerEnv.currentDailyPnL) -
                  this.config.brokerEnv.dailyLossLimit,
              },
            });
            logger.error(
              `🚨 DAILY LOSS LIMIT BREACHED: ${this.config.brokerEnv.currentDailyPnL.toFixed(2)} <= -${this.config.brokerEnv.dailyLossLimit.toFixed(2)}`
            );
          }
        } catch (error) {
          logger.warn(
            "⚠️  Failed to refresh portfolio snapshot for risk caps:",
            error as Error
          );
        }

        // Check which strategies need bar updates based on their timeframe
        const strategiesNeedingBars: string[] = [];
        for (const instance of activeStrategies) {
          const timeframe = instance.getTimeframe();
          const timeframeMs = this.timeframeToMilliseconds(timeframe);

          if (instance.shouldFetchBars(timeframeMs)) {
            strategiesNeedingBars.push(instance.symbol);
          }
        }

        if (strategiesNeedingBars.length === 0) {
          logger.info(
            `⏭️  No strategies need bar updates yet (all waiting for timeframe intervals)`
          );
        } else {
          logger.info(
            `🔄 Fetching bars for ${strategiesNeedingBars.length}/${
              activeStrategies.length
            } strategy(ies): ${strategiesNeedingBars.join(", ")}`
          );

          // Fetch latest bars only for symbols that need updates
          const latestBars =
            await this.multiStrategyManager.fetchLatestBarsForSymbols(
              strategiesNeedingBars
            );

          // Process bars for each strategy
          for (const [symbol, bars] of latestBars.entries()) {
            const instance =
              this.multiStrategyManager.getStrategyBySymbol(symbol);
            if (!instance) continue;

            // Mark bars as fetched
            instance.markBarsFetched();

            // Process bars: warm up on historical bars, act only on latest
            if (bars.length === 0) {
              continue;
            }

            if (bars.length === 1) {
              await instance.processBar(bars[0]);
            } else {
              const warmupBars = bars.slice(0, -1);
              const liveBar = bars[bars.length - 1];

              for (const bar of warmupBars) {
                await instance.processBar(bar, { replay: true });
              }

              await instance.processBar(liveBar);
            }

            // Check if evaluation is due (every bar for now)
            if (instance.shouldEvaluate(1)) {
              await this.lifecycleManager.evaluateStrategy(instance);
            }
          }
        }

        // Run periodic reconciliation (if due)
        await this.runPeriodicReconciliation();

        // Calculate sleep interval (based on shortest timeframe)
        const sleepInterval = this.calculateSleepInterval(activeStrategies);
        const sleepSeconds = Math.round(sleepInterval / 1000);
        const humanReadable = this.formatDuration(sleepInterval);
        logger.info(`⏰ Next check in ${humanReadable} (${sleepSeconds}s)`);
        logger.info("");

        await this.sleep(sleepInterval);
      } catch (error) {
        logger.error("Error in main loop:", error as Error);
        await this.sleep(60000); // Wait 1 minute on error
      }
    }
  }

  /**
   * Handle new strategy detected by database poller
   */
  private async handleNewStrategyFromDB(strategy: Strategy): Promise<void> {
    logger.info(
      `📥 New strategy detected: ${strategy.name} (${strategy.symbol})`
    );

    try {
      // Check if this symbol is currently being swapped (distributed lock check)
      const lockKey = DistributedLockService.symbolLockKey(strategy.symbol);
      if (await this.lockService.isLocked(lockKey)) {
        logger.info(
          `⏸️  Symbol ${strategy.symbol} is currently locked (swap in progress). Skipping auto-load.`
        );
        return;
      }

      // Check if strategy for this symbol already exists
      if (this.multiStrategyManager.getStrategyBySymbol(strategy.symbol)) {
        logger.info(
          `⚠️  Strategy for ${strategy.symbol} already loaded. Skipping.`
        );
        return;
      }

      // Check max concurrent strategies
      if (
        this.multiStrategyManager.getActiveCount() >=
        this.config.maxConcurrentStrategies
      ) {
        logger.warn(
          `⚠️ Max concurrent strategies (${this.config.maxConcurrentStrategies}) reached. Ignoring new strategy.`
        );
        return;
      }

      // Load strategy
      await this.multiStrategyManager.loadStrategy(strategy.id);

      // Mark as active
      await this.repositoryFactory.getStrategyRepo().activate(strategy.id);

      logger.info(`✓ Successfully loaded strategy ${strategy.name}`);

      // Wake up main loop to recalculate interval immediately
      this.wakeUpEarly();
    } catch (error: any) {
      logger.error(`Failed to load strategy ${strategy.name}:`, error.message);

      // Mark strategy as failed
      await this.repositoryFactory
        .getStrategyRepo()
        .markFailed(strategy.id, error.message);
    }
  }

  /**
   * Load existing strategies from database
   */
  private async loadExistingStrategies(): Promise<void> {
    logger.info(
      `📊 Loading existing strategies from database for user: ${this.config.userId}`
    );

    const strategies = await this.repositoryFactory
      .getStrategyRepo()
      .findActiveByUser(this.config.userId);
    logger.info(`Found ${strategies.length} active strategy(ies)`);

    // Load each strategy
    for (const strategy of strategies) {
      try {
        await this.multiStrategyManager.loadStrategy(strategy.id);
        logger.info(`✓ Loaded ${strategy.name} (${strategy.symbol})`);
      } catch (error: any) {
        logger.error(`Failed to load ${strategy.name}:`, error.message);

        // Mark as failed
        await this.repositoryFactory
          .getStrategyRepo()
          .markFailed(strategy.id, error.message);
      }
    }

    logger.info(
      `✓ Loaded ${this.multiStrategyManager.getActiveCount()} strategy(ies)`
    );
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
    if (strategies.length === 0) {
      return 30000; // 30 seconds if no strategies
    }

    // Get all timeframes and find the shortest
    let shortestIntervalMs = Number.MAX_SAFE_INTEGER;

    for (const strategy of strategies) {
      const timeframe = strategy.getTimeframe();
      const intervalMs = this.timeframeToMilliseconds(timeframe);

      if (intervalMs < shortestIntervalMs) {
        shortestIntervalMs = intervalMs;
      }
    }

    // Add 10% buffer to avoid hitting exactly on bar close
    const bufferMs = Math.floor(shortestIntervalMs * 0.1);
    return shortestIntervalMs + bufferMs;
  }

  /**
   * Convert timeframe string to milliseconds
   */
  private timeframeToMilliseconds(timeframe: string): number {
    // Parse timeframe format like "1m", "5m", "1h", "1d"
    const match = timeframe.match(/^(\d+)([smhd])$/i);

    if (!match) {
      logger.warn(
        `Unknown timeframe format: ${timeframe}, defaulting to 5 minutes`
      );
      return 5 * 60 * 1000; // 5 minutes default
    }

    const value = parseInt(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "s": // seconds
        return value * 1000;
      case "m": // minutes
        return value * 60 * 1000;
      case "h": // hours
        return value * 60 * 60 * 1000;
      case "d": // days
        return value * 24 * 60 * 60 * 1000;
      default:
        return 5 * 60 * 1000; // 5 minutes default
    }
  }

  /**
   * Format duration in milliseconds to human-readable string
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      const remainingHours = hours % 24;
      return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
    } else if (hours > 0) {
      const remainingMinutes = minutes % 60;
      return remainingMinutes > 0
        ? `${hours}h ${remainingMinutes}m`
        : `${hours}h`;
    } else if (minutes > 0) {
      const remainingSeconds = seconds % 60;
      return remainingSeconds > 0
        ? `${minutes}m ${remainingSeconds}s`
        : `${minutes}m`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Sleep for specified milliseconds (interruptible)
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.currentSleepResolve = resolve;
      this.currentSleepTimeout = setTimeout(() => {
        this.currentSleepResolve = undefined;
        this.currentSleepTimeout = undefined;
        resolve();
      }, ms);
    });
  }

  /**
   * Interrupt current sleep and wake up immediately
   */
  private wakeUpEarly(): void {
    if (this.currentSleepTimeout) {
      clearTimeout(this.currentSleepTimeout);
      this.currentSleepTimeout = undefined;
    }
    if (this.currentSleepResolve) {
      logger.info("⚡ Waking up early due to new strategy...");
      this.currentSleepResolve();
      this.currentSleepResolve = undefined;
    }
  }

  /**
   * Lock a symbol during swap operation
   * Now uses distributed PostgreSQL advisory locks
   * Reduced timeout from 30s to 5s to fail fast on contention
   */
  async lockSymbol(symbol: string): Promise<boolean> {
    const lockKey = DistributedLockService.symbolLockKey(symbol);
    return await this.lockService.acquireLock(lockKey, 5000); // 5 seconds instead of 30
  }

  /**
   * Unlock a symbol after swap operation
   */
  async unlockSymbol(symbol: string): Promise<void> {
    const lockKey = DistributedLockService.symbolLockKey(symbol);
    await this.lockService.releaseLock(lockKey);
  }

  /**
   * Check if a symbol is currently locked (non-blocking)
   */
  async isSymbolLocked(symbol: string): Promise<boolean> {
    const lockKey = DistributedLockService.symbolLockKey(symbol);
    return await this.lockService.isLocked(lockKey);
  }

  /**
   * Run broker reconciliation on startup
   * Detects and auto-cancels orphaned orders at broker
   */
  private async runStartupReconciliation(): Promise<void> {
    const activeStrategies = this.multiStrategyManager.getActiveStrategies();
    if (activeStrategies.length === 0) {
      logger.info("ℹ️  No active strategies - skipping startup reconciliation");
      return;
    }

    // Collect all symbols from active strategies
    const symbols = [...new Set(activeStrategies.map((s) => s.symbol))];

    logger.info(
      `🔍 Running startup reconciliation for ${
        symbols.length
      } symbol(s): ${symbols.join(", ")}`
    );

    try {
      const report = await this.reconciliationService.reconcileOnStartup(
        this.config.brokerAdapter,
        symbols,
        this.config.brokerEnv
      );

      // Log summary
      if (
        report.orphanedOrders.length === 0 &&
        report.missingOrders.length === 0
      ) {
        logger.info("✓ Reconciliation complete - no discrepancies found");
      } else {
        logger.info(
          `⚠️  Reconciliation complete - found ${report.orphanedOrders.length} orphaned, ${report.missingOrders.length} missing`
        );
      }

      // Update last reconciliation time
      this.lastReconciliationTime = Date.now();
    } catch (error) {
      logger.error("❌ Startup reconciliation failed:", error as Error);
    }
  }

  /**
   * Run periodic broker reconciliation
   * Called from main loop every N minutes
   */
  private async runPeriodicReconciliation(): Promise<void> {
    const now = Date.now();
    const timeSinceLastReconciliation = now - this.lastReconciliationTime;

    // Check if it's time for reconciliation
    if (timeSinceLastReconciliation < this.reconciliationIntervalMs) {
      return; // Not time yet
    }

    const activeStrategies = this.multiStrategyManager.getActiveStrategies();
    if (activeStrategies.length === 0) {
      return; // No active strategies
    }

    // Collect all symbols from active strategies
    const symbols = [...new Set(activeStrategies.map((s) => s.symbol))];

    logger.info(
      `\n🔍 Running periodic reconciliation for ${symbols.length} symbol(s)...`
    );

    try {
      const report = await this.reconciliationService.reconcilePeriodic(
        this.config.brokerAdapter,
        symbols,
        this.config.brokerEnv
      );

      // Log if any discrepancies found
      if (report.orphanedOrders.length > 0 || report.missingOrders.length > 0) {
        logger.warn(
          `⚠️  Reconciliation found discrepancies - orphaned: ${report.orphanedOrders.length}, missing: ${report.missingOrders.length}`
        );
      }

      // Update last reconciliation time
      this.lastReconciliationTime = now;
    } catch (error) {
      logger.error("❌ Periodic reconciliation failed:", error as Error);
    }
  }

  /**
   * Get evaluator client for error checking
   */
  getEvaluatorClient(): StrategyEvaluatorClient {
    return this.evaluatorClient;
  }
}
