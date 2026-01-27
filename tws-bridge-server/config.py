"""Configuration management for TWS Bridge Server."""

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Server Configuration
    port: int = Field(default=3003, description="Server port")
    host: str = Field(default="0.0.0.0", description="Server host")
    log_level: str = Field(default="INFO", description="Logging level")

    # TWS Connection
    tws_host: str = Field(default="127.0.0.1", description="TWS host")
    tws_port: int = Field(default=7497, description="TWS port")
    tws_client_id: int = Field(default=100, description="TWS client ID")
    tws_connect_timeout: int = Field(default=10, description="TWS connection timeout (seconds)")
    tws_read_timeout: int = Field(default=60, description="TWS read timeout (seconds)")

    # Market Data Configuration
    tws_market_data_type: int = Field(default=2, description="TWS market data type (1=Live, 2=Frozen, 3=Delayed)")

    # Request Configuration
    max_concurrent_requests: int = Field(default=10, description="Maximum concurrent TWS requests")
    request_timeout: int = Field(default=30, description="Request timeout (seconds)")
    bar_fetch_timeout: int = Field(default=30, description="Bar fetch timeout (seconds)")

    # Health Check
    health_check_interval: int = Field(default=60, description="Health check interval (seconds)")

    class Config:
        env_file = ".env"
        case_sensitive = False


# Global settings instance
settings = Settings()
