# TWS Bridge Server

HTTP API bridge for Interactive Brokers TWS API, enabling Node.js applications to fetch market data reliably.

## Overview

The TWS Bridge Server solves the problem of unreliable real-time bar streaming in the Node.js `@stoqey/ib` library by providing a Python-based HTTP API that uses the official `ibapi` package. This architecture enables:

- **Reliable bar fetching**: Official TWS API with proven real-time streaming support
- **Language interoperability**: Node.js applications can use TWS features without direct integration
- **Singleton connection management**: Single persistent TWS connection with automatic reconnection
- **Simple HTTP interface**: RESTful API for fetching historical and real-time bars

## Architecture

```
┌─────────────────┐      HTTP       ┌──────────────────┐      TWS API      ┌─────────────┐
│   Node.js App   │ ──────────────> │  Python FastAPI  │ ────────────────> │  TWS/IBKR   │
│  (TypeScript)   │ <────────────── │   Bridge Server  │ <──────────────── │   Gateway   │
└─────────────────┘   JSON/REST     └──────────────────┘   Official ibapi  └─────────────┘
```

## Features

- ✅ **Historical bar fetching** - Get OHLCV bars for any symbol, timeframe, and duration
- ✅ **Real-time streaming** - Receive forming bar updates via `keepUpToDate=true`
- ✅ **Automatic reconnection** - Background thread monitors and restores TWS connection
- ✅ **Health checks** - `/health` endpoint for service monitoring
- ✅ **Comprehensive logging** - Structured logs with component tagging
- ✅ **CORS support** - Cross-origin requests enabled for web applications
- ✅ **Type-safe models** - Pydantic models for request/response validation

## Installation

### Prerequisites

- Python 3.8+
- Interactive Brokers TWS or IB Gateway running
- TWS API enabled (Configuration → API → Settings)

### Setup

1. **Create virtual environment:**
```bash
cd tws-bridge-server
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

2. **Install dependencies:**
```bash
pip install -r requirements.txt
```

3. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your TWS settings
```

4. **Start the server:**
```bash
python server.py
```

The server will start on `http://localhost:3003` by default.

## Configuration

Edit `.env` to configure:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3003 | Server port |
| `HOST` | 0.0.0.0 | Server host (0.0.0.0 = all interfaces) |
| `TWS_HOST` | 127.0.0.1 | TWS/IB Gateway host |
| `TWS_PORT` | 7497 | TWS port (7497=paper, 7496=live) |
| `TWS_CLIENT_ID` | 100 | TWS client ID (unique per connection) |
| `TWS_MARKET_DATA_TYPE` | 2 | Market data type (1=Live, 2=Frozen, 3=Delayed) |
| `LOG_LEVEL` | INFO | Logging level (DEBUG, INFO, WARN, ERROR) |

## API Endpoints

### Health Check

```bash
GET /api/v1/health
```

**Response:**
```json
{
  "status": "ok",
  "connected": true,
  "tws_host": "127.0.0.1",
  "tws_port": 7497,
  "uptime_seconds": 3600.5,
  "version": "1.0.0"
}
```

### Fetch Bars

```bash
POST /api/v1/bars
Content-Type: application/json

{
  "symbol": "AAPL",
  "period": "5m",
  "duration": "1 D",
  "what": "TRADES",
  "session": "rth",
  "include_forming": false,
  "end_datetime": ""
}
```

**Request Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | Stock symbol (e.g., "AAPL") |
| `period` | string | Yes | Bar size: "1m", "5m", "15m", "30m", "1h", "1d" |
| `duration` | string | Yes | Duration: "1 D", "2 D", "1 W", "1 M" |
| `what` | string | No | "TRADES" (default), "MIDPOINT", "BID", "ASK" |
| `session` | string | No | "rth" (default, regular hours), "all" (extended hours) |
| `include_forming` | boolean | No | Include incomplete forming bar (default: false) |
| `end_datetime` | string | No | End datetime (empty=now, format: "20250126 10:30:00") |

