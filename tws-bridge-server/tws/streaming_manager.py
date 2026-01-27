"""Real-time bar streaming manager with subscription control."""

import logging
import asyncio
import threading
from typing import Dict, Set, Optional, Callable
from datetime import datetime

from tws.connection_manager import tws_manager
from tws.bar_fetcher import BarData

logger = logging.getLogger(__name__)


class StreamingSubscription:
    """Manages a single streaming subscription."""

    def __init__(self, req_id: int, symbol: str, period: str, session: str, what: str):
        self.req_id = req_id
        self.symbol = symbol
        self.period = period
        self.session = session
        self.what = what
        self.is_active = True
        self.subscribers: Set[str] = set()  # WebSocket connection IDs
        self.last_bar: Optional[BarData] = None
        self.update_count = 0
        self.created_at = datetime.now()

    def add_subscriber(self, connection_id: str):
        """Add a subscriber to this subscription."""
        self.subscribers.add(connection_id)
        logger.info(f"📡 Added subscriber {connection_id} to {self.symbol} stream (total: {len(self.subscribers)})")

    def remove_subscriber(self, connection_id: str):
        """Remove a subscriber from this subscription."""
        if connection_id in self.subscribers:
            self.subscribers.remove(connection_id)
            logger.info(f"📡 Removed subscriber {connection_id} from {self.symbol} stream (remaining: {len(self.subscribers)})")

    def has_subscribers(self) -> bool:
        """Check if subscription has any active subscribers."""
        return len(self.subscribers) > 0


