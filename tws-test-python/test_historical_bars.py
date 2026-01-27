#!/usr/bin/env python3
"""
TWS Python API Historical Data Fetching Test
Tests basic historical bar fetching from TWS

Official TWS API Python package: ibapi
"""

import sys
import time
import threading
from datetime import datetime
from collections import defaultdict

from ibapi.client import EClient
from ibapi.wrapper import EWrapper
from ibapi.contract import Contract
from ibapi.common import BarData

# Configuration
TWS_HOST = "127.0.0.1"
TWS_PORT = 7497  # Paper trading port (use 7496 for live)
CLIENT_ID = 9998
REQUEST_ID = 12346
TIMEOUT_SECONDS = 30

# ANSI color codes
RESET = "\033[0m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
CYAN = "\033[36m"


class TestApp(EWrapper, EClient):
    """
    TWS API test application
    Combines EWrapper (callbacks) and EClient (request methods)
    """

    def __init__(self):
        EClient.__init__(self, self)

        # State tracking
        self.connected = False
        self.data_complete = False
        self.bar_count = 0
        self.bars_received = []
        self.error_occurred = False
        self.error_message = None
        self.event_counts = defaultdict(int)

        # Thread for message processing
        self.msg_thread = None

    def start(self):
        """Connect to TWS and start message loop"""
        print(f"{CYAN}🔌 Connecting to TWS at {TWS_HOST}:{TWS_PORT}...{RESET}")
        self.connect(TWS_HOST, TWS_PORT, CLIENT_ID)

        # Start message processing thread
        self.msg_thread = threading.Thread(target=self.run, daemon=True)
        self.msg_thread.start()

    # ==================== Connection Callbacks ====================

    def nextValidId(self, orderId: int):
        """Called when connection is established"""
        super().nextValidId(orderId)
        self.connected = True
        self.event_counts['nextValidId'] += 1

        print(f"{GREEN}✅ Connected to TWS{RESET}")
        print(f"   Next valid order ID: {orderId}")
        print()

        # Request historical data after connection
        self.request_historical_data()

    def connectAck(self):
        """Connection acknowledged"""
        super().connectAck()
        self.event_counts['connectAck'] += 1

    def connectionClosed(self):
        """Connection closed"""
        super().connectionClosed()
        self.event_counts['connectionClosed'] += 1
        print(f"{YELLOW}⚠️  Connection closed{RESET}")
        self.connected = False

    # ==================== Historical Data Request ====================

    def request_historical_data(self):
        """Request historical data for HL (5-minute bars, 1 day)"""
        print(f"{BLUE}📡 Requesting historical data...{RESET}")

        # Create HL stock contract (the symbol from your error logs)
        contract = Contract()
        contract.symbol = "HL"
        contract.secType = "STK"
        contract.exchange = "SMART"
        contract.currency = "USD"

        print(f"   Contract: {contract.symbol} {contract.secType}")
        print(f"   Request ID: {REQUEST_ID}")
        print(f"   Bar Size: 5 mins")
        print(f"   Duration: 1 D")
        print(f"   Session: Regular Trading Hours (RTH)")
        print(f"   What: TRADES")
        print(f"   End DateTime: Current time (empty string)")
        print()

        # Request historical data
        self.reqHistoricalData(
            reqId=REQUEST_ID,
            contract=contract,
            endDateTime="",         # Empty string = current time
            durationStr="1 D",      # 1 day of data
            barSizeSetting="5 mins",  # 5-minute bars
            whatToShow="TRADES",    # Trade data
            useRTH=1,               # Regular trading hours only
            formatDate=1,           # Format: yyyymmdd  hh:mm:ss
            keepUpToDate=False,     # No real-time streaming
            chartOptions=[]
        )

        print(f"{YELLOW}⏳ Waiting for historical data (timeout: {TIMEOUT_SECONDS}s)...{RESET}")

    # ==================== Historical Data Callbacks ====================

    def historicalData(self, reqId: int, bar: BarData):
        """Called for each historical bar"""
        super().historicalData(reqId, bar)

        if reqId != REQUEST_ID:
            return

        self.event_counts['historicalData'] += 1
        self.bar_count += 1
        self.bars_received.append({
            'date': bar.date,
            'open': bar.open,
            'high': bar.high,
            'low': bar.low,
            'close': bar.close,
            'volume': int(bar.volume),
            'wap': bar.average,
            'count': bar.barCount
        })

        # Print first 5 bars, then every 10th
        if self.bar_count <= 5 or self.bar_count % 10 == 0:
            print(f"   Bar {self.bar_count}: {bar.date} | "
                  f"O: ${bar.open:.2f} | H: ${bar.high:.2f} | "
                  f"L: ${bar.low:.2f} | C: ${bar.close:.2f} | "
                  f"Vol: {int(bar.volume)}")

    def historicalDataEnd(self, reqId: int, start: str, end: str):
        """Called when historical data download is complete"""
        super().historicalDataEnd(reqId, start, end)

        if reqId != REQUEST_ID:
            return

        self.event_counts['historicalDataEnd'] += 1
        self.data_complete = True

        print()
        print(f"{GREEN}✅ Historical data complete: {self.bar_count} bars received{RESET}")
        print(f"   Start: {start}")
        print(f"   End: {end}")

    # ==================== Error Handling ====================

    def error(self, reqId: int, errorCode: int, errorString: str, advancedOrderRejectJson=""):
        """Error callback"""
        # Note: super().error() signature varies by ibapi version
        try:
            super().error(reqId, errorCode, errorString, advancedOrderRejectJson)
        except TypeError:
            # Older ibapi versions don't have advancedOrderRejectJson parameter
            super().error(reqId, errorCode, errorString)

        self.event_counts[f'error_{errorCode}'] += 1

        # Filter out informational messages (don't treat as errors)
        info_codes = [2104, 2106, 2107, 2108, 2158, 2174, 2176]
        if errorCode in info_codes:
            print(f"ℹ️  TWS Info [{errorCode}]: {errorString}")
            return

        # Pacing violation - this is what we're looking for
        if errorCode == 162:
            print(f"{RED}🚨 PACING VIOLATION [{errorCode}]: {errorString}{RESET}")
            print(f"   This means you've exceeded TWS historical data request limits")
            print(f"   Wait 10 minutes before trying again")
            self.error_occurred = True
            self.error_message = f"Pacing violation: {errorString}"
            return

        # Market data errors
        if errorCode in [354, 10197, 10167]:
            print(f"{RED}❌ Market Data Error [{errorCode}]: {errorString}{RESET}")
            self.error_occurred = True
            self.error_message = f"Market data error: {errorString}"
            return

        # Request-specific errors
        if reqId == REQUEST_ID:
            print(f"{RED}❌ Request Error [{errorCode}]: {errorString}{RESET}")
            self.error_occurred = True
            self.error_message = f"[{errorCode}] {errorString}"
        else:
            print(f"{YELLOW}⚠️  TWS Error [{errorCode}]: {errorString}{RESET}")
            if reqId != -1:
                print(f"   Request ID: {reqId}")

    # ==================== Results ====================

    def print_results(self):
        """Print test results"""
        print()
        print("=" * 80)
        print("TEST RESULTS")
        print("=" * 80)
        print(f"Connected: {self.connected}")
        print(f"Data Complete: {self.data_complete}")
        print(f"Bars Received: {self.bar_count}")
        print(f"Error Occurred: {self.error_occurred}")
        if self.error_message:
            print(f"Error Message: {self.error_message}")
        print()

        if self.bar_count > 0:
            print(f"First Bar: {self.bars_received[0]['date']} @ ${self.bars_received[0]['close']:.2f}")
            print(f"Last Bar:  {self.bars_received[-1]['date']} @ ${self.bars_received[-1]['close']:.2f}")
            print()

        print("Event Counts:")
        for event, count in sorted(self.event_counts.items(), key=lambda x: x[1], reverse=True):
            print(f"  {event}: {count}")
        print("=" * 80)

        # Determine exit code
        if self.error_occurred:
            print()
            print(f"{RED}❌ FAILURE: Request failed with error{RESET}")
            print(f"   {self.error_message}")
            return 1
        elif self.data_complete and self.bar_count > 0:
            print()
            print(f"{GREEN}✅ SUCCESS: Historical data fetched successfully!{RESET}")
            return 0
        elif self.bar_count > 0:
            print()
            print(f"{YELLOW}⚠️  PARTIAL: Received bars but no completion signal{RESET}")
            return 1
        else:
            print()
            print(f"{RED}❌ FAILURE: No bars received{RESET}")
            print("   Possible causes:")
            print("   - Market is closed and no historical data available")
            print("   - TWS pacing violation (error 162)")
            print("   - Market data subscription required")
            print("   - Symbol not found or invalid")
            return 1


