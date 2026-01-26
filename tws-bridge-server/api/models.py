"""Request and response models for the API."""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


class BarRequest(BaseModel):
    """Request model for fetching bars."""

    symbol: str = Field(..., description="Stock symbol (e.g., 'AAPL')")
    period: str = Field(..., description="Bar size (e.g., '5m', '15m', '1h', '1d')")
    duration: str = Field(..., description="Duration string (e.g., '1 D', '2 D', '1 W')")
    what: str = Field(default="TRADES", description="What to show (TRADES, MIDPOINT, BID, ASK)")
    session: str = Field(default="rth", description="Trading session (rth=regular hours, all=extended hours)")
    include_forming: bool = Field(default=False, description="Include forming (incomplete) bar")
    end_datetime: str = Field(default="", description="End datetime (empty=now, format: '20250126 10:30:00')")

    class Config:
        json_schema_extra = {
            "example": {
                "symbol": "AAPL",
                "period": "5m",
                "duration": "1 D",
                "what": "TRADES",
                "session": "rth",
                "include_forming": False,
                "end_datetime": ""
            }
        }


class Bar(BaseModel):
    """Response model for a single bar."""

    date: str = Field(..., description="Bar timestamp (format: 'yyyyMMdd HH:mm:ss')")
    open: float = Field(..., description="Open price")
    high: float = Field(..., description="High price")
    low: float = Field(..., description="Low price")
    close: float = Field(..., description="Close price")
    volume: int = Field(..., description="Volume")
    wap: float = Field(..., description="Weighted average price")
    count: int = Field(..., description="Number of trades")


class BarResponse(BaseModel):
    """Response model for bar fetch."""

    success: bool = Field(..., description="Whether the request succeeded")
    symbol: str = Field(..., description="Stock symbol")
    period: str = Field(..., description="Bar size")
    bars: List[Bar] = Field(..., description="List of bars")
    count: int = Field(..., description="Number of bars returned")
    error: Optional[str] = Field(None, description="Error message if failed")


class HealthResponse(BaseModel):
    """Response model for health check."""

    status: str = Field(..., description="Service status (ok, degraded, error)")
    connected: bool = Field(..., description="Whether connected to TWS")
    tws_host: str = Field(..., description="TWS host")
    tws_port: int = Field(..., description="TWS port")
    uptime_seconds: float = Field(..., description="Server uptime in seconds")
    version: str = Field(default="1.0.0", description="Server version")


class ErrorResponse(BaseModel):
    """Response model for errors."""

    success: bool = Field(default=False, description="Always false for errors")
    error: str = Field(..., description="Error message")
    details: Optional[Dict[str, Any]] = Field(None, description="Additional error details")
