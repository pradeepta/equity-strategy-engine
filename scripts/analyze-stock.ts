/**
 * Analyze stock data and create optimal strategy
 */

import * as https from 'https';

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchYahooData(symbol: string, days: number = 90): Promise<Bar[]> {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const past = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    const url =
      `https://query1.finance.yahoo.com/v7/finance/download/${symbol}?` +
      `period1=${past}&period2=${now}&interval=1d&events=history`;

    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const lines = data.split('\n');
            const bars: Bar[] = [];

            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              const parts = line.split(',');
              if (parts.length < 5 || parts[1] === 'null') continue;

              bars.push({
                date: parts[0],
                open: parseFloat(parts[1]),
                high: parseFloat(parts[2]),
                low: parseFloat(parts[3]),
                close: parseFloat(parts[4]),
                volume: parseInt(parts[6], 10),
              });
            }

            resolve(bars);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function analyzeData(bars: Bar[], symbol: string) {
  if (bars.length === 0) {
    console.log('No data available');
    return;
  }

  // Calculate metrics
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);

  const current = bars[bars.length - 1];
  const high90 = Math.max(...highs);
  const low90 = Math.min(...lows);
  const avg20 = closes.slice(-20).reduce((a, b) => a + b) / 20;
  const avg50 = closes.slice(-50).reduce((a, b) => a + b) / 50;
  const avgVol = volumes.reduce((a, b) => a + b) / volumes.length;
  const volatility = calculateVolatility(closes);

  console.log('\n╔' + '═'.repeat(58) + '╗');
  console.log('║' + ` ${symbol} ANALYSIS (${bars.length} days)`.padEnd(59) + '║');
  console.log('╚' + '═'.repeat(58) + '╝\n');

  console.log('📊 PRICE DATA:');
  console.log(`  Current: $${current.close.toFixed(2)}`);
  console.log(`  90-day High: $${high90.toFixed(2)}`);
  console.log(`  90-day Low: $${low90.toFixed(2)}`);
  console.log(`  Range: $${(high90 - low90).toFixed(2)} (${((high90 - low90) / low90 * 100).toFixed(1)}%)`);
  console.log(`  20-day MA: $${avg20.toFixed(2)}`);
  console.log(`  50-day MA: $${avg50.toFixed(2)}`);
  console.log(`  Trend: ${current.close > avg50 ? '📈 UP' : '📉 DOWN'} vs 50-day MA\n`);

  console.log('📈 VOLATILITY:');
  console.log(`  Daily Volatility: ${(volatility * 100).toFixed(2)}%`);
  console.log(`  Avg Daily Move: ${((high90 - low90) / 90 / current.close * 100).toFixed(2)}%`);
  console.log(`  Avg Volume: ${(avgVol / 1e6).toFixed(1)}M shares\n`);

  console.log('💡 STRATEGY RECOMMENDATION:\n');

  // Determine strategy
  if (current.close > avg50 && volatility > 0.02) {
    console.log('✓ TREND-FOLLOWING BREAKOUT STRATEGY');
    console.log('  • Price above 50-day MA (uptrend)');
    console.log('  • High volatility = momentum');
    console.log('  • Strategy: Long on pullback, exit on failure');
    generateBreakoutStrategy(symbol, current, avg20, avg50, low90);
  } else if (current.close > avg50 && current.close < avg20) {
    console.log('✓ MEAN-REVERSION PULLBACK STRATEGY');
    console.log('  • Price above 50-day MA but below 20-day MA');
    console.log('  • Pullback in uptrend = buying opportunity');
    console.log('  • Strategy: Long pullback to 50-day MA');
    generatePullbackStrategy(symbol, current, avg20, avg50, low90);
  } else if (current.close < avg50 && volatility > 0.02) {
    console.log('✓ MEAN-REVERSION BOUNCE STRATEGY');
    console.log('  • Price below 50-day MA (downtrend)');
    console.log('  • High volatility = bounce opportunity');
    console.log('  • Strategy: Short bounce, cover at support');
    generateMeanReversionStrategy(symbol, current, avg20, avg50, high90);
  } else {
    console.log('✓ RANGE-BOUND STRATEGY');
    console.log('  • Price in sideways range');
    console.log('  • Low volatility');
    console.log('  • Strategy: Buy support, sell resistance');
    generateRangeBoundStrategy(symbol, current, high90, low90);
  }

  console.log('\n' + '═'.repeat(60) + '\n');
}

function calculateVolatility(closes: number[]): number {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  return Math.sqrt(variance);
}

