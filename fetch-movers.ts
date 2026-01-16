/**
 * Fetch Top 5 NASDAQ Movers using TWS API
 * Retrieves the top gaining stocks from NASDAQ via Interactive Brokers
 */

import * as dotenv from 'dotenv';
const IB = require('ib');

dotenv.config();

interface StockMover {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
}

interface TickerData {
  symbol: string;
  price: number;
  prevClose: number;
  volume: number;
  change: number;
  changePercent: number;
}

/**
 * Fetch top NASDAQ movers using TWS API
 */
async function fetchNasdaqMoversTWS(): Promise<StockMover[]> {
  console.log('\n╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('║' + 'NASDAQ TOP 5 MOVERS (via TWS)'.padEnd(58) + '║');
  console.log('║' + ' '.repeat(58) + '║');
  console.log('╚' + '═'.repeat(58) + '╝\n');

  const twsHost = process.env.TWS_HOST || '127.0.0.1';
  const twsPort = parseInt(process.env.TWS_PORT || '7497');
  const twsClientId = parseInt(process.env.TWS_CLIENT_ID || '1'); // Use different client ID

  console.log(`📊 Connecting to TWS at ${twsHost}:${twsPort}...\n`);

  // Popular NASDAQ stocks to scan
  const nasdaqStocks = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA',
    'META', 'TSLA', 'AVGO', 'COST', 'NFLX',
    'AMD', 'ADBE', 'CSCO', 'INTC', 'QCOM',
    'PYPL', 'CMCSA', 'PEP', 'TXN', 'AMGN'
  ];

  const client = new IB({
    clientId: twsClientId,
    host: twsHost,
    port: twsPort,
  });

  const movers: StockMover[] = [];
  const tickerDataMap = new Map<string, TickerData>();
  let connected = false;

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Connection timeout. Make sure TWS/IB Gateway is running.'));
    }, 10000);

    client.on('connected', () => {
      console.log('✓ Connected to TWS\n');
      connected = true;
      clearTimeout(timeout);
      resolve();
    });

    client.on('error', (err: Error, code: number, reqId: number) => {
      if (!connected && code === 502) {
        clearTimeout(timeout);
        reject(new Error(`Cannot connect to TWS at ${twsHost}:${twsPort}`));
      }
    });

    client.connect();
  });

  // Request market data for each stock
  console.log('📈 Requesting market data for NASDAQ stocks...\n');

  let reqId = 1;
  const requestMap = new Map<number, string>();

  // Set up market data handlers
  client.on('tickPrice', (tickerId: number, field: number, price: number) => {
    const symbol = requestMap.get(tickerId);
    if (!symbol) return;

    if (!tickerDataMap.has(symbol)) {
      tickerDataMap.set(symbol, {
        symbol,
        price: 0,
        prevClose: 0,
        volume: 0,
        change: 0,
        changePercent: 0,
      });
    }

    const data = tickerDataMap.get(symbol)!;

    // Field codes:
    // 1 = Bid, 2 = Ask, 4 = Last, 6 = High, 7 = Low, 9 = Close/Prev Close
    if (field === 4) { // Last price
      data.price = price;
    } else if (field === 9) { // Previous close
      data.prevClose = price;
    }

    // Calculate change
    if (data.price > 0 && data.prevClose > 0) {
      data.change = data.price - data.prevClose;
      data.changePercent = (data.change / data.prevClose) * 100;
    }

    tickerDataMap.set(symbol, data);
  });

  client.on('tickSize', (tickerId: number, field: number, size: number) => {
    const symbol = requestMap.get(tickerId);
    if (!symbol) return;

    if (!tickerDataMap.has(symbol)) {
      tickerDataMap.set(symbol, {
        symbol,
        price: 0,
        prevClose: 0,
        volume: 0,
        change: 0,
        changePercent: 0,
      });
    }

    const data = tickerDataMap.get(symbol)!;

    // Field code 8 = Volume
    if (field === 8) {
      data.volume = size;
    }

    tickerDataMap.set(symbol, data);
  });

  // Request market data for each stock
  for (const symbol of nasdaqStocks) {
    const contract = {
      symbol,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    };

    requestMap.set(reqId, symbol);
    client.reqMktData(reqId, contract, '', false, false);
    reqId++;
  }

  // Wait for data to be collected
  console.log('⏳ Collecting market data (3 seconds)...\n');
  await sleep(3000);

  // Cancel all market data requests
  for (let i = 1; i < reqId; i++) {
    client.cancelMktData(i);
  }

  // Convert to StockMover format
  for (const [symbol, data] of tickerDataMap) {
    if (data.price > 0 && data.prevClose > 0) {
      movers.push({
        symbol: data.symbol,
        name: data.symbol, // TWS doesn't provide company name in basic data
        price: data.price,
        change: data.change,
        changePercent: data.changePercent,
        volume: data.volume,
      });
    }
  }

  // Sort by percentage change (descending)
  movers.sort((a, b) => b.changePercent - a.changePercent);

  // Disconnect
  client.disconnect();
  console.log('✓ Disconnected from TWS\n');

  return movers.slice(0, 5);
}