def main():
    """Main entry point"""
    print("=" * 80)
    print("TWS Python API Historical Data Fetching Test")
    print("=" * 80)
    print(f"Connecting to TWS at {TWS_HOST}:{TWS_PORT}")
    print(f"Testing symbol: HL (Hecla Mining)")
    print(f"Bar size: 5 mins, Duration: 1 day, Session: RTH")
    print(f"Timeout: {TIMEOUT_SECONDS} seconds")
    print("=" * 80)
    print()

    # Create and start app
    app = TestApp()
    app.start()

    # Wait for connection
    connection_timeout = 10
    start_time = time.time()
    while not app.connected and (time.time() - start_time) < connection_timeout:
        time.sleep(0.1)

    if not app.connected:
        print(f"{RED}❌ Failed to connect to TWS{RESET}")
        print(f"   Make sure TWS or IB Gateway is running on {TWS_HOST}:{TWS_PORT}")
        print("   Check TWS API settings: Configuration → API → Settings")
        print("   Enable 'Enable ActiveX and Socket Clients'")
        print(f"   Add 127.0.0.1 to 'Trusted IP Addresses'")
        return 1

    # Wait for data to complete or timeout
    start_time = time.time()
    while not app.data_complete and not app.error_occurred and (time.time() - start_time) < TIMEOUT_SECONDS:
        time.sleep(0.5)

    # Check if timed out
    if not app.data_complete and not app.error_occurred:
        print()
        print(f"{RED}❌ TIMEOUT: No response after {TIMEOUT_SECONDS} seconds{RESET}")
        print("   This suggests TWS is not responding to the request")
        print("   Possible causes:")
        print("   - TWS pacing violation (too many requests recently)")
        print("   - TWS connection issue")
        print("   - Request stuck in TWS queue")

    # Print results
    exit_code = app.print_results()

    # Disconnect
    print()
    print(f"{CYAN}🔌 Disconnecting from TWS...{RESET}")
    app.disconnect()
    time.sleep(1)  # Give time to disconnect cleanly

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
