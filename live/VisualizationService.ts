/**
 * Visualization Service
 *
 * Streams real-time strategy execution events to connected WebSocket clients
 * for chart visualization and debugging.
 */

import WebSocket from 'ws';
import { createServer, Server as HTTPServer } from 'http';
import {
  VisualizationEvent,
  StrategySnapshot,
  BarProcessedEvent,
  RuleEvaluationEvent,
  StateTransitionEvent,
  EntryZoneEvent,
  OrderPlanEvent,
  FeatureComputeEvent,
  OrderSubmissionEvent,
  OrderFillEvent,
} from './types/visualization';
import { LoggerFactory } from '../logging/logger';

const logger = LoggerFactory.getLogger('VisualizationService');

export class VisualizationService {
  private wss: WebSocket.Server;
  private httpServer: HTTPServer;
  private clients: Set<WebSocket> = new Set();
  private eventBuffer: Map<string, VisualizationEvent[]> = new Map(); // strategyId -> events
  private snapshots: Map<string, StrategySnapshot> = new Map(); // strategyId -> snapshot
  private readonly maxBufferSize = 1000; // Max events per strategy
  private readonly port: number;

  constructor(port: number = 3003) {
    this.port = port;

    // Create HTTP server
    this.httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', clients: this.clients.size }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Create WebSocket server
    this.wss = new WebSocket.Server({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    logger.info(`Visualization service initialized on port ${this.port}`);
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, () => {
        logger.info(`📊 Visualization WebSocket server listening on ws://localhost:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    logger.info('Stopping visualization service...');

    // Close all client connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    // Close WebSocket server
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => {
          logger.info('✓ Visualization service stopped');
          resolve();
        });
      });
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    logger.info(`New visualization client connected (total: ${this.clients.size})`);

    // Send current snapshots to new client
    ws.send(
      JSON.stringify({
        type: 'snapshot_list',
        snapshots: Array.from(this.snapshots.values()),
      })
    );

    ws.on('message', (data: string) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, message);
      } catch (error) {
        logger.warn('Failed to parse client message', error as Error);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      logger.info(`Visualization client disconnected (remaining: ${this.clients.size})`);
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error', error);
      this.clients.delete(ws);
    });
  }

  /**
   * Handle messages from client
   */
  private handleClientMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'subscribe':
        // Client wants to subscribe to specific strategy
        const strategyId = message.strategyId;
        if (strategyId && this.snapshots.has(strategyId)) {
          ws.send(
            JSON.stringify({
              type: 'snapshot',
              snapshot: this.snapshots.get(strategyId),
            })
          );

          // Send buffered events
          const events = this.eventBuffer.get(strategyId) || [];
          if (events.length > 0) {
            ws.send(
              JSON.stringify({
                type: 'event_batch',
                strategyId,
                events: events.slice(-100), // Last 100 events
              })
            );
          }
        }
        break;

      case 'request_snapshot':
        // Client requests current snapshot
        ws.send(
          JSON.stringify({
            type: 'snapshot_list',
            snapshots: Array.from(this.snapshots.values()),
          })
        );
        break;

      default:
        logger.warn(`Unknown message type: ${message.type}`);
    }
  }

  /**
   * Emit visualization event to all connected clients
   */
  emitEvent(event: VisualizationEvent): void {
    // Store in buffer
    const strategyId = event.strategyId;
    if (!this.eventBuffer.has(strategyId)) {
      this.eventBuffer.set(strategyId, []);
    }

    const buffer = this.eventBuffer.get(strategyId)!;
    buffer.push(event);

    // Trim buffer if too large
    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }

    // Broadcast to all clients
    const message = JSON.stringify({ type: 'event', event });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Update strategy snapshot
   */
  updateSnapshot(snapshot: StrategySnapshot): void {
    this.snapshots.set(snapshot.strategyId, snapshot);

    // Broadcast snapshot update
    const message = JSON.stringify({ type: 'snapshot', snapshot });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Remove strategy from tracking
   */
  removeStrategy(strategyId: string): void {
    this.snapshots.delete(strategyId);
    this.eventBuffer.delete(strategyId);

    // Notify clients
    const message = JSON.stringify({ type: 'strategy_removed', strategyId });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Get current client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  // Convenience methods for emitting specific event types

  emitBarProcessed(event: Omit<BarProcessedEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'bar_processed',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  emitRuleEvaluation(event: Omit<RuleEvaluationEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'rule_evaluation',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  emitStateTransition(event: Omit<StateTransitionEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'state_transition',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  emitEntryZone(event: Omit<EntryZoneEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'entry_zone',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  emitOrderPlan(event: Omit<OrderPlanEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'order_plan',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  emitFeatureCompute(event: Omit<FeatureComputeEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'feature_compute',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  emitOrderSubmission(event: Omit<OrderSubmissionEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'order_submission',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  emitOrderFill(event: Omit<OrderFillEvent, 'type' | 'timestamp'>): void {
    this.emitEvent({
      type: 'order_fill',
      timestamp: new Date().toISOString(),
      ...event,
    });
  }
}
