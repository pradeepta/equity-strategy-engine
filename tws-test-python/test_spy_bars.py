#!/usr/bin/env python3
"""
Test SPY historical bars specifically
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
TWS_PORT = 7497
CLIENT_ID = 9995
REQUEST_ID = 12347
TIMEOUT_SECONDS = 30

# ANSI colors
RESET = "\033[0m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
CYAN = "\033[36m"


class TestApp(EWrapper, EClient):
    def __init__(self):
        EClient.__init__(self, self)
        self.connected = False
        self.data_complete = False
        self.bar_count = 0
        self.bars_received = []
        self.error_occurred = False
        self.error_message = None

    def start(self):
        print(f"{CYAN}🔌 Connecting to TWS at {TWS_HOST}:{TWS_PORT}...{RESET}")
        self.connect(TWS_HOST, TWS_PORT, CLIENT_ID)
        self.msg_thread = threading.Thread(target=self.run, daemon=True)
        self.msg_thread.start()

    def nextValidId(self, orderId: int):
        super().nextValidId(orderId)
        self.connected = True
        print(f"{GREEN}✅ Connected to TWS{RESET}")
        print()
        self.request_historical_data()

    def request_historical_data(self):
        print(f"{BLUE}📡 Requesting SPY historical data...{RESET}")

        # Create SPY ETF contract
        contract = Contract()
        contract.symbol = "SPY"
        contract.secType = "STK"
        contract.exchange = "SMART"
        contract.currency = "USD"

        print(f"   Contract: {contract.symbol} {contract.secType}")
        print(f"   Bar Size: 5 mins")
        print(f"   Duration: 1 D")
        print(f"   Session: RTH")
        print()

        self.reqHistoricalData(
            reqId=REQUEST_ID,
            contract=contract,
            endDateTime="",
            durationStr="1 D",
            barSizeSetting="5 mins",
            whatToShow="TRADES",
            useRTH=1,
            formatDate=1,
            keepUpToDate=False,
            chartOptions=[]
        )

        print(f"{YELLOW}⏳ Waiting for data (timeout: {TIMEOUT_SECONDS}s)...{RESET}")

    def historicalData(self, reqId: int, bar: BarData):
        super().historicalData(reqId, bar)
        if reqId != REQUEST_ID:
            return

        self.bar_count += 1
        self.bars_received.append({
            'date': bar.date,
            'close': bar.close,
            'volume': int(bar.volume)
        })

        if self.bar_count <= 5 or self.bar_count % 10 == 0:
            print(f"   Bar {self.bar_count}: {bar.date} | C: ${bar.close:.2f} | Vol: {int(bar.volume)}")

    def historicalDataEnd(self, reqId: int, start: str, end: str):
        super().historicalDataEnd(reqId, start, end)
        if reqId != REQUEST_ID:
            return

        self.data_complete = True
        print()
        print(f"{GREEN}✅ Historical data complete: {self.bar_count} bars{RESET}")
        print(f"   Start: {start}")
        print(f"   End: {end}")

    def error(self, reqId: int, errorCode: int, errorString: str, advancedOrderRejectJson=""):
        try:
            super().error(reqId, errorCode, errorString, advancedOrderRejectJson)
        except TypeError:
            super().error(reqId, errorCode, errorString)

        # Filter info messages
        if errorCode in [2104, 2106, 2107, 2108, 2158, 2174, 2176]:
            return

        # Pacing violation
        if errorCode == 162:
            print(f"{RED}🚨 PACING VIOLATION: {errorString}{RESET}")
            self.error_occurred = True
            self.error_message = f"Pacing violation: {errorString}"
            return

        if reqId == REQUEST_ID:
            print(f"{RED}❌ Error [{errorCode}]: {errorString}{RESET}")
            self.error_occurred = True
            self.error_message = f"[{errorCode}] {errorString}"

    def print_results(self):
        print()
        print("=" * 80)
        print("SPY TEST RESULTS")
        print("=" * 80)
        print(f"Connected: {self.connected}")
        print(f"Data Complete: {self.data_complete}")
        print(f"Bars Received: {self.bar_count}")
        print(f"Error Occurred: {self.error_occurred}")
        if self.error_message:
            print(f"Error: {self.error_message}")

        if self.bar_count > 0:
            print()
            print(f"First: {self.bars_received[0]['date']} @ ${self.bars_received[0]['close']:.2f}")
            print(f"Last:  {self.bars_received[-1]['date']} @ ${self.bars_received[-1]['close']:.2f}")

        print("=" * 80)

        if self.error_occurred:
            print(f"{RED}❌ FAILURE{RESET}")
            return 1
        elif self.data_complete and self.bar_count > 0:
            print(f"{GREEN}✅ SUCCESS{RESET}")
            return 0
        else:
            print(f"{RED}❌ FAILURE: No bars received{RESET}")
            return 1


def main():
    print("=" * 80)
    print("SPY Historical Bars Test")
    print("=" * 80)
    print()

    app = TestApp()
    app.start()

    # Wait for connection
    start_time = time.time()
    while not app.connected and (time.time() - start_time) < 10:
        time.sleep(0.1)

    if not app.connected:
        print(f"{RED}❌ Failed to connect{RESET}")
        return 1

    # Wait for data
    start_time = time.time()
    while not app.data_complete and not app.error_occurred and (time.time() - start_time) < TIMEOUT_SECONDS:
        time.sleep(0.5)

    if not app.data_complete and not app.error_occurred:
        print(f"{RED}❌ TIMEOUT{RESET}")

    exit_code = app.print_results()

    print()
    print(f"{CYAN}🔌 Disconnecting...{RESET}")
    app.disconnect()
    time.sleep(1)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
