/**
 * Order Alert Service
 * Handles alerting for critical order management failures
 */

import { CancellationResult } from '../../spec/types';

export interface AlertChannel {
  type: 'console' | 'email' | 'webhook' | 'sms';
  enabled: boolean;
  config?: Record<string, unknown>;
}

export interface OrderAlert {
  timestamp: Date;
  severity: 'critical' | 'high' | 'medium' | 'low';
  type: 'cancellation_failure' | 'submission_failure' | 'orphaned_order' | 'reconciliation_failure';
  symbol: string;
  message: string;
  details: Record<string, unknown>;
}

/**
 * Service for sending alerts when order operations fail
 */
export class OrderAlertService {
  private channels: AlertChannel[];
  private alertHistory: OrderAlert[] = [];
  private maxHistorySize: number = 1000;

  constructor(channels: AlertChannel[] = []) {
    // Default to console if no channels provided
    this.channels = channels.length > 0 ? channels : [
      { type: 'console', enabled: true }
    ];
  }

  /**
   * Alert on order cancellation failure
   */
  async alertCancellationFailure(
    symbol: string,
    cancelResult: CancellationResult,
    context?: string
  ): Promise<void> {
    const alert: OrderAlert = {
      timestamp: new Date(),
      severity: 'critical',
      type: 'cancellation_failure',
      symbol,
      message: `Failed to cancel ${cancelResult.failed.length} order(s) for ${symbol}`,
      details: {
        context,
        failedOrders: cancelResult.failed,
        succeededCount: cancelResult.succeeded.length,
        failedCount: cancelResult.failed.length,
      },
    };

    await this.sendAlert(alert);
  }

  /**
   * Alert on order submission failure
   */
  async alertSubmissionFailure(
    symbol: string,
    error: Error,
    orderPlanId?: string
  ): Promise<void> {
    const alert: OrderAlert = {
      timestamp: new Date(),
      severity: 'critical',
      type: 'submission_failure',
      symbol,
      message: `Failed to submit orders for ${symbol}: ${error.message}`,
      details: {
        orderPlanId,
        error: error.message,
        stack: error.stack,
      },
    };

    await this.sendAlert(alert);
  }

  /**
   * Alert on orphaned order detection
   */
  async alertOrphanedOrder(
    symbol: string,
    orderIds: string[],
    action: 'cancelled' | 'detected'
  ): Promise<void> {
    const alert: OrderAlert = {
      timestamp: new Date(),
      severity: 'high',
      type: 'orphaned_order',
      symbol,
      message: `${action === 'cancelled' ? 'Cancelled' : 'Detected'} ${orderIds.length} orphaned order(s) for ${symbol}`,
      details: {
        orderIds,
        action,
      },
    };

    await this.sendAlert(alert);
  }

  /**
   * Alert on reconciliation failure
   */
  async alertReconciliationFailure(
    symbol: string,
    discrepancies: Record<string, unknown>
  ): Promise<void> {
    const alert: OrderAlert = {
      timestamp: new Date(),
      severity: 'high',
      type: 'reconciliation_failure',
      symbol,
      message: `Order reconciliation found discrepancies for ${symbol}`,
      details: discrepancies,
    };

    await this.sendAlert(alert);
  }

  /**
   * Send alert through all enabled channels
   */
  private async sendAlert(alert: OrderAlert): Promise<void> {
    // Add to history
    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory.shift();
    }

    // Send through all enabled channels
    const promises = this.channels
      .filter(channel => channel.enabled)
      .map(channel => this.sendToChannel(alert, channel));

    await Promise.allSettled(promises);
  }

  /**
   * Send alert to specific channel
   */
  private async sendToChannel(alert: OrderAlert, channel: AlertChannel): Promise<void> {
    try {
      switch (channel.type) {
        case 'console':
          this.sendToConsole(alert);
          break;

        case 'email':
          await this.sendToEmail(alert, channel.config);
          break;

        case 'webhook':
          await this.sendToWebhook(alert, channel.config);
          break;

        case 'sms':
          await this.sendToSms(alert, channel.config);
          break;

        default:
          console.warn(`Unknown alert channel type: ${channel.type}`);
      }
    } catch (error) {
      console.error(`Failed to send alert via ${channel.type}:`, error);
    }
  }

  /**
   * Send alert to console (always available)
   */
  private sendToConsole(alert: OrderAlert): void {
    const emoji = this.getSeverityEmoji(alert.severity);
    const border = '='.repeat(80);

    console.error('\n' + border);
    console.error(`${emoji} CRITICAL ALERT [${alert.severity.toUpperCase()}] ${emoji}`);
    console.error(border);
    console.error(`Type:      ${alert.type}`);
    console.error(`Symbol:    ${alert.symbol}`);
    console.error(`Time:      ${alert.timestamp.toISOString()}`);
    console.error(`Message:   ${alert.message}`);
    console.error('\nDetails:');
    console.error(JSON.stringify(alert.details, null, 2));
    console.error(border + '\n');
  }

  /**
   * Send alert via email (stub - implement with your email service)
   */
  private async sendToEmail(alert: OrderAlert, config?: Record<string, unknown>): Promise<void> {
    // TODO: Implement email sending
    // Example: Use nodemailer, SendGrid, AWS SES, etc.
    console.log(`[EMAIL STUB] Would send alert to ${config?.to || 'default recipient'}`);
  }

  /**
   * Send alert via webhook (stub - implement with your webhook endpoint)
   */
  private async sendToWebhook(alert: OrderAlert, config?: Record<string, unknown>): Promise<void> {
    // TODO: Implement webhook posting
    // Example: POST to Slack, Discord, PagerDuty, etc.
    const url = config?.url as string;
    if (url) {
      console.log(`[WEBHOOK STUB] Would POST alert to ${url}`);
    }
  }

  /**
   * Send alert via SMS (stub - implement with your SMS service)
   */
  private async sendToSms(alert: OrderAlert, config?: Record<string, unknown>): Promise<void> {
    // TODO: Implement SMS sending
    // Example: Use Twilio, AWS SNS, etc.
    console.log(`[SMS STUB] Would send alert to ${config?.phone || 'default phone'}`);
  }

  /**
   * Get emoji for severity level
   */
  private getSeverityEmoji(severity: string): string {
    switch (severity) {
      case 'critical': return '🚨';
      case 'high': return '⚠️';
      case 'medium': return '⚡';
      case 'low': return 'ℹ️';
      default: return '❓';
    }
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit?: number): OrderAlert[] {
    if (limit) {
      return this.alertHistory.slice(-limit);
    }
    return [...this.alertHistory];
  }

  /**
   * Get alert statistics
   */
  getAlertStats(): Record<string, number> {
    const stats: Record<string, number> = {
      total: this.alertHistory.length,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    for (const alert of this.alertHistory) {
      stats[alert.severity]++;
    }

    return stats;
  }

  /**
   * Clear alert history
   */
  clearHistory(): void {
    this.alertHistory = [];
  }
}
