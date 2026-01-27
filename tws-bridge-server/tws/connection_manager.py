"""TWS connection manager with support for multiple independent connections."""

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

    def __init__(self, name: str = "TWS"):
        super().__init__()
        self.name = name
        self.next_valid_id: Optional[int] = None
        self.is_connected: bool = False
        self.connection_event = threading.Event()

    def nextValidId(self, orderId: int):
        """Callback when connection is established."""
        super().nextValidId(orderId)
        self.next_valid_id = orderId
        self.is_connected = True
        self.connection_event.set()
        logger.info(f"✅ [{self.name}] TWS connected, next valid order ID: {orderId}")

    def error(self, reqId: int, errorCode: int, errorString: str, advancedOrderRejectJson=""):
        """Error callback."""
        try:
            super().error(reqId, errorCode, errorString, advancedOrderRejectJson)
        except TypeError:
            # Older ibapi versions don't have advancedOrderRejectJson parameter
            super().error(reqId, errorCode, errorString)

        # 502 = connection lost, 504 = not connected
        if errorCode in [502, 504, 1100, 1300]:
            logger.error(f"❌ [{self.name}] TWS connection error: [{errorCode}] {errorString}")
            self.is_connected = False
            self.connection_event.clear()
        elif errorCode == 2104:
            # Market data farm connection OK
            logger.debug(f"[{self.name}] TWS: {errorString}")
        elif errorCode == 2106:
            # Historical data farm connection OK
            logger.debug(f"[{self.name}] TWS: {errorString}")
        elif errorCode >= 2000:
            # Informational messages
            logger.debug(f"[{self.name}] TWS info [{errorCode}]: {errorString}")
        else:
            logger.warning(f"[{self.name}] TWS error for reqId={reqId}: [{errorCode}] {errorString}")

    def connectionClosed(self):
        """Connection closed callback."""
        super().connectionClosed()
        self.is_connected = False
        self.connection_event.clear()
        logger.warning(f"⚠️  [{self.name}] TWS connection closed")


class TWSClient(EClient):
    """Extended TWS client with additional utilities."""

    def __init__(self, wrapper: TWSWrapper):
        super().__init__(wrapper)


