/**
 * TWS Portfolio Data Fetcher
 * Connects to TWS to fetch account summary and position data
 */

import { PortfolioSnapshot } from '../evaluation/types';

const IB = require('ib');

export class PortfolioDataFetcher {
  private client: any;
  private host: string;
  private port: number;
  private clientId: number;
  private connected: boolean = false;
  private cache: PortfolioSnapshot | null = null;
  private cacheTTL: number = 30000; // 30 seconds
  private lastFetchTime: number = 0;

  constructor(host: string = '127.0.0.1', port: number = 7497, clientId: number = 3) {
    this.host = host;
    this.port = port;
    this.clientId = clientId; // Client ID 3 to avoid conflicts with trading (0) and market data (2)
  }

  /**
   * Connect to TWS
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.client = new IB({
        clientId: this.clientId,
        host: this.host,
        port: this.port,
      });

      this.client.on('connected', () => {
        console.log(`✓ Connected to TWS for portfolio data at ${this.host}:${this.port}`);
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err: Error, code: number, reqId: number) => {
        // Filter out informational messages (codes 2100, 2104, 2106, 2107, 2108, 2158)
        const infoMessages = [2100, 2104, 2106, 2107, 2108, 2158];
        const isInfoMessage = infoMessages.includes(code);

        if (!this.connected && code === 502) {
          reject(new Error(`TWS portfolio connection failed: ${err.message}`));
        } else if (!isInfoMessage) {
          // Only log real errors, not info messages
          console.error(`TWS Portfolio Error [${code}]: ${err.message} (reqId: ${reqId})`);
        }
      });

      this.client.on('disconnected', () => {
        console.log('Disconnected from TWS (portfolio client)');
        this.connected = false;
      });

      // Initiate connection
      this.client.connect();

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('TWS portfolio connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Get portfolio snapshot with caching
   */
  async getPortfolioSnapshot(): Promise<PortfolioSnapshot> {
    // Return cached data if fresh
    const now = Date.now();
    if (this.cache && (now - this.lastFetchTime) < this.cacheTTL) {
      return this.cache;
    }

    // Connect if not connected
    if (!this.connected) {
      await this.connect();
    }

    // Fetch fresh data
    const snapshot = await this.fetchPortfolioData();
    this.cache = snapshot;
    this.lastFetchTime = now;

    return snapshot;
  }

  /**
   * Fetch portfolio data from TWS
   */
  private async fetchPortfolioData(): Promise<PortfolioSnapshot> {
    return new Promise((resolve, reject) => {
      const accountValues: Map<string, number> = new Map();
      const positions: Array<any> = [];
      let accountId: string = process.env.TWS_ACCOUNT_ID || 'N/A';

      // Request account updates
      this.client.reqAccountUpdates(true, accountId === 'N/A' ? '' : accountId);

      // Handle account value updates
      this.client.on('updateAccountValue', (key: string, value: string, currency: string, accountName: string) => {
        if (accountName) {
          accountId = accountName;
        }

        // Parse relevant values
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) {
          accountValues.set(key, numValue);
        }
      });

      // Handle position updates
      this.client.on('updatePortfolio', (
        contract: any,
        position: number,
        marketPrice: number,
        marketValue: number,
        averageCost: number,
        unrealizedPNL: number,
        realizedPNL: number,
        accountName: string
      ) => {
        positions.push({
          symbol: contract.symbol,
          quantity: position,
          avgCost: averageCost,
          currentPrice: marketPrice,
          unrealizedPnL: unrealizedPNL,
          marketValue: marketValue,
        });
      });

      // Handle account download end
      this.client.on('accountDownloadEnd', (accountName: string) => {
        // Stop updates
        this.client.reqAccountUpdates(false, accountName);

        // Build snapshot
        const snapshot: PortfolioSnapshot = {
          timestamp: Date.now(),
          accountId: accountName || accountId,
          totalValue: accountValues.get('NetLiquidation') || 0,
          cash: accountValues.get('TotalCashValue') || 0,
          buyingPower: accountValues.get('BuyingPower') || 0,
          unrealizedPnL: accountValues.get('UnrealizedPnL') || 0,
          realizedPnL: accountValues.get('RealizedPnL') || 0,
          positions: positions,
        };

        resolve(snapshot);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        this.client.reqAccountUpdates(false, accountId === 'N/A' ? '' : accountId);
        resolve({
          timestamp: Date.now(),
          accountId: accountId,
          totalValue: 0,
          cash: 0,
          buyingPower: 0,
          unrealizedPnL: 0,
          realizedPnL: 0,
          positions: [],
        });
      }, 10000);
    });
  }

  /**
   * Disconnect from TWS
   */
  async disconnect(): Promise<void> {
    if (this.connected && this.client) {
      this.client.disconnect();
      this.connected = false;
    }
  }
}