class StreamingManager:
    """Manages real-time bar streaming subscriptions."""

    _instance: Optional['StreamingManager'] = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._initialized = True
        self.subscriptions: Dict[str, StreamingSubscription] = {}  # key: symbol
        self.callbacks: Dict[str, Callable] = {}  # key: symbol, value: async callback
        self.lock = threading.Lock()
        self.event_loop = None  # Reference to main event loop for thread-safe task scheduling

        # Register callback with bar fetcher wrapper
        from tws.bar_fetcher import bar_fetcher
        self._original_update_handler = bar_fetcher.wrapper.historicalDataUpdate

        # IMPORTANT: Must override BOTH places where historicalDataUpdate is referenced:
        # 1. On bar_fetcher.wrapper (for future method calls on wrapper instance)
        bar_fetcher.wrapper.historicalDataUpdate = self._handle_bar_update
        # 2. On tws_manager.client.wrapper (where TWS actually calls the callback)
        tws_manager.client.wrapper.historicalDataUpdate = self._handle_bar_update

        logger.info("🔧 Streaming Manager initialized")
        logger.info(f"🔧 Registered callbacks on both wrapper and client.wrapper")

    def _handle_bar_update(self, reqId: int, bar):
        """Handle real-time bar updates from TWS (called from TWS thread)."""
        # DEBUG: Log EVERY callback invocation
        logger.info(f"🔔 _handle_bar_update CALLED: reqId={reqId}, bar.date={bar.date}")
        try:
            self._process_bar_update(reqId, bar)
        except Exception as e:
            logger.error(f"❌ Exception in _handle_bar_update: {e}", exc_info=True)

    def _process_bar_update(self, reqId: int, bar):
        """Process bar update with error handling."""
        with self.lock:
            # Find subscription by reqId
            subscription = None
            for sub in self.subscriptions.values():
                if sub.req_id == reqId:
                    subscription = sub
                    break

            if not subscription:
                logger.warning(f"⚠️  Received bar update for unknown reqId={reqId}")
                return

            # Convert to BarData
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

            subscription.last_bar = bar_data
            subscription.update_count += 1

            logger.debug(
                f"🔄 Real-time update for {subscription.symbol}: "
                f"{bar.date} | C=${bar.close:.2f} | V={int(bar.volume)} | "
                f"Update #{subscription.update_count}"
            )

            # Call async callback if registered
            if subscription.symbol in self.callbacks and self.event_loop:
                callback = self.callbacks[subscription.symbol]
                # Schedule callback in event loop from TWS thread (thread-safe)
                try:
                    asyncio.run_coroutine_threadsafe(
                        callback(subscription.symbol, bar_data.to_dict()),
                        self.event_loop
                    )
                    logger.info(f"✅ Scheduled callback for {subscription.symbol} (update #{subscription.update_count})")
                except Exception as e:
                    logger.error(f"❌ Failed to schedule callback for {subscription.symbol}: {e}")
            else:
                # DEBUG: Log why callback wasn't scheduled
                if subscription.symbol not in self.callbacks:
                    logger.warning(f"⚠️  No callback registered for {subscription.symbol}")
                if not self.event_loop:
                    logger.warning(f"⚠️  Event loop not set")

    async def subscribe(
        self,
        symbol: str,
        period: str,
        session: str,
        what: str,
        connection_id: str,
        callback: Optional[Callable] = None
    ) -> Dict:
        """
        Subscribe to real-time bar streaming.

        Args:
            symbol: Stock symbol
            period: Bar size (e.g., "5m")
            session: Trading session ("rth" or "all")
            what: What to show (e.g., "TRADES")
            connection_id: WebSocket connection ID
            callback: Optional async callback for bar updates

        Returns:
            Subscription details
        """
        # Capture event loop reference (first time only)
        if self.event_loop is None:
            self.event_loop = asyncio.get_running_loop()
            logger.info(f"📡 Captured event loop reference: {self.event_loop}")

        with self.lock:
            # Check if subscription already exists
            if symbol in self.subscriptions:
                subscription = self.subscriptions[symbol]
                subscription.add_subscriber(connection_id)
                logger.info(
                    f"✅ Reusing existing stream for {symbol} "
                    f"(subscribers: {len(subscription.subscribers)})"
                )
                return {
                    "status": "subscribed",
                    "symbol": symbol,
                    "req_id": subscription.req_id,
                    "existing": True,
                    "subscribers": len(subscription.subscribers)
                }

        # Create new subscription
        req_id = tws_manager.get_next_request_id()

        # Import here to avoid circular dependency
        from ibapi.contract import Contract

        # Create contract
        # VIX is an index, not a stock - requires special handling
        is_vix = symbol.upper() == "VIX"

        contract = Contract()
        contract.symbol = symbol
        contract.secType = "IND" if is_vix else "STK"
        contract.exchange = "CBOE" if is_vix else "SMART"
        contract.currency = "USD"

        # Map period to bar size
        bar_size_map = {
            "1m": "1 min",
            "5m": "5 mins",
            "15m": "15 mins",
            "30m": "30 mins",
            "1h": "1 hour",
        }
        bar_size = bar_size_map.get(period)
        if not bar_size:
            raise ValueError(f"Unsupported period for streaming: {period}")

        # Map session to useRTH
        use_rth = 1 if session == "rth" else 0

        # Map what to whatToShow
        what_to_show = what.upper()

        logger.info(
            f"📡 Starting real-time stream: symbol={symbol}, period={period}, "
            f"session={session}, what={what_to_show}, reqId={req_id}"
        )

        try:
            # Request historical data with keepUpToDate=True
            tws_manager.client.reqHistoricalData(
                reqId=req_id,
                contract=contract,
                endDateTime="",  # Empty = current time
                durationStr="1 D",  # Need initial history
                barSizeSetting=bar_size,
                whatToShow=what_to_show,
                useRTH=use_rth,
                formatDate=1,
                keepUpToDate=True,  # Enable real-time streaming
                chartOptions=[]
            )

            # Create subscription
            subscription = StreamingSubscription(req_id, symbol, period, session, what)
            subscription.add_subscriber(connection_id)

            with self.lock:
                self.subscriptions[symbol] = subscription
                if callback:
                    self.callbacks[symbol] = callback

            logger.info(f"✅ Started real-time stream for {symbol} (reqId={req_id})")

            return {
                "status": "subscribed",
                "symbol": symbol,
                "req_id": req_id,
                "existing": False,
                "subscribers": 1
            }

        except Exception as e:
            logger.error(f"❌ Failed to start stream for {symbol}: {e}")
            raise

    async def unsubscribe(self, symbol: str, connection_id: str) -> Dict:
        """
        Unsubscribe from real-time bar streaming.

        Args:
            symbol: Stock symbol
            connection_id: WebSocket connection ID

        Returns:
            Unsubscribe status
        """
        with self.lock:
            if symbol not in self.subscriptions:
                logger.warning(f"⚠️  No active subscription for {symbol}")
                return {"status": "not_found", "symbol": symbol}

            subscription = self.subscriptions[symbol]
            subscription.remove_subscriber(connection_id)

            # If no more subscribers, cancel TWS streaming
            if not subscription.has_subscribers():
                logger.info(f"🛑 Cancelling stream for {symbol} (no subscribers)")
                tws_manager.client.cancelHistoricalData(subscription.req_id)
                del self.subscriptions[symbol]
                if symbol in self.callbacks:
                    del self.callbacks[symbol]
                return {
                    "status": "cancelled",
                    "symbol": symbol,
                    "reason": "no_subscribers"
                }

            return {
                "status": "unsubscribed",
                "symbol": symbol,
                "remaining_subscribers": len(subscription.subscribers)
            }

    async def unsubscribe_all(self, connection_id: str) -> Dict:
        """
        Unsubscribe connection from all streams.

        Args:
            connection_id: WebSocket connection ID

        Returns:
            Unsubscribe summary
        """
        unsubscribed = []
        cancelled = []

        with self.lock:
            for symbol in list(self.subscriptions.keys()):
                subscription = self.subscriptions[symbol]
                if connection_id in subscription.subscribers:
                    subscription.remove_subscriber(connection_id)
                    unsubscribed.append(symbol)

                    if not subscription.has_subscribers():
                        logger.info(f"🛑 Cancelling stream for {symbol} (no subscribers)")
                        tws_manager.client.cancelHistoricalData(subscription.req_id)
                        del self.subscriptions[symbol]
                        if symbol in self.callbacks:
                            del self.callbacks[symbol]
                        cancelled.append(symbol)

        logger.info(
            f"📡 Connection {connection_id} unsubscribed from {len(unsubscribed)} streams, "
            f"cancelled {len(cancelled)} streams"
        )

        return {
            "status": "unsubscribed",
            "connection_id": connection_id,
            "unsubscribed": unsubscribed,
            "cancelled": cancelled
        }

    def get_active_subscriptions(self) -> Dict:
        """Get list of active subscriptions."""
        with self.lock:
            return {
                symbol: {
                    "req_id": sub.req_id,
                    "period": sub.period,
                    "session": sub.session,
                    "what": sub.what,
                    "subscribers": len(sub.subscribers),
                    "update_count": sub.update_count,
                    "last_bar": sub.last_bar.to_dict() if sub.last_bar else None,
                    "created_at": sub.created_at.isoformat()
                }
                for symbol, sub in self.subscriptions.items()
            }


# Global streaming manager instance
streaming_manager = StreamingManager()
