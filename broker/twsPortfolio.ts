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
        // Set market data type (1=Live[paid], 2=Frozen[safe], 3=Delayed-15min[intraday], 4=Delayed-Frozen)
        // Default to 2 (frozen) - most conservative for risk management
        const marketDataType = parseInt(process.env.TWS_MARKET_DATA_TYPE || '2');
        this.client.reqMarketDataType(marketDataType);
        console.log(`✓ Using market data type: ${marketDataType} (1=Live, 2=Frozen, 3=Delayed, 4=Delayed-Frozen)`);
        this.connected = true;
        resolve();
      });

      this.client.on('error', (err: Error, code: number, reqId: number) => {
        // Filter out informational messages (codes 2100, 2104, 2106, 2107, 2108, 2158)
        const infoMessages = [2100, 2104, 2106, 2107, 2108, 2158];
        const codeNum = typeof code === 'number' ? code : (code as any)?.code;
        const isInfoMessage = infoMessages.includes(codeNum);
        const infoText = err?.message?.toLowerCase?.() || '';
        const isInfoText =
          infoText.includes('market data farm connection is ok') ||
          infoText.includes('hmds data farm connection is ok') ||
          infoText.includes('sec-def data farm connection is ok') ||
          infoText.includes('unsubscribed from account'); // Expected when we call reqAccountUpdates(false)

        if (!this.connected && codeNum === 502) {
          reject(new Error(`TWS portfolio connection failed: ${err.message}`));
        } else if (!isInfoMessage && !isInfoText) {
          // Only log real errors, not info messages
          console.error(`TWS Portfolio Error [${codeNum}]: ${err.message} (reqId: ${reqId})`);
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
  async getPortfolioSnapshot(forceRefresh: boolean = false): Promise<PortfolioSnapshot> {
    // Return cached data if fresh
    const now = Date.now();
    if (!forceRefresh && this.cache && (now - this.lastFetchTime) < this.cacheTTL) {
      return this.cache;
    }

    // Reconnect if disconnected
    if (!this.connected) {
      console.log('📡 Reconnecting to TWS for portfolio data...');
      await this.connect();
    }

    // Fetch fresh data with retry logic
    try {
      const snapshot = await this.fetchPortfolioData();
      this.cache = snapshot;
      this.lastFetchTime = now;
      return snapshot;
    } catch (error: any) {
      // If fetch fails, try reconnecting once
      if (error.message.includes('unsubscribed') || !this.connected) {
        console.log('⚠️  Portfolio fetch failed, attempting reconnect...');
        this.connected = false;
        await this.connect();
        const snapshot = await this.fetchPortfolioData();
        this.cache = snapshot;
        this.lastFetchTime = now;
        return snapshot;
      }
      throw error;
    }
  }

  /**
   * Fetch portfolio data from TWS
   */
  private async fetchPortfolioData(): Promise<PortfolioSnapshot> {
    return new Promise((resolve, reject) => {
      const accountValues: Map<string, number> = new Map();
      const positions: Array<any> = [];
      let accountId: string = process.env.TWS_ACCOUNT_ID || 'N/A';

      // Create temporary handlers that will be cleaned up
      const handleAccountValue = (key: string, value: string, _currency: string, accountName: string) => {
        if (accountName) {
          accountId = accountName;
        }

        // Parse relevant values
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) {
          accountValues.set(key, numValue);
        }
      };

      const handlePortfolio = (
        contract: any,
        position: number,
        marketPrice: number,
        marketValue: number,
        averageCost: number,
        unrealizedPNL: number,
        _realizedPNL: number,
        _accountName: string
      ) => {
        positions.push({
          symbol: contract.symbol,
          quantity: position,
          avgCost: averageCost,
          currentPrice: marketPrice,
          unrealizedPnL: unrealizedPNL,
          marketValue: marketValue,
        });
      };

      const handleDownloadEnd = (accountName: string) => {
        // Clean up listeners
        this.client.removeListener('updateAccountValue', handleAccountValue);
        this.client.removeListener('updatePortfolio', handlePortfolio);
        this.client.removeListener('accountDownloadEnd', handleDownloadEnd);

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
      };

      // Attach listeners
      this.client.on('updateAccountValue', handleAccountValue);
      this.client.on('updatePortfolio', handlePortfolio);
      this.client.on('accountDownloadEnd', handleDownloadEnd);

      // Request account updates
      this.client.reqAccountUpdates(true, accountId === 'N/A' ? '' : accountId);

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
