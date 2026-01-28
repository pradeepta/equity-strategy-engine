#!/usr/bin/env python3
"""
TWS Python API reqRealTimeBars Test (5-second bars only)
Tests if real-time 5-second bar subscription works with paper trading
"""

import sys
import time
import threading
from datetime import datetime
from collections import defaultdict

from ibapi.client import EClient
from ibapi.wrapper import EWrapper
from ibapi.contract import Contract
from ibapi.common import RealTimeBar

# Configuration
TWS_HOST = "127.0.0.1"
TWS_PORT = 7497  # Paper trading port
CLIENT_ID = 9998
REQUEST_ID = 12346
WAIT_SECONDS = 30

# ANSI color codes
RESET = "\033[0m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
CYAN = "\033[36m"


class TestApp(EWrapper, EClient):
    """TWS API test application for reqRealTimeBars"""

    def __init__(self):
        EClient.__init__(self, self)

        self.connected = False
        self.bar_count = 0
        self.last_bar_time = None
        self.event_counts = defaultdict(int)
        self.msg_thread = None

    def start(self):
        """Connect to TWS and start message loop"""
        print(f"{CYAN}🔌 Connecting to TWS at {TWS_HOST}:{TWS_PORT}...{RESET}")
        self.connect(TWS_HOST, TWS_PORT, CLIENT_ID)

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

        # Request live market data (Type 1)
        print(f"{CYAN}📡 Requesting LIVE market data (Type 1)...{RESET}")
        self.reqMarketDataType(1)
        print()

        # Request real-time 5-second bars
        self.request_realtime_bars()

    def connectionClosed(self):
        """Connection closed"""
        super().connectionClosed()
        self.event_counts['connectionClosed'] += 1
        print(f"{YELLOW}⚠️  Connection closed{RESET}")
        self.connected = False

    # ==================== Real-Time Bar Request ====================

    def request_realtime_bars(self):
        """Request real-time 5-second bars"""
        print(f"{BLUE}📡 Requesting real-time 5-second bars (reqRealTimeBars)...{RESET}")

        # Create XLE stock contract
        contract = Contract()
        contract.symbol = "XLE"
        contract.secType = "STK"
        contract.exchange = "SMART"
        contract.currency = "USD"

        print(f"   Contract: {contract.symbol} {contract.secType}")
        print(f"   Request ID: {REQUEST_ID}")
        print(f"   Bar Size: 5 seconds (ONLY size supported)")
        print(f"   What to Show: TRADES")
        print()

        # Request real-time bars
        # def reqRealTimeBars(self, reqId, contract, barSize, whatToShow, useRTH, realTimeBarsOptions)
        self.reqRealTimeBars(
            reqId=REQUEST_ID,
            contract=contract,
            barSize=5,  # Only 5 seconds supported
            whatToShow="TRADES",
            useRTH=True,  # Regular trading hours only
            realTimeBarsOptions=[]
        )

    # ==================== Real-Time Bar Callback ====================

    def realtimeBar(self, reqId: int, time: int, open_: float, high: float,
                     low: float, close: float, volume: int, wap: float, count: int):
        """
        Called every 5 seconds with a new real-time bar
        THIS IS WHAT WE'RE TESTING
        """
        super().realtimeBar(reqId, time, open_, high, low, close, volume, wap, count)

        if reqId != REQUEST_ID:
            print(f"{YELLOW}⚠️  Received realtimeBar for different reqId: "
                  f"{reqId} (expected: {REQUEST_ID}){RESET}")
            return

        self.event_counts['realtimeBar'] += 1
        self.bar_count += 1
        self.last_bar_time = datetime.fromtimestamp(time).strftime('%Y-%m-%d %H:%M:%S')

        print()
        print(f"{GREEN}🎯 REAL-TIME BAR #{self.bar_count}:{RESET}")
        print(f"   Time: {self.last_bar_time} (Unix: {time})")
        print(f"   Open: ${open_:.2f}")
        print(f"   High: ${high:.2f}")
        print(f"   Low: ${low:.2f}")
        print(f"   Close: ${close:.2f}")
        print(f"   Volume: {volume}")
        print(f"   Count: {count}")
        print(f"   WAP: ${wap:.2f}")

    # ==================== Error Handling ====================

    def error(self, reqId: int, errorCode: int, errorString: str, advancedOrderRejectJson=""):
        """Error callback"""
        try:
            super().error(reqId, errorCode, errorString, advancedOrderRejectJson)
        except TypeError:
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
        print(f"Real-Time Bars Received: {self.bar_count}")
        print(f"Last Bar Time: {self.last_bar_time or 'N/A'}")
        print()
        print("Event Counts:")
        for event, count in sorted(self.event_counts.items(), key=lambda x: x[1], reverse=True):
            print(f"  {event}: {count}")
        print("=" * 80)

        if self.bar_count > 0:
            print()
            print(f"{GREEN}✅ SUCCESS: Real-time bars are working!{RESET}")
            print(f"   Note: reqRealTimeBars only supports 5-second bars")
            print(f"   For 5-minute bars, use reqHistoricalData with keepUpToDate=True")
            return 0
        else:
            print()
            print(f"{RED}❌ FAILURE: No real-time bars received{RESET}")
            print("   Possible causes:")
            print("   - Market is closed or no trading activity")
            print("   - Paper trading doesn't support reqRealTimeBars")
            print("   - Market data subscription required")
            return 1


def main():
    """Main entry point"""
    print("=" * 80)
    print("TWS Python API reqRealTimeBars Test (5-second bars)")
    print("=" * 80)
    print(f"Connecting to TWS at {TWS_HOST}:{TWS_PORT}")
    print(f"Testing symbol: XLE, Bar size: 5 seconds")
    print(f"Will wait {WAIT_SECONDS} seconds for real-time bars...")
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
        return 1

    # Wait for specified time to collect real-time bars
    try:
        time.sleep(WAIT_SECONDS)
    except KeyboardInterrupt:
        print()
        print(f"{YELLOW}⚠️  Interrupted by user{RESET}")

    # Print results
    exit_code = app.print_results()

    # Cancel subscription
    print()
    print(f"{CYAN}Canceling real-time bar subscription...{RESET}")
    app.cancelRealTimeBars(REQUEST_ID)
    time.sleep(1)

    # Disconnect
    app.disconnect()

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