function generateBreakoutStrategy(symbol: string, current: Bar, avg20: number, avg50: number, low90: number) {
  const entryHigh = current.close * 1.02; // Breakout above recent
  const entryLow = current.close * 0.98;
  const stop = Math.min(avg20, current.close * 0.95);
  const target1 = current.close * 1.05;
  const target2 = current.close * 1.10;

  const yaml = `# Breakout Strategy for ${symbol}
# Trend-following strategy in uptrend
# Buy breakouts above recent resistance

meta:
  name: "${symbol} Breakout"
  symbol: ${symbol}
  timeframe: 1d
  description: "Long breakout strategy - enter on strength in uptrend"

features:
  - name: ema20
    type: indicator
  - name: ema50
    type: indicator
  - name: volume_zscore
    type: indicator

rules:
  arm: "close > ema50 && close > ema20 * 0.98"
  trigger: "close > ema20 && volume_zscore > 0.3"
  invalidate:
    when_any:
      - "close < ema20 * 0.95"
      - "volume_zscore < -1.0"

orderPlans:
  - name: breakout_long
    side: buy
    entryZone: [${entryLow.toFixed(2)}, ${entryHigh.toFixed(2)}]
    qty: 10
    stopPrice: ${stop.toFixed(2)}
    targets:
      - price: ${target1.toFixed(2)}
        ratioOfPosition: 0.5
      - price: ${target2.toFixed(2)}
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 5
  rthOnly: false

risk:
  maxRiskPerTrade: 200
`;

  console.log(`  Entry Zone: $${entryLow.toFixed(2)} - $${entryHigh.toFixed(2)}`);
  console.log(`  Stop Loss: $${stop.toFixed(2)}`);
  console.log(`  Target 1: $${target1.toFixed(2)} (50% exit)`);
  console.log(`  Target 2: $${target2.toFixed(2)} (remaining)`);
  console.log(`  Max Risk: $${(10 * (current.close - stop)).toFixed(2)}\n`);

  return saveStrategy(symbol.toLowerCase() + '-breakout', yaml);
}

function generatePullbackStrategy(symbol: string, current: Bar, avg20: number, avg50: number, low90: number) {
  const entryHigh = avg50 * 1.01;
  const entryLow = avg50 * 0.99;
  const stop = Math.max(low90, avg50 * 0.96);
  const target1 = avg20 * 0.98;
  const target2 = current.close * 1.02;

  const yaml = `# Pullback Strategy for ${symbol}
# Buy pullbacks in uptrend to moving averages

meta:
  name: "${symbol} Pullback"
  symbol: ${symbol}
  timeframe: 1d
  description: "Long pullback strategy - enter dips in uptrend"

features:
  - name: ema20
    type: indicator
  - name: ema50
    type: indicator
  - name: volume_zscore
    type: indicator

rules:
  arm: "close > ema50 && close < ema20 * 1.02"
  trigger: "close < ema50 * 1.005 && volume_zscore > 0.0"
  invalidate:
    when_any:
      - "close < ema50 * 0.96"
      - "close > ema20 * 1.05"

orderPlans:
  - name: pullback_long
    side: buy
    entryZone: [${entryLow.toFixed(2)}, ${entryHigh.toFixed(2)}]
    qty: 10
    stopPrice: ${stop.toFixed(2)}
    targets:
      - price: ${target1.toFixed(2)}
        ratioOfPosition: 0.5
      - price: ${target2.toFixed(2)}
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 5
  rthOnly: false

risk:
  maxRiskPerTrade: 200
`;

  console.log(`  Entry Zone: $${entryLow.toFixed(2)} - $${entryHigh.toFixed(2)}`);
  console.log(`  Stop Loss: $${stop.toFixed(2)}`);
  console.log(`  Target 1: $${target1.toFixed(2)} (50% exit)`);
  console.log(`  Target 2: $${target2.toFixed(2)} (remaining)`);
  console.log(`  Max Risk: $${(10 * (current.close - stop)).toFixed(2)}\n`);

  return saveStrategy(symbol.toLowerCase() + '-pullback', yaml);
}

