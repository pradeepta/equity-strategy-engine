"""TWS Bridge Server - FastAPI application."""

import logging
import sys
import os
from contextlib import asynccontextmanager

# ============================================
# DEBUG: Enable Python debugger (debugpy)
# ============================================
# Check if DEBUG environment variable is set
if os.environ.get("DEBUG_ENABLED") == "true":
    try:
        import debugpy
        debugpy.listen(("0.0.0.0", 5678))
        print("🐛 Python debugger listening on port 5678")
        print("   Attach VS Code debugger to start debugging")
        # Optional: Uncomment to wait for debugger before continuing
        # debugpy.wait_for_client()
        # print("🐛 Debugger attached, continuing...")
    except ImportError:
        print("⚠️  debugpy not installed. Install with: pip install debugpy")
    except Exception as e:
        print(f"⚠️  Failed to start debugger: {e}")

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from config import settings
from api.routes import router
from api.websocket import handle_websocket
from tws.connection_manager import initialize_connections, get_http_connection, get_websocket_connection
import tws.bar_fetcher as bar_fetcher_module
import tws.streaming_manager as streaming_manager_module

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.

    Handles startup and shutdown tasks.
    """
    # Startup
    logger.info("=" * 60)
    logger.info("🚀 TWS Bridge Server Starting")
    logger.info("=" * 60)
    logger.info(f"Server: http://{settings.host}:{settings.port}")
    logger.info(f"TWS: {settings.tws_host}:{settings.tws_port}")
    logger.info(f"Market Data Type: {settings.tws_market_data_type}")
    logger.info("=" * 60)

    # Initialize TWS connections (HTTP and WebSocket with separate Client IDs)
    logger.info("🔧 Initializing TWS connections...")
    initialize_connections()

    # Connect HTTP API connection (Client ID 100)
    logger.info("🔌 Connecting HTTP API to TWS (Client ID 100)...")
    http_conn = get_http_connection()
    http_success = http_conn.connect()

    if http_success:
        logger.info("✅ HTTP API TWS connection established")
    else:
        logger.warning("⚠️  HTTP API failed to connect to TWS on startup (will retry automatically)")

    # Connect WebSocket API connection (Client ID 101)
    logger.info("🔌 Connecting WebSocket API to TWS (Client ID 101)...")
    ws_conn = get_websocket_connection()
    ws_success = ws_conn.connect()

    if ws_success:
        logger.info("✅ WebSocket API TWS connection established")
    else:
        logger.warning("⚠️  WebSocket API failed to connect to TWS on startup (will retry automatically)")

    # Initialize bar fetcher (uses HTTP connection)
    logger.info("🔧 Initializing bar fetcher...")
    from tws.bar_fetcher import BarFetcher
    bar_fetcher_module.bar_fetcher = BarFetcher()

    # Initialize streaming manager (uses WebSocket connection)
    logger.info("🔧 Initializing streaming manager...")
    from tws.streaming_manager import StreamingManager
    streaming_manager_module.streaming_manager = StreamingManager()

    logger.info("=" * 60)
    logger.info("✅ TWS Bridge Server Started Successfully")
    logger.info("   HTTP API:      Uses TWS Client ID 200")
    logger.info("   WebSocket API: Uses TWS Client ID 201")
    logger.info("=" * 60)

    yield

    # Shutdown
    logger.info("=" * 60)
    logger.info("🛑 TWS Bridge Server Shutting Down")
    logger.info("=" * 60)

    # Disconnect both connections
    logger.info("🔌 Disconnecting HTTP API from TWS...")
    http_conn.disconnect()

    logger.info("🔌 Disconnecting WebSocket API from TWS...")
    ws_conn.disconnect()

    logger.info("✅ Shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="TWS Bridge Server",
    description="HTTP API bridge for Interactive Brokers TWS API",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS (WebSocket connections bypass CORS middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins (adjust for production)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"]
)

# Include API routes
app.include_router(router, prefix="/api/v1")


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "service": "TWS Bridge Server",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "health": "/api/v1/health",
            "bars": "/api/v1/bars",
            "connect": "/api/v1/connect",
            "disconnect": "/api/v1/disconnect",
            "streaming": "ws://localhost:3003/ws/stream"
        }
    }


@app.websocket("/ws/stream")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for real-time bar streaming.

    Connect to ws://localhost:3003/ws/stream and send:
    {
        "action": "subscribe",
        "symbol": "AAPL",
        "period": "5m",
        "session": "rth",
        "what": "TRADES"
    }
    """
    await handle_websocket(websocket)


def main():
    """Main entry point."""
    try:
        uvicorn.run(
            "server:app",
            host=settings.host,
            port=settings.port,
            log_level=settings.log_level.lower(),
            access_log=True
        )
    except KeyboardInterrupt:
        logger.info("🛑 Received shutdown signal")
    except Exception as e:
        logger.error(f"❌ Server error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