**Response:**
```json
{
  "success": true,
  "symbol": "AAPL",
  "period": "5m",
  "bars": [
    {
      "date": "20250126  09:30:00",
      "open": 225.50,
      "high": 226.00,
      "low": 225.40,
      "close": 225.80,
      "volume": 150000,
      "wap": 225.75,
      "count": 1200
    }
  ],
  "count": 1,
  "error": null
}
```

### Manual Connection Control

```bash
# Connect to TWS
POST /api/v1/connect

# Disconnect from TWS
POST /api/v1/disconnect
```

## Testing

### Test with curl

```bash
# Health check
curl http://localhost:3003/api/v1/health

# Fetch bars
curl -X POST http://localhost:3003/api/v1/bars \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "AAPL",
    "period": "5m",
    "duration": "1 D"
  }'
```

### Test with Python

```python
import requests

# Fetch bars
response = requests.post('http://localhost:3003/api/v1/bars', json={
    'symbol': 'AAPL',
    'period': '5m',
    'duration': '1 D',
    'include_forming': False
})

data = response.json()
print(f"Fetched {data['count']} bars")
for bar in data['bars']:
    print(f"{bar['date']}: ${bar['close']}")
```

## Logging

The server produces structured logs with component tagging:

```
2026-01-26 10:00:00 - tws.connection_manager - INFO - ✅ TWS connected, next valid order ID: 1
2026-01-26 10:00:05 - tws.bar_fetcher - INFO - 📊 Fetching bars: symbol=AAPL, period=5m, duration=1 D, reqId=1000
2026-01-26 10:00:06 - tws.bar_fetcher - INFO - ✅ Historical data complete for reqId=1000: 78 bars
```

**Log Levels:**
- **DEBUG**: Detailed bar-by-bar updates
- **INFO**: Request lifecycle and major events
- **WARN**: Connection issues, retries
- **ERROR**: Failed requests, exceptions

## Troubleshooting

### Server won't start

**Error:** `Address already in use`

**Solution:** Change `PORT` in `.env` or kill the process using port 3003:
```bash
lsof -ti:3003 | xargs kill -9
```

### Connection to TWS fails

**Error:** `❌ Failed to connect to TWS`

**Check:**
1. TWS/IB Gateway is running
2. TWS API is enabled: Configuration → API → Settings → Enable ActiveX and Socket Clients
3. `TWS_PORT` in `.env` matches TWS port (7497=paper, 7496=live)
4. `TWS_CLIENT_ID` is unique (not used by other connections)

### No bar data returned

**Error:** `Bar fetch timeout after 30s`

**Possible causes:**
1. Symbol not found (check spelling, e.g., "AAPL" not "Apple")
2. Market closed and requesting intraday bars (use daily bars instead)
3. Insufficient market data subscription (use `TWS_MARKET_DATA_TYPE=2` for free frozen data)

### Real-time updates not working

**Symptom:** `include_forming=true` but no updates

**Check:**
1. Market is open (real-time updates only during trading hours)
2. Using intraday period (5m, 15m, 30m - not daily)
3. TWS has real-time data permission for the symbol

## Deployment

### Development

```bash
python server.py
```

### Production (using PM2)

```bash
# Install PM2 (requires Node.js)
npm install -g pm2

# Start server with PM2
pm2 start server.py --name tws-bridge --interpreter python3

# Enable startup on boot
pm2 startup
pm2 save

# Monitor
pm2 logs tws-bridge
pm2 monit
```

### Production (using systemd)

Create `/etc/systemd/system/tws-bridge.service`:

```ini
[Unit]
Description=TWS Bridge Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/tws-bridge-server
Environment="PATH=/path/to/venv/bin"
ExecStart=/path/to/venv/bin/python server.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable tws-bridge
sudo systemctl start tws-bridge
sudo systemctl status tws-bridge
```

## Integration with Node.js

See the main project's `broker/marketData/ibkr.ts` for the TypeScript HTTP client implementation.

**Example:**

```typescript
import axios from 'axios';

const response = await axios.post('http://localhost:3003/api/v1/bars', {
  symbol: 'AAPL',
  period: '5m',
  duration: '1 D'
});

const bars = response.data.bars;
```

## License

Part of the Stocks Trading System project.
