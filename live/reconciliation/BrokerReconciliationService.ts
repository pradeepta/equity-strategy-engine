/**
 * Broker Reconciliation Service
 * Detects and fixes inconsistencies between broker state and database state
 */

import { BaseBrokerAdapter } from '../../broker/broker';
import { Order, BrokerEnvironment } from '../../spec/types';
import { OrderRepository } from '../../database/repositories/OrderRepository';
import { OrderAlertService } from '../alerts/OrderAlertService';

export interface BrokerOrder {
  id: string;
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  status: string;
}

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
  constructor(
    private orderRepo: OrderRepository,
    private alertService: OrderAlertService
  ) {}

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

        report.orphanedOrders.push(...orphaned);
        report.missingOrders.push(...missing);

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
      }));
  }

  /**
   * Find orders in database that aren't at broker (missing)
   */
  private findMissingOrders(brokerOrders: Order[], dbOrders: Order[]): Order[] {
    const brokerOrderIds = new Set(brokerOrders.map(o => o.id));

    return dbOrders.filter(dbo => !brokerOrderIds.has(dbo.id));
  }

  /**
   * Handle orphaned orders: Auto-cancel them at broker
   * Per user preference: automatically cancel any orders not tracked in DB
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

    // Auto-cancel orphaned orders (per user preference)
    console.log(`🔨 Auto-canceling ${orphanedOrders.length} orphaned orders for ${symbol}...`);

    try {
      // Convert BrokerOrder to Order format for cancellation
      const ordersToCancel: Order[] = orphanedOrders.map(bo => ({
        id: bo.id,
        planId: 'unknown',
        symbol: bo.symbol,
        side: bo.side,
        qty: bo.qty,
        type: 'limit',
        status: 'pending',
      }));

      const cancelResult = await brokerAdapter.cancelOpenEntries(
        symbol,
        ordersToCancel,
        brokerEnv
      );

      if (cancelResult.succeeded.length > 0) {
        console.log(`✓ Cancelled ${cancelResult.succeeded.length} orphaned orders for ${symbol}`);
        report.actionsToken.push(
          `Cancelled ${cancelResult.succeeded.length} orphaned orders for ${symbol}`
        );

        // Alert about successful cancellation
        await this.alertService.alertOrphanedOrder(
          symbol,
          cancelResult.succeeded,
          'cancelled'
        );
      }

      if (cancelResult.failed.length > 0) {
        console.error(`✗ Failed to cancel ${cancelResult.failed.length} orphaned orders for ${symbol}`);
        report.actionsToken.push(
          `Failed to cancel ${cancelResult.failed.length} orphaned orders for ${symbol}: ` +
          cancelResult.failed.map(f => `${f.orderId}(${f.reason})`).join(', ')
        );
      }
    } catch (error) {
      console.error(`Failed to cancel orphaned orders for ${symbol}:`, error);
      report.actionsToken.push(`Failed to cancel orphaned orders for ${symbol}: ${error}`);
    }
  }

  /**
   * Handle missing orders: Mark them as cancelled in database
   */
  private async handleMissingOrders(
    missingOrders: Order[],
    report: ReconciliationReport
  ): Promise<void> {
    for (const order of missingOrders) {
      try {
        // Mark as cancelled in database (order no longer exists at broker)
        await this.orderRepo.updateStatus(order.id, 'cancelled');

        console.log(`✓ Marked order ${order.id} as cancelled in database (missing from broker)`);
        report.actionsToken.push(`Marked order ${order.id} as cancelled (missing from broker)`);
      } catch (error) {
        console.error(`Failed to update order ${order.id}:`, error);
        report.actionsToken.push(`Failed to update order ${order.id}: ${error}`);
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

        report.orphanedOrders.push(...orphaned);
        report.missingOrders.push(...missing);

        // Alert but don't auto-fix (periodic checks are informational)
        if (orphaned.length > 0) {
          console.warn(`⚠️ Periodic check found ${orphaned.length} orphaned orders for ${symbol}`);
          await this.alertService.alertReconciliationFailure(symbol, {
            type: 'orphaned_orders',
            count: orphaned.length,
            orderIds: orphaned.map(o => o.id),
          });
        }

        if (missing.length > 0) {
          console.warn(`⚠️ Periodic check found ${missing.length} missing orders for ${symbol}`);
          await this.alertService.alertReconciliationFailure(symbol, {
            type: 'missing_orders',
            count: missing.length,
            orderIds: missing.map(o => o.id),
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
