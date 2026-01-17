"use client";

import { useEffect, useState } from "react";

interface SystemLog {
  id: string;
  level: string;
  component: string;
  message: string;
  metadata?: any;
  strategyId?: string;
  orderId?: string;
  stackTrace?: string;
  errorCode?: string;
  createdAt: string;
}

interface LogStats {
  byLevel: Record<string, number>;
  byComponent: { component: string; count: number }[];
  recentErrors: {
    id: string;
    component: string;
    message: string;
    createdAt: string;
  }[];
}

export function LogsViewer() {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter states
  const [levelFilter, setLevelFilter] = useState<string>("ALL");
  const [componentFilter, setComponentFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Modal state
  const [selectedLog, setSelectedLog] = useState<SystemLog | null>(null);
  const [showLogModal, setShowLogModal] = useState(false);

  const fetchLogs = async () => {
    try {
      const params = new URLSearchParams();
      params.set("limit", "200");
      if (levelFilter !== "ALL") params.set("level", levelFilter);
      if (componentFilter !== "ALL") params.set("component", componentFilter);

      const response = await fetch(
        `http://localhost:3002/api/logs?${params.toString()}`
      );
      if (!response.ok) throw new Error("Failed to fetch logs");
      const data = await response.json();
      setLogs(data.logs || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to load logs");
      console.error("Logs fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await fetch("http://localhost:3002/api/logs/stats");
      if (!response.ok) throw new Error("Failed to fetch log stats");
      const data = await response.json();
      setStats(data.stats || null);
    } catch (err: any) {
      console.error("Stats fetch error:", err);
    }
  };

  useEffect(() => {
    fetchLogs();
    fetchStats();
  }, [levelFilter, componentFilter]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchLogs();
      fetchStats();
    }, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [autoRefresh, levelFilter, componentFilter]);

  if (loading && !logs.length) {
    return (
      <div className="dashboard-loading">
        <div className="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div style={{ marginTop: "12px", color: "#737373" }}>
          Loading logs...
        </div>
      </div>
    );
  }

  if (error && !logs.length) {
    return (
      <div className="dashboard-error">
        <div
          style={{ fontSize: "16px", fontWeight: 600, marginBottom: "8px" }}
        >
          Unable to Load Logs
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

  const uniqueComponents = [
    "ALL",
    ...Array.from(new Set(logs.map((log) => log.component))),
  ];

  // Filter logs by search query
  const filteredLogs = logs.filter((log) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      log.message.toLowerCase().includes(query) ||
      log.component.toLowerCase().includes(query) ||
      log.id.toLowerCase().includes(query)
    );
  });

  const getLevelColor = (level: string) => {
    switch (level.toUpperCase()) {
      case "ERROR":
        return "error";
      case "WARN":
        return "warn";
      case "INFO":
        return "info";
      case "DEBUG":
        return "debug";
      default:
        return "";
    }
  };

  return (
    <div className="dashboard">
      {/* Stats Summary */}
      {stats && (
        <div className="dashboard-section">
          <h2 className="dashboard-title">Log Statistics</h2>
          <div className="dashboard-cards">
            <div className="dashboard-card">
              <div className="card-label">Total Logs</div>
              <div className="card-value">{logs.length}</div>
            </div>
            <div className="dashboard-card">
              <div className="card-label">Errors</div>
              <div className="card-value error">
                {stats.byLevel.ERROR || 0}
              </div>
            </div>
            <div className="dashboard-card">
              <div className="card-label">Warnings</div>
              <div className="card-value warn">
                {stats.byLevel.WARN || 0}
              </div>
            </div>
            <div className="dashboard-card">
              <div className="card-label">Info</div>
              <div className="card-value">
                {stats.byLevel.INFO || 0}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Top Components */}
      {stats && stats.byComponent.length > 0 && (
        <div className="dashboard-section">
          <h2 className="dashboard-title">Top Components (by log count)</h2>
          <div className="dashboard-table">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Log Count</th>
                </tr>
              </thead>
              <tbody>
                {stats.byComponent.slice(0, 5).map((comp: any, idx: number) => (
                  <tr key={idx}>
                    <td className="component-cell">{comp.component}</td>
                    <td>{comp.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Errors */}
      {stats && stats.recentErrors.length > 0 && (
        <div className="dashboard-section">
          <h2 className="dashboard-title">Recent Errors</h2>
          <div className="dashboard-table">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Component</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentErrors.map((err: any) => (
                  <tr key={err.id}>
                    <td className="time-cell">
                      {new Date(err.createdAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </td>
                    <td className="component-cell">{err.component}</td>
                    <td className="error-message">
                      {err.message.substring(0, 80)}...
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* System Logs */}
      <div className="dashboard-section dashboard-fixed-height">
        <div className="dashboard-header">
          <div className="dashboard-title-group">
            <h2 className="dashboard-title">System Logs</h2>
            <div className="dashboard-subtitle">
              Source: system_logs table
            </div>
          </div>
          <div className="dashboard-filters">
            <input
              type="text"
              placeholder="Search logs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="filter-input"
            />
            <select
              value={componentFilter}
              onChange={(e) => setComponentFilter(e.target.value)}
              className="filter-select"
            >
              {uniqueComponents.map((comp) => (
                <option key={comp} value={comp}>
                  {comp === "ALL" ? "All Components" : comp}
                </option>
              ))}
            </select>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="filter-select"
            >
              <option value="ALL">All Levels</option>
              <option value="ERROR">Error</option>
              <option value="WARN">Warning</option>
              <option value="INFO">Info</option>
              <option value="DEBUG">Debug</option>
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
                  <th>Level</th>
                  <th>Component</th>
                  <th>Message</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length > 0 ? (
                  filteredLogs.map((log) => (
                    <tr
                      key={log.id}
                      onClick={() => {
                        setSelectedLog(log);
                        setShowLogModal(true);
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
                      <td>
                        <span
                          className={`status-badge ${getLevelColor(log.level)}`}
                        >
                          {log.level}
                        </span>
                      </td>
                      <td className="component-cell">{log.component}</td>
                      <td className="log-message">
                        {log.message.substring(0, 100)}
                        {log.message.length > 100 ? "..." : ""}
                      </td>
                      <td>
                        {log.strategyId && (
                          <span className="badge">Strategy</span>
                        )}
                        {log.orderId && <span className="badge">Order</span>}
                        {log.metadata && <span className="badge">Meta</span>}
                        {log.stackTrace && <span className="badge error">Stack</span>}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="empty-row">
                      No logs found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Log Detail Modal */}
      {showLogModal && selectedLog && (
        <div
          className="modal-overlay"
          onClick={() => setShowLogModal(false)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2 className="modal-title">Log Details</h2>
              <button
                className="modal-close"
                onClick={() => setShowLogModal(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-section">
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Level</div>
                    <div className="modal-value">
                      <span
                        className={`status-badge ${getLevelColor(selectedLog.level)}`}
                      >
                        {selectedLog.level}
                      </span>
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Component</div>
                    <div className="modal-value component-cell">
                      {selectedLog.component}
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
                <h3 className="modal-section-title">Message</h3>
                <div className="log-message-full">{selectedLog.message}</div>
              </div>

              {selectedLog.errorCode && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Error Code</h3>
                  <div className="modal-value error">{selectedLog.errorCode}</div>
                </div>
              )}

              {(selectedLog.strategyId || selectedLog.orderId) && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Related Entities</h3>
                  <div className="modal-row">
                    {selectedLog.strategyId && (
                      <div className="modal-field">
                        <div className="modal-label">Strategy ID</div>
                        <div className="modal-value audit-id">
                          {selectedLog.strategyId}
                        </div>
                      </div>
                    )}
                    {selectedLog.orderId && (
                      <div className="modal-field">
                        <div className="modal-label">Order ID</div>
                        <div className="modal-value audit-id">
                          {selectedLog.orderId}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedLog.metadata && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Metadata</h3>
                  <pre className="yaml-content">
                    <code>
                      {JSON.stringify(selectedLog.metadata, null, 2)}
                    </code>
                  </pre>
                </div>
              )}

              {selectedLog.stackTrace && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Stack Trace</h3>
                  <pre className="stack-trace">
                    <code>{selectedLog.stackTrace}</code>
                  </pre>
                </div>
              )}

              <div className="modal-section">
                <h3 className="modal-section-title">Log ID</h3>
                <div className="modal-value audit-id">{selectedLog.id}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
