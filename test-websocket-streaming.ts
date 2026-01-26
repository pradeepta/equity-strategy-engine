/**
 * Test WebSocket streaming connection to Python TWS Bridge
 */

import { RealtimeBarClient } from "./live/streaming/RealtimeBarClient";
import { LoggerFactory } from "./logging/logger";

const logger = LoggerFactory.getLogger("WebSocketTest");

async function main() {
  logger.info("========================================");
  logger.info("Testing WebSocket Streaming Connection");
  logger.info("========================================");

  // Create client
  const client = new RealtimeBarClient("ws://localhost:3003/ws/stream");

  // Set up event handlers
  client.on("connected", () => {
    logger.info("✅ Connected to streaming server");
  });

  client.on("disconnected", () => {
    logger.warn("⚠️  Disconnected from streaming server");
  });

  client.on("bar", (symbol: string, bar: any) => {
    logger.info(`🔄 Bar update received: ${symbol}`, {
      timestamp: new Date(bar.timestamp).toISOString(),
      close: bar.close,
      volume: bar.volume,
    });
  });

  client.on("subscribed", (symbol: string) => {
    logger.info(`✅ Successfully subscribed to ${symbol}`);
  });

  client.on("error", (error: Error) => {
    logger.error(`❌ Error: ${error.message}`);
  });

  // Connect
  logger.info("Connecting to WebSocket...");
  try {
    await client.connect();

    // Subscribe to XLE (as seen in the Python logs)
    logger.info("Subscribing to XLE real-time bars...");
    await client.subscribe({
      symbol: "XLE",
      period: "5m",
      session: "rth",
      what: "TRADES",
    });

    logger.info("Waiting for bar updates... (will run for 30 seconds)");
    logger.info("Press Ctrl+C to exit early");

    // Wait 30 seconds to receive updates
    await new Promise((resolve) => setTimeout(resolve, 30000));

    logger.info("Test complete, disconnecting...");
    client.disconnect();

    logger.info("✅ Test finished");
    process.exit(0);
  } catch (error: any) {
    logger.error(`❌ Test failed: ${error.message}`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
