# TWS Python API Real-Time Bar Test

Official Python test for TWS API `keepUpToDate` feature using the `ibapi` package.

## Overview

This test determines whether TWS API's real-time bar streaming (`keepUpToDate=True`) works with your account and setup. It's independent of the Node.js `@stoqey/ib` library to isolate potential issues.

## Prerequisites

1. **Python 3.7+**
   ```bash
   python3 --version
   ```

2. **TWS or IB Gateway Running**
   - Must be running on `localhost:7497` (paper trading)
   - Or `localhost:7496` (live trading)
   - API connections enabled in settings

3. **Market Data Subscription** (optional but recommended)
   - Free delayed data works but may be limited
   - Paid real-time subscription provides better results

## Installation

### Option 1: Using pip (Recommended)

```bash
cd tws-test-python
pip install -r requirements.txt
```

### Option 2: Manual Installation

```bash
# Install official TWS API Python package
pip install ibapi
```

### Option 3: From Source (if pip install fails)

```bash
# Download TWS API
cd ~
wget https://interactivebrokers.github.io/downloads/twsapi_macunix.1019.01.zip
unzip twsapi_macunix.1019.01.zip

# Install Python package
cd TWS_API/IBJts/source/pythonclient
python3 setup.py install

# Or use without installing
export PYTHONPATH="${HOME}/TWS_API/IBJts/source/pythonclient:${PYTHONPATH}"
```

## Usage

### Basic Test (Paper Trading)

```bash
cd tws-test-python
python3 test_realtime_bars.py
```

### Custom TWS Connection

```bash
# Live trading port (7496)
python3 test_realtime_bars.py --host 127.0.0.1 --port 7496

# Remote TWS
python3 test_realtime_bars.py --host 192.168.1.100 --port 7497
```

### Run with Python Path (if not installed)

```bash
PYTHONPATH="${HOME}/TWS_API/IBJts/source/pythonclient" python3 test_realtime_bars.py
```

## Expected Output

### ✅ If keepUpToDate Works (Success Case)

```
================================================================================
TWS Python API Real-Time Bar Streaming Test
================================================================================
Connecting to TWS at 127.0.0.1:7497
Testing symbol: XLE, Bar size: 5 mins, Duration: 1 day
Will wait 60 seconds for real-time updates...
================================================================================

🔌 Connecting to TWS at 127.0.0.1:7497...
Connection acknowledged
✅ Connected to TWS
   Next valid order ID: 1

📡 Requesting historical data with keepUpToDate=true...
   Contract: XLE STK
   Request ID: 12345
   Bar Size: 5 mins
   Duration: 1 D
   Keep Up To Date: true

   Bar 1: 20260126  09:30:00 | Close: $49.37 | Vol: 2476485
   Bar 2: 20260126  09:35:00 | Close: $49.50 | Vol: 1379486
   Bar 3: 20260126  09:40:00 | Close: $49.50 | Vol: 659872
   ...
   Bar 25: 20260126  11:30:00 | Close: $48.99 | Vol: 294057

✅ Historical data complete: 25 bars received
⏳ Waiting for real-time updates (historicalDataUpdate callbacks)...
   Connection stays open for 60 seconds...

🎯 REAL-TIME UPDATE #1:
   Time: 20260126  11:35:00
   Open: $48.95
   High: $49.02
   Low: $48.94
   Close: $49.00
   Volume: 325000
   Count: 1500
   WAP: $48.98

================================================================================
TEST RESULTS
================================================================================
Connected: True
Historical Data Complete: True
Historical Bars Received: 25
Real-Time Updates Received: 1
Last Update Time: 20260126  11:35:00

Event Counts:
  historicalData: 25
  historicalDataUpdate: 1
  nextValidId: 1
  connectAck: 1
================================================================================

✅ SUCCESS: Real-time updates are working!
```

### ❌ If keepUpToDate Doesn't Work (Current Situation)

```
================================================================================
TEST RESULTS
================================================================================
Connected: True
Historical Data Complete: True
Historical Bars Received: 25
Real-Time Updates Received: 0
Last Update Time: N/A

Event Counts:
  historicalData: 26
  historicalDataEnd: 1
  nextValidId: 1
  connectAck: 1
  error_2104: 3
================================================================================

❌ FAILURE: No real-time updates received
   Possible causes:
   - Market is closed or no trading activity
   - TWS doesn't support keepUpToDate with your account
   - TWS API version doesn't support this feature
   - Market data subscription required
```

