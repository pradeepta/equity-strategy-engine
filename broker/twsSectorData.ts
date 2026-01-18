/**
 * TWS Sector & Industry Data Client
 * Fetches sector/industry classification and related stock data
 */

const IB = require('ib');

export interface SectorInfo {
  symbol: string;
  industry: string;
  category: string;
  subcategory: string;
}

export interface SectorStocks {
  sector: string;
  stocks: Array<{
    symbol: string;
    price: number;
    changePercent: number;
    volume: number;
  }>;
}

export class TwsSectorDataClient {
  private host: string;
  private port: number;
  private clientId: number;

  constructor(
    host: string = '127.0.0.1',
    port: number = 7497,
    clientId: number = 4
  ) {
    this.host = host;
    this.port = port;
    this.clientId = clientId;
  }

  /**
   * Get sector/industry classification for a symbol
   */
  async getSectorInfo(symbol: string): Promise<SectorInfo> {
    const client = new IB({
      clientId: this.clientId,
      host: this.host,
      port: this.port,
    });

    let connected = false;
    let sectorInfo: SectorInfo | null = null;

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      client.on('connected', () => {
        console.log(`✓ Connected to TWS for sector data`);
        connected = true;
        clearTimeout(timeout);
        resolve();
      });

      client.on('error', (err: Error, code: number) => {
        const infoMessages = [2104, 2106, 2107, 2108, 2158];
        if (!infoMessages.includes(code) && !connected) {
          clearTimeout(timeout);
          reject(new Error(`Cannot connect to TWS: ${err.message}`));
        }
      });

      client.connect();
    });

    // Request contract details
    const reqId = 1;
    const contract = {
      symbol,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    };

    await new Promise<void>((resolve) => {
      client.on('contractDetails', (id: number, details: any) => {
        if (id === reqId) {
          sectorInfo = {
            symbol,
            industry: details.industry || 'Unknown',
            category: details.category || 'Unknown',
            subcategory: details.subcategory || 'Unknown',
          };
        }
      });

      client.on('contractDetailsEnd', (id: number) => {
        if (id === reqId) {
          resolve();
        }
      });

      client.reqContractDetails(reqId, contract);

      // Timeout after 5 seconds
      setTimeout(() => resolve(), 5000);
    });

    client.disconnect();

    if (!sectorInfo) {
      throw new Error(`No sector info found for ${symbol}`);
    }

    return sectorInfo;
  }

  /**
   * Get top performing stocks in a sector
   * Uses TWS market scanner API
   */
  async getSectorTopPerformers(
    sector: string,
    limit: number = 10
  ): Promise<SectorStocks> {
    const client = new IB({
      clientId: this.clientId,
      host: this.host,
      port: this.port,
    });

    let connected = false;
    const stocks: Array<{
      symbol: string;
      price: number;
      changePercent: number;
      volume: number;
    }> = [];

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      client.on('connected', () => {
        console.log(`✓ Connected to TWS for scanner`);
        connected = true;
        clearTimeout(timeout);
        resolve();
      });

      client.on('error', (err: Error, code: number) => {
        const infoMessages = [2104, 2106, 2107, 2108, 2158];
        if (!infoMessages.includes(code) && !connected) {
          clearTimeout(timeout);
          reject(new Error(`Cannot connect to TWS: ${err.message}`));
        }
      });

      client.connect();
    });

    // Scanner subscription for sector
    const scannerSubscription = {
      instrument: 'STK',
      locationCode: 'STK.US.MAJOR',
      scanCode: 'TOP_PERC_GAIN',
      numberOfRows: limit,
      abovePrice: 5.0,
      belowPrice: 500.0,
      marketCapAbove: 1000000000, // $1B minimum
    };

    await new Promise<void>((resolve) => {
      client.on('scannerData', (
        reqId: number,
        rank: number,
        contractDetails: any,
        distance: string,
        benchmark: string,
        projection: string,
        legsStr: string
      ) => {
        // Filter by sector in handler (TWS doesn't support sector filter directly)
        stocks.push({
          symbol: contractDetails.contract.symbol,
          price: parseFloat(distance) || 0,
          changePercent: parseFloat(benchmark) || 0,
          volume: parseInt(projection) || 0,
        });
      });

      client.on('scannerDataEnd', (reqId: number) => {
        resolve();
      });

      client.reqScannerSubscription(1, scannerSubscription, [], []);

      // Timeout after 10 seconds
      setTimeout(() => resolve(), 10000);
    });

    client.disconnect();

    return {
      sector,
      stocks: stocks.slice(0, limit),
    };
  }

  /**
   * Get stocks in same sector as reference symbol
   */
  async getSectorPeers(
    referenceSymbol: string,
    limit: number = 10
  ): Promise<string[]> {
    // First get the sector of reference symbol
    const sectorInfo = await this.getSectorInfo(referenceSymbol);

    // Then get top performers in that sector
    const sectorStocks = await this.getSectorTopPerformers(sectorInfo.industry, limit);

    return sectorStocks.stocks.map(s => s.symbol);
  }
}
