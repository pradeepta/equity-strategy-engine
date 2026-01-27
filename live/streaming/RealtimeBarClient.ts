/**
 * Real-time bar streaming client for Python TWS Bridge
 * Manages WebSocket connection and bar subscriptions
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import { LoggerFactory } from "../../logging/logger";
import type { Bar } from "../../spec/types";

const logger = LoggerFactory.getLogger("RealtimeBarClient");

interface SubscribeParams {
  symbol: string;
  period: string;
  session?: string;
  what?: string;
}

interface BarUpdateMessage {
  type: "bar_update";
  symbol: string;
  bar: {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    wap: number;
    count: number;
  };
  timestamp: string;
}

interface SubscribedMessage {
  type: "subscribed";
  symbol: string;
  period: string;
  req_id: number;
  existing: boolean;
}

interface ErrorMessage {
  type: "error";
  error: string;
  action?: string;
  symbol?: string;
}

type ServerMessage = BarUpdateMessage | SubscribedMessage | ErrorMessage | { type: string };

/**
 * Real-time bar streaming client
 * Emits events:
 * - 'connected': WebSocket connected
 * - 'disconnected': WebSocket disconnected
 * - 'bar': (symbol, bar) - New bar update received
 * - 'subscribed': (symbol) - Successfully subscribed
 * - 'error': (error) - Error occurred
 */
export class RealtimeBarClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private activeSubscriptions: Set<string> = new Set(); // Set of subscribed symbols
  private pendingSubscriptions: Map<string, SubscribeParams> = new Map(); // Pending resubscribe on reconnect
  private isConnecting: boolean = false;
  private shouldReconnect: boolean = true;

  constructor(url: string = "ws://localhost:3003/ws/stream") {
    super();
    this.url = url;
  }

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      logger.debug("WebSocket already connected or connecting");
      return;
    }

    if (this.isConnecting) {
      logger.debug("Connection already in progress");
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        logger.info(`📡 Connecting to streaming server: ${this.url}`);
        this.ws = new WebSocket(this.url);

        this.ws.on("open", () => {
          this.isConnecting = false;
          logger.info("✅ WebSocket connected to streaming server");
          this.emit("connected");

          // Start heartbeat
          this.startHeartbeat();

          // Resubscribe to pending subscriptions
          if (this.pendingSubscriptions.size > 0) {
            logger.info(`♻️  Resubscribing to ${this.pendingSubscriptions.size} symbols`);
            for (const [symbol, params] of this.pendingSubscriptions) {
              this.subscribe(params).catch((err) => {
                logger.error(`Failed to resubscribe to ${symbol}: ${err.message}`);
              });
            }
          }

          resolve();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          try {
            const message: ServerMessage = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error: any) {
            logger.error("Failed to parse WebSocket message", error);
          }
        });

        this.ws.on("close", () => {
          this.isConnecting = false;
          logger.warn("⚠️  WebSocket disconnected from streaming server");
          this.emit("disconnected");
          this.stopHeartbeat();

          // Auto-reconnect if enabled
          if (this.shouldReconnect) {
            logger.info("🔄 Reconnecting in 5 seconds...");
            this.reconnectInterval = setTimeout(() => this.connect(), 5000);
          }
        });

        this.ws.on("error", (error: Error) => {
          this.isConnecting = false;
          logger.error("❌ WebSocket error:", error);
          this.emit("error", error);
          reject(error);
        });
      } catch (error: any) {
        this.isConnecting = false;
        logger.error("Failed to create WebSocket connection", error);
        reject(error);
      }
    });
  }

  /**
   * Subscribe to real-time bars for a symbol
   */
  async subscribe(params: SubscribeParams): Promise<void> {
    const { symbol, period, session = "rth", what = "TRADES" } = params;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Store for resubscribe on reconnect
      this.pendingSubscriptions.set(symbol, params);
      logger.info(`📌 Queued subscription for ${symbol} (WebSocket not ready)`);

      // Try to connect if not connected
      if (!this.isConnecting) {
        this.connect().catch((err) => {
          logger.error(`Failed to connect for subscription: ${err.message}`);
        });
      }
      return;
    }

    logger.info(`📡 Subscribing to real-time bars: ${symbol} (${period})`);

    this.ws.send(
      JSON.stringify({
        action: "subscribe",
        symbol,
        period,
        session,
        what,
      })
    );

    // Track subscription
    this.activeSubscriptions.add(symbol);
    this.pendingSubscriptions.set(symbol, params);
  }

  /**
   * Unsubscribe from real-time bars for a symbol
   */
  async unsubscribe(symbol: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`Cannot unsubscribe from ${symbol}: WebSocket not connected`);
      this.activeSubscriptions.delete(symbol);
      this.pendingSubscriptions.delete(symbol);
      return;
    }

    logger.info(`📡 Unsubscribing from real-time bars: ${symbol}`);

    this.ws.send(
      JSON.stringify({
        action: "unsubscribe",
        symbol,
      })
    );

    this.activeSubscriptions.delete(symbol);
    this.pendingSubscriptions.delete(symbol);
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    logger.info("🔌 Disconnecting from streaming server");
    this.shouldReconnect = false;
    this.stopHeartbeat();

    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.activeSubscriptions.clear();
    this.pendingSubscriptions.clear();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get active subscriptions
   */
  getActiveSubscriptions(): string[] {
    return Array.from(this.activeSubscriptions);
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "connected":
        logger.debug("Received welcome message from server");
        break;

      case "bar_update":
        this.handleBarUpdate(message as BarUpdateMessage);
        break;

      case "subscribed":
        this.handleSubscribed(message as SubscribedMessage);
        break;

      case "unsubscribed":
        logger.info(`✅ Unsubscribed from ${(message as any).symbol}`);
        break;

      case "error":
        this.handleError(message as ErrorMessage);
        break;

      case "pong":
        // Heartbeat response
        break;

      default:
        logger.debug(`Received message: ${message.type}`);
    }
  }

  /**
   * Handle bar update message
   */
  private handleBarUpdate(message: BarUpdateMessage): void {
    const { symbol, bar } = message;

    logger.debug(`🔄 Bar update: ${symbol} | ${bar.date} | C=$${bar.close} | V=${bar.volume}`);

    // Parse TWS date format to Unix timestamp
    // Format: "20260126  10:30:00"
    const dateMatch = bar.date.match(/(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!dateMatch) {
      logger.error(`Failed to parse bar date: ${bar.date}`);
      return;
    }

    const [, year, month, day, hour, minute, second] = dateMatch;
    const timestamp = new Date(
      parseInt(year),
      parseInt(month) - 1, // JS months are 0-indexed
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      parseInt(second)
    ).getTime();

    // Convert to Bar format and emit
    const barData: Bar = {
      timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    };

    this.emit("bar", symbol, barData);
  }

  /**
   * Handle subscribed confirmation
   */
  private handleSubscribed(message: SubscribedMessage): void {
    const { symbol, existing } = message;
    logger.info(`✅ Subscribed to ${symbol} stream ${existing ? "(existing)" : "(new)"}`);
    this.emit("subscribed", symbol);
  }

  /**
   * Handle error message
   */
  private handleError(message: ErrorMessage): void {
    const { error, action, symbol } = message;
    const errorMsg = `WebSocket error${action ? ` (${action})` : ""}${symbol ? ` for ${symbol}` : ""}: ${error}`;
    logger.error(errorMsg);
    this.emit("error", new Error(errorMsg));
  }

  /**
   * Start heartbeat ping
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: "ping" }));
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stop heartbeat ping
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
}
