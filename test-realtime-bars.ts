/**
 * Standalone test script for TWS real-time bar streaming
 * Tests if keepUpToDate=true works for XLE 5-minute bars
 */

import { IBApi, EventName, Contract, SecType, BarSizeSetting } from "@stoqey/ib";

const TWS_HOST = process.env.TWS_HOST || "127.0.0.1";
const TWS_PORT = parseInt(process.env.TWS_PORT || "7497", 10);
const CLIENT_ID = 9999; // Use unique ID to avoid conflicts

console.log("=".repeat(80));
console.log("TWS Real-Time Bar Streaming Test");
console.log("=".repeat(80));
console.log(`Connecting to TWS at ${TWS_HOST}:${TWS_PORT}`);
console.log(`Testing symbol: XLE, Bar size: 5 mins, Duration: 1 day`);
console.log(`Will wait 60 seconds for real-time updates...`);
console.log("=".repeat(80));
console.log();

const ib = new IBApi({
  clientId: CLIENT_ID,
  host: TWS_HOST,
  port: TWS_PORT,
});

const reqId = 12345;
let connected = false;
let historicalDataComplete = false;
let updateCount = 0;
let lastUpdateTime: string | null = null;

// Track all received events
const eventCounts: Record<string, number> = {};

// Intercept ALL events to see what TWS is sending
const ibEmitter = ib as any;
const originalEmit = ibEmitter.emit.bind(ibEmitter);
ibEmitter.emit = function (event: any, ...args: any[]) {
  const eventName = String(event);
  eventCounts[eventName] = (eventCounts[eventName] || 0) + 1;

  // Log any event with "update" in the name
  if (eventName.includes("update") || eventName.includes("Update")) {
    console.log(`\n🔔 EVENT: ${eventName}`);
    console.log(`   Args: ${JSON.stringify(args.slice(0, 3))}...`);
  }

  return originalEmit(event, ...args);
};

// Error handler
ibEmitter.on("error", (err: Error, code: number, reqIdReceived: number) => {
  const infoMessages = [2104, 2106, 2107, 2108, 2158];
  if (!infoMessages.includes(code) && code !== 2176) {
    console.error(`❌ TWS Error [${code}]:`, err.message);
  } else {
    console.log(`ℹ️  TWS Info [${code}]:`, err.message);
  }
});

// Connection handler
ibEmitter.once("connected", () => {
  connected = true;
  console.log("✅ Connected to TWS\n");

  const contract: Contract = {
    symbol: "XLE",
    secType: SecType.STK,
    exchange: "SMART",
    currency: "USD",
  };

  console.log("📡 Requesting historical data with keepUpToDate=true...");
  console.log(`   Contract: ${JSON.stringify(contract)}`);
  console.log(`   Request ID: ${reqId}`);
  console.log(`   Bar Size: 5 mins`);
  console.log(`   Duration: 1 D`);
  console.log(`   Keep Up To Date: true`);
  console.log();

  ib.reqHistoricalData(
    reqId,
    contract,
    "", // Empty string = current time (required for keepUpToDate)
    "1 D",
    BarSizeSetting.MINUTES_FIVE,
    "TRADES",
    1, // useRTH = 1 (regular trading hours only)
    1, // formatDate = 1
    true // keepUpToDate = TRUE (enable real-time streaming)
  );
});

// Historical data handler
let barCount = 0;
ibEmitter.on(
  "historicalData",
  (
    id: number,
    date: string,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
    count: number,
    WAP: number
  ) => {
    if (id !== reqId) return;

    if (date.startsWith("finished")) {
      historicalDataComplete = true;
      console.log(`\n✅ Historical data complete: ${barCount} bars received`);
      console.log(`⏳ Waiting for real-time updates (historicalDataUpdate events)...`);
      console.log(`   Connection stays open for 60 seconds...\n`);
      return;
    }

    barCount++;
    if (barCount === 1 || barCount % 10 === 0 || barCount === barCount) {
      console.log(`   Bar ${barCount}: ${date} | Close: $${close.toFixed(2)} | Vol: ${volume}`);
    }
  }
);

// Real-time update handler (THIS IS WHAT WE'RE TESTING)
ibEmitter.on(
  EventName.historicalDataUpdate,
  (
    id: number,
    time: string,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
    count: number,
    WAP: number
  ) => {
    if (id !== reqId) {
      console.log(`⚠️  Received historicalDataUpdate for different reqId: ${id} (expected: ${reqId})`);
      return;
    }

    updateCount++;
    lastUpdateTime = time;

    console.log(`\n🎯 REAL-TIME UPDATE #${updateCount}:`);
    console.log(`   Time: ${time}`);
    console.log(`   Open: $${open.toFixed(2)}`);
    console.log(`   High: $${high.toFixed(2)}`);
    console.log(`   Low: $${low.toFixed(2)}`);
    console.log(`   Close: $${close.toFixed(2)}`);
    console.log(`   Volume: ${volume}`);
    console.log(`   Count: ${count}`);
    console.log(`   WAP: $${WAP.toFixed(2)}`);
  }
);

// Connect to TWS
console.log("🔌 Connecting...\n");
ib.connect();

// Wait 60 seconds, then show results and exit
setTimeout(() => {
  console.log("\n" + "=".repeat(80));
  console.log("TEST RESULTS");
  console.log("=".repeat(80));
  console.log(`Connected: ${connected}`);
  console.log(`Historical Data Complete: ${historicalDataComplete}`);
  console.log(`Historical Bars Received: ${barCount}`);
  console.log(`Real-Time Updates Received: ${updateCount}`);
  console.log(`Last Update Time: ${lastUpdateTime || "N/A"}`);
  console.log();
  console.log("Event Counts:");
  Object.entries(eventCounts)
    .sort(([, a], [, b]) => b - a)
    .forEach(([event, count]) => {
      console.log(`  ${event}: ${count}`);
    });
  console.log("=".repeat(80));

  if (updateCount > 0) {
    console.log("\n✅ SUCCESS: Real-time updates are working!");
  } else {
    console.log("\n❌ FAILURE: No real-time updates received");
    console.log("   Possible causes:");
    console.log("   - Market is closed or no trading activity");
    console.log("   - TWS doesn't support keepUpToDate with your account");
    console.log("   - TWS API version doesn't support this feature");
    console.log("   - @stoqey/ib library bug");
  }

  ib.disconnect();
  process.exit(updateCount > 0 ? 0 : 1);
}, 60000); // Wait 60 seconds

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log("\n\n⚠️  Interrupted by user");
  ib.disconnect();
  process.exit(130);
});
