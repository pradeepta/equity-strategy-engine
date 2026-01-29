/**
 * Broker Reconciliation Service
 * Detects and fixes inconsistencies between broker state and database state
 */

import { BaseBrokerAdapter } from '../../broker/broker';
import { Order, BrokerEnvironment } from '../../spec/types';
import { OrderRepository } from '../../database/repositories/OrderRepository';
import { StrategyRepository } from '../../database/repositories/StrategyRepository';
import { SystemLogRepository } from '../../database/repositories/SystemLogRepository';
import { OrderAlertService } from '../alerts/OrderAlertService';
import { OrderStatus } from '@prisma/client';

export interface BrokerOrder {
  id: string;
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  status: string;
  type: 'limit' | 'market';
}

type DbOrder = ReturnType<OrderRepository['findOpenBySymbol']> extends Promise<
  Array<infer T>
>
  ? T
  : never;

export interface ReconciliationReport {
  timestamp: Date;
  orphanedOrders: BrokerOrder[];  // At broker but not in DB
  missingOrders: Order[];          // In DB but not at broker
  statusMismatches: Array<{
    orderId: string;
    dbStatus: string;
    brokerStatus: string;
  }>;
  actionsToken: Array<string>;
}

/**
 * Service for reconciling broker state with database state
 */
export class BrokerReconciliationService {
  // Circuit breaker for auto-cancel to prevent runaway cancellations
  private cancellationHistory: Array<{ timestamp: Date; count: number }> = [];
  private readonly MAX_CANCELLATIONS_PER_HOUR = 20; // Max 20 cancellations per hour
  private readonly CIRCUIT_BREAKER_WINDOW_MS = 60 * 60 * 1000; // 1 hour window
  private circuitBreakerTripped = false;

  constructor(
    private orderRepo: OrderRepository,
    private strategyRepo: StrategyRepository,
    private alertService: OrderAlertService,
    private systemLogRepo?: SystemLogRepository
  ) {}

  /**
   * Check if circuit breaker should trip (too many cancellations)
   */
  private checkCircuitBreaker(proposedCancellations: number): boolean {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.CIRCUIT_BREAKER_WINDOW_MS);

    // Remove old entries outside the window
    this.cancellationHistory = this.cancellationHistory.filter(
      entry => entry.timestamp >= windowStart
    );

    // Calculate total cancellations in window
    const totalCancellations = this.cancellationHistory.reduce(
      (sum, entry) => sum + entry.count,
      0
    );

    // Check if adding proposed cancellations would exceed threshold
    if (totalCancellations + proposedCancellations > this.MAX_CANCELLATIONS_PER_HOUR) {
      this.circuitBreakerTripped = true;
      console.error(`🚨 CIRCUIT BREAKER TRIPPED: ${totalCancellations} cancellations in last hour, refusing to cancel ${proposedCancellations} more orders`);
      return true;
    }

