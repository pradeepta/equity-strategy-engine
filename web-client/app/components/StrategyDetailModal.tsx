import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StrategyChart } from "./StrategyChart";

/**
 * Strategy Detail Modal Component
 * Displays detailed strategy information including performance metrics,
 * price chart, YAML configuration, backtest results, and AI review
 */
export function StrategyDetailModal({
  strategy,
  backtestResult,
  isBacktesting,
  backtestError,
  onClose,
  onCloseStrategy,
  onReopenStrategy,
  onForceDeployStrategy,
  onRunBacktest,
}: {
  strategy: any;
  backtestResult: any;
  isBacktesting: boolean;
  backtestError: string | null;
  onClose: () => void;
  onCloseStrategy: () => void;
  onReopenStrategy: () => void;
  onForceDeployStrategy?: (strategy: any) => void;
  onRunBacktest: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"performance" | "config" | "backtest" | "review">("performance");
  const [isReviewing, setIsReviewing] = useState(false);
  const [reviewResponse, setReviewResponse] = useState("");
  const [reviewRecommendation, setReviewRecommendation] = useState<"continue" | "swap" | null>(null);
  const [swapYaml, setSwapYaml] = useState<string | null>(null);

  if (!strategy) return null;

  const handleStartReview = async () => {
    setIsReviewing(true);
    setReviewResponse("");
    setReviewRecommendation(null);
    setSwapYaml(null);

    try {
      // Call backend API for complete AI review
      const response = await fetch(`http://localhost:3002/api/portfolio/strategies/${strategy.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to run review");
      }

      const { analysis } = await response.json();

      // Check if analysis is valid
      if (!analysis || analysis === 'No analysis generated') {
        throw new Error('No analysis was generated. Check server logs for details.');
      }

      // Display the complete analysis
      setReviewResponse(analysis);

      // Parse the response to extract recommendation
      parseReviewResponse(analysis);

      setIsReviewing(false);
    } catch (error: any) {
      setIsReviewing(false);
      let errorMessage = `Error: ${error.message}\n\n`;

      if (error.message.includes('authentication')) {
        errorMessage += 'The ANTHROPIC_API_KEY environment variable is not set in the portfolio API server.\n\nPlease add it to your .env file and restart the server.';
      } else {
        errorMessage += 'Please ensure the portfolio API server is running and check the server logs for details.';
      }

      setReviewResponse(errorMessage);
    }
  };

  const parseReviewResponse = (response: string) => {
    // Extract recommendation
    const recommendationMatch = response.match(/\*\*Recommendation:\s*(CONTINUE|SWAP)\*\*/i);
    if (recommendationMatch) {
      const recommendation = recommendationMatch[1].toLowerCase() as "continue" | "swap";
      setReviewRecommendation(recommendation);
    }

    // Extract YAML if present
    const yamlMatch = response.match(/```yaml\n([\s\S]*?)\n```/);
    if (yamlMatch) {
      setSwapYaml(yamlMatch[1]);
    }
  };

  const handleApplySwap = async () => {
    if (!swapYaml) return;

    const confirmed = confirm(
      `This will:\n1. Close the current strategy "${strategy.name}"\n2. Deploy the new recommended strategy\n3. The orchestrator will automatically activate it\n\nProceed?`
    );
    if (!confirmed) return;

    try {
      // Call swap endpoint (closes old, deploys new atomically)
      const swapResponse = await fetch(`http://localhost:3002/api/portfolio/strategies/${strategy.id}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yamlContent: swapYaml,
          reason: "Swapped based on AI Review Recommendation"
        }),
      });

      if (!swapResponse.ok) {
        const data = await swapResponse.json();
        throw new Error(data.error || "Failed to swap strategy");
      }

      const result = await swapResponse.json();

      alert(`Strategy swap successful!\n\nOld strategy closed: ${result.oldStrategyId}\nNew strategy created: ${result.newStrategyId}\n\nThe new strategy will be activated automatically by the orchestrator.`);

      onClose();
    } catch (error: any) {
      alert(`Failed to apply swap: ${error.message}`);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{strategy.name}</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="modal-tabs">
          <button
            className={`modal-tab ${activeTab === "performance" ? "active" : ""}`}
            onClick={() => setActiveTab("performance")}
          >
            Performance
          </button>
          <button
            className={`modal-tab ${activeTab === "config" ? "active" : ""}`}
            onClick={() => setActiveTab("config")}
          >
            Configuration
          </button>
          <button
            className={`modal-tab ${activeTab === "backtest" ? "active" : ""}`}
            onClick={() => setActiveTab("backtest")}
          >
            Backtest
          </button>
          <button
            className={`modal-tab ${activeTab === "review" ? "active" : ""}`}
            onClick={() => setActiveTab("review")}
          >
            🤖 Review
          </button>
        </div>

        <div className="modal-body">
          {/* Performance Tab */}
          {activeTab === "performance" && (
            <>
              <div className="modal-section">
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Symbol</div>
                    <div className="modal-value symbol-cell">{strategy.symbol}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Status</div>
                    <div className="modal-value">
                      <span
                        className={`status-badge ${strategy.status.toLowerCase()}`}
                      >
                        {strategy.status}
                      </span>
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Timeframe</div>
                    <div className="modal-value">{strategy.timeframe}</div>
                  </div>
                </div>
              </div>

              <div className="modal-section">
                <h3 className="modal-section-title">Performance Metrics</h3>
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Total Trades</div>
                    <div className="modal-value">{strategy.totalTrades}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Wins / Losses</div>
                    <div className="modal-value">
                      {strategy.wins} / {strategy.losses}
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Win Rate</div>
                    <div className="modal-value">
                      {strategy.winRate.toFixed(1)}%
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Total P&L</div>
                    <div
                      className={`modal-value ${strategy.totalPnL >= 0 ? "positive" : "negative"}`}
                    >
                      ${strategy.totalPnL.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Open Orders Section */}
              {strategy.openOrders && strategy.openOrders.length > 0 && (
                <div className="modal-section">
                  <h3 className="modal-section-title">
                    Open Orders ({strategy.openOrders.length})
                  </h3>
                  <div className="orders-table-container">
                    <table className="orders-table">
                      <thead>
                        <tr>
                          <th>Order ID</th>
                          <th>Type</th>
                          <th>Side</th>
                          <th>Qty</th>
                          <th>Limit Price</th>
                          <th>Stop Price</th>
                          <th>Status</th>
                          <th>Submitted</th>
                        </tr>
                      </thead>
                      <tbody>
                        {strategy.openOrders.map((order: any) => (
                          <tr key={order.id}>
                            <td className="order-id-cell">
                              {order.brokerOrderId || order.id.slice(0, 8)}
                            </td>
                            <td>{order.type}</td>
                            <td>
                              <span
                                className={`side-badge ${order.side.toLowerCase()}`}
                              >
                                {order.side}
                              </span>
                            </td>
                            <td>{order.qty}</td>
                            <td>
                              {order.limitPrice
                                ? `$${order.limitPrice.toFixed(2)}`
                                : "—"}
                            </td>
                            <td>
                              {order.stopPrice
                                ? `$${order.stopPrice.toFixed(2)}`
                                : "—"}
                            </td>
                            <td>
                              <span
                                className={`status-badge ${order.status.toLowerCase()}`}
                              >
                                {order.status}
                              </span>
                            </td>
                            <td className="time-cell">
                              {new Date(order.submittedAt).toLocaleString("en-US", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Show error warnings if any orders have errors */}
                  {strategy.openOrders.some((o: any) => o.errorMessage) && (
                    <div className="order-errors-warning">
                      ⚠️ Some orders have errors:
                      {strategy.openOrders
                        .filter((o: any) => o.errorMessage)
                        .map((o: any) => (
                          <div key={o.id} className="error-detail">
                            Order {o.brokerOrderId || o.id.slice(0, 8)}:{" "}
                            {o.errorMessage}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              {strategy.latestRecommendation && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Latest Recommendation</h3>
                  <div className="modal-value">
                    <span
                      className={`status-badge ${strategy.latestRecommendation.toLowerCase()}`}
                    >
                      {strategy.latestRecommendation}
                    </span>
                  </div>
                </div>
              )}

              {strategy.activatedAt && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Timeline</h3>
                  <div className="modal-field">
                    <div className="modal-label">Activated At</div>
                    <div className="modal-value">
                      {new Date(strategy.activatedAt).toLocaleString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Embedded Chart Section */}
              <div className="modal-section">
                <h3 className="modal-section-title">
                  Price Chart with Trade Levels
                </h3>
                <StrategyChart strategy={strategy} />
              </div>
            </>
          )}

          {/* Configuration Tab */}
          {activeTab === "config" && strategy.yamlContent && (
            <div className="modal-section">
              <h3 className="modal-section-title">Strategy Configuration</h3>
              <pre className="yaml-content">
                <code>{strategy.yamlContent}</code>
              </pre>
            </div>
          )}

          {/* Backtest Tab */}
          {activeTab === "backtest" && (
            <div className="modal-section">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "16px",
                }}
              >
                <h3 className="modal-section-title" style={{ margin: 0 }}>
                  Backtest (Last 180 Bars)
                </h3>
                <button
                  className="backtest-button"
                  onClick={onRunBacktest}
                  disabled={isBacktesting}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: isBacktesting ? "#d4d4d4" : "#f55036",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: 600,
                    cursor: isBacktesting ? "not-allowed" : "pointer",
                    transition: "background-color 0.2s",
                  }}
                >
                  {isBacktesting ? "Running..." : "Run Backtest"}
                </button>
              </div>

              {backtestError && (
                <div
                  style={{
                    padding: "12px",
                    backgroundColor: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    color: "#991b1b",
                    fontSize: "14px",
                  }}
                >
                  {backtestError}
                </div>
              )}

              {backtestResult && (
                <div className="backtest-results">
                  <div className="modal-row" style={{ marginBottom: "16px" }}>
                    <div className="modal-field">
                      <div className="modal-label">Bars Processed</div>
                      <div className="modal-value">
                        {backtestResult.barsProcessed}
                      </div>
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">Final State</div>
                      <div className="modal-value">
                        <span
                          className={`status-badge ${backtestResult.finalState.toLowerCase()}`}
                        >
                          {backtestResult.finalState}
                        </span>
                      </div>
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">Price Change</div>
                      <div
                        className={`modal-value ${backtestResult.priceChangePercent >= 0 ? "positive" : "negative"}`}
                      >
                        {backtestResult.priceChangePercent >= 0 ? "+" : ""}
                        {backtestResult.priceChangePercent.toFixed(2)}%
                      </div>
                    </div>
                  </div>

                  <div className="modal-row" style={{ marginBottom: "16px" }}>
                    <div className="modal-field">
                      <div className="modal-label">Total Trades</div>
                      <div className="modal-value">
                        {backtestResult.totalTrades}
                      </div>
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">Win Rate</div>
                      <div className="modal-value">
                        {backtestResult.winRate.toFixed(1)}%
                      </div>
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">Realized P&L</div>
                      <div
                        className={`modal-value ${backtestResult.realizedPnL >= 0 ? "positive" : "negative"}`}
                      >
                        ${backtestResult.realizedPnL.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="modal-row" style={{ marginBottom: "16px" }}>
                    <div className="modal-field">
                      <div className="modal-label">Orders Placed</div>
                      <div className="modal-value">
                        {backtestResult.ordersPlaced}
                      </div>
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">Orders Filled</div>
                      <div className="modal-value">
                        {backtestResult.ordersFilled}
                      </div>
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">Stop Loss Hits</div>
                      <div
                        className="modal-value"
                        style={{
                          color:
                            backtestResult.stopLossHits > 0
                              ? "#dc2626"
                              : "inherit",
                        }}
                      >
                        {backtestResult.stopLossHits}
                      </div>
                    </div>
                  </div>

                  {backtestResult.invalidations > 0 && (
                    <div
                      style={{
                        padding: "12px",
                        backgroundColor: "#fef9c3",
                        border: "1px solid #fde047",
                        borderRadius: "6px",
                        marginBottom: "16px",
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          marginBottom: "8px",
                          color: "#854d0e",
                        }}
                      >
                        Invalidations: {backtestResult.invalidations}
                      </div>
                      <div style={{ fontSize: "13px", color: "#a16207" }}>
                        {backtestResult.invalidationReasons.map(
                          (reason: string, idx: number) => (
                            <div key={idx} style={{ marginBottom: "4px" }}>
                              • {reason}
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )}

                  {backtestResult.stateTransitions.length > 0 && (
                    <div>
                      <div
                        style={{
                          fontWeight: 600,
                          marginBottom: "8px",
                          fontSize: "14px",
                        }}
                      >
                        State Transitions ({backtestResult.stateTransitions.length}
                        )
                      </div>
                      <div
                        style={{
                          maxHeight: "200px",
                          overflowY: "auto",
                          border: "1px solid #ebe6dd",
                          borderRadius: "6px",
                          padding: "8px",
                          fontSize: "13px",
                        }}
                      >
                        {backtestResult.stateTransitions.map(
                          (transition: any, idx: number) => (
                            <div
                              key={idx}
                              style={{
                                padding: "6px",
                                borderBottom:
                                  idx <
                                  backtestResult.stateTransitions.length - 1
                                    ? "1px solid #f5f5f4"
                                    : "none",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                }}
                              >
                                <div>
                                  <span style={{ fontWeight: 600 }}>
                                    Bar {transition.bar}:
                                  </span>{" "}
                                  <span
                                    className={`status-badge ${transition.from.toLowerCase()}`}
                                    style={{
                                      fontSize: "11px",
                                      padding: "2px 6px",
                                    }}
                                  >
                                    {transition.from}
                                  </span>
                                  {" → "}
                                  <span
                                    className={`status-badge ${transition.to.toLowerCase()}`}
                                    style={{
                                      fontSize: "11px",
                                      padding: "2px 6px",
                                    }}
                                  >
                                    {transition.to}
                                  </span>
                                </div>
                                <div style={{ color: "#737373" }}>
                                  ${transition.price.toFixed(2)}
                                </div>
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Review Tab */}
          {activeTab === "review" && (
            <div className="modal-section">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "16px",
                }}
              >
                <h3 className="modal-section-title" style={{ margin: 0 }}>
                  AI Strategy Review
                </h3>
                <button
                  className="backtest-button"
                  onClick={handleStartReview}
                  disabled={isReviewing}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: isReviewing ? "#d4d4d4" : "#f55036",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: 600,
                    cursor: isReviewing ? "not-allowed" : "pointer",
                    transition: "background-color 0.2s",
                  }}
                >
                  {isReviewing ? "Reviewing..." : "Start Review"}
                </button>
              </div>


              <div
                style={{
                  padding: "12px",
                  backgroundColor: "#f0f9ff",
                  border: "1px solid #bae6fd",
                  borderRadius: "6px",
                  marginBottom: "16px",
                  fontSize: "14px",
                  color: "#0c4a6e",
                }}
              >
                <strong>How it works:</strong> The AI will analyze current market conditions,
                portfolio state, and sector performance to recommend whether to continue with
                the current strategy or swap to an improved one. If a swap is recommended,
                you'll receive a new optimized YAML configuration addressing any identified issues.
              </div>

              {reviewResponse && (
                <div
                  style={{
                    marginTop: "16px",
                    padding: "16px",
                    backgroundColor: "#faf8f5",
                    border: "1px solid #ebe6dd",
                    borderRadius: "6px",
                    fontSize: "14px",
                    lineHeight: "1.6",
                    maxHeight: "400px",
                    overflowY: "auto",
                  }}
                >
                  {/* Recommendation Badge */}
                  {reviewRecommendation && (
                    <div style={{ marginBottom: "16px" }}>
                      <span
                        className={`status-badge ${
                          reviewRecommendation === "continue"
                            ? "active"
                            : "pending"
                        }`}
                        style={{
                          fontSize: "16px",
                          padding: "8px 16px",
                        }}
                      >
                        {reviewRecommendation.toUpperCase()}
                      </span>
                    </div>
                  )}

                  {/* Response Content */}
                  <div
                    className="message-content"
                    style={{
                      fontSize: "14px",
                      lineHeight: "1.6",
                      color: "#1a1a1a"
                    }}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {reviewResponse}
                    </ReactMarkdown>
                  </div>

                  {/* Swap YAML Section */}
                  {swapYaml && (
                    <div style={{ marginTop: "24px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "12px",
                        }}
                      >
                        <strong style={{ fontSize: "16px" }}>
                          Proposed Replacement Strategy
                        </strong>
                        <button
                          onClick={handleApplySwap}
                          style={{
                            padding: "8px 16px",
                            backgroundColor: "#10b981",
                            color: "white",
                            border: "none",
                            borderRadius: "6px",
                            fontSize: "14px",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Apply Swap
                        </button>
                      </div>
                      <pre
                        className="yaml-content"
                        style={{
                          backgroundColor: "#fff",
                          border: "1px solid #ebe6dd",
                          padding: "12px",
                          borderRadius: "6px",
                          fontSize: "13px",
                          maxHeight: "300px",
                          overflowY: "auto",
                        }}
                      >
                        <code>{swapYaml}</code>
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Actions Footer */}
        <div className="modal-footer">
          {strategy.status === "ACTIVE" && (
            <>
              <button
                className="close-strategy-button"
                onClick={onCloseStrategy}
              >
                Close Strategy
              </button>
              {/* Force Deploy button - only shown if no orders placed yet */}
              {onForceDeployStrategy && (strategy.openOrderCount === 0 || strategy.openOrderCount === undefined) && (
                <button
                  className="force-deploy-button"
                  onClick={() => onForceDeployStrategy(strategy)}
                  style={{
                    backgroundColor: '#f59e0b',
                    color: 'white',
                  }}
                >
                  ⚡ Force Deploy
                </button>
              )}
            </>
          )}
          {strategy.status === "CLOSED" && (
            <button
              className="reopen-strategy-button"
              onClick={onReopenStrategy}
            >
              Reopen Strategy
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