class TWSConnectionManager:
    """
    Manager for a single TWS connection with automatic reconnection.

    This is NO LONGER a singleton - create separate instances for different purposes.
    """

    def __init__(self, name: str, client_id: int, request_id_start: int = 1000):
        """
        Initialize a TWS connection manager.

        Args:
            name: Descriptive name for this connection (e.g., "HTTP", "WebSocket")
            client_id: TWS client ID (must be unique across all connections)
            request_id_start: Starting request ID to avoid conflicts
        """
        self.name = name
        self.client_id = client_id
        self.wrapper = TWSWrapper(name)
        self.client = TWSClient(self.wrapper)
        self._api_thread: Optional[threading.Thread] = None
        self._reconnect_thread: Optional[threading.Thread] = None
        self._should_stop = threading.Event()
        self._request_id_counter = request_id_start
        self._request_id_lock = threading.Lock()

        logger.info(f"🔧 [{name}] TWS Connection Manager initialized (Client ID: {client_id})")

    def connect(self) -> bool:
        """Connect to TWS/IB Gateway."""
        # Check if truly connected (both client socket and wrapper state)
        if self.client.isConnected() and self.wrapper.is_connected:
            logger.debug(f"[{self.name}] Already connected to TWS")
            return True

        # If client thinks it's connected but wrapper doesn't, force disconnect
        if self.client.isConnected() and not self.wrapper.is_connected:
            logger.warning(f"⚠️  [{self.name}] Client connected but wrapper disconnected, forcing cleanup...")
            try:
                self.client.disconnect()
                time.sleep(1)
            except Exception as e:
                logger.debug(f"[{self.name}] Cleanup disconnect error: {e}")

        try:
            logger.info(f"🔌 [{self.name}] Connecting to TWS at {settings.tws_host}:{settings.tws_port} (Client ID: {self.client_id})...")

            self.client.connect(
                settings.tws_host,
                settings.tws_port,
                self.client_id  # Use instance-specific client ID
            )

            # Start API message processing thread (always start fresh if not alive)
            if self._api_thread is None or not self._api_thread.is_alive():
                self._api_thread = threading.Thread(
                    target=self._run_api_loop,
                    daemon=True,
                    name=f"TWS-{self.name}-API"
                )
                self._api_thread.start()
                logger.debug(f"✅ [{self.name}] TWS API thread started")

            # Wait for connection confirmation
            connected = self.wrapper.connection_event.wait(timeout=settings.tws_connect_timeout)

            if connected:
                # Set market data type (2 = frozen/delayed, free)
                self.client.reqMarketDataType(settings.tws_market_data_type)
                logger.info(f"✅ [{self.name}] TWS connected successfully (market data type: {settings.tws_market_data_type})")

                # Start auto-reconnect monitor
                if self._reconnect_thread is None or not self._reconnect_thread.is_alive():
                    self._reconnect_thread = threading.Thread(
                        target=self._reconnect_loop,
                        daemon=True,
                        name=f"TWS-{self.name}-Reconnect"
                    )
                    self._reconnect_thread.start()

                return True
            else:
                logger.error(f"❌ [{self.name}] TWS connection timeout")
                self.disconnect()
                return False

        except Exception as e:
            logger.error(f"❌ [{self.name}] Failed to connect to TWS: {e}")
            return False

    def disconnect(self):
        """Disconnect from TWS."""
        logger.info(f"🔌 [{self.name}] Disconnecting from TWS...")
        self._should_stop.set()
        self.client.disconnect()
        self.wrapper.is_connected = False
        self.wrapper.connection_event.clear()
        logger.info(f"✅ [{self.name}] TWS disconnected")

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
        logger.info(f"🔄 [{self.name}] Starting TWS API message loop...")
        try:
            self.client.run()
        except Exception as e:
            logger.error(f"❌ [{self.name}] TWS API loop error: {e}")
        finally:
            logger.info(f"⏸️  [{self.name}] TWS API message loop stopped")

    def _reconnect_loop(self):
        """Monitor connection and auto-reconnect if needed."""
        logger.info(f"🔄 [{self.name}] Starting TWS auto-reconnect monitor...")

        while not self._should_stop.is_set():
            try:
                if not self.is_connected():
                    logger.warning(f"⚠️  [{self.name}] TWS connection lost, attempting reconnect...")

                    # Force full disconnect to clean up stale state
                    try:
                        self.client.disconnect()
                        self.wrapper.is_connected = False
                        self.wrapper.connection_event.clear()
                        # Wait for socket to fully close
                        time.sleep(2)
                    except Exception as e:
                        logger.debug(f"[{self.name}] Disconnect during reconnect: {e}")

                    # Attempt reconnect
                    if self.connect():
                        logger.info(f"✅ [{self.name}] Successfully reconnected to TWS")
                    else:
                        logger.error(f"❌ [{self.name}] Reconnect attempt failed, will retry in 10s")

                # Check every 10 seconds
                self._should_stop.wait(timeout=10)

            except Exception as e:
                logger.error(f"❌ [{self.name}] Reconnect loop error: {e}")
                self._should_stop.wait(timeout=5)

        logger.info(f"⏸️  [{self.name}] TWS auto-reconnect monitor stopped")


# Global connection instances (initialized on server startup)
http_connection: Optional[TWSConnectionManager] = None
websocket_connection: Optional[TWSConnectionManager] = None


def initialize_connections():
    """Initialize both HTTP and WebSocket TWS connections."""
    global http_connection, websocket_connection

    # HTTP API connection (Client ID 200, Request IDs 1000+)
    http_connection = TWSConnectionManager(
        name="HTTP",
        client_id=200,
        request_id_start=1000
    )

    # WebSocket API connection (Client ID 201, Request IDs 5000+)
    websocket_connection = TWSConnectionManager(
        name="WebSocket",
        client_id=201,
        request_id_start=5000
    )

    logger.info("✅ Created separate TWS connections for HTTP and WebSocket APIs")


def get_http_connection() -> TWSConnectionManager:
    """Get the HTTP API connection."""
    if http_connection is None:
        raise RuntimeError("HTTP connection not initialized. Call initialize_connections() first.")
    return http_connection


def get_websocket_connection() -> TWSConnectionManager:
    """Get the WebSocket API connection."""
    if websocket_connection is None:
        raise RuntimeError("WebSocket connection not initialized. Call initialize_connections() first.")
    return websocket_connection


# DEPRECATED: Legacy singleton instance for backward compatibility
# This will be removed once all code is migrated to use get_http_connection()
tws_manager = None  # Will be set to http_connection after initialize_connections()
