import { StrategyChart } from "./StrategyChart";

/**
 * Strategy Detail Modal Component
 * Displays detailed strategy information including performance metrics,
 * price chart, YAML configuration, and backtest results
 */
export function StrategyDetailModal({
  strategy,
  backtestResult,
  isBacktesting,
  backtestError,
  onClose,
  onCloseStrategy,
  onReopenStrategy,
  onRunBacktest,
}: {
  strategy: any;
  backtestResult: any;
  isBacktesting: boolean;
  backtestError: string | null;
  onClose: () => void;
  onCloseStrategy: () => void;
  onReopenStrategy: () => void;
  onRunBacktest: () => void;
}) {
  if (!strategy) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{strategy.name}</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
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

          {strategy.yamlContent && (
            <div className="modal-section">
              <h3 className="modal-section-title">Strategy Configuration</h3>
              <pre className="yaml-content">
                <code>{strategy.yamlContent}</code>
              </pre>
            </div>
          )}

          {/* Backtest Section */}
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
        </div>

        {/* Modal Actions Footer */}
        <div className="modal-footer">
          {strategy.status === "ACTIVE" && (
            <button
              className="close-strategy-button"
              onClick={onCloseStrategy}
            >
              Close Strategy
            </button>
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