## Troubleshooting

### Connection Error: "Failed to connect to TWS"

**Check TWS is running:**
```bash
# macOS
ps aux | grep -i "tws\|gateway"

# Find TWS process
lsof -i :7497  # Paper trading
lsof -i :7496  # Live trading
```

**Verify TWS API Settings:**
1. Open TWS/IB Gateway
2. Go to: **Configuration → API → Settings**
3. Enable: **"Enable ActiveX and Socket Clients"**
4. Set Socket port: `7497` (paper) or `7496` (live)
5. Add to **Trusted IP Addresses**: `127.0.0.1`
6. **Allow connections from localhost**: ✓

### Import Error: "No module named 'ibapi'"

```bash
# Install via pip
pip install ibapi

# Or check Python path
python3 -c "import sys; print('\n'.join(sys.path))"

# Verify installation
python3 -c "import ibapi; print(ibapi.__version__)"
```

### Permission Error on macOS

```bash
# Make script executable
chmod +x test_realtime_bars.py

# Run with full path
/usr/bin/python3 test_realtime_bars.py
```

### Error 2119: "Market data not available"

**This is EXPECTED** - historical data still works, but real-time updates may require:
- Market data subscription
- Different account type
- Delayed data permissions

**The test will still show if `historicalDataUpdate` events are received.**

## Comparison with Other Tests

| Test | Language | Library | Purpose |
|------|----------|---------|---------|
| **Python (this)** | Python 3 | `ibapi` (official) | Official API reference test |
| **Node.js** | TypeScript | `@stoqey/ib` | Production integration test |
| **C++** | C++ | TWS C++ SDK | Low-level API test |

## Code Structure

```python
class TestApp(EWrapper, EClient):
    """Main test application"""

    # Connection
    def nextValidId(self, orderId)
    def connectAck(self)
    def connectionClosed(self)

    # Historical data
    def historicalData(self, reqId, bar)
    def historicalDataEnd(self, reqId, start, end)

    # Real-time updates (THE KEY CALLBACK)
    def historicalDataUpdate(self, reqId, bar)

    # Error handling
    def error(self, reqId, errorCode, errorString)
```

## Key TWS API Calls

```python
# Request historical data with real-time streaming
self.reqHistoricalData(
    reqId=12345,
    contract=contract,
    endDateTime="",           # Empty = current time (required)
    durationStr="1 D",        # 1 day lookback
    barSizeSetting="5 mins",  # 5-minute bars
    whatToShow="TRADES",      # Trade data
    useRTH=1,                 # Regular trading hours only
    formatDate=1,             # yyyymmdd  hh:mm:ss format
    keepUpToDate=True,        # Enable real-time streaming
    chartOptions=[]
)
```

## Expected Behavior

1. **Connect to TWS** - Receive `nextValidId` callback
2. **Request historical data** - Receive 20-30 `historicalData` callbacks
3. **Receive end marker** - `historicalDataEnd` callback
4. **Wait for updates** - Should receive `historicalDataUpdate` callbacks every 5 minutes
5. **Print results** - Show count of updates received

## What This Test Proves

**If Python test receives 0 updates:**
- ✅ Confirms TWS API `keepUpToDate` doesn't work with your account/setup
- ✅ Validates that Node.js `@stoqey/ib` is not the problem
- ✅ Proves polling is the correct solution

**If Python test receives updates but Node.js doesn't:**
- ⚠️ Suggests `@stoqey/ib` library has a bug
- Would need to investigate event name mapping
- Could file issue with @stoqey/ib maintainers

## References

- [Official TWS API Python Guide](https://interactivebrokers.github.io/tws-api/historical_bars.html)
- [TWS API Downloads](https://interactivebrokers.github.io/tws-api/index.html#gsc.tab=0)
- [Python API Documentation](https://interactivebrokers.github.io/tws-api/classIBApi_1_1EClient.html#a8c93a26f1dbd2983d5fab70b047e6dc7)
- [Historical Data with keepUpToDate](https://interactivebrokers.github.io/tws-api/historical_bars.html#hd_request)

## License

This test script is provided as-is for debugging purposes. Use at your own risk.
