# TWS (Interactive Brokers) Setup Guide

This guide will help you set up Interactive Brokers TWS API for paper trading with the algorithmic trading system.

## Prerequisites

- An Interactive Brokers account (you can open a paper trading account for free)
- TWS (Trader Workstation) or IB Gateway installed

## Step 1: Install TWS or IB Gateway

### Option A: TWS (Full Trading Platform)
Download from: https://www.interactivebrokers.com/en/trading/tws.php

- **Pros**: Full-featured trading platform with charts and analysis tools
- **Cons**: More resource-intensive, requires GUI

### Option B: IB Gateway (Recommended for Automated Trading)
Download from: https://www.interactivebrokers.com/en/trading/ibgateway-stable.php

- **Pros**: Lightweight, designed for API access, can run headless
- **Cons**: No charting or manual trading interface

## Step 2: Enable API Access in TWS

1. Launch TWS or IB Gateway
2. Log in with your credentials
3. Go to **Edit → Global Configuration → API → Settings**
4. Configure the following settings:

   - ✅ **Enable ActiveX and Socket Clients**
   - ✅ **Allow connections from localhost only** (recommended for security)
   - **Socket port**:
     - `7497` for Paper Trading (default)
     - `7496` for Live Trading
   - **Master API client ID**: `0` (or your preferred ID)
   - Add `127.0.0.1` to **Trusted IP Addresses**
   - ✅ **Read-Only API** (disable this for trading)

5. Click **OK** and restart TWS/IB Gateway

## Step 3: Configure Environment Variables

Create or update your `.env` file in the project root:

```bash
# Broker Configuration
BROKER=tws

# TWS Configuration
TWS_HOST=127.0.0.1
TWS_PORT=7497         # 7497 for paper trading, 7496 for live
TWS_CLIENT_ID=0       # Must match your TWS API settings

# Trading Mode
LIVE=false            # Set to 'true' to submit real orders
```

## Step 4: Test the Connection

Run the TWS connection test:

```bash
npm run test:tws
```

You should see output like:

```
╔══════════════════════════════════════════════════════╗
║                                                      ║
║ TWS ADAPTER TEST                                     ║
║                                                      ║
╚══════════════════════════════════════════════════════╝

Configuration:
  Host: 127.0.0.1
  Port: 7497 (Paper Trading)
  Client ID: 0
  Mode: DRY-RUN

✓ Connected to TWS at 127.0.0.1:7497
Next valid order ID: 1

TEST 1: Dry-run Bracket Order Submission
...
✓ Successfully submitted 2 order(s)
```

## Step 5: Run Live Trading

### Dry-Run Mode (No Orders Submitted)
```bash
npm run live
```

This will:
- Connect to TWS for market data
- Run your strategy
- Show what orders would be placed
- NOT submit any actual orders

### Paper Trading Mode (Real Orders on Paper Account)
```bash
LIVE=true npm run live
```

This will:
- Connect to TWS
- Run your strategy
- Submit actual paper trading orders
- Manage positions in real-time

## Troubleshooting

### Cannot Connect to TWS

**Error**: `Cannot connect to TWS at 127.0.0.1:7497`

**Solutions**:
1. Verify TWS/IB Gateway is running
2. Check that the correct port is configured (7497 for paper, 7496 for live)
3. Ensure API connections are enabled in TWS settings
4. Verify 127.0.0.1 is in trusted IP addresses
5. Check that no firewall is blocking the connection

### Connection Timeout

**Error**: `Connection timeout. Make sure TWS/IB Gateway is running`

**Solutions**:
1. TWS may be starting up - wait 30 seconds and try again
2. Check TWS logs for errors: File → Error Log
3. Restart TWS/IB Gateway
4. Verify port is not in use by another application

### Permission Denied

**Error**: `Permission denied` or API access errors

**Solutions**:
1. Disable "Read-Only API" in TWS settings
2. Ensure your account has paper trading permissions
3. Check that client ID matches TWS configuration
4. Verify account is logged in and active

### Order Placement Errors

**Error**: Orders are rejected or fail to place

**Solutions**:
1. Check account has sufficient buying power
2. Verify symbol is valid and tradeable
3. Ensure market hours (9:30 AM - 4:00 PM ET for stocks)
4. Check order quantity and price are reasonable
5. Review TWS order logs for specific rejection reasons

## Port Reference

| Port | Environment | Description |
|------|-------------|-------------|
| 7497 | Paper Trading | Default port for paper trading account |
| 7496 | Live Trading | Default port for live trading account |
| 4001 | IB Gateway Paper | Alternative port for IB Gateway paper |
| 4002 | IB Gateway Live | Alternative port for IB Gateway live |

## Best Practices

1. **Always test with paper trading first** - Never jump directly to live trading
2. **Use unique client IDs** - If running multiple bots, use different client IDs
3. **Monitor TWS logs** - Check File → Error Log regularly
4. **Keep TWS updated** - Use the latest stable version
5. **Start with small positions** - Test with minimal capital first
6. **Set proper risk limits** - Configure stop losses and position sizing
7. **Run during market hours** - Stock trading is 9:30 AM - 4:00 PM ET
8. **Keep TWS running** - Don't close TWS while trades are active

## Market Hours

- **Pre-market**: 4:00 AM - 9:30 AM ET
- **Regular hours**: 9:30 AM - 4:00 PM ET
- **After-hours**: 4:00 PM - 8:00 PM ET

The system automatically closes positions at 4:00 PM ET market close.

## Switching Between Brokers

To switch back to Alpaca:

```bash
# In .env file
BROKER=alpaca
ALPACA_API_KEY=your_key_here
ALPACA_API_SECRET=your_secret_here
```

Then run:
```bash
npm run live
```

## Additional Resources

- [IB API Documentation](https://interactivebrokers.github.io/tws-api/)
- [IB API Support](https://www.interactivebrokers.com/en/support/api/support.php)
- [TWS User Guide](https://www.interactivebrokers.com/en/software/tws/usersguidebook.htm)
- [Paper Trading Setup](https://www.interactivebrokers.com/en/support/papertradingaccount.php)

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review TWS error logs
3. Verify your configuration matches this guide
4. Test with the `npm run test:tws` command
5. Check the [IB API support forum](https://www.interactivebrokers.com/en/support/api/support.php)
