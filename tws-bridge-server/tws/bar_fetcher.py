"""Bar fetching logic with real-time streaming support."""

import logging
import threading
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import List, Optional, Dict, Any
from ibapi.contract import Contract
from ibapi.wrapper import EWrapper

from tws.connection_manager import get_http_connection
from config import settings

logger = logging.getLogger(__name__)


def parse_ibkr_date_to_utc(date_str: str) -> str:
    """
    Parse IBKR date format (local server time) and convert to UTC ISO format.

    IMPORTANT: TWS returns timestamps in the SERVER'S LOCAL TIMEZONE, not Eastern Time!
    - Format: "20260126  09:55:00" (note: two spaces between date and time)
    - If server is in Pacific Time: represents 9:55 AM Pacific (12:55 PM ET)
    - If server is in Eastern Time: represents 9:55 AM Eastern

    Returns:
    - ISO 8601 UTC string: "2026-01-26T14:55:00+00:00"
    """
    try:
        # Split date and time parts
        parts = date_str.split()
        date_part = parts[0]  # "20260126"
        time_part = parts[1] if len(parts) > 1 else "00:00:00"

        # Parse components
        year = int(date_part[0:4])
        month = int(date_part[4:6])
        day = int(date_part[6:8])
        hour, minute, second = [int(x) for x in time_part.split(':')]

        # CRITICAL FIX: Create datetime in LOCAL time (server's timezone)
        # TWS returns timestamps in the server's local timezone, not Eastern Time!
        # Get system's local timezone
        local_tz = datetime.now().astimezone().tzinfo
        local_time = datetime(year, month, day, hour, minute, second, tzinfo=local_tz)

        # Convert to UTC
        utc_time = local_time.astimezone(ZoneInfo('UTC'))

        # Return ISO format
        return utc_time.isoformat()

    except Exception as e:
        logger.error(f"Failed to parse IBKR date '{date_str}': {e}")
        # Return original if parsing fails
        return date_str


