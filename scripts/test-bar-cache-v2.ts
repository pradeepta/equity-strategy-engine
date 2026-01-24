/**
 * Test script for new bar caching system
 * Usage: tsx test-bar-cache-v2.ts
 */

import { Pool } from 'pg';
import { BarCacheServiceV2 } from '../live/cache/BarCacheServiceV2';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const cacheService = new BarCacheServiceV2(
    pool,
    {
      host: process.env.TWS_HOST || '127.0.0.1',
      port: parseInt(process.env.TWS_PORT || '7497', 10),
      clientId: 2000 + Math.floor(Math.random() * 1000),
    },
    {
      enabled: true,
      session: 'rth', // regular trading hours only
      what: 'trades',
    }
  );

  console.log('Testing BarCacheServiceV2...\n');

  // Test 1: Fetch 1d bars for AAPL (works outside market hours)
  console.log('Test 1: Fetching 100 bars of AAPL 1d data');
  const startTime = Date.now();
  const bars = await cacheService.getBars('AAPL', '1d', 100);
  const duration = Date.now() - startTime;

  console.log(`✓ Retrieved ${bars.length} bars in ${duration}ms`);
  if (bars.length > 0) {
    const first = bars[0];
    const last = bars[bars.length - 1];
    console.log('  First bar:', {
      timestamp: new Date(first.timestamp).toISOString(),
      close: first.close,
      volume: first.volume,
    });
    console.log('  Last bar:', {
      timestamp: new Date(last.timestamp).toISOString(),
      close: last.close,
      volume: last.volume,
    });
  }

  // Test 2: Fetch again (should be faster from cache)
  console.log('\nTest 2: Fetching same data again (should use cache)');
  const startTime2 = Date.now();
  const bars2 = await cacheService.getBars('AAPL', '1d', 100);
  const duration2 = Date.now() - startTime2;

  console.log(`✓ Retrieved ${bars2.length} bars in ${duration2}ms`);
  console.log(
    `  Cache speedup: ${Math.round((duration / duration2) * 10) / 10}x faster`
  );

  // Test 3: Get cache stats
  console.log('\nTest 3: Getting cache statistics');
  const stats = await cacheService.getCacheStats('AAPL', '1d');
  if (stats) {
    console.log('✓ Cache stats:', {
      barCount: stats.barCount,
      oldestBar: new Date(stats.oldestBar).toISOString(),
      newestBar: new Date(stats.newestBar).toISOString(),
    });
  } else {
    console.log('  No cache stats available');
  }

  // Test 4: Test different timeframes
  console.log('\nTest 4: Testing 1h timeframe');
  const startTime4 = Date.now();
  const bars4 = await cacheService.getBars('AAPL', '1h', 50);
  const duration4 = Date.now() - startTime4;

  console.log(`✓ Retrieved ${bars4.length} bars of 1h data in ${duration4}ms`);
  if (bars4.length > 0) {
    const last = bars4[bars4.length - 1];
    console.log('  Last bar:', {
      timestamp: new Date(last.timestamp).toISOString(),
      close: last.close,
    });
  }

  await pool.end();
  console.log('\n✓ All tests completed!');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
