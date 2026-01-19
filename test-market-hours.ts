/**
 * Test script to demonstrate market hours awareness
 */

import { getMarketHoursInfo, calculateTradingTime, formatTradingTimeInfo } from './utils/marketHours';

console.log('═══════════════════════════════════════════════════════════════');
console.log('Market Hours Awareness Test');
console.log('═══════════════════════════════════════════════════════════════\n');

// Get current market status
const marketInfo = getMarketHoursInfo();
console.log('Current Market Status:');
console.log('─────────────────────────────────────────────────────────────');
console.log(`Time (ET): ${marketInfo.currentTimeET}`);
console.log(`Day: ${marketInfo.currentDayOfWeek}`);
console.log(`Market Open: ${marketInfo.isMarketOpen ? '✓ YES' : '✗ NO'}`);
console.log(`Status: ${marketInfo.description}`);
console.log(`Hours: ${marketInfo.marketOpen} - ${marketInfo.marketClose}\n`);

// Test case 1: XOM scenario (156 bars @ 5m = 13 hours calendar, but how much trading time?)
console.log('Test Case 1: XOM Energy Momentum (156 bars @ 5m)');
console.log('─────────────────────────────────────────────────────────────');
const xomTime = calculateTradingTime(156, '5m');
console.log(`Total Bars: ${xomTime.totalBars}`);
console.log(`Bars Per Day: ${xomTime.barsPerDay} bars/day`);
console.log(`Estimated Trading Days: ${xomTime.estimatedTradingDays.toFixed(2)} days`);
console.log(`Estimated Trading Hours: ${xomTime.estimatedTradingHours.toFixed(2)} hours`);
console.log(`Total Calendar Time: ${xomTime.totalCalendarHours.toFixed(2)} hours`);
console.log(`Summary: ${xomTime.description}\n`);

// Test case 2: Full trading day (78 bars @ 5m)
console.log('Test Case 2: Full Trading Day (78 bars @ 5m)');
console.log('─────────────────────────────────────────────────────────────');
const fullDay = calculateTradingTime(78, '5m');
console.log(`Summary: ${fullDay.description}\n`);

// Test case 3: Three trading days (234 bars @ 5m)
console.log('Test Case 3: Three Trading Days (234 bars @ 5m)');
console.log('─────────────────────────────────────────────────────────────');
const threeDays = calculateTradingTime(234, '5m');
console.log(`Summary: ${threeDays.description}\n`);

// Test case 4: Weekend included scenario (78 bars Friday + 48 hours weekend = still 1 trading day)
console.log('Test Case 4: Breakout Strategy Patience Threshold');
console.log('─────────────────────────────────────────────────────────────');
console.log('Recommended minimums before considering strategy "stale":');
console.log('- Breakout strategies: 1-3 trading days (78-234 bars @ 5m)');
console.log('- Mean reversion: 0.5-2 trading days (39-156 bars @ 5m)\n');

// Test formatted output
console.log('Formatted Output for Logging:');
console.log('─────────────────────────────────────────────────────────────');
console.log(formatTradingTimeInfo(156, '5m'));
console.log('\n═══════════════════════════════════════════════════════════════');
