"""API routes for the TWS Bridge Server."""

import logging
import time
from typing import Dict, Any
from fastapi import APIRouter, HTTPException, status

from api.models import (
    BarRequest,
    BarResponse,
    Bar,
    HealthResponse,
    ErrorResponse
)
from tws.connection_manager import get_http_connection
import tws.bar_fetcher as bar_fetcher_module

logger = logging.getLogger(__name__)

# Router instance
router = APIRouter()

# Server start time for uptime calculation
server_start_time = time.time()


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint.

    Returns server status and TWS connection state.
    """
    connected = get_http_connection().is_connected()
    uptime = time.time() - server_start_time

    return HealthResponse(
        status="ok" if connected else "degraded",
        connected=connected,
        tws_host=get_http_connection().client.host if hasattr(get_http_connection().client, 'host') else "unknown",
        tws_port=get_http_connection().client.port if hasattr(get_http_connection().client, 'port') else 0,
        uptime_seconds=uptime,
        version="1.0.0"
    )


@router.post("/bars", response_model=BarResponse)
async def fetch_bars(request: BarRequest):
    """
    Fetch historical bars for a symbol.

    Args:
        request: Bar fetch request parameters

    Returns:
        BarResponse with fetched bars

    Raises:
        HTTPException: If bar fetch fails
    """
    try:
        # Ensure connected
        if not get_http_connection().is_connected():
            logger.warning("Not connected to TWS, attempting to connect...")
            if not get_http_connection().connect():
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Failed to connect to TWS"
                )

        # Fetch bars
        bars_data = bar_fetcher_module.bar_fetcher.fetch_bars(
            symbol=request.symbol,
            period=request.period,
            duration=request.duration,
            what=request.what,
            session=request.session,
            include_forming=request.include_forming,
            end_datetime=request.end_datetime
        )

        # Convert to response model
        bars = [Bar(**bar_dict) for bar_dict in bars_data]

        logger.info(
            f"✅ API: Fetched {len(bars)} bars for {request.symbol} "
            f"(period={request.period}, duration={request.duration})"
        )

        return BarResponse(
            success=True,
            symbol=request.symbol,
            period=request.period,
            bars=bars,
            count=len(bars),
            error=None
        )

    except TimeoutError as e:
        logger.error(f"❌ Bar fetch timeout: {e}")
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=str(e)
        )

    except ValueError as e:
        logger.error(f"❌ Invalid request parameters: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    except RuntimeError as e:
        logger.error(f"❌ Bar fetch failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

    except Exception as e:
        logger.error(f"❌ Unexpected error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal server error: {str(e)}"
        )


@router.post("/connect")
async def connect_to_tws():
    """
    Manually trigger TWS connection.

    Returns:
        Success status
    """
    try:
        if get_http_connection().is_connected():
            return {"success": True, "message": "Already connected to TWS"}

        success = get_http_connection().connect()

        if success:
            return {"success": True, "message": "Connected to TWS"}
        else:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Failed to connect to TWS"
            )

    except Exception as e:
        logger.error(f"❌ Connection error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.post("/disconnect")
async def disconnect_from_tws():
    """
    Manually disconnect from TWS.

    Returns:
        Success status
    """
    try:
        get_http_connection().disconnect()
        return {"success": True, "message": "Disconnected from TWS"}

    except Exception as e:
        logger.error(f"❌ Disconnection error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
