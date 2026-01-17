"use client";

import { useEffect, useState } from "react";

interface AuditLog {
  id: string;
  orderId?: string;
  brokerOrderId?: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  eventType: string;
  oldStatus?: string;
  newStatus?: string;
  quantity?: number;
  price?: number;
  errorMessage?: string;
  metadata?: any;
  createdAt: string;
}

export function AuditLogsViewer() {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Filter states
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("ALL");
  const [symbolFilter, setSymbolFilter] = useState<string>("");
  const [strategyFilter, setStrategyFilter] = useState<string>("");

  // Modal state
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [showModal, setShowModal] = useState(false);

  const fetchAuditLogs = async () => {
    try {
      const response = await fetch(
        "http://localhost:3002/api/portfolio/overview"
      );
      if (!response.ok) throw new Error("Failed to fetch audit logs");
      const data = await response.json();
      setAuditLogs(data.auditTrail || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load audit logs");
      console.error("Audit logs fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLogs();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchAuditLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  if (loading && !auditLogs.length) {
    return (
      <div className="dashboard-loading">
        <div className="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div style={{ marginTop: "12px", color: "#737373" }}>
          Loading audit logs...
        </div>
      </div>
    );
  }

  if (error && !auditLogs.length) {
    return (
      <div className="dashboard-error">
        <div
          style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}
        >
          Unable to Load Audit Logs
        </div>
        <div style={{ fontSize: "14px", color: "#737373" }}>{error}</div>
        <div
          style={{ fontSize: "12px", color: "#737373", marginTop: "12px" }}
        >
          Make sure the portfolio API server is running: npm run
          portfolio:api:dev
        </div>
      </div>
    );
  }

  // Get unique values for filters
  const uniqueEventTypes = [
    "ALL",
    ...Array.from(new Set(auditLogs.map((log) => log.eventType))),
  ];
  const uniqueSymbols = Array.from(new Set(auditLogs.map((log) => log.symbol)));
  const uniqueStrategies = Array.from(
    new Set(auditLogs.map((log) => log.strategyName))
  );

  // Filter audit logs
  const filteredLogs = auditLogs.filter((log) => {
    const matchesEventType =
      eventTypeFilter === "ALL" || log.eventType === eventTypeFilter;
    const matchesSymbol =
      !symbolFilter ||
      log.symbol.toLowerCase().includes(symbolFilter.toLowerCase());
    const matchesStrategy =
      !strategyFilter ||
      log.strategyName.toLowerCase().includes(strategyFilter.toLowerCase());
    return matchesEventType && matchesSymbol && matchesStrategy;
  });

  return (
    <div className="dashboard">
      {/* Summary Stats */}
      <div className="dashboard-section">
        <h2 className="dashboard-title">Audit Trail Summary</h2>
        <div className="dashboard-cards">
          <div className="dashboard-card">
            <div className="card-label">Total Events</div>
            <div className="card-value">{auditLogs.length}</div>
          </div>
          <div className="dashboard-card">
            <div className="card-label">Submitted</div>
            <div className="card-value">
              {auditLogs.filter((l) => l.eventType === "SUBMITTED").length}
            </div>
          </div>
          <div className="dashboard-card">
            <div className="card-label">Filled</div>
            <div className="card-value">
              {auditLogs.filter((l) => l.eventType === "FILLED").length}
            </div>
          </div>
          <div className="dashboard-card">
            <div className="card-label">Errors</div>
            <div className="card-value error">
              {
                auditLogs.filter(
                  (l) => l.eventType === "REJECTED" || l.errorMessage
                ).length
              }
            </div>
          </div>
        </div>
      </div>

      {/* Audit Logs Table */}
      <div className="dashboard-section dashboard-fixed-height">
        <div className="dashboard-header">
          <div className="dashboard-title-group">
            <h2 className="dashboard-title">Order Audit Trail</h2>
            <div className="dashboard-subtitle">
              Source: order_audit_log table
            </div>
          </div>
          <div className="dashboard-filters">
            <input
              type="text"
              placeholder="Filter by symbol..."
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
              className="filter-input"
            />
            <input
              type="text"
              placeholder="Filter by strategy..."
              value={strategyFilter}
              onChange={(e) => setStrategyFilter(e.target.value)}
              className="filter-input"
            />
            <select
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="filter-select"
            >
              {uniqueEventTypes.map((type) => (
                <option key={type} value={type}>
                  {type === "ALL" ? "All Events" : type}
                </option>
              ))}
            </select>
            <label className="auto-refresh-toggle">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh
            </label>
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
                  <th>Event</th>
                  <th>Status Change</th>
                  <th>Details</th>
                  <th>IDs</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length > 0 ? (
                  filteredLogs.map((log) => (
                    <tr
                      key={log.id}
                      onClick={() => {
                        setSelectedLog(log);
                        setShowModal(true);
                      }}
                      className="clickable-row"
                    >
                      <td className="time-cell">
                        {new Date(log.createdAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </td>
                      <td className="strategy-cell">{log.strategyName}</td>
                      <td className="symbol-cell">{log.symbol}</td>
                      <td>
                        <span
                          className={`status-badge ${log.eventType.toLowerCase()}`}
                        >
                          {log.eventType}
                        </span>
                      </td>
                      <td>
                        {log.oldStatus && log.newStatus ? (
                          <span className="status-change">
                            {log.oldStatus} → {log.newStatus}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td>
                        {log.errorMessage ? (
                          <span className="error-message">
                            {log.errorMessage.substring(0, 50)}...
                          </span>
                        ) : log.quantity ? (
                          <span>
                            Qty: {log.quantity}{" "}
                            {log.price ? `@ $${log.price.toFixed(2)}` : ""}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="audit-id-cell">
                        {log.orderId && (
                          <div className="id-badge" title={log.orderId}>
                            Order
                          </div>
                        )}
                        {log.brokerOrderId && (
                          <div className="id-badge" title={log.brokerOrderId}>
                            Broker
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="empty-row">
                      No audit logs found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Event Type Breakdown */}
      {auditLogs.length > 0 && (
        <div className="dashboard-section">
          <h2 className="dashboard-title">Event Breakdown by Type</h2>
          <div className="dashboard-table">
            <table>
              <thead>
                <tr>
                  <th>Event Type</th>
                  <th>Count</th>
                  <th>Percentage</th>
                </tr>
              </thead>
              <tbody>
                {uniqueEventTypes
                  .filter((type) => type !== "ALL")
                  .map((eventType) => {
                    const count = auditLogs.filter(
                      (l) => l.eventType === eventType
                    ).length;
                    const percentage = (
                      (count / auditLogs.length) *
                      100
                    ).toFixed(1);
                    return (
                      <tr key={eventType}>
                        <td>
                          <span
                            className={`status-badge ${eventType.toLowerCase()}`}
                          >
                            {eventType}
                          </span>
                        </td>
                        <td>{count}</td>
                        <td>{percentage}%</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal for Log Details */}
      {showModal && selectedLog && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Audit Log Details</h2>
              <button
                className="modal-close"
                onClick={() => setShowModal(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-section">
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Event Type</div>
                    <div className="modal-value">
                      <span
                        className={`status-badge ${selectedLog.eventType.toLowerCase()}`}
                      >
                        {selectedLog.eventType}
                      </span>
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Timestamp</div>
                    <div className="modal-value">
                      {new Date(selectedLog.createdAt).toLocaleString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-section">
                <h3 className="modal-section-title">Strategy Information</h3>
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Strategy Name</div>
                    <div className="modal-value">{selectedLog.strategyName}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Symbol</div>
                    <div className="modal-value symbol-cell">
                      {selectedLog.symbol}
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Strategy ID</div>
                    <div className="modal-value audit-id">
                      {selectedLog.strategyId}
                    </div>
                  </div>
                </div>
              </div>

              {(selectedLog.orderId || selectedLog.brokerOrderId) && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Order Information</h3>
                  <div className="modal-row">
                    {selectedLog.orderId && (
                      <div className="modal-field">
                        <div className="modal-label">Order ID</div>
                        <div className="modal-value audit-id">
                          {selectedLog.orderId}
                        </div>
                      </div>
                    )}
                    {selectedLog.brokerOrderId && (
                      <div className="modal-field">
                        <div className="modal-label">Broker Order ID</div>
                        <div className="modal-value audit-id">
                          {selectedLog.brokerOrderId}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(selectedLog.oldStatus || selectedLog.newStatus) && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Status Change</h3>
                  <div className="modal-row">
                    {selectedLog.oldStatus && (
                      <div className="modal-field">
                        <div className="modal-label">Old Status</div>
                        <div className="modal-value">
                          <span
                            className={`status-badge ${selectedLog.oldStatus.toLowerCase()}`}
                          >
                            {selectedLog.oldStatus}
                          </span>
                        </div>
                      </div>
                    )}
                    {selectedLog.newStatus && (
                      <div className="modal-field">
                        <div className="modal-label">New Status</div>
                        <div className="modal-value">
                          <span
                            className={`status-badge ${selectedLog.newStatus.toLowerCase()}`}
                          >
                            {selectedLog.newStatus}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(selectedLog.quantity || selectedLog.price) && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Trade Details</h3>
                  <div className="modal-row">
                    {selectedLog.quantity && (
                      <div className="modal-field">
                        <div className="modal-label">Quantity</div>
                        <div className="modal-value">{selectedLog.quantity}</div>
                      </div>
                    )}
                    {selectedLog.price && (
                      <div className="modal-field">
                        <div className="modal-label">Price</div>
                        <div className="modal-value">
                          ${selectedLog.price.toFixed(2)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedLog.errorMessage && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Error Message</h3>
                  <div className="error-message-full">
                    {selectedLog.errorMessage}
                  </div>
                </div>
              )}

              {selectedLog.metadata && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Metadata</h3>
                  <pre className="yaml-content">
                    <code>{JSON.stringify(selectedLog.metadata, null, 2)}</code>
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