    return false;
  }

  /**
   * Record cancellations for circuit breaker tracking
   */
  private recordCancellations(count: number): void {
    this.cancellationHistory.push({
      timestamp: new Date(),
      count,
    });
  }

  /**
   * Reset circuit breaker (manual intervention)
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerTripped = false;
    this.cancellationHistory = [];
    console.log('✓ Circuit breaker reset - auto-cancellation re-enabled');
  }

  /**
   * Perform full reconciliation on startup
   * Detects orphaned orders and auto-cancels them (per user preference)
   */
  async reconcileOnStartup(
    brokerAdapter: BaseBrokerAdapter,
    symbols: string[],
    brokerEnv: BrokerEnvironment
  ): Promise<ReconciliationReport> {
    console.log('\n🔍 Starting broker reconciliation...');

    // Audit log for reconciliation start
    await this.systemLogRepo?.create({
      level: 'INFO',
      component: 'BrokerReconciliationService',
      message: 'Reconciliation started (startup)',
      metadata: {
        symbols,
        symbolCount: symbols.length,
        timestamp: new Date().toISOString(),
      },
    });

    const report: ReconciliationReport = {
      timestamp: new Date(),
      orphanedOrders: [],
      missingOrders: [],
      statusMismatches: [],
      actionsToken: [],
    };

    for (const symbol of symbols) {
      try {
        // Fetch open orders from broker
        const brokerOrders = await brokerAdapter.getOpenOrders(symbol, brokerEnv);

        // Fetch open orders from database for this symbol
        const dbOrders = await this.orderRepo.findOpenBySymbol(symbol);

        // Find discrepancies
        const orphaned = this.findOrphanedOrders(brokerOrders, dbOrders);
        const missing = this.findMissingOrders(brokerOrders, dbOrders);
        const statusMismatches = this.findStatusMismatches(brokerOrders, dbOrders);

        report.orphanedOrders.push(...orphaned);
        report.missingOrders.push(...missing);
        report.statusMismatches.push(...statusMismatches.map(m => ({
          orderId: m.orderId,
          dbStatus: m.dbStatus,
          brokerStatus: m.brokerStatus,
        })));

        // Handle status mismatches FIRST (before handling orphaned/missing)
        if (statusMismatches.length > 0) {
          console.warn(`⚠️ Found ${statusMismatches.length} status mismatches for ${symbol}`);
          await this.handleStatusMismatches(statusMismatches, report);
        }

        // Handle orphaned orders (auto-cancel per user preference)
        if (orphaned.length > 0) {
          console.warn(`⚠️ Found ${orphaned.length} orphaned orders for ${symbol} at broker`);
          await this.handleOrphanedOrders(orphaned, symbol, brokerAdapter, brokerEnv, report);
        }

        // Handle missing orders (mark as cancelled in DB)
        if (missing.length > 0) {
          console.warn(`⚠️ Found ${missing.length} missing orders for ${symbol} in database`);
          await this.handleMissingOrders(missing, report);
        }
      } catch (error) {
        console.error(`Failed to reconcile ${symbol}:`, error);
        report.actionsToken.push(`Failed to reconcile ${symbol}: ${error}`);
      }
    }

    // Summary
    console.log('\n📊 Reconciliation Summary:');
    console.log(`  Orphaned orders (at broker): ${report.orphanedOrders.length}`);
    console.log(`  Missing orders (in database): ${report.missingOrders.length}`);
    console.log(`  Status mismatches: ${report.statusMismatches.length}`);
    console.log(`  Actions taken: ${report.actionsToken.length}`);

    // Audit log for reconciliation completion
    await this.systemLogRepo?.create({
      level: report.orphanedOrders.length > 0 || report.missingOrders.length > 0 ? 'WARN' : 'INFO',
      component: 'BrokerReconciliationService',
      message: 'Reconciliation completed (startup)',
      metadata: {
        orphanedOrdersCount: report.orphanedOrders.length,
        missingOrdersCount: report.missingOrders.length,
        statusMismatchesCount: report.statusMismatches.length,
        actionsTakenCount: report.actionsToken.length,
        symbolsProcessed: symbols.length,
        timestamp: new Date().toISOString(),
        hasDiscrepancies: report.orphanedOrders.length > 0 || report.missingOrders.length > 0,
      },
    });

    return report;
  }

  /**
   * Find orders at broker that aren't in database (orphaned)
   */
  private findOrphanedOrders(brokerOrders: Order[], dbOrders: Order[]): BrokerOrder[] {
    const dbOrderIds = new Set(dbOrders.map(o => o.id));

    return brokerOrders
      .filter(bo => !dbOrderIds.has(bo.id))
      .map(bo => ({
        id: bo.id,
        symbol: bo.symbol,
        qty: bo.qty,
        side: bo.side,
        status: bo.status,
        type: bo.type,
      }));
  }

  /**
   * Find orders in database that aren't at broker (missing)
   */
  private findMissingOrders(brokerOrders: Order[], dbOrders: DbOrder[]): DbOrder[] {
    const brokerOrderIds = new Set(brokerOrders.map(o => o.id));

    return dbOrders.filter(dbo => !brokerOrderIds.has(dbo.id));
  }

  /**
   * Find orders with mismatched status between broker and database
   */
  private findStatusMismatches(
    brokerOrders: Order[],
    dbOrders: DbOrder[]
  ): Array<{ orderId: string; dbStatus: string; brokerStatus: string; order: DbOrder }> {
    const mismatches: Array<{ orderId: string; dbStatus: string; brokerStatus: string; order: DbOrder }> = [];

    // Create a map of broker orders by ID for quick lookup
    const brokerOrderMap = new Map(brokerOrders.map(bo => [bo.id, bo]));

    // Check each DB order against broker state
    for (const dbOrder of dbOrders) {
      const brokerOrder = brokerOrderMap.get(dbOrder.id);

      if (!brokerOrder) {
        // Order not at broker - will be handled by findMissingOrders
        continue;
      }

      // Normalize statuses for comparison (both to uppercase)
      const dbStatus = dbOrder.status.toUpperCase();
      const brokerStatus = brokerOrder.status.toUpperCase();

      // Map broker statuses to our DB statuses
      const statusMap: Record<string, string> = {
        'PENDING': 'PENDING',
        'PENDINGSUBMIT': 'PENDING',
        'PENDINGCANCEL': 'PENDING',
        'PRESUBMITTED': 'PENDING',
        'SUBMITTED': 'SUBMITTED',
        'FILLED': 'FILLED',
        'PARTIALLYFILLED': 'PARTIALLY_FILLED',
        'CANCELLED': 'CANCELLED',
        'INACTIVE': 'REJECTED',
        'REJECTED': 'REJECTED',
      };

      const normalizedBrokerStatus = statusMap[brokerStatus] || brokerStatus;

      // Detect mismatch
      if (dbStatus !== normalizedBrokerStatus) {
        mismatches.push({
          orderId: dbOrder.id,
          dbStatus,
          brokerStatus: normalizedBrokerStatus,
          order: dbOrder,
        });
      }
    }

    return mismatches;
  }

  /**
   * Handle orphaned orders: Import them into database as MANUAL orders
   * Creates a MANUAL strategy for the symbol and associates orphaned orders with it
   */
  private async handleOrphanedOrders(
    orphanedOrders: BrokerOrder[],
    symbol: string,
    brokerAdapter: BaseBrokerAdapter,
    brokerEnv: BrokerEnvironment,
    report: ReconciliationReport
  ): Promise<void> {
    // Alert about orphaned orders
    await this.alertService.alertOrphanedOrder(
      symbol,
      orphanedOrders.map(o => o.id),
      'detected'
    );
    await this.systemLogRepo?.create({
      level: 'WARN',
      component: 'BrokerReconciliationService',
      message: `Orphaned orders detected for ${symbol}`,
      metadata: {
        symbol,
        orderIds: orphanedOrders.map(o => o.id),
      },
    });

    console.log(`📥 Importing ${orphanedOrders.length} orphaned orders for ${symbol} into database...`);

    try {
      // Get or create MANUAL strategy for this symbol
      const userId = process.env.USER_ID || process.env.SYSTEM_USER_ID || '1';
      // Don't pass accountId for MANUAL strategies - they're not associated with any account
      // (avoids FK constraint errors when TWS_ACCOUNT_ID is invalid or doesn't exist in DB)

      const manualStrategy = await this.strategyRepo.getOrCreateManualStrategy({
        symbol,
        userId,
        accountId: undefined, // MANUAL strategies don't need account association
      });

      let importedCount = 0;
      let failedCount = 0;

      // Import each orphaned order
      for (const orphanedOrder of orphanedOrders) {
        try {
          // Check if order already exists in database (prevent duplicates)
          const existing = await this.orderRepo.findByBrokerOrderId(orphanedOrder.id);
          if (existing) {
            console.log(`⏭️  Skipping ${orphanedOrder.id} - already exists in database`);
            continue;
          }

          // Create order record
          const createdOrder = await this.orderRepo.create({
            brokerOrderId: orphanedOrder.id,
            strategyId: manualStrategy.id,
            planId: `manual:imported:${orphanedOrder.id}`, // Unique plan ID for imported orders
            symbol: orphanedOrder.symbol,
            side: orphanedOrder.side.toUpperCase() as 'BUY' | 'SELL',
            qty: orphanedOrder.qty,
            type: orphanedOrder.type.toUpperCase() as 'LIMIT' | 'MARKET' | 'STOP',
          });

          // Update status to match TWS status
          const dbStatus = this.mapTWSStatusToDB(orphanedOrder.status);
          if (dbStatus !== 'PENDING') {
            await this.orderRepo.updateStatus(createdOrder.id, dbStatus as OrderStatus);
          }

          // Create audit log entry
          await this.orderRepo.createAuditLog({
            orderId: createdOrder.id,
            brokerOrderId: orphanedOrder.id,
            strategyId: manualStrategy.id,
            eventType: 'RECONCILED',
            newStatus: dbStatus as any,
            metadata: {
              reason: 'Reconciliation imported orphaned order from TWS',
              source: 'manual_trading',
              manualStrategyId: manualStrategy.id,
              originalTWSStatus: orphanedOrder.status,
            },
          });

          importedCount++;
          console.log(`✓ Imported order ${orphanedOrder.id} (${orphanedOrder.side} ${orphanedOrder.qty} ${orphanedOrder.symbol})`);
        } catch (error) {
          failedCount++;
          console.error(`✗ Failed to import order ${orphanedOrder.id}:`, error);
        }
      }

      // Report results
      if (importedCount > 0) {
        console.log(`✓ Successfully imported ${importedCount} orphaned orders for ${symbol} into MANUAL_${symbol} strategy`);
        report.actionsToken.push(
          `Imported ${importedCount} orphaned orders for ${symbol} into MANUAL strategy`
        );

        await this.systemLogRepo?.create({
          level: 'INFO',
          component: 'BrokerReconciliationService',
          message: `Imported orphaned orders for ${symbol}`,
          metadata: {
            symbol,
            importedCount,
            manualStrategyId: manualStrategy.id,
            manualStrategyName: manualStrategy.name,
          },
        });
      }

      if (failedCount > 0) {
        console.error(`✗ Failed to import ${failedCount} orphaned orders for ${symbol}`);
        report.actionsToken.push(
          `Failed to import ${failedCount} orphaned orders for ${symbol}`
        );
      }
    } catch (error) {
      console.error(`Failed to import orphaned orders for ${symbol}:`, error);
      report.actionsToken.push(`Failed to import orphaned orders for ${symbol}: ${error}`);
      await this.systemLogRepo?.create({
        level: 'ERROR',
        component: 'BrokerReconciliationService',
        message: `Failed to import orphaned orders for ${symbol}`,
        metadata: {
          symbol,
          error: String(error),
        },
      });
    }
  }

  /**
   * Map TWS order status to database order status
   */
  private mapTWSStatusToDB(twsStatus: string): string {
    const statusMap: Record<string, string> = {
      'PreSubmitted': 'PENDING',
      'Submitted': 'SUBMITTED',
      'Filled': 'FILLED',
      'PartiallyFilled': 'PARTIALLY_FILLED',
      'Cancelled': 'CANCELLED',
      'PendingCancel': 'PENDING',
      'ApiCancelled': 'CANCELLED',
      'Inactive': 'CANCELLED',
    };

    return statusMap[twsStatus] || 'SUBMITTED';
  }

  /**
   * Handle missing orders: Mark them as cancelled in database
   */
  private async handleMissingOrders(
    missingOrders: DbOrder[],
    report: ReconciliationReport
  ): Promise<void> {
    for (const order of missingOrders) {
      try {
        // Mark as cancelled in database (order no longer exists at broker)
        await this.orderRepo.updateStatus(order.id, 'CANCELLED');
        await this.orderRepo.createAuditLog({
          orderId: order.id,
          brokerOrderId: order.brokerOrderId ?? undefined,
          strategyId: order.strategyId,
          eventType: 'MISSING',
          newStatus: 'CANCELLED',
          metadata: {
            symbol: order.symbol,
          },
        });

        console.log(`✓ Marked order ${order.id} as cancelled in database (missing from broker)`);
        report.actionsToken.push(`Marked order ${order.id} as cancelled (missing from broker)`);
      } catch (error) {
        console.error(`Failed to update order ${order.id}:`, error);
        report.actionsToken.push(`Failed to update order ${order.id}: ${error}`);
        await this.systemLogRepo?.create({
          level: 'ERROR',
          component: 'BrokerReconciliationService',
          message: `Failed to update missing order ${order.id}`,
          metadata: {
            orderId: order.id,
            error: String(error),
          },
        });
      }
    }
  }

  /**
   * Handle status mismatches: Update DB to match broker state
   */
  private async handleStatusMismatches(
    mismatches: Array<{ orderId: string; dbStatus: string; brokerStatus: string; order: DbOrder }>,
    report: ReconciliationReport
  ): Promise<void> {
    for (const mismatch of mismatches) {
      try {
        const oldStatus = mismatch.dbStatus;
        const newStatus = mismatch.brokerStatus;

        console.log(`🔄 Status mismatch for order ${mismatch.orderId}: DB=${oldStatus}, Broker=${newStatus}`);

        // Update status in database to match broker
        await this.orderRepo.updateStatus(mismatch.orderId, newStatus as any);
        await this.orderRepo.createAuditLog({
          orderId: mismatch.orderId,
          brokerOrderId: mismatch.order.brokerOrderId ?? undefined,
          strategyId: mismatch.order.strategyId,
          eventType: 'RECONCILED',
          oldStatus: oldStatus as any,
          newStatus: newStatus as any,
          metadata: {
            symbol: mismatch.order.symbol,
            reconciliationType: 'status_sync',
            previousDbStatus: oldStatus,
            brokerStatus: newStatus,
          },
        });

        console.log(`✓ Updated order ${mismatch.orderId} status: ${oldStatus} → ${newStatus}`);
        report.actionsToken.push(`Updated order ${mismatch.orderId} status: ${oldStatus} → ${newStatus}`);

        await this.systemLogRepo?.create({
          level: 'INFO',
          component: 'BrokerReconciliationService',
          message: `Status mismatch resolved for order ${mismatch.orderId}`,
          metadata: {
            orderId: mismatch.orderId,
            symbol: mismatch.order.symbol,
            oldStatus,
            newStatus,
          },
        });
      } catch (error) {
        console.error(`Failed to update status for order ${mismatch.orderId}:`, error);
        report.actionsToken.push(`Failed to update status for order ${mismatch.orderId}: ${error}`);
        await this.systemLogRepo?.create({
          level: 'ERROR',
          component: 'BrokerReconciliationService',
          message: `Failed to resolve status mismatch for order ${mismatch.orderId}`,
          metadata: {
            orderId: mismatch.orderId,
            error: String(error),
          },
        });
      }
    }
  }

  /**
   * Periodic reconciliation (lighter weight - only checks for discrepancies)
   * Does NOT auto-cancel orders - just detects and alerts
   */
  async reconcilePeriodic(
    brokerAdapter: BaseBrokerAdapter,
    symbols: string[],
    brokerEnv: BrokerEnvironment
  ): Promise<ReconciliationReport> {
    console.log('\n🔍 Running periodic reconciliation check...');

    // Audit log for periodic reconciliation start
    await this.systemLogRepo?.create({
      level: 'INFO',
      component: 'BrokerReconciliationService',
      message: 'Reconciliation started (periodic)',
      metadata: {
        symbols,
        symbolCount: symbols.length,
        timestamp: new Date().toISOString(),
      },
    });

    const report: ReconciliationReport = {
      timestamp: new Date(),
      orphanedOrders: [],
      missingOrders: [],
      statusMismatches: [],
      actionsToken: [],
    };

    for (const symbol of symbols) {
      try {
        const brokerOrders = await brokerAdapter.getOpenOrders(symbol, brokerEnv);
        const dbOrders = await this.orderRepo.findOpenBySymbol(symbol);

        const orphaned = this.findOrphanedOrders(brokerOrders, dbOrders);
        const missing = this.findMissingOrders(brokerOrders, dbOrders);
        const statusMismatches = this.findStatusMismatches(brokerOrders, dbOrders);

        report.orphanedOrders.push(...orphaned);
        report.missingOrders.push(...missing);
        report.statusMismatches.push(...statusMismatches.map(m => ({
          orderId: m.orderId,
          dbStatus: m.dbStatus,
          brokerStatus: m.brokerStatus,
        })));

        // Fix status mismatches automatically (safe operation)
        if (statusMismatches.length > 0) {
          console.warn(`⚠️ Periodic check found ${statusMismatches.length} status mismatches for ${symbol}`);
          await this.handleStatusMismatches(statusMismatches, report);
        }

        // Alert but don't auto-fix (periodic checks are informational)
        if (orphaned.length > 0) {
          console.warn(`⚠️ Periodic check found ${orphaned.length} orphaned orders for ${symbol}`);
          await this.alertService.alertReconciliationFailure(symbol, {
            type: 'orphaned_orders',
            count: orphaned.length,
            orderIds: orphaned.map(o => o.id),
          });
          await this.systemLogRepo?.create({
            level: 'WARN',
            component: 'BrokerReconciliationService',
            message: `Periodic orphaned orders detected for ${symbol}`,
            metadata: {
              symbol,
              orderIds: orphaned.map(o => o.id),
            },
          });
        }

        if (missing.length > 0) {
          console.warn(`⚠️ Periodic check found ${missing.length} missing orders for ${symbol}`);
          await this.alertService.alertReconciliationFailure(symbol, {
            type: 'missing_orders',
            count: missing.length,
            orderIds: missing.map(o => o.id),
          });
          await this.systemLogRepo?.create({
            level: 'WARN',
            component: 'BrokerReconciliationService',
            message: `Periodic missing orders detected for ${symbol}`,
            metadata: {
              symbol,
              orderIds: missing.map(o => o.id),
            },
          });
        }
      } catch (error) {
        console.error(`Failed periodic reconciliation for ${symbol}:`, error);
      }
    }

    if (report.orphanedOrders.length > 0 || report.missingOrders.length > 0) {
      console.warn('⚠️ Discrepancies detected - consider running full reconciliation');
    } else {
      console.log('✓ No discrepancies found');
    }

    // Audit log for periodic reconciliation completion
    await this.systemLogRepo?.create({
      level: report.orphanedOrders.length > 0 || report.missingOrders.length > 0 ? 'WARN' : 'INFO',
      component: 'BrokerReconciliationService',
      message: 'Reconciliation completed (periodic)',
      metadata: {
        orphanedOrdersCount: report.orphanedOrders.length,
        missingOrdersCount: report.missingOrders.length,
        symbolsProcessed: symbols.length,
        timestamp: new Date().toISOString(),
        hasDiscrepancies: report.orphanedOrders.length > 0 || report.missingOrders.length > 0,
      },
    });

    return report;
  }

  /**
   * Get reconciliation health status
   */
  async getReconciliationHealth(): Promise<{
    healthy: boolean;
    issues: string[];
  }> {
    // TODO: Implement health check
    // - Check for old pending orders
    // - Check for stuck orders
    // - Check for fill discrepancies
    return {
      healthy: true,
      issues: [],
    };
  }
}
