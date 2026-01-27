"""Singleton TWS connection manager with automatic reconnection."""

import logging
import threading
import time
from typing import Optional
from ibapi.client import EClient
from ibapi.wrapper import EWrapper
from ibapi.contract import Contract

from config import settings

logger = logging.getLogger(__name__)


class TWSWrapper(EWrapper):
    """TWS API event wrapper."""

    def __init__(self):
        super().__init__()
        self.next_valid_id: Optional[int] = None
        self.is_connected: bool = False
        self.connection_event = threading.Event()

    def nextValidId(self, orderId: int):
        """Callback when connection is established."""
        super().nextValidId(orderId)
        self.next_valid_id = orderId
        self.is_connected = True
        self.connection_event.set()
        logger.info(f"✅ TWS connected, next valid order ID: {orderId}")

    def error(self, reqId: int, errorCode: int, errorString: str, advancedOrderRejectJson=""):
        """Error callback."""
        try:
            super().error(reqId, errorCode, errorString, advancedOrderRejectJson)
        except TypeError:
            # Older ibapi versions don't have advancedOrderRejectJson parameter
            super().error(reqId, errorCode, errorString)

        # 502 = connection lost, 504 = not connected
        if errorCode in [502, 504, 1100, 1300]:
            logger.error(f"❌ TWS connection error: [{errorCode}] {errorString}")
            self.is_connected = False
            self.connection_event.clear()
        elif errorCode == 2104:
            # Market data farm connection OK
            logger.debug(f"TWS: {errorString}")
        elif errorCode == 2106:
            # Historical data farm connection OK
            logger.debug(f"TWS: {errorString}")
        elif errorCode >= 2000:
            # Informational messages
            logger.debug(f"TWS info [{errorCode}]: {errorString}")
        else:
            logger.warning(f"TWS error for reqId={reqId}: [{errorCode}] {errorString}")

    def connectionClosed(self):
        """Connection closed callback."""
        super().connectionClosed()
        self.is_connected = False
        self.connection_event.clear()
        logger.warning("⚠️  TWS connection closed")


class TWSClient(EClient):
    """Extended TWS client with additional utilities."""

    def __init__(self, wrapper: TWSWrapper):
        super().__init__(wrapper)


class TWSConnectionManager:
    """Singleton manager for TWS connection with automatic reconnection."""

    _instance: Optional['TWSConnectionManager'] = None
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
        self.wrapper = TWSWrapper()
        self.client = TWSClient(self.wrapper)
        self._api_thread: Optional[threading.Thread] = None
        self._reconnect_thread: Optional[threading.Thread] = None
        self._should_stop = threading.Event()
        self._request_id_counter = 1000
        self._request_id_lock = threading.Lock()

        logger.info("🔧 TWS Connection Manager initialized")

    def connect(self) -> bool:
        """Connect to TWS/IB Gateway."""
        # Check if truly connected (both client socket and wrapper state)
        if self.client.isConnected() and self.wrapper.is_connected:
            logger.debug("Already connected to TWS")
            return True

        # If client thinks it's connected but wrapper doesn't, force disconnect
        if self.client.isConnected() and not self.wrapper.is_connected:
            logger.warning("⚠️  Client connected but wrapper disconnected, forcing cleanup...")
            try:
                self.client.disconnect()
                time.sleep(1)
            except Exception as e:
                logger.debug(f"Cleanup disconnect error: {e}")

        try:
            logger.info(f"🔌 Connecting to TWS at {settings.tws_host}:{settings.tws_port}...")

            self.client.connect(
                settings.tws_host,
                settings.tws_port,
                settings.tws_client_id
            )

            # Start API message processing thread (always start fresh if not alive)
            if self._api_thread is None or not self._api_thread.is_alive():
                self._api_thread = threading.Thread(
                    target=self._run_api_loop,
                    daemon=True,
                    name="TWS-API-Thread"
                )
                self._api_thread.start()
                logger.debug("✅ TWS API thread started")

            # Wait for connection confirmation
            connected = self.wrapper.connection_event.wait(timeout=settings.tws_connect_timeout)

            if connected:
                # Set market data type (2 = frozen/delayed, free)
                self.client.reqMarketDataType(settings.tws_market_data_type)
                logger.info(f"✅ TWS connected successfully (market data type: {settings.tws_market_data_type})")

                # Start auto-reconnect monitor
                if self._reconnect_thread is None or not self._reconnect_thread.is_alive():
                    self._reconnect_thread = threading.Thread(
                        target=self._reconnect_loop,
                        daemon=True,
                        name="TWS-Reconnect-Thread"
                    )
                    self._reconnect_thread.start()

                return True
            else:
                logger.error("❌ TWS connection timeout")
                self.disconnect()
                return False

        except Exception as e:
            logger.error(f"❌ Failed to connect to TWS: {e}")
            return False

    def disconnect(self):
        """Disconnect from TWS."""
        logger.info("🔌 Disconnecting from TWS...")
        self._should_stop.set()
        self.client.disconnect()
        self.wrapper.is_connected = False
        self.wrapper.connection_event.clear()
        logger.info("✅ TWS disconnected")

    def is_connected(self) -> bool:
        """Check if connected to TWS."""
        return self.client.isConnected() and self.wrapper.is_connected

    def get_next_request_id(self) -> int:
        """Get next unique request ID."""
        with self._request_id_lock:
            req_id = self._request_id_counter
            self._request_id_counter += 1
            return req_id

    def _run_api_loop(self):
        """Run the TWS API message processing loop."""
        logger.info("🔄 Starting TWS API message loop...")
        try:
            self.client.run()
        except Exception as e:
            logger.error(f"❌ TWS API loop error: {e}")
        finally:
            logger.info("⏸️  TWS API message loop stopped")

    def _reconnect_loop(self):
        """Monitor connection and auto-reconnect if needed."""
        logger.info("🔄 Starting TWS auto-reconnect monitor...")

        while not self._should_stop.is_set():
            try:
                if not self.is_connected():
                    logger.warning("⚠️  TWS connection lost, attempting reconnect...")

                    # Force full disconnect to clean up stale state
                    try:
                        self.client.disconnect()
                        self.wrapper.is_connected = False
                        self.wrapper.connection_event.clear()
                        # Wait for socket to fully close
                        time.sleep(2)
                    except Exception as e:
                        logger.debug(f"Disconnect during reconnect: {e}")

                    # Attempt reconnect
                    if self.connect():
                        logger.info("✅ Successfully reconnected to TWS")
                    else:
                        logger.error("❌ Reconnect attempt failed, will retry in 10s")

                # Check every 10 seconds
                self._should_stop.wait(timeout=10)

            except Exception as e:
                logger.error(f"❌ Reconnect loop error: {e}")
                self._should_stop.wait(timeout=5)

        logger.info("⏸️  TWS auto-reconnect monitor stopped")


# Global singleton instance
tws_manager = TWSConnectionManager()
