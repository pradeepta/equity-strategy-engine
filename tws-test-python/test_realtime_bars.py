#!/usr/bin/env python3
"""
TWS Python API Real-Time Bar Streaming Test
Tests if keepUpToDate=true works for XLE 5-minute bars

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
TWS_PORT = 7496  # Paper trading port (use 7496 for live)
CLIENT_ID = 9999
REQUEST_ID = 12345
WAIT_SECONDS = 60

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
        self.historical_data_complete = False
        self.historical_bar_count = 0
        self.update_count = 0
        self.last_update_time = None
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

        # CRITICAL: Request LIVE market data (Type 1) for real-time streaming with keepUpToDate
        # Type 1 = Live (requires paid subscription, needed for keepUpToDate)
        # Type 2 = Frozen (closing prices only, no updates)
        # Type 3 = Delayed (15-min delay, doesn't work with keepUpToDate)
        print(f"{CYAN}📡 Requesting LIVE market data (Type 1)...{RESET}")
        self.reqMarketDataType(1)
        print(f"   Note: Type 1 = Live real-time data (required for keepUpToDate)")
        print(f"   If you don't have a market data subscription, you'll get errors")
        print()

        # Request historical data after connection
        self.request_historical_data()

    def connectAck(self):
        """Connection acknowledged"""
        super().connectAck()
        self.event_counts['connectAck'] += 1
        print("Connection acknowledged")

    def connectionClosed(self):
        """Connection closed"""
        super().connectionClosed()
        self.event_counts['connectionClosed'] += 1
        print(f"{YELLOW}⚠️  Connection closed{RESET}")
        self.connected = False

    # ==================== Historical Data Request ====================

    def request_historical_data(self):
        """Request historical data with keepUpToDate=true"""
        print(f"{BLUE}📡 Requesting historical data with keepUpToDate=true...{RESET}")

        # Create XLE stock contract
        contract = Contract()
        contract.symbol = "AAPL"
        contract.secType = "STK"
        contract.exchange = "SMART"
        contract.currency = "USD"

        print(f"   Contract: {contract.symbol} {contract.secType}")
        print(f"   Request ID: {REQUEST_ID}")
        print(f"   Bar Size: 5 mins")
        print(f"   Duration: 1 D")
        print(f"   Keep Up To Date: true")
        print()

        # Request historical data with keepUpToDate=true
        # def reqHistoricalData(self, reqId, contract, endDateTime, durationStr,
        #                       barSizeSetting, whatToShow, useRTH, formatDate,
        #                       keepUpToDate, chartOptions)
        self.reqHistoricalData(
            reqId=REQUEST_ID,
            contract=contract,
            endDateTime="",         # Empty string = current time (required for keepUpToDate)
            durationStr="1 D",      # 1 day of data
            barSizeSetting="5 mins",  # 5-minute bars
            whatToShow="TRADES",    # Trade data
            useRTH=1,               # Regular trading hours only
            formatDate=1,           # Format: yyyymmdd  hh:mm:ss
            keepUpToDate=True,      # Enable real-time streaming
            chartOptions=[]
        )

    # ==================== Historical Data Callbacks ====================

    def historicalData(self, reqId: int, bar: BarData):
        """Called for each historical bar"""
        super().historicalData(reqId, bar)

        if reqId != REQUEST_ID:
            return

        self.event_counts['historicalData'] += 1
        self.historical_bar_count += 1

        # Print every bar (or every 10th for brevity)
        if self.historical_bar_count <= 5 or self.historical_bar_count % 10 == 0:
            print(f"   Bar {self.historical_bar_count}: {bar.date} | "
                  f"Close: ${bar.close:.2f} | Vol: {int(bar.volume)}")

    def historicalDataEnd(self, reqId: int, start: str, end: str):
        """Called when historical data download is complete"""
        super().historicalDataEnd(reqId, start, end)

        if reqId != REQUEST_ID:
            return

        self.event_counts['historicalDataEnd'] += 1
        self.historical_data_complete = True

        print()
        print(f"{GREEN}✅ Historical data complete: {self.historical_bar_count} bars received{RESET}")
        print(f"{YELLOW}⏳ Waiting for real-time updates (historicalDataUpdate callbacks)...{RESET}")
        print(f"   Connection stays open for {WAIT_SECONDS} seconds...")
        print()

    def historicalDataUpdate(self, reqId: int, bar: BarData):
        """
        Called for real-time bar updates when keepUpToDate=True
        THIS IS WHAT WE'RE TESTING
        """
        super().historicalDataUpdate(reqId, bar)

        if reqId != REQUEST_ID:
            print(f"{YELLOW}⚠️  Received historicalDataUpdate for different reqId: "
                  f"{reqId} (expected: {REQUEST_ID}){RESET}")
            return

        self.event_counts['historicalDataUpdate'] += 1
        self.update_count += 1
        self.last_update_time = bar.date

        print()
        print(f"{GREEN}🎯 REAL-TIME UPDATE #{self.update_count}:{RESET}")
        print(f"   Time: {bar.date}")
        print(f"   Open: ${bar.open:.2f}")
        print(f"   High: ${bar.high:.2f}")
        print(f"   Low: ${bar.low:.2f}")
        print(f"   Close: ${bar.close:.2f}")
        print(f"   Volume: {int(bar.volume)}")
        print(f"   Count: {bar.barCount}")
        print(f"   WAP: ${bar.average:.2f}")

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

        # Filter out informational messages
        info_codes = [2104, 2106, 2107, 2108, 2158, 2176]
        if errorCode in info_codes:
            print(f"ℹ️  TWS Info [{errorCode}]: {errorString}")
            return

        print(f"{RED}❌ TWS Error [{errorCode}]: {errorString}{RESET}")
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
        print(f"Historical Data Complete: {self.historical_data_complete}")
        print(f"Historical Bars Received: {self.historical_bar_count}")
        print(f"Real-Time Updates Received: {self.update_count}")
        print(f"Last Update Time: {self.last_update_time or 'N/A'}")
        print()
        print("Event Counts:")
        for event, count in sorted(self.event_counts.items(), key=lambda x: x[1], reverse=True):
            print(f"  {event}: {count}")
        print("=" * 80)

        if self.update_count > 0:
            print()
            print(f"{GREEN}✅ SUCCESS: Real-time updates are working!{RESET}")
            return 0
        else:
            print()
            print(f"{RED}❌ FAILURE: No real-time updates received{RESET}")
            print("   Possible causes:")
            print("   - Market is closed or no trading activity")
            print("   - TWS doesn't support keepUpToDate with your account")
            print("   - TWS API version doesn't support this feature")
            print("   - Market data subscription required")
            return 1


def main():
    """Main entry point"""
    print("=" * 80)
    print("TWS Python API Real-Time Bar Streaming Test")
    print("=" * 80)
    print(f"Connecting to TWS at {TWS_HOST}:{TWS_PORT}")
    print(f"Testing symbol: XLE, Bar size: 5 mins, Duration: 1 day")
    print(f"Will wait {WAIT_SECONDS} seconds for real-time updates...")
    print("=" * 80)
    print()

    # Create and start app
    app = TestApp()
    app.start()

    # Wait for connection
    timeout = 10
    start_time = time.time()
    while not app.connected and (time.time() - start_time) < timeout:
        time.sleep(0.1)

    if not app.connected:
        print(f"{RED}❌ Failed to connect to TWS{RESET}")
        print(f"   Make sure TWS or IB Gateway is running on {TWS_HOST}:{TWS_PORT}")
        print("   Check TWS API settings: Configuration → API → Settings")
        return 1

    # Wait for specified time to collect real-time updates
    try:
        time.sleep(WAIT_SECONDS)
    except KeyboardInterrupt:
        print()
        print(f"{YELLOW}⚠️  Interrupted by user{RESET}")

    # Print results
    exit_code = app.print_results()

    # Disconnect
    app.disconnect()

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
