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
import { BrokerEnvironment, Bar } from "../spec/types";
import { RepositoryFactory } from "../database/RepositoryFactory";
import { Strategy } from "@prisma/client";
import { OperationQueueService } from "./queue/OperationQueueService";
import { DistributedLockService } from "./locking/DistributedLockService";
import { BrokerReconciliationService } from "./reconciliation/BrokerReconciliationService";
import { OrderAlertService } from "./alerts/OrderAlertService";
import { LoggerFactory } from "../logging/logger";
import { Logger } from "../logging/logger";
import { BarCacheServiceV2 } from "./cache/BarCacheServiceV2";
import { isMarketOpen as checkMarketOpen } from "../utils/marketHours";
import { RealtimeBarClient } from "./streaming/RealtimeBarClient";
import { upsertBars } from "../broker/marketData/database";
import { VisualizationService } from "./VisualizationService";

// Logger will be initialized in constructor after LoggerFactory is set up
let logger: Logger;

// Global orchestrator instance for API access (force deploy, etc.)
export let globalOrchestrator: LiveTradingOrchestrator | null = null;

/**
 * Set global orchestrator instance
 * Called from live-multi.ts after orchestrator creation
 */
export function setGlobalOrchestrator(
  orchestrator: LiveTradingOrchestrator
): void {
  globalOrchestrator = orchestrator;
}

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
  private visualizationService: VisualizationService;
  private barCacheService?: BarCacheServiceV2;
  private realtimeBarClient: RealtimeBarClient | null = null;
  private config: OrchestratorConfig;
  private running: boolean = false;
  private mainLoopInterval?: NodeJS.Timeout;
  private currentSleepResolve?: () => void; // Resolve function to interrupt sleep
  private currentSleepTimeout?: NodeJS.Timeout; // Timeout reference to clear
  private lastReconciliationTime: number = 0;
  private reconciliationIntervalMs: number = 60 * 1000; // 60 seconds (increased from 5 minutes)

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

    // Initialize visualization service
    const vizPort = parseInt(process.env.VISUALIZATION_PORT || '3003', 10);
    this.visualizationService = new VisualizationService(vizPort);

    // Add visualization callbacks to broker environment
    this.config.brokerEnv.visualizationCallback = {
      onBarProcessed: (data) => this.visualizationService.emitBarProcessed(data),
      onRuleEvaluation: (data) => this.visualizationService.emitRuleEvaluation(data),
      onStateTransition: (data) => this.visualizationService.emitStateTransition(data),
      onEntryZone: (data) => this.visualizationService.emitEntryZone(data),
      onOrderPlan: (data) => this.visualizationService.emitOrderPlan(data),
      onFeatureCompute: (data) => this.visualizationService.emitFeatureCompute(data),
      onOrderSubmission: (data) => this.visualizationService.emitOrderSubmission(data),
    };

    // Initialize reconciliation service
    this.reconciliationService = new BrokerReconciliationService(
      this.repositoryFactory.getOrderRepo(),
      this.repositoryFactory.getStrategyRepo(),
      this.alertService,
      this.repositoryFactory.getSystemLogRepo()
    );

    // Initialize bar cache service V2 (if enabled)
    const barCacheEnabled = process.env.BAR_CACHE_ENABLED === 'true';
    if (barCacheEnabled) {
      const pool = this.repositoryFactory.getPool();
      const twsHost = config.twsHost || process.env.TWS_HOST || "127.0.0.1";
      const twsPort = config.twsPort || parseInt(process.env.TWS_PORT || "7497", 10);
      const twsClientId = parseInt(process.env.TWS_CLIENT_ID || "2000", 10) + Math.floor(Math.random() * 1000);

      this.barCacheService = new BarCacheServiceV2(
        pool,
        { host: twsHost, port: twsPort, clientId: twsClientId },
        {
          enabled: true,
          session: (process.env.BAR_CACHE_SESSION as 'rth' | 'all') || 'rth',
          what: (process.env.BAR_CACHE_WHAT as 'trades' | 'midpoint' | 'bid' | 'ask') || 'trades',
        }
      );
      logger.info('✓ Bar caching V2 enabled');
    }

    // Initialize components
    this.multiStrategyManager = new MultiStrategyManager(
      config.brokerAdapter,
      config.brokerEnv,
      strategyRepo,
      execHistoryRepo,  // Pass execution history repository
      orderRepo,  // Pass order repository for order persistence
      this.barCacheService  // Pass bar cache service
    );

    const twsHost = config.twsHost || process.env.TWS_HOST || "127.0.0.1";
    const twsPort = config.twsPort || parseInt(process.env.TWS_PORT || "7497");

    // Use unique client ID to avoid conflicts with other portfolio fetchers
    this.portfolioFetcher = new PortfolioDataFetcher(twsHost, twsPort, 3000 + Math.floor(Math.random() * 1000));
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

    // Initialize real-time bar streaming client if Python bridge enabled
    const pythonTwsEnabled = process.env.PYTHON_TWS_ENABLED === "true";
    if (pythonTwsEnabled) {
      const pythonTwsUrl = process.env.PYTHON_TWS_URL || "http://localhost:3003";
      const wsUrl = pythonTwsUrl.replace("http://", "ws://").replace("https://", "wss://") + "/ws/stream";

      logger.info(`📡 Initializing real-time bar streaming client: ${wsUrl}`);
      this.realtimeBarClient = new RealtimeBarClient(wsUrl);

      // Set up bar update handler
      this.realtimeBarClient.on("bar", async (symbol: string, bar: Bar) => {
        logger.debug(`🔄 Real-time bar update: ${symbol} | ${bar.timestamp}`);

        // Persist bar to database for chart visibility
        try {
          const pool = this.repositoryFactory.getPool();
          const barTimestamp = new Date(bar.timestamp);

          // Calculate bar period (assuming 5-minute bars for now)
          // TODO: Get actual period from strategy metadata
          const period = "5m";
          const barStart = new Date(barTimestamp);
          barStart.setSeconds(0, 0); // Normalize to start of minute

          // Calculate bar end (5 minutes later)
          const barEnd = new Date(barStart);
          barEnd.setMinutes(barEnd.getMinutes() + 5);

          await upsertBars(pool, {
            symbol,
            period: period as "5m",
            what: "trades",
            session: "rth",
            bars: [{
              barstart: barStart,
              barend: barEnd,
              o: bar.open,
              h: bar.high,
              l: bar.low,
              c: bar.close,
              v: bar.volume,
              wap: null,
              tradeCount: null,
            }]
          });

          logger.debug(`💾 Persisted forming bar to DB: ${symbol} @ ${barStart.toISOString()}`);
        } catch (error: any) {
          logger.warn(`⚠️  Failed to persist bar to database: ${error.message}`);
          // Don't fail strategy processing if DB write fails
        }

        // Process bar through all strategy instances for this symbol
        await this.multiStrategyManager.processBar(symbol, bar);
      });

      this.realtimeBarClient.on("error", (error: Error) => {
        logger.error("Real-time streaming error:", error);
      });

      this.realtimeBarClient.on("disconnected", () => {
        logger.warn("⚠️  Real-time streaming disconnected, will auto-reconnect");
      });

      // Connect to streaming server
      try {
        await this.realtimeBarClient.connect();
        logger.info("✅ Real-time bar streaming connected");

        // Pass streaming client to all strategies
        this.multiStrategyManager.setStreamingClient(this.realtimeBarClient);
      } catch (error: any) {
        logger.error(`❌ Failed to connect streaming client: ${error.message}`);
        logger.info("⏸️  Continuing without real-time streaming (polling only)");
        this.realtimeBarClient = null;
      }
    } else {
      logger.info("⏸️  Real-time streaming disabled (set PYTHON_TWS_ENABLED=true to enable)");
    }

    // Start visualization WebSocket server
    await this.visualizationService.start();
    logger.info(`✅ Visualization service started on port ${process.env.VISUALIZATION_PORT || 3003}`);

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

    // Stop visualization service
    await this.visualizationService.stop();
    logger.info("✓ Visualization service stopped");

    // Clear main loop interval
    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
      this.mainLoopInterval = undefined;
    }

    // Shutdown all strategies
    await this.multiStrategyManager.shutdownAll();

    // Disconnect real-time streaming client
    if (this.realtimeBarClient) {
      logger.info("🔌 Disconnecting real-time bar streaming...");
      this.realtimeBarClient.disconnect();
      this.realtimeBarClient = null;
    }

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

          // Update portfolio values for dynamic position sizing
          this.config.brokerEnv.accountValue = portfolio.totalValue;
          this.config.brokerEnv.buyingPower = portfolio.buyingPower;

          // Log portfolio snapshot for transparency
          logger.debug("📊 Portfolio Snapshot Updated", {
            totalValue: portfolio.totalValue.toFixed(2),
            cash: portfolio.cash.toFixed(2),
            buyingPower: portfolio.buyingPower.toFixed(2),
            unrealizedPnL: portfolio.unrealizedPnL.toFixed(2),
            realizedPnL: portfolio.realizedPnL.toFixed(2),
            positionCount: portfolio.positions.length,
          });

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
          // Deduplicate symbols (multiple strategies can share same symbol)
          const uniqueSymbols = Array.from(new Set(strategiesNeedingBars));

          // Check if we should force refresh (when using fast loop override)
          const loopOverride = process.env.ORCHESTRATOR_LOOP_INTERVAL_MS;
          const useFastLoop = loopOverride ? parseInt(loopOverride, 10) < 60000 : false; // < 1 minute
          const forceRefresh = useFastLoop;
          const includeForming = false; // DEPRECATED: TWS keepUpToDate is unreliable, always use polling

          logger.info(
            `🔄 Fetching bars for ${strategiesNeedingBars.length}/${
              activeStrategies.length
            } strategy(ies): ${strategiesNeedingBars.join(", ")} (${uniqueSymbols.length} unique symbols)${forceRefresh ? ' [LIVE]' : ' [CACHED]'}`
          );

          // Fetch latest bars only for unique symbols
          const latestBars =
            await this.multiStrategyManager.fetchLatestBarsForSymbols(
              uniqueSymbols,
              { forceRefresh, includeForming }
            );

          // Process bars for each symbol (distributes to all strategies)
          for (const [symbol, bars] of latestBars.entries()) {
            const strategies = this.multiStrategyManager.getStrategiesForSymbol(symbol);
            if (strategies.length === 0) continue;

            // Process bars: warm up on historical bars, act only on latest
            if (bars.length === 0) {
              continue;
            }

            // Process for each strategy on this symbol
            for (const instance of strategies) {
              // Mark bars as fetched
              instance.markBarsFetched();

              // Filter to only new bars (not already processed)
              const newBars = instance.filterNewBars(bars);

              // Check if we should force evaluation even without new bars
              const forceEvaluation = process.env.FORCE_STRATEGY_EVALUATION === 'true';

              if (newBars.length === 0) {
                // Show polling activity at INFO level when using fast loop override
                if (forceRefresh) {
                  logger.info(`[${instance.symbol}] ⏸️  Waiting for new bar (polled ${bars.length} bars, none new)`);
                }

                // Skip processing unless forced evaluation is enabled
                if (!forceEvaluation) {
                  continue;
                }

                // Force evaluation: re-process the most recent bar
                if (bars.length > 0) {
                  logger.info(`[${instance.symbol}] 🔄 Force evaluation: re-processing last bar (live mode)`);
                  await instance.processBar(bars[bars.length - 1], { replay: false });
                }
                continue; // Move to next strategy after forced evaluation
              }

              logger.info(`[${instance.symbol}] Processing ${newBars.length} new bar(s) out of ${bars.length} total`);

              if (newBars.length === 1) {
                logger.debug(`[${instance.symbol}] 🔍 Processing single bar with replay: false`);
                await instance.processBar(newBars[0], { replay: false });
              } else {
                const warmupBars = newBars.slice(0, -1);
                const liveBar = newBars[newBars.length - 1];

                logger.debug(`[${instance.symbol}] 🔍 Split ${newBars.length} bars: ${warmupBars.length} warmup + 1 live`);
                logger.debug(`[${instance.symbol}] 🔍 Live bar timestamp: ${new Date(liveBar.timestamp).toISOString()}`);

                // Check if forced evaluation should apply to warmup bars
                const warmupReplay = !forceEvaluation; // If forced, process warmup in live mode too

                if (warmupReplay) {
                  // Standard warmup: replay mode (no orders placed)
                  logger.debug(`[${instance.symbol}] 🔍 Processing ${warmupBars.length} warmup bars with replay: true`);
                  for (const bar of warmupBars) {
                    await instance.processBar(bar, { replay: true });
                  }
                } else {
                  // Forced evaluation: all bars in live mode (orders can be placed)
                  logger.info(`[${instance.symbol}] ⚠️  Processing ${warmupBars.length} warmup bars in LIVE mode (FORCE_STRATEGY_EVALUATION=true)`);
                  for (const bar of warmupBars) {
                    await instance.processBar(bar, { replay: false });
                  }
                }

                logger.debug(`[${instance.symbol}] 🔍 Processing live bar with replay: false`);
                await instance.processBar(liveBar, { replay: false });
              }

              // Check if strategy reached terminal state (no outgoing transitions)
              if (instance.isInTerminalState()) {
                const stateName = instance.getCurrentStateName();
                logger.info(`[${instance.symbol}] ⚠️  Strategy reached terminal state: ${stateName}`);
                logger.info(`[${instance.symbol}] Auto-closing strategy in database...`);

                try {
                  const strategyRepo = this.repositoryFactory.getStrategyRepo();
                  await strategyRepo.close(
                    instance.strategyId,
                    `Auto-closed: reached terminal state ${stateName} with no outgoing transitions`
                  );
                  logger.info(`[${instance.symbol}] ✅ Strategy auto-closed successfully`);

                  // Remove from active strategies
                  this.multiStrategyManager.removeStrategy(instance.strategyId);
                  logger.info(`[${instance.symbol}] Removed from active strategy pool`);
                } catch (error: any) {
                  logger.error(`[${instance.symbol}] ❌ Failed to auto-close strategy: ${error.message}`);
                }

                // Skip evaluation check for closed strategy
                continue;
              }

              // Check if evaluation is due (every bar for now)
              if (instance.shouldEvaluate(1)) {
                // Check if evaluation is globally enabled (default: false)
                const evalEnabled = process.env.STRATEGY_EVAL_ENABLED === 'true';
                if (!evalEnabled) {
                  logger.debug(`⏸️  Skipping evaluation for ${instance.symbol} (STRATEGY_EVAL_ENABLED=false)`);
                  instance.resetEvaluationCounter(); // Reset to avoid accumulation
                  continue;
                }

                // Skip evaluation outside market hours if configured
                const evalMarketHoursOnly = process.env.STRATEGY_EVAL_MARKET_HOURS_ONLY === 'true';
                if (evalMarketHoursOnly && !this.isMarketOpen()) {
                  logger.debug(`⏸️  Skipping evaluation for ${instance.symbol} (market closed, STRATEGY_EVAL_MARKET_HOURS_ONLY=true)`);
                  instance.resetEvaluationCounter(); // Reset to avoid accumulation
                } else {
                  await this.lifecycleManager.evaluateStrategy(instance);
                }
              }
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

      // REMOVED: Symbol duplicate check - multiple strategies per symbol now allowed

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

      // Mark as active (creates strategy audit log)
      await this.repositoryFactory.getStrategyRepo().activate(strategy.id);

      // Log activation to execution history
      await this.repositoryFactory.getExecutionHistoryRepo().logActivation(strategy.id);

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
   * Delegates to shared utility function
   */
  private isMarketOpen(): boolean {
    return checkMarketOpen();
  }

  /**
   * Calculate sleep interval based on shortest timeframe
   */
  private calculateSleepInterval(strategies: any[]): number {
    // Check for fixed interval override (useful for development/testing)
    const fixedIntervalMs = process.env.ORCHESTRATOR_LOOP_INTERVAL_MS;
    if (fixedIntervalMs) {
      const interval = parseInt(fixedIntervalMs, 10);
      if (!isNaN(interval) && interval > 0) {
        logger.debug(`Using fixed loop interval: ${interval}ms (ORCHESTRATOR_LOOP_INTERVAL_MS)`);
        return interval;
      }
    }

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
   * Lock a strategy during swap operation
   * Now uses strategy ID instead of symbol to allow independent swaps
   * Uses distributed PostgreSQL advisory locks
   * Reduced timeout from 30s to 5s to fail fast on contention
   */
  async lockStrategy(strategyId: string): Promise<boolean> {
    const lockKey = `strategy_swap:${strategyId}`;
    return await this.lockService.acquireLock(lockKey, 5000);
  }

  /**
   * Unlock a strategy after swap operation
   */
  async unlockStrategy(strategyId: string): Promise<void> {
    const lockKey = `strategy_swap:${strategyId}`;
    await this.lockService.releaseLock(lockKey);
  }

  /**
   * Check if a strategy is currently locked (non-blocking)
   */
  async isStrategyLocked(strategyId: string): Promise<boolean> {
    const lockKey = `strategy_swap:${strategyId}`;
    return await this.lockService.isLocked(lockKey);
  }

  // Deprecated: kept for backward compatibility
  async lockSymbol(symbol: string): Promise<boolean> {
    console.warn('lockSymbol is deprecated, use lockStrategy instead');
    return this.lockStrategy(symbol);
  }

  async unlockSymbol(symbol: string): Promise<void> {
    console.warn('unlockSymbol is deprecated, use unlockStrategy instead');
    return this.unlockStrategy(symbol);
  }

  async isSymbolLocked(symbol: string): Promise<boolean> {
    console.warn('isSymbolLocked is deprecated, use isStrategyLocked instead');
    return this.isStrategyLocked(symbol);
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

  /**
   * Get strategy instance by ID (for force deploy)
   */
  getStrategyInstance(strategyId: string) {
    return this.multiStrategyManager.getStrategyById(strategyId);
  }

  /**
   * Get broker adapter (for force deploy)
   */
  getBrokerAdapter(): BaseBrokerAdapter {
    return this.config.brokerAdapter;
  }

  /**
   * Get broker environment (for force deploy)
   */
  getBrokerEnv(): BrokerEnvironment {
    return this.config.brokerEnv;
  }
}
