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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter states
  const [strategyStatusFilter, setStrategyStatusFilter] =
    useState<string>("ALL");
  const [tradeStatusFilter, setTradeStatusFilter] = useState<string>("ALL");
  const [symbolFilter, setSymbolFilter] = useState<string>("");

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
      return matchesStatus && matchesSymbol;
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

      {/* P&L Summary */}
      <div className="dashboard-section">
        <h2 className="dashboard-title">Portfolio Summary</h2>
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
              {strategies?.filter((s: any) => s.status === "ACTIVE").length ||
                0}
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

      {/* Current Positions */}
      {pnl?.currentPositions && pnl.currentPositions.length > 0 && (
        <div className="dashboard-section">
          <h2 className="dashboard-title">Current Positions</h2>
          <div className="dashboard-table">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Quantity</th>
                  <th>Avg Price</th>
                </tr>
              </thead>
              <tbody>
                {pnl.currentPositions.map((pos: any, idx: number) => (
                  <tr key={idx}>
                    <td className="symbol-cell">{pos.symbol}</td>
                    <td>{pos.qty}</td>
                    <td>${pos.avgPrice.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
