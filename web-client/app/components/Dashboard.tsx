"use client";

import { useEffect, useState } from "react";
import { StrategyDetailModal } from "./StrategyDetailModal";
import { CloseStrategyModal } from "./CloseStrategyModal";
import { ReopenStrategyModal } from "./ReopenStrategyModal";
import { ForceDeployModal } from "./ForceDeployModal";
import { NotificationBanner } from "./NotificationBanner";

const API_BASE = "http://localhost:3002";

/**
 * Dashboard Component
 * Displays portfolio overview, strategy performance, current positions, and recent trades
 */
export function Dashboard() {
  const [portfolioData, setPortfolioData] = useState<any>(null);
  const [twsData, setTwsData] = useState<any>(null);
  const [twsError, setTwsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter states
  const [strategyStatusFilter, setStrategyStatusFilter] =
    useState<string>("ALL");
  const [tradeStatusFilter, setTradeStatusFilter] = useState<string>("ALL");
  const [symbolFilter, setSymbolFilter] = useState<string>("");
  // Date filter defaults to today
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const today = new Date();
    return today.toISOString().split('T')[0]; // Format: YYYY-MM-DD
  });

  // Modal states
  const [selectedStrategy, setSelectedStrategy] = useState<any>(null);
  const [showStrategyModal, setShowStrategyModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showReopenModal, setShowReopenModal] = useState(false);
  const [showForceDeployModal, setShowForceDeployModal] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [forceDeployReason, setForceDeployReason] = useState("");
  const [isClosing, setIsClosing] = useState(false);
  const [isReopening, setIsReopening] = useState(false);
  const [isForceDeploying, setIsForceDeploying] = useState(false);

  // Backtest states
  const [backtestResult, setBacktestResult] = useState<any>(null);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  // Notification state
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Evaluation error state
  const [evaluationErrors, setEvaluationErrors] = useState<any[]>([]);

  // Track last rejection check timestamp to avoid duplicate notifications
  const [lastRejectionCheck, setLastRejectionCheck] = useState<Date>(
    new Date()
  );

  // Auto-swap feature state
  const [autoSwapEnabled, setAutoSwapEnabled] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("autoSwapEnabled") === "true";
    }
    return false;
  });
  const [autoSwapParallel, setAutoSwapParallel] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("autoSwapParallel");
      return stored !== null ? stored === "true" : true; // Default to parallel
    }
    return true;
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${API_BASE}/api/portfolio/overview`);
        if (!response.ok) throw new Error("Failed to fetch portfolio data");
        const data = await response.json();
        setPortfolioData(data);
        setError(null);
      } catch (err: any) {
        setError(err.message || "Failed to load portfolio data");
        console.error("Portfolio fetch error:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  // Fetch TWS snapshot data separately
  useEffect(() => {
    const fetchTWSData = async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/portfolio/tws-snapshot?force_refresh=false`,
        );
        if (!response.ok) {
          throw new Error("Failed to fetch TWS data");
        }
        const data = await response.json();
        if (data.success) {
          setTwsData(data.snapshot);
          setTwsError(null);
        } else {
          setTwsError(data.message || "TWS connection failed");
        }
      } catch (err: any) {
        setTwsError(err.message || "Failed to connect to TWS");
        console.error("TWS fetch error:", err);
      }
    };

    fetchTWSData();
    const interval = setInterval(fetchTWSData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  // Fetch evaluation errors separately
  useEffect(() => {
    const fetchEvaluationErrors = async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/logs?component=StrategyEvaluator&level=ERROR&limit=10`,
        );
        if (response.ok) {
          const data = await response.json();
          setEvaluationErrors(data.logs || []);
        }
      } catch (err) {
        console.error("Failed to fetch evaluation errors:", err);
      }
    };

    fetchEvaluationErrors();
    const interval = setInterval(fetchEvaluationErrors, 15000); // Refresh every 15s
    return () => clearInterval(interval);
  }, []);

  // Poll for order rejections and show notifications
  useEffect(() => {
    const checkForRejections = async () => {
      try {
        const response = await fetch(
          `${API_BASE}/api/portfolio/rejections?since=${lastRejectionCheck.toISOString()}`,
        );
        if (response.ok) {
          const data = await response.json();

          // Show notification if there are new rejections
          if (data.rejections && data.rejections.length > 0) {
            const rejectionCount = data.rejections.length;
            const firstRejection = data.rejections[0];

            // Create detailed error message
            let message = `Order rejected: ${firstRejection.symbol} - ${firstRejection.errorMessage}`;
            if (rejectionCount > 1) {
              message = `${rejectionCount} orders rejected. Latest: ${firstRejection.symbol} - ${firstRejection.errorMessage}`;
            }

            setNotification({
              type: "error",
              message,
            });

            console.warn("[Dashboard] Order rejections detected:", data.rejections);
          }

          // Update check timestamp for next poll
          setLastRejectionCheck(new Date());
        }
      } catch (err) {
        console.error("Failed to check for order rejections:", err);
      }
    };

    // Initial check after 5 seconds (let dashboard load first)
    const initialTimeout = setTimeout(checkForRejections, 5000);

    // Then check every 10 seconds
    const interval = setInterval(checkForRejections, 10000);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [lastRejectionCheck]);

  // Auto-swap: Control backend service
  useEffect(() => {
    const syncAutoSwap = async () => {
      try {
        if (autoSwapEnabled) {
          // Enable on backend
          const response = await fetch(`${API_BASE}/api/portfolio/auto-swap/enable`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parallel: autoSwapParallel }),
          });

          if (!response.ok) {
            throw new Error("Failed to enable auto-swap on backend");
          }

          console.log(`[AutoSwap] Backend service enabled (mode: ${autoSwapParallel ? "parallel" : "serial"})`);
        } else {
          // Disable on backend
          const response = await fetch(`${API_BASE}/api/portfolio/auto-swap/disable`, {
            method: "POST",
          });

          if (!response.ok) {
            throw new Error("Failed to disable auto-swap on backend");
          }

          console.log("[AutoSwap] Backend service disabled");
        }
      } catch (error: any) {
        console.error("[AutoSwap] Error syncing with backend:", error);
        setNotification({
          type: "error",
          message: `Auto-swap sync failed: ${error.message}`,
        });
      }
    };

    syncAutoSwap();
  }, [autoSwapEnabled, autoSwapParallel]);

  // Toggle auto-swap handler
  const handleToggleAutoSwap = () => {
    const newValue = !autoSwapEnabled;
    setAutoSwapEnabled(newValue);

    if (typeof window !== "undefined") {
      localStorage.setItem("autoSwapEnabled", String(newValue));
    }

    setNotification({
      type: "success",
      message: newValue
        ? "Auto-swap enabled (evaluating every 30 minutes)"
        : "Auto-swap disabled",
    });
  };

  // Toggle parallel/serial mode handler
  const handleToggleParallel = () => {
    const newValue = !autoSwapParallel;
    setAutoSwapParallel(newValue);

    if (typeof window !== "undefined") {
      localStorage.setItem("autoSwapParallel", String(newValue));
    }

    setNotification({
      type: "success",
      message: newValue
        ? "Auto-swap mode: Parallel (faster)"
        : "Auto-swap mode: Serial (one at a time)",
    });
  };

  // Close strategy handler
  const handleCloseStrategy = async () => {
    if (!selectedStrategy || !closeReason.trim()) {
      setNotification({
        type: "error",
        message: "Please provide a reason for closing the strategy",
      });
      return;
    }

    setIsClosing(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/portfolio/strategies/${selectedStrategy.id}/close`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: closeReason }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to close strategy");
      }

      // Success - show notification and refresh data
      setNotification({
        type: "success",
        message: `Strategy "${selectedStrategy.name}" closed successfully`,
      });
      setShowCloseModal(false);
      setShowStrategyModal(false);
      setCloseReason("");

      // Refresh portfolio data
      const refreshResponse = await fetch(`${API_BASE}/api/portfolio/overview`);
      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        setPortfolioData(refreshData);
      }
    } catch (error: any) {
      setNotification({
        type: "error",
        message: error.message || "Failed to close strategy",
      });
    } finally {
      setIsClosing(false);
    }
  };

  // Reopen strategy handler
  const handleReopenStrategy = async () => {
    if (!selectedStrategy || !reopenReason.trim()) {
      setNotification({
        type: "error",
        message: "Please provide a reason for reopening the strategy",
      });
      return;
    }

    setIsReopening(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/portfolio/strategies/${selectedStrategy.id}/reopen`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reopenReason }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to reopen strategy");
      }

      // Success - show notification and refresh data
      setNotification({
        type: "success",
        message: `Strategy "${selectedStrategy.name}" reopened successfully. Status: PENDING`,
      });
      setShowReopenModal(false);
      setShowStrategyModal(false);
      setReopenReason("");

      // Refresh portfolio data
      const refreshResponse = await fetch(`${API_BASE}/api/portfolio/overview`);
      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        setPortfolioData(refreshData);
      }
    } catch (error: any) {
      setNotification({
        type: "error",
        message: error.message || "Failed to reopen strategy",
      });
    } finally {
      setIsReopening(false);
    }
  };

  // Force deploy handler
  const handleForceDeployClick = (strategy: any) => {
    // Validate that no orders have been placed yet
    if (strategy.openOrderCount > 0) {
      setNotification({
        type: "error",
        message: `Cannot force deploy - strategy already has ${strategy.openOrderCount} open order(s)`,
      });
      return;
    }

    setSelectedStrategy(strategy);
    setForceDeployReason('');
    setShowForceDeployModal(true);
  };

  const handleConfirmForceDeploy = async () => {
    if (!selectedStrategy || !forceDeployReason.trim()) {
      setNotification({
        type: "error",
        message: "Please provide a reason for force deploying the strategy",
      });
      return;
    }

    setIsForceDeploying(true);
    try {
      const response = await fetch(
        `${API_BASE}/api/portfolio/strategies/${selectedStrategy.id}/force-deploy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: forceDeployReason }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to force deploy strategy");
      }

      // Success - show notification and refresh data
      setNotification({
        type: "success",
        message: `Strategy "${selectedStrategy.name}" force deployed successfully (${data.ordersSubmitted} orders)`,
      });
      setShowForceDeployModal(false);
      setShowStrategyModal(false);
      setForceDeployReason('');

      // Refresh portfolio data
      const refreshResponse = await fetch(`${API_BASE}/api/portfolio/overview`);
      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        setPortfolioData(refreshData);
      }
    } catch (error: any) {
      setNotification({
        type: "error",
        message: error.message || "Failed to force deploy strategy",
      });
    } finally {
      setIsForceDeploying(false);
    }
  };

  // Backtest handler
  const handleRunBacktest = async () => {
    if (!selectedStrategy) return;

    setIsBacktesting(true);
    setBacktestError(null);
    setBacktestResult(null);

    try {
      const response = await fetch(
        `${API_BASE}/api/portfolio/strategies/${selectedStrategy.id}/backtest`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to run backtest");
      }

      const data = await response.json();
      setBacktestResult(data.backtest);
      setNotification({
        type: "success",
        message: "Backtest completed successfully",
      });
    } catch (error: any) {
      setBacktestError(error.message || "Failed to run backtest");
      setNotification({
        type: "error",
        message: error.message || "Failed to run backtest",
      });
    } finally {
      setIsBacktesting(false);
    }
  };

  // Auto-dismiss notification after 5 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  if (loading && !portfolioData) {
    return (
      <div className="dashboard-loading">
        <div className="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div style={{ marginTop: "12px", color: "#737373" }}>
          Loading portfolio data...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-error">
        <div style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}>
          Unable to Load Dashboard
        </div>
        <div style={{ fontSize: "14px", color: "#737373" }}>{error}</div>
        <div style={{ fontSize: "12px", color: "#737373", marginTop: "12px" }}>
          Make sure the portfolio API server is running: npm run
          portfolio:api:dev
        </div>
      </div>
    );
  }

  const { pnl, strategies, recentTrades, orderStats } = portfolioData || {};

  // Filter strategies
  const filteredStrategies =
    strategies?.filter((strategy: any) => {
      const matchesStatus =
        strategyStatusFilter === "ALL" ||
        strategy.status === strategyStatusFilter;
      const matchesSymbol =
        !symbolFilter ||
        strategy.symbol.toLowerCase().includes(symbolFilter.toLowerCase());

      // Date filter: check if strategy was active on the selected date
      let matchesDate = true;
      if (selectedDate) {
        const filterDate = new Date(selectedDate);
        filterDate.setHours(0, 0, 0, 0);
        const filterDateEnd = new Date(selectedDate);
        filterDateEnd.setHours(23, 59, 59, 999);

        // Check if strategy was activated before or on the selected date
        const activatedAt = strategy.activatedAt ? new Date(strategy.activatedAt) : null;
        const closedAt = strategy.closedAt ? new Date(strategy.closedAt) : null;
        const createdAt = strategy.createdAt ? new Date(strategy.createdAt) : null;

        // Strategy should have been created/activated by the selected date
        const wasActiveByDate = Boolean(
          (activatedAt && activatedAt <= filterDateEnd) ||
          (createdAt && createdAt <= filterDateEnd)
        );

        // Strategy should not have been closed before the selected date
        const wasNotClosedYet = !closedAt || closedAt >= filterDate;

        matchesDate = wasActiveByDate && wasNotClosedYet;
      }

      return matchesStatus && matchesSymbol && matchesDate;
    }) || [];

  const getStrategyTimestamp = (strategy: any) => {
    return (
      strategy.updatedAt ||
      strategy.activatedAt ||
      strategy.closedAt ||
      strategy.archivedAt ||
      strategy.createdAt ||
      null
    );
  };

  const sortedStrategies = [...filteredStrategies].sort((a: any, b: any) => {
    const aTime = getStrategyTimestamp(a)
      ? new Date(getStrategyTimestamp(a)).getTime()
      : 0;
    const bTime = getStrategyTimestamp(b)
      ? new Date(getStrategyTimestamp(b)).getTime()
      : 0;
    return bTime - aTime;
  });

  // Filter trades
  const filteredTrades =
    recentTrades?.filter((trade: any) => {
      const matchesStatus =
        tradeStatusFilter === "ALL" || trade.status === tradeStatusFilter;
      const matchesSymbol =
        !symbolFilter ||
        trade.symbol.toLowerCase().includes(symbolFilter.toLowerCase());
      return matchesStatus && matchesSymbol;
    }) || [];

  return (
    <div className="dashboard">
      {/* Auto-Swap Toggle */}
      <div
        style={{
          position: "fixed",
          top: "20px",
          right: "20px",
          zIndex: 1000,
          background: autoSwapEnabled ? "#22c55e" : "#f4f1eb",
          padding: "12px 20px",
          borderRadius: "8px",
          boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          cursor: "pointer",
          transition: "all 0.2s",
          border: autoSwapEnabled ? "2px solid #16a34a" : "2px solid #ebe6dd",
        }}
        onClick={handleToggleAutoSwap}
      >
        <div style={{
          fontSize: "20px",
        }}>
          {autoSwapEnabled ? "🔄" : "⏸️"}
        </div>
        <div>
          <div style={{
            fontWeight: 600,
            fontSize: "14px",
            color: autoSwapEnabled ? "white" : "#1a1a1a",
            marginBottom: "2px",
          }}>
            Auto-Swap {autoSwapEnabled ? "ON" : "OFF"}
          </div>
          <div style={{
            fontSize: "11px",
            color: autoSwapEnabled ? "rgba(255,255,255,0.9)" : "#737373",
          }}>
            {autoSwapEnabled ? "Evaluating every 30min" : "Click to enable"}
          </div>
        </div>
      </div>

      {/* Parallel/Serial Mode Toggle (only show when auto-swap is enabled) */}
      {autoSwapEnabled && (
        <div
          style={{
            position: "fixed",
            top: "90px",
            right: "20px",
            zIndex: 1000,
            background: "#f4f1eb",
            padding: "8px 16px",
            borderRadius: "6px",
            boxShadow: "0 2px 6px rgba(0,0,0,0.08)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            cursor: "pointer",
            transition: "all 0.2s",
            border: "1px solid #ebe6dd",
          }}
          onClick={handleToggleParallel}
        >
          <div style={{ fontSize: "14px" }}>
            {autoSwapParallel ? "⚡" : "➡️"}
          </div>
          <div>
            <div
              style={{
                fontWeight: 600,
                fontSize: "12px",
                color: "#1a1a1a",
              }}
            >
              {autoSwapParallel ? "Parallel" : "Serial"}
            </div>
            <div
              style={{
                fontSize: "10px",
                color: "#737373",
              }}
            >
              {autoSwapParallel ? "All at once" : "One at a time"}
            </div>
          </div>
        </div>
      )}

      {/* Evaluation Error Banner */}
      {evaluationErrors.length > 0 && (
        <div
          style={{
            background: "#fee",
            border: "1px solid #fcc",
            borderRadius: "8px",
            padding: "16px",
            marginBottom: "20px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: "8px",
            }}
          >
            <span style={{ fontSize: "20px", marginRight: "8px" }}>⚠️</span>
            <strong style={{ fontSize: "16px", color: "#c00" }}>
              Strategy Evaluation Errors
            </strong>
          </div>
          {evaluationErrors.slice(0, 3).map((error: any, idx: number) => (
            <div
              key={idx}
              style={{
                fontSize: "14px",
                color: "#666",
                marginTop: "8px",
                paddingLeft: "28px",
              }}
            >
              <strong>{error.metadata?.symbol || "Unknown"}:</strong>{" "}
              {error.metadata?.reason || error.message}
              <span
                style={{ color: "#999", marginLeft: "8px", fontSize: "12px" }}
              >
                {new Date(error.createdAt).toLocaleTimeString()}
              </span>
            </div>
          ))}
          {evaluationErrors.length > 3 && (
            <div
              style={{
                fontSize: "12px",
                color: "#999",
                marginTop: "8px",
                paddingLeft: "28px",
              }}
            >
              +{evaluationErrors.length - 3} more errors. Check System Logs tab
              for details.
            </div>
          )}
        </div>
      )}

      {/* Portfolio Reconciliation: Database vs TWS */}
      <div className="dashboard-section">
        <h2 className="dashboard-title">
          Portfolio Reconciliation
          {twsError && (
            <span
              style={{
                fontSize: "14px",
                color: "#f55036",
                marginLeft: "12px",
                fontWeight: "normal",
              }}
            >
              ⚠️ TWS: {twsError}
            </span>
          )}
        </h2>

        <div style={{ marginBottom: "24px" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
              marginBottom: "16px",
            }}
          >
            {/* Database Column */}
            <div>
              <h3
                style={{
                  fontSize: "14px",
                  fontWeight: "600",
                  marginBottom: "12px",
                  color: "#737373",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                📊 Database (Internal Records)
              </h3>
              <div className="dashboard-cards">
                <div className="dashboard-card">
                  <div className="card-label">Realized P&L</div>
                  <div
                    className={`card-value ${(pnl?.realizedPnL || 0) >= 0 ? "positive" : "negative"}`}
                  >
                    ${pnl?.realizedPnL?.toFixed(2) || "0.00"}
                  </div>
                </div>
                <div className="dashboard-card">
                  <div className="card-label">Open Positions</div>
                  <div className="card-value">{pnl?.totalPositions || 0}</div>
                </div>
                <div className="dashboard-card">
                  <div className="card-label">Active Strategies</div>
                  <div className="card-value">
                    {strategies?.filter((s: any) => s.status === "ACTIVE")
                      .length || 0}
                  </div>
                </div>
                <div className="dashboard-card">
                  <div className="card-label">Total Orders</div>
                  <div className="card-value">
                    {Object.values(orderStats || {}).reduce(
                      (a: number, b: unknown) => a + (b as number),
                      0,
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* TWS Column */}
            <div>
              <h3
                style={{
                  fontSize: "14px",
                  fontWeight: "600",
                  marginBottom: "12px",
                  color: "#737373",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                🔴 TWS (Live Broker)
              </h3>
              {twsData ? (
                <div className="dashboard-cards">
                  <div className="dashboard-card">
                    <div className="card-label">Realized P&L</div>
                    <div
                      className={`card-value ${(twsData.realizedPnL || 0) >= 0 ? "positive" : "negative"}`}
                      style={{
                        fontWeight: Math.abs((pnl?.realizedPnL || 0) - (twsData.realizedPnL || 0)) > 0.01 ? "700" : undefined,
                        color: Math.abs((pnl?.realizedPnL || 0) - (twsData.realizedPnL || 0)) > 0.01 ? "#f55036" : undefined,
                      }}
                    >
                      ${twsData.realizedPnL?.toFixed(2) || "0.00"}
                    </div>
                  </div>
                  <div className="dashboard-card">
                    <div className="card-label">Account Value</div>
                    <div className="card-value">
                      ${twsData.totalValue?.toFixed(2) || "0.00"}
                    </div>
                  </div>
                  <div className="dashboard-card">
                    <div className="card-label">Unrealized P&L</div>
                    <div
                      className={`card-value ${(twsData.unrealizedPnL || 0) >= 0 ? "positive" : "negative"}`}
                    >
                      ${twsData.unrealizedPnL?.toFixed(2) || "0.00"}
                    </div>
                  </div>
                  <div className="dashboard-card">
                    <div className="card-label">Buying Power</div>
                    <div className="card-value">
                      ${twsData.buyingPower?.toFixed(2) || "0.00"}
                    </div>
                  </div>
                  <div className="dashboard-card">
                    <div className="card-label">Cash</div>
                    <div
                      className={`card-value ${(twsData.cash || 0) >= 0 ? "positive" : "negative"}`}
                    >
                      ${twsData.cash?.toFixed(2) || "0.00"}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    padding: "24px",
                    textAlign: "center",
                    color: "#999",
                    background: "#faf8f5",
                    borderRadius: "8px",
                    border: "1px solid #ebe6dd",
                  }}
                >
                  {twsError
                    ? "TWS connection unavailable"
                    : "Loading TWS data..."}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Position Reconciliation */}
      {((pnl?.currentPositions && pnl.currentPositions.length > 0) ||
        (twsData?.positions && twsData.positions.length > 0)) && (
        <div className="dashboard-section">
          <h2 className="dashboard-title">Position Reconciliation</h2>
          <div className="dashboard-table">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>DB Qty</th>
                  <th>TWS Qty</th>
                  <th>DB Avg Price</th>
                  <th>TWS Avg Cost</th>
                  <th>TWS Current Price</th>
                  <th>TWS Market Value</th>
                  <th>TWS Unrealized P&L</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Create a map of all symbols from both sources
                  const allSymbols = new Set<string>();
                  pnl?.currentPositions?.forEach((p: any) =>
                    allSymbols.add(p.symbol),
                  );
                  twsData?.positions?.forEach((p: any) =>
                    allSymbols.add(p.symbol),
                  );

                  return Array.from(allSymbols)
                    .map((symbol) => {
                      const dbPos = pnl?.currentPositions?.find(
                        (p: any) => p.symbol === symbol,
                      );
                      const twsPos = twsData?.positions?.find(
                        (p: any) => p.symbol === symbol,
                      );

                      const dbQty = dbPos?.qty || 0;
                      const twsQty = twsPos?.quantity || 0;

                      // Skip symbols with no positions in either system
                      if (dbQty === 0 && twsQty === 0) {
                        return null;
                      }

                      const qtyMismatch = Math.abs(dbQty - twsQty) > 0.01;

                      const dbAvgPrice = dbPos?.avgPrice || 0;
                      const twsAvgCost = twsPos?.avgCost || 0;
                      const priceMismatch =
                        dbAvgPrice > 0 &&
                        twsAvgCost > 0 &&
                        Math.abs(dbAvgPrice - twsAvgCost) > 0.01;

                      const hasMismatch = qtyMismatch || priceMismatch;
                      // Only flag as missing if there's actually a non-zero position
                      const missingInDB = twsQty > 0 && dbQty === 0;
                      const missingInTWS = dbQty > 0 && twsQty === 0;

                    return (
                      <tr
                        key={symbol}
                        style={{
                          backgroundColor: hasMismatch
                            ? "rgba(245, 80, 54, 0.05)"
                            : undefined,
                        }}
                      >
                        <td className="symbol-cell">{symbol}</td>
                        <td
                          style={{
                            color: missingInDB
                              ? "#f55036"
                              : qtyMismatch
                                ? "#f55036"
                                : undefined,
                            fontWeight: qtyMismatch ? "600" : undefined,
                          }}
                        >
                          {dbQty > 0 ? dbQty : missingInDB ? "-" : "0"}
                        </td>
                        <td
                          style={{
                            color: missingInTWS
                              ? "#f55036"
                              : qtyMismatch
                                ? "#f55036"
                                : undefined,
                            fontWeight: qtyMismatch ? "600" : undefined,
                          }}
                        >
                          {twsQty > 0 ? twsQty : missingInTWS ? "-" : "0"}
                        </td>
                        <td
                          style={{
                            color: priceMismatch ? "#f55036" : undefined,
                            fontWeight: priceMismatch ? "600" : undefined,
                          }}
                        >
                          {dbAvgPrice > 0
                            ? `$${dbAvgPrice.toFixed(2)}`
                            : "-"}
                        </td>
                        <td
                          style={{
                            color: priceMismatch ? "#f55036" : undefined,
                            fontWeight: priceMismatch ? "600" : undefined,
                          }}
                        >
                          {twsAvgCost > 0
                            ? `$${twsAvgCost.toFixed(2)}`
                            : "-"}
                        </td>
                        <td>
                          {twsPos?.currentPrice
                            ? `$${twsPos.currentPrice.toFixed(2)}`
                            : "-"}
                        </td>
                        <td>
                          {twsPos?.marketValue
                            ? `$${twsPos.marketValue.toFixed(2)}`
                            : "-"}
                        </td>
                        <td
                          className={
                            twsPos?.unrealizedPnL
                              ? twsPos.unrealizedPnL >= 0
                                ? "positive"
                                : "negative"
                              : ""
                          }
                        >
                          {twsPos?.unrealizedPnL
                            ? `$${twsPos.unrealizedPnL.toFixed(2)}`
                            : "-"}
                        </td>
                        <td>
                          {missingInDB ? (
                            <span style={{ color: "#f55036", fontSize: "14px" }}>
                              ⚠️ In TWS, not tracked in database (acquired outside system)
                            </span>
                          ) : missingInTWS ? (
                            <span style={{ color: "#f55036", fontSize: "14px" }}>
                              ⚠️ In database, missing from TWS (closed outside system?)
                            </span>
                          ) : hasMismatch ? (
                            <span style={{ color: "#f55036", fontSize: "14px" }}>
                              ⚠️ Quantity/price mismatch (DB: {dbQty} @ ${dbAvgPrice.toFixed(2)}, TWS: {twsQty} @ ${twsAvgCost.toFixed(2)})
                            </span>
                          ) : (
                            <span style={{ color: "#10b981", fontSize: "14px" }}>
                              ✓ Synced
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                  .filter((row) => row !== null); // Remove symbols with no positions
                })()}
              </tbody>
            </table>
          </div>

          {/* Reconciliation Summary */}
          <div
            style={{
              marginTop: "16px",
              padding: "12px 16px",
              background: "#faf8f5",
              borderRadius: "8px",
              fontSize: "14px",
              color: "#666",
            }}
          >
            <strong>Legend:</strong>
            <span style={{ marginLeft: "16px" }}>
              <span style={{ color: "#10b981", fontSize: "18px" }}>✓</span> =
              Match
            </span>
            <span style={{ marginLeft: "16px" }}>
              <span style={{ color: "#f55036", fontSize: "18px" }}>⚠️</span> =
              Discrepancy (red highlight)
            </span>
          </div>
        </div>
      )}

      {/* Strategy Performance */}
      {strategies && strategies.length > 0 && (
        <div className="dashboard-section dashboard-fixed-height">
          <div className="dashboard-header">
            <h2 className="dashboard-title">Strategy Performance</h2>
            <div className="dashboard-filters">
              <input
                type="text"
                placeholder="Filter by symbol..."
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
                className="filter-input"
              />
              <select
                value={strategyStatusFilter}
                onChange={(e) => setStrategyStatusFilter(e.target.value)}
                className="filter-select"
              >
                <option value="ALL">All Status</option>
                <option value="ACTIVE">Active</option>
                <option value="CLOSED">Closed</option>
                <option value="DRAFT">Draft</option>
                <option value="PENDING">Pending</option>
              </select>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="filter-input"
                style={{ width: "150px" }}
                title="Filter by date"
              />
              {selectedDate && (
                <button
                  onClick={() => setSelectedDate("")}
                  className="filter-clear-button"
                  title="Clear date filter"
                  style={{
                    padding: "6px 12px",
                    background: "#f55036",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "14px",
                    fontWeight: "500",
                  }}
                >
                  Clear Date
                </button>
              )}
            </div>
          </div>
          <div className="dashboard-table-container">
            <div className="dashboard-table">
              <table>
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Symbol</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Open Orders</th>
                    <th>Trades</th>
                    <th>Win Rate</th>
                    <th>P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStrategies.length > 0 ? (
                    sortedStrategies.map((strategy: any) => (
                      <tr
                        key={strategy.id}
                        onClick={() => {
                          setSelectedStrategy(strategy);
                          setShowStrategyModal(true);
                        }}
                        className="clickable-row"
                      >
                        <td className="strategy-cell">{strategy.name}</td>
                        <td className="symbol-cell">{strategy.symbol}</td>
                        <td>
                          <span
                            className={`status-badge ${strategy.status.toLowerCase()}`}
                          >
                            {strategy.status}
                          </span>
                        </td>
                        <td className="time-cell">
                          {getStrategyTimestamp(strategy)
                            ? new Date(
                                getStrategyTimestamp(strategy),
                              ).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "-"}
                        </td>
                        <td>
                          {strategy.openOrderCount > 0 ? (
                            <span className="order-count-badge">
                              {strategy.openOrderCount}
                            </span>
                          ) : (
                            <span style={{ color: "#737373" }}>—</span>
                          )}
                        </td>
                        <td>{strategy.totalTrades}</td>
                        <td>{strategy.winRate.toFixed(1)}%</td>
                        <td
                          className={
                            strategy.totalPnL >= 0 ? "positive" : "negative"
                          }
                        >
                          ${strategy.totalPnL.toFixed(2)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} className="empty-row">
                        No strategies match the filter
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Recent Trades */}
      {recentTrades && recentTrades.length > 0 && (
        <div className="dashboard-section dashboard-fixed-height">
          <div className="dashboard-header">
            <h2 className="dashboard-title">Recent Trades</h2>
            <div className="dashboard-filters">
              <select
                value={tradeStatusFilter}
                onChange={(e) => setTradeStatusFilter(e.target.value)}
                className="filter-select"
              >
                <option value="ALL">All Status</option>
                <option value="FILLED">Filled</option>
                <option value="PARTIALLY_FILLED">Partially Filled</option>
                <option value="SUBMITTED">Submitted</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>
          </div>
          <div className="dashboard-table-container">
            <div className="dashboard-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Strategy</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTrades.length > 0 ? (
                    filteredTrades.slice(0, 10).map((trade: any) => (
                      <tr key={trade.id}>
                        <td className="time-cell">
                          {trade.filledAt
                            ? new Date(trade.filledAt).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "-"}
                        </td>
                        <td className="strategy-cell">{trade.strategyName}</td>
                        <td className="symbol-cell">{trade.symbol}</td>
                        <td>
                          <span
                            className={`side-badge ${trade.side.toLowerCase()}`}
                          >
                            {trade.side}
                          </span>
                        </td>
                        <td>{trade.qty}</td>
                        <td>${trade.price?.toFixed(2) || "-"}</td>
                        <td>
                          <span
                            className={`status-badge ${trade.status.toLowerCase()}`}
                          >
                            {trade.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="empty-row">
                        No trades match the filter
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {(!strategies || strategies.length === 0) &&
        (!recentTrades || recentTrades.length === 0) && (
          <div className="dashboard-empty">
            <div
              style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}
            >
              No Trading Data Yet
            </div>
            <div style={{ fontSize: "14px", color: "#737373" }}>
              Start trading strategies to see portfolio metrics and performance
              data here.
            </div>
          </div>
        )}

      {/* Strategy Detail Modal */}
      {showStrategyModal && selectedStrategy && (
        <StrategyDetailModal
          strategy={selectedStrategy}
          backtestResult={backtestResult}
          isBacktesting={isBacktesting}
          backtestError={backtestError}
          onClose={() => setShowStrategyModal(false)}
          onCloseStrategy={() => setShowCloseModal(true)}
          onReopenStrategy={() => setShowReopenModal(true)}
          onForceDeployStrategy={handleForceDeployClick}
          onRunBacktest={handleRunBacktest}
        />
      )}

      {/* Close Strategy Confirmation Modal */}
      {showCloseModal && selectedStrategy && (
        <CloseStrategyModal
          strategy={selectedStrategy}
          closeReason={closeReason}
          isClosing={isClosing}
          onClose={() => {
            setShowCloseModal(false);
            setCloseReason("");
          }}
          onReasonChange={setCloseReason}
          onConfirm={handleCloseStrategy}
        />
      )}

      {/* Reopen Strategy Confirmation Modal */}
      {showReopenModal && selectedStrategy && (
        <ReopenStrategyModal
          strategy={selectedStrategy}
          reopenReason={reopenReason}
          isReopening={isReopening}
          onClose={() => {
            setShowReopenModal(false);
            setReopenReason("");
          }}
          onReasonChange={setReopenReason}
          onConfirm={handleReopenStrategy}
        />
      )}

      {/* Force Deploy Strategy Confirmation Modal */}
      {showForceDeployModal && selectedStrategy && (
        <ForceDeployModal
          strategy={selectedStrategy}
          forceDeployReason={forceDeployReason}
          isDeploying={isForceDeploying}
          onClose={() => {
            setShowForceDeployModal(false);
            setForceDeployReason("");
          }}
          onReasonChange={setForceDeployReason}
          onConfirm={handleConfirmForceDeploy}
        />
      )}

      {/* Notification Banner */}
      <NotificationBanner
        notification={notification}
        onClose={() => setNotification(null)}
      />
    </div>
  );
}