function generateMeanReversionStrategy(symbol: string, current: Bar, avg20: number, avg50: number, high90: number) {
  const entryHigh = current.close * 1.02;
  const entryLow = current.close * 0.98;
  const stop = Math.min(high90, current.close * 1.05);
  const target1 = current.close * 0.98;
  const target2 = current.close * 0.94;

  const yaml = `# Mean Reversion Strategy for ${symbol}
# Short bounces in downtrend back to resistance

meta:
  name: "${symbol} Mean Reversion"
  symbol: ${symbol}
  timeframe: 1d
  description: "Short mean reversion - fade bounces in downtrend"

features:
  - name: ema20
    type: indicator
  - name: ema50
    type: indicator
  - name: volume_zscore
    type: indicator

rules:
  arm: "close < ema50 && close < ema20 * 1.02"
  trigger: "close > ema20 * 0.995 && volume_zscore > 0.2"
  invalidate:
    when_any:
      - "close > ema50"
      - "volume_zscore > 1.5"

orderPlans:
  - name: meanrev_short
    side: sell
    entryZone: [${entryLow.toFixed(2)}, ${entryHigh.toFixed(2)}]
    qty: 10
    stopPrice: ${stop.toFixed(2)}
    targets:
      - price: ${target1.toFixed(2)}
        ratioOfPosition: 0.5
      - price: ${target2.toFixed(2)}
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 5
  rthOnly: false

risk:
  maxRiskPerTrade: 200
`;

  console.log(`  Entry Zone: $${entryLow.toFixed(2)} - $${entryHigh.toFixed(2)}`);
  console.log(`  Stop Loss: $${stop.toFixed(2)}`);
  console.log(`  Target 1: $${target1.toFixed(2)} (50% exit)`);
  console.log(`  Target 2: $${target2.toFixed(2)} (remaining)`);
  console.log(`  Max Risk: $${(10 * (stop - current.close)).toFixed(2)}\n`);

  return saveStrategy(symbol.toLowerCase() + '-meanrev', yaml);
}

function generateRangeBoundStrategy(symbol: string, current: Bar, high90: number, low90: number) {
  const midpoint = (high90 + low90) / 2;
  const entryHighBuy = low90 * 1.005;
  const entryLowBuy = low90 * 0.995;
  const entryHighSell = high90 * 0.995;
  const entryLowSell = high90 * 1.005;

  const yaml = `# Range-Bound Strategy for ${symbol}
# Buy support, sell resistance in sideways market

meta:
  name: "${symbol} Range"
  symbol: ${symbol}
  timeframe: 1d
  description: "Range-bound strategy - buy support, sell resistance"

features:
  - name: ema20
    type: indicator
  - name: volume_zscore
    type: indicator

rules:
  arm: "close > ${low90.toFixed(2)} * 0.99 && close < ${high90.toFixed(2)} * 1.01"
  trigger: "close < ${(low90 + midpoint).toFixed(2)} && volume_zscore > 0.0"
  invalidate:
    when_any:
      - "close > ${high90.toFixed(2)}"
      - "close < ${low90.toFixed(2)} * 0.95"

orderPlans:
  - name: range_long
    side: buy
    entryZone: [${entryLowBuy.toFixed(2)}, ${entryHighBuy.toFixed(2)}]
    qty: 10
    stopPrice: ${(low90 * 0.98).toFixed(2)}
    targets:
      - price: ${midpoint.toFixed(2)}
        ratioOfPosition: 0.5
      - price: ${(high90 * 0.99).toFixed(2)}
        ratioOfPosition: 0.5

execution:
  entryTimeoutBars: 5
  rthOnly: false

risk:
  maxRiskPerTrade: 150
`;

  console.log(`  Support: $${low90.toFixed(2)}`);
  console.log(`  Resistance: $${high90.toFixed(2)}`);
  console.log(`  Midpoint: $${midpoint.toFixed(2)}`);
  console.log(`  Buy Entry: $${entryLowBuy.toFixed(2)} - $${entryHighBuy.toFixed(2)}`);
  console.log(`  Sell Entry: $${entryLowSell.toFixed(2)} - $${entryHighSell.toFixed(2)}\n`);

  return saveStrategy(symbol.toLowerCase() + '-range', yaml);
}

function saveStrategy(filename: string, yaml: string): string {
  const fs = require('fs');
  const path = `../strategies/${filename}.yaml`;
  fs.writeFileSync(path, yaml);
  console.log(`\n✓ Strategy saved: ${path}\n`);
  return path;
}

async function main() {
  try {
    console.log('\n🔍 Fetching NFLX data...');
    const bars = await fetchYahooData('NFLX', 90);
    console.log(`✓ Got ${bars.length} days of data\n`);
    analyzeData(bars, 'NFLX');
  } catch (e) {
    const err = e as Error;
    console.error('Error:', err.message);
  }
}

main();
