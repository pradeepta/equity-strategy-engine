"""WebSocket routes for real-time bar streaming."""

import logging
import json
import uuid
from typing import Dict, Set
from fastapi import WebSocket, WebSocketDisconnect

import tws.streaming_manager as streaming_manager_module

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections."""

    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.connection_subscriptions: Dict[str, Set[str]] = {}  # connection_id -> set of symbols

    async def connect(self, websocket: WebSocket) -> str:
        """Accept WebSocket connection and return connection ID."""
        try:
            logger.info("Accepting WebSocket connection...")
            await websocket.accept()
            connection_id = str(uuid.uuid4())
            self.active_connections[connection_id] = websocket
            self.connection_subscriptions[connection_id] = set()
            logger.info(f"✅ WebSocket connected: {connection_id}")
            return connection_id
        except Exception as e:
            logger.error(f"❌ Failed to accept WebSocket connection: {e}")
            raise

    async def disconnect(self, connection_id: str):
        """Disconnect WebSocket and cleanup subscriptions."""
        if connection_id in self.active_connections:
            # Unsubscribe from all streams
            await streaming_manager_module.streaming_manager.unsubscribe_all(connection_id)

            # Remove connection
            del self.active_connections[connection_id]
            if connection_id in self.connection_subscriptions:
                del self.connection_subscriptions[connection_id]

            logger.info(f"🔌 WebSocket disconnected: {connection_id}")

    async def send_message(self, connection_id: str, message: Dict):
        """Send message to specific connection."""
        if connection_id in self.active_connections:
            websocket = self.active_connections[connection_id]
            try:
                await websocket.send_json(message)
            except Exception as e:
                logger.error(f"❌ Failed to send message to {connection_id}: {e}")
                await self.disconnect(connection_id)

    async def broadcast_to_symbol_subscribers(self, symbol: str, message: Dict):
        """Broadcast message to all connections subscribed to a symbol."""
        for connection_id, subscriptions in self.connection_subscriptions.items():
            if symbol in subscriptions:
                await self.send_message(connection_id, message)

    def add_subscription(self, connection_id: str, symbol: str):
        """Track symbol subscription for connection."""
        if connection_id in self.connection_subscriptions:
            self.connection_subscriptions[connection_id].add(symbol)

    def remove_subscription(self, connection_id: str, symbol: str):
        """Remove symbol subscription for connection."""
        if connection_id in self.connection_subscriptions:
            self.connection_subscriptions[connection_id].discard(symbol)


# Global connection manager
connection_manager = ConnectionManager()


async def handle_websocket(websocket: WebSocket):
    """
    Handle WebSocket connection for real-time bar streaming.

    Message format (client -> server):
    {
        "action": "subscribe" | "unsubscribe" | "ping",
        "symbol": "AAPL",
        "period": "5m",
        "session": "rth",
        "what": "TRADES"
    }

    Message format (server -> client):
    {
        "type": "bar_update" | "subscribed" | "unsubscribed" | "error" | "pong",
        "symbol": "AAPL",
        "bar": { ... },
        "timestamp": "2026-01-26T10:30:00Z"
    }
    """
    connection_id = await connection_manager.connect(websocket)

    try:
        # Send welcome message
        await websocket.send_json({
            "type": "connected",
            "connection_id": connection_id,
            "message": "Connected to TWS Bridge streaming server"
        })

        # Message loop
        while True:
            # Receive message from client
            data = await websocket.receive_json()

            action = data.get("action")
            symbol = data.get("symbol")

            if action == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if action == "subscribe":
                # Validate parameters
                if not symbol:
                    await websocket.send_json({
                        "type": "error",
                        "error": "Missing symbol parameter"
                    })
                    continue

                period = data.get("period", "5m")
                session = data.get("session", "rth")
                what = data.get("what", "TRADES")

                try:
                    # Define callback for bar updates
                    async def bar_update_callback(sym: str, bar_dict: Dict):
                        """Send bar update to WebSocket client."""
                        await connection_manager.broadcast_to_symbol_subscribers(sym, {
                            "type": "bar_update",
                            "symbol": sym,
                            "bar": bar_dict,
                            "timestamp": bar_dict["date"]
                        })

                    # Subscribe to streaming
                    result = await streaming_manager_module.streaming_manager.subscribe(
                        symbol=symbol,
                        period=period,
                        session=session,
                        what=what,
                        connection_id=connection_id,
                        callback=bar_update_callback
                    )

                    # Track subscription
                    connection_manager.add_subscription(connection_id, symbol)

                    # Send confirmation
                    await websocket.send_json({
                        "type": "subscribed",
                        "symbol": symbol,
                        "period": period,
                        "session": session,
                        "what": what,
                        "req_id": result["req_id"],
                        "existing": result["existing"]
                    })

                    logger.info(f"📡 {connection_id} subscribed to {symbol} stream")

                except Exception as e:
                    logger.error(f"❌ Subscription failed for {symbol}: {e}")
                    await websocket.send_json({
                        "type": "error",
                        "action": "subscribe",
                        "symbol": symbol,
                        "error": str(e)
                    })

            elif action == "unsubscribe":
                if not symbol:
                    await websocket.send_json({
                        "type": "error",
                        "error": "Missing symbol parameter"
                    })
                    continue

                try:
                    result = await streaming_manager_module.streaming_manager.unsubscribe(symbol, connection_id)
                    connection_manager.remove_subscription(connection_id, symbol)

                    await websocket.send_json({
                        "type": "unsubscribed",
                        "symbol": symbol,
                        "status": result["status"]
                    })

                    logger.info(f"📡 {connection_id} unsubscribed from {symbol} stream")

                except Exception as e:
                    logger.error(f"❌ Unsubscribe failed for {symbol}: {e}")
                    await websocket.send_json({
                        "type": "error",
                        "action": "unsubscribe",
                        "symbol": symbol,
                        "error": str(e)
                    })

            elif action == "list_subscriptions":
                # Get active subscriptions
                subscriptions = streaming_manager_module.streaming_manager.get_active_subscriptions()
                await websocket.send_json({
                    "type": "subscriptions",
                    "subscriptions": subscriptions
                })

            else:
                await websocket.send_json({
                    "type": "error",
                    "error": f"Unknown action: {action}"
                })

    except WebSocketDisconnect:
        logger.info(f"🔌 WebSocket disconnected: {connection_id}")
        await connection_manager.disconnect(connection_id)

    except Exception as e:
        logger.error(f"❌ WebSocket error for {connection_id}: {e}", exc_info=True)
        await connection_manager.disconnect(connection_id)