class BarData:
    """Represents a single OHLCV bar."""

    def __init__(self, date: str, open: float, high: float, low: float,
                 close: float, volume: int, wap: float, count: int):
        self.date = date
        self.open = open
        self.high = high
        self.low = low
        self.close = close
        self.volume = volume
        self.wap = wap
        self.count = count

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary with UTC timestamps."""
        return {
            "date": parse_ibkr_date_to_utc(self.date),  # Convert local time to UTC
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "wap": self.wap,
            "count": self.count
        }


class BarFetchRequest:
    """Manages a single bar fetch request."""

    def __init__(self, req_id: int, include_forming: bool = False):
        self.req_id = req_id
        self.include_forming = include_forming
        self.bars: List[BarData] = []
        self.is_complete = threading.Event()
        self.error: Optional[str] = None
        self.lock = threading.Lock()

    def add_bar(self, bar: BarData):
        """Add a bar to the result."""
        with self.lock:
            self.bars.append(bar)

    def update_last_bar(self, bar: BarData):
        """Update the last (forming) bar."""
        with self.lock:
            if self.bars:
                self.bars[-1] = bar
            else:
                self.bars.append(bar)

    def mark_complete(self):
        """Mark request as complete."""
        self.is_complete.set()

    def mark_error(self, error: str):
        """Mark request as failed."""
        self.error = error
        self.is_complete.set()

    def wait(self, timeout: float) -> bool:
        """Wait for request completion."""
        return self.is_complete.wait(timeout=timeout)


class BarFetcherWrapper(EWrapper):
    """Extended wrapper to handle bar data callbacks."""

    def __init__(self, base_wrapper: EWrapper):
        super().__init__()
        self.base_wrapper = base_wrapper
        # Save original error method before we replace it
        self.original_error = base_wrapper.error
        self.requests: Dict[int, BarFetchRequest] = {}
        self.requests_lock = threading.Lock()

    def register_request(self, req_id: int, request: BarFetchRequest):
        """Register a bar fetch request."""
        with self.requests_lock:
            self.requests[req_id] = request
            logger.debug(f"📝 Registered bar fetch request {req_id}")

    def unregister_request(self, req_id: int):
        """Unregister a bar fetch request."""
        with self.requests_lock:
            if req_id in self.requests:
                del self.requests[req_id]
                logger.debug(f"🗑️  Unregistered bar fetch request {req_id}")

    def historicalData(self, reqId: int, bar):
        """Callback for historical bar data."""
        with self.requests_lock:
            request = self.requests.get(reqId)

        if request:
            bar_data = BarData(
                date=bar.date,
                open=bar.open,
                high=bar.high,
                low=bar.low,
                close=bar.close,
                volume=int(bar.volume),
                wap=bar.average,
                count=bar.barCount
            )
            request.add_bar(bar_data)
            logger.debug(f"📊 Historical bar for reqId={reqId}: {bar.date} | C=${bar.close:.2f} | V={int(bar.volume)}")

    def historicalDataEnd(self, reqId: int, start: str, end: str):
        """Callback when historical data is complete."""
        with self.requests_lock:
            request = self.requests.get(reqId)

        if request:
            logger.info(f"✅ Historical data complete for reqId={reqId}: {len(request.bars)} bars")
            request.mark_complete()

    def historicalDataUpdate(self, reqId: int, bar):
        """Callback for real-time bar updates (forming bar)."""
        # DEBUG: Log ALL historicalDataUpdate calls
        logger.info(f"🔔 historicalDataUpdate CALLED: reqId={reqId}, date={bar.date}")
        with self.requests_lock:
            request = self.requests.get(reqId)

        if request and request.include_forming:
            bar_data = BarData(
                date=bar.date,
                open=bar.open,
                high=bar.high,
                low=bar.low,
                close=bar.close,
                volume=int(bar.volume),
                wap=bar.average,
                count=bar.barCount
            )
            request.update_last_bar(bar_data)
            logger.debug(f"🔄 Real-time bar update for reqId={reqId}: {bar.date} | C=${bar.close:.2f} | V={int(bar.volume)}")

    def error(self, reqId: int, errorCode: int, errorString: str, advancedOrderRejectJson=""):
        """Error callback - delegate to base wrapper and handle request errors."""
        # Delegate to original error method (not self.base_wrapper.error to avoid recursion)
        try:
            self.original_error(reqId, errorCode, errorString, advancedOrderRejectJson)
        except TypeError:
            self.original_error(reqId, errorCode, errorString)

        # Handle request-specific errors
        if reqId > 0:
            with self.requests_lock:
                request = self.requests.get(reqId)

            if request and errorCode not in [2104, 2106, 2158, 2174, 2176]:
                # Not informational messages (2104/2106 = data farm OK, 2158 = HMDS OK, 2174/2176 = warnings)
                error_msg = f"[{errorCode}] {errorString}"
                logger.error(f"❌ Error for bar fetch reqId={reqId}: {error_msg}")
                request.mark_error(error_msg)


class BarFetcher:
    """Fetches historical and real-time bars from TWS."""

    def __init__(self):
        # Get HTTP connection
        self.tws_connection = get_http_connection()

        # Wrap the existing wrapper to intercept bar callbacks
        self.wrapper = BarFetcherWrapper(self.tws_connection.wrapper)

        # Replace callbacks in client's wrapper
        self.tws_connection.client.wrapper.historicalData = self.wrapper.historicalData
        self.tws_connection.client.wrapper.historicalDataEnd = self.wrapper.historicalDataEnd
        self.tws_connection.client.wrapper.historicalDataUpdate = self.wrapper.historicalDataUpdate
        self.tws_connection.client.wrapper.error = self.wrapper.error

        logger.info("🔧 [HTTP] BarFetcher initialized")

    def fetch_bars(
        self,
        symbol: str,
        period: str,
        duration: str,
        what: str = "TRADES",
        session: str = "rth",
        include_forming: bool = False,
        end_datetime: str = ""
    ) -> List[Dict[str, Any]]:
        """
        Fetch historical bars from TWS.

        Args:
            symbol: Stock symbol (e.g., "AAPL")
            period: Bar size (e.g., "5m", "15m", "1h", "1d")
            duration: Duration string (e.g., "1 D", "2 D", "1 W")
            what: What to show (TRADES, MIDPOINT, BID, ASK)
            session: Trading session (rth=regular hours, all=extended hours)
            include_forming: Include forming (incomplete) bar
            end_datetime: End datetime (empty = now, format: "20250126 10:30:00")

        Returns:
            List of bar dictionaries
        """
        if not self.tws_connection.is_connected():
            raise RuntimeError("[HTTP] Not connected to TWS")

        # Create contract
        # VIX is an index, not a stock - requires special handling
        is_vix = symbol.upper() == "VIX"

        contract = Contract()
        contract.symbol = symbol
        contract.secType = "IND" if is_vix else "STK"
        contract.exchange = "CBOE" if is_vix else "SMART"
        contract.currency = "USD"

        # Map period to TWS bar size
        bar_size_map = {
            "1m": "1 min",
            "2m": "2 mins",
            "3m": "3 mins",
            "5m": "5 mins",
            "10m": "10 mins",
            "15m": "15 mins",
            "30m": "30 mins",
            "1h": "1 hour",
            "2h": "2 hours",
            "4h": "4 hours",
            "1d": "1 day",
            "1w": "1 week",
            "1M": "1 month"
        }
        bar_size = bar_size_map.get(period)
        if not bar_size:
            raise ValueError(f"Unsupported period: {period}")

        # Map session to useRTH
        use_rth = 1 if session == "rth" else 0

        # Map what to whatToShow
        what_to_show = what.upper()

        # Get request ID
        req_id = self.tws_connection.get_next_request_id()

        # Create request tracker
        request = BarFetchRequest(req_id, include_forming)
        self.wrapper.register_request(req_id, request)

        try:
            logger.info(
                f"📊 Fetching bars: symbol={symbol}, period={period}, duration={duration}, "
                f"what={what_to_show}, session={session}, includeForming={include_forming}, "
                f"endDateTime='{end_datetime}', reqId={req_id}"
            )

            # Request historical data
            self.tws_connection.client.reqHistoricalData(
                reqId=req_id,
                contract=contract,
                endDateTime=end_datetime,
                durationStr=duration,
                barSizeSetting=bar_size,
                whatToShow=what_to_show,
                useRTH=use_rth,
                formatDate=1,  # 1 = yyyyMMdd HH:mm:ss
                keepUpToDate=include_forming,  # Stream real-time updates if True
                chartOptions=[]
            )

            # Wait for completion
            completed = request.wait(timeout=settings.bar_fetch_timeout)

            if not completed:
                raise TimeoutError(f"Bar fetch timeout after {settings.bar_fetch_timeout}s")

            if request.error:
                raise RuntimeError(f"Bar fetch failed: {request.error}")

            bars = [bar.to_dict() for bar in request.bars]
            logger.info(f"✅ Fetched {len(bars)} bars for {symbol}")

            return bars

        finally:
            # Cleanup
            if include_forming:
                # Cancel real-time updates
                self.tws_connection.client.cancelHistoricalData(req_id)
            self.wrapper.unregister_request(req_id)

    def cancel_streaming(self, req_id: int):
        """Cancel real-time bar streaming."""
        self.tws_connection.client.cancelHistoricalData(req_id)
        self.wrapper.unregister_request(req_id)
        logger.info(f"🛑 [HTTP] Cancelled bar streaming for reqId={req_id}")


# Global bar fetcher instance (initialized on server startup)
bar_fetcher = None