/**
 * Display movers in a formatted table
 */
function displayMovers(movers: StockMover[]) {
  console.log('═'.repeat(80));
  console.log('TOP 5 NASDAQ GAINERS');
  console.log('═'.repeat(80));
  console.log('');

  console.log(
    'Rank'.padEnd(6) +
    'Symbol'.padEnd(10) +
    'Price'.padEnd(12) +
    'Change'.padEnd(12) +
    '% Change'.padEnd(12) +
    'Volume'
  );
  console.log('─'.repeat(80));

  movers.forEach((mover, index) => {
    const rank = `#${index + 1}`;
    const symbol = mover.symbol;
    const price = `$${mover.price.toFixed(2)}`;
    const change = mover.change >= 0
      ? `+$${mover.change.toFixed(2)}`
      : `-$${Math.abs(mover.change).toFixed(2)}`;
    const changePercent = mover.changePercent >= 0
      ? `+${mover.changePercent.toFixed(2)}%`
      : `${mover.changePercent.toFixed(2)}%`;
    const volume = mover.volume > 0
      ? (mover.volume / 1e6).toFixed(1) + 'M'
      : 'N/A';

    const arrow = mover.changePercent >= 0 ? '📈' : '📉';

    console.log(
      `${arrow} ${rank.padEnd(4)}` +
      symbol.padEnd(10) +
      price.padEnd(12) +
      change.padEnd(12) +
      changePercent.padEnd(12) +
      volume
    );
  });

  console.log('');
  console.log('═'.repeat(80));
  console.log(`\n✅ Retrieved ${movers.length} movers`);
  console.log(`📅 Data as of: ${new Date().toLocaleString()}\n`);
}

/**
 * Export movers to JSON file
 */
async function exportMoversToFile(movers: StockMover[], filename: string = 'nasdaq-movers.json') {
  const fs = await import('fs');
  const data = {
    timestamp: new Date().toISOString(),
    source: 'Interactive Brokers TWS',
    movers,
  };

  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  console.log(`💾 Saved to ${filename}\n`);
}

/**
 * Helper: sleep for ms
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main function
 */
async function main() {
  try {
    const movers = await fetchNasdaqMoversTWS();

    if (movers.length === 0) {
      console.error('❌ No movers data available');
      console.error('\nPossible reasons:');
      console.error('1. Market is closed');
      console.error('2. TWS/IB Gateway is not running');
      console.error('3. No market data subscription (check TWS account)');
      console.error('4. Delayed data may take a few moments\n');
      process.exit(1);
    }

    displayMovers(movers);

    // Export to file if requested
    if (process.argv.includes('--export')) {
      await exportMoversToFile(movers);
    }

    // Print symbols only if requested
    if (process.argv.includes('--symbols-only')) {
      console.log('\nSymbols:');
      console.log(movers.map(m => m.symbol).join(', '));
      console.log('');
    }

    process.exit(0);
  } catch (e) {
    console.error('\n❌ Error:', (e as Error).message);
    console.error('\nTroubleshooting:');
    console.error('1. Make sure TWS/IB Gateway is running');
    console.error('2. Check TWS API settings are enabled');
    console.error('3. Verify port 7497 (paper) or 7496 (live) is correct');
    console.error('4. Ensure market data subscription is active');
    console.error('5. Try during market hours (9:30 AM - 4:00 PM ET)\n');
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { fetchNasdaqMoversTWS, StockMover };
