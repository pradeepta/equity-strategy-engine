/**
 * Test script to verify Python TWS Bridge integration
 */

import { fetchHistoricalFromIbkr } from "./broker/marketData/ibkr";
import type { Period, Session, What } from "./broker/marketData/types";

async function testPythonBridge() {
  console.log("=" .repeat(60));
  console.log("Testing Python TWS Bridge Integration");
  console.log("=" .repeat(60));
  console.log("");

  // Configure test parameters
  const symbol = "XLE";
  const period: Period = "5m";
  const durationSeconds = 24 * 60 * 60; // 1 day
  const what: What = "trades";
  const session: Session = "rth";
  const windowEnd = new Date();

  console.log("Test Parameters:");
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Period: ${period}`);
  console.log(`  Duration: ${durationSeconds}s (${durationSeconds / (24 * 60 * 60)} days)`);
  console.log(`  What: ${what}`);
  console.log(`  Session: ${session}`);
  console.log(`  Window End: ${windowEnd.toISOString()}`);
  console.log("");

  console.log("Environment:");
  console.log(`  PYTHON_TWS_ENABLED: ${process.env.PYTHON_TWS_ENABLED}`);
  console.log(`  PYTHON_TWS_URL: ${process.env.PYTHON_TWS_URL || "http://localhost:3003"}`);
  console.log("");

  try {
    console.log("Fetching bars...");
    const startTime = Date.now();

    const bars = await fetchHistoricalFromIbkr({
      ibkr: {
        host: process.env.TWS_HOST || "127.0.0.1",
        port: parseInt(process.env.TWS_PORT || "7497"),
        clientId: parseInt(process.env.TWS_CLIENT_ID || "0"),
      },
      symbol,
      period,
      what,
      session,
      windowEnd,
      durationSeconds,
      includeForming: false,
    });

    const duration = Date.now() - startTime;

    console.log("");
    console.log("✅ Success!");
    console.log(`  Fetched ${bars.length} bars in ${duration}ms`);
    console.log("");

    if (bars.length > 0) {
      console.log("First 3 bars:");
      bars.slice(0, 3).forEach((bar, idx) => {
        console.log(`  [${idx + 1}] ${bar.date}: O=$${bar.open} H=$${bar.high} L=$${bar.low} C=$${bar.close} V=${bar.volume}`);
      });
      console.log("");

      console.log("Last 3 bars:");
      bars.slice(-3).forEach((bar, idx) => {
        console.log(`  [${bars.length - 2 + idx}] ${bar.date}: O=$${bar.open} H=$${bar.high} L=$${bar.low} C=$${bar.close} V=${bar.volume}`);
      });
    }

    console.log("");
    console.log("=" .repeat(60));
    console.log("✅ Test PASSED");
    console.log("=" .repeat(60));

  } catch (error: any) {
    console.error("");
    console.error("❌ Error:", error.message);
    if (error.stack) {
      console.error("");
      console.error("Stack trace:");
      console.error(error.stack);
    }
    console.log("");
    console.log("=" .repeat(60));
    console.log("❌ Test FAILED");
    console.log("=" .repeat(60));
    process.exit(1);
  }
}

testPythonBridge();
