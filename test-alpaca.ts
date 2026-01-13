/**
 * Test Alpaca connection and show API response format
 */

import * as dotenv from 'dotenv';
import * as https from 'https';

dotenv.config();

const apiKey = process.env.ALPACA_API_KEY || '';
const apiSecret = process.env.ALPACA_API_SECRET || '';
const baseUrl = 'https://paper-api.alpaca.markets';

console.log('\n🔌 Testing Alpaca API Connection\n');

function request(method: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function test() {
  try {
    console.log('1️⃣  Testing account endpoint...\n');
    const account = await request('GET', '/v2/account');
    console.log('Response:');
    console.log(JSON.stringify(account, null, 2));

    if (account.portfolio_value) {
      console.log(`\n✓ Account connected!`);
      console.log(`  Portfolio: $${parseFloat(account.portfolio_value).toFixed(2)}`);
      console.log(`  Cash: $${parseFloat(account.cash).toFixed(2)}`);
    } else if (account.code) {
      console.log(`\n❌ API Error: ${account.message}`);
    }

    console.log('\n2️⃣  Checking market status...\n');
    const clock = await request('GET', '/v1/clock');
    console.log('Market Status:');
    console.log(JSON.stringify(clock, null, 2));

    if (clock.is_open) {
      console.log('\n✓ Market is OPEN');
    } else {
      const nextOpen = new Date(clock.next_open);
      console.log(`\n⚠️  Market is CLOSED`);
      console.log(`   Next open: ${nextOpen.toLocaleString()}`);
    }

    console.log('\n3️⃣  Fetching recent bars...\n');
    const bars = await request('GET', '/v1/bars/1day?symbols=NFLX&limit=5');
    console.log('Bars Response (first 200 chars):');
    console.log(JSON.stringify(bars, null, 2).substring(0, 200) + '...');

    if (bars.NFLX && bars.NFLX.length > 0) {
      console.log(`\n✓ Got ${bars.NFLX.length} bars for NFLX`);
      const latest = bars.NFLX[bars.NFLX.length - 1];
      console.log(`  Latest: $${latest.c}`);
    } else {
      console.log('\n⚠️  No bars available');
    }

    console.log('\n✅ Connection test complete\n');

  } catch (e) {
    const err = e as Error;
    console.error('❌ Error:', err.message);
  }
}

test();
