"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AcpClient } from "../src/lib/acpClient";
import { AuditLogsViewer } from "./components/AuditLogsViewer";
import { LogsViewer } from "./components/LogsViewer";

type ChatMessage = {
  role: "user" | "agent";
  content: string;
  images?: { data: string; mimeType: string }[];
};

const mergeChunk = (current: string, chunk: string) => {
  if (!chunk) return current;
  if (!current) return chunk;
  if (current.endsWith(chunk)) return current;
  const maxOverlap = Math.min(current.length, chunk.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.slice(-size) === chunk.slice(0, size)) {
      return current + chunk.slice(size);
    }
  }
  return current + chunk;
};

let sharedClient: AcpClient | null = null;

const getClient = (
  onChunk: (chunk: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
  onSession: (sessionId: string) => void
) => {
  if (!sharedClient) {
    sharedClient = new AcpClient(onChunk, onDone, onError, onSession);
  } else {
    sharedClient.setHandlers(onChunk, onDone, onError, onSession);
  }
  return sharedClient;
};

export default function HomePage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "dashboard" | "logs" | "audit">("chat");
  const [attachedImages, setAttachedImages] = useState<
    { data: string; mimeType: string }[]
  >([]);
  const [isDragging, setIsDragging] = useState(false);
  const gatewayUrl = process.env.NEXT_PUBLIC_ACP_URL;
  const persona = "blackrock_advisor";
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const userJustSentMessageRef = useRef(false);
  const hasConnectedRef = useRef(false);

  const client = useMemo(() => {
    return getClient(
      (chunk) => {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === "agent") {
            last.content = mergeChunk(last.content, chunk);
            return copy;
          }
          return [...copy, { role: "agent", content: chunk }];
        });
      },
      () => {
        setStatus("ready");
      },
      (error) => {
        setStatus("error");
        console.error(error);
      },
      (id) => {
        setSessionId(id);
        setStatus("ready");
      }
    );
  }, []);

  useEffect(() => {
    if (!gatewayUrl) {
      setStatus("missing_url");
      return;
    }

    // Prevent double connection in StrictMode
    if (hasConnectedRef.current) {
      console.log("[HomePage] Already connected, skipping effect");
      return;
    }

    const url = new URL(gatewayUrl);
    url.searchParams.set("persona", persona);

    // Check if we have a stored session
    const storedSessionId = localStorage.getItem("acp_session_id");

    console.log("[HomePage] Initiating connection, storedSession:", storedSessionId);
    hasConnectedRef.current = true;

    setStatus("connecting");
    client.connect(url.toString());

    // Always start session on page load
    // If reconnecting to an existing session, the gateway will handle it
    // If session is dead, this creates a new one
    const defaultCwd = process.env.NEXT_PUBLIC_ACP_CWD || "/Users/pradeeptadash/sandbox";
    client.startSession(defaultCwd);

    // Cleanup function - only reset on actual unmount
    return () => {
      console.log("[HomePage] Effect cleanup - component unmounting");
      hasConnectedRef.current = false;
    };
  }, [client, gatewayUrl]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const scrollDistanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      const isNearBottom = scrollDistanceFromBottom < 200;
      if (isNearBottom) {
        setShowScrollButton(false);
      }
    };
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    const endElement = messagesEndRef.current;
    if (!container || !endElement) return;

    const isNewMessage = messages.length > prevMessagesLengthRef.current;
    const isMessageUpdate =
      messages.length === prevMessagesLengthRef.current && messages.length > 0;
    const isFirstMessage = prevMessagesLengthRef.current === 0 && messages.length > 0;
    prevMessagesLengthRef.current = messages.length;

    const scrollDistanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = scrollDistanceFromBottom < 200;

    const shouldScroll =
      isFirstMessage ||
      userJustSentMessageRef.current ||
      isNearBottom ||
      isMessageUpdate;

    if (shouldScroll) {
      requestAnimationFrame(() => {
        endElement.scrollIntoView({ behavior: isFirstMessage ? "instant" : "smooth" });
      });
      setShowScrollButton(false);
      if (status !== "streaming" && userJustSentMessageRef.current) {
        userJustSentMessageRef.current = false;
      }
    } else if (isNewMessage) {
      setShowScrollButton(true);
      userJustSentMessageRef.current = false;
    }
  }, [messages, status]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(
      textareaRef.current.scrollHeight,
      200
    )}px`;
  }, [input]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text && attachedImages.length === 0) return;
    userJustSentMessageRef.current = true;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, images: attachedImages },
    ]);
    setInput("");
    setStatus("streaming");
    client.sendPrompt(text, attachedImages);
    setAttachedImages([]);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
    const files = Array.from(event.dataTransfer.files);
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const newImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<{ data: string; mimeType: string }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(",")[1];
              resolve({ data: base64, mimeType: file.type });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );
    setAttachedImages((prev) => [...prev, ...newImages]);
  };

  const removeImage = (index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleNewSession = () => {
    if (typeof window !== "undefined") {
      // Clear session cookies
      window.localStorage.removeItem("acp_gateway_session_id");
      window.localStorage.removeItem("acp_agent_session_id");
      // Reload the page
      window.location.reload();
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-title">Trade•with•Claude</div>
        <div className="topbar-tabs">
          <button
            className={`tab-button ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </button>
          <button
            className={`tab-button ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={`tab-button ${activeTab === "audit" ? "active" : ""}`}
            onClick={() => setActiveTab("audit")}
          >
            Audit Logs
          </button>
          <button
            className={`tab-button ${activeTab === "logs" ? "active" : ""}`}
            onClick={() => setActiveTab("logs")}
          >
            System Logs
          </button>
        </div>
        <div className="topbar-status">
          Status: {status}
          {sessionId ? ` | Session: ${sessionId}` : ""}
        </div>
        <button className="new-session-button" onClick={handleNewSession}>
          New Session
        </button>
      </header>

      {activeTab === "chat" && (
      <section className="chat-shell">
        <div className="messages" ref={messagesContainerRef}>
          {messages.length === 0 && (
            <div className="empty-state">Start a conversation…</div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className={`message ${msg.role}`}>
              {msg.images && msg.images.length > 0 && (
                <div className="message-images">
                  {msg.images.map((img, imageIdx) => (
                    <img
                      key={imageIdx}
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt="Attachment"
                    />
                  ))}
                </div>
              )}
              <div className="message-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
              </div>
            </div>
          ))}
          {status === "streaming" && messages[messages.length - 1]?.role === "user" && (
            <div className="message agent typing-indicator">
              <div className="typing-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {showScrollButton && (
          <button className="scroll-button" onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })}>
            Jump to latest
          </button>
        )}

        <div className="composer">
          <div
            className={`composer-inner ${
              isDragging ? "composer-dragging" : ""
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {attachedImages.length > 0 && (
              <div className="composer-images">
                {attachedImages.map((img, imageIdx) => (
                  <div key={imageIdx} className="composer-image">
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt="Preview"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(imageIdx)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message the advisor..."
              rows={1}
            />
            <label className="composer-attach">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={async (event) => {
                  if (!event.target.files) return;
                  const files = Array.from(event.target.files);
                  const imageFiles = files.filter((file) =>
                    file.type.startsWith("image/")
                  );
                  if (!imageFiles.length) return;
                  const newImages = await Promise.all(
                    imageFiles.map(
                      (file) =>
                        new Promise<{ data: string; mimeType: string }>(
                          (resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () => {
                              const base64 = (reader.result as string).split(
                                ","
                              )[1];
                              resolve({ data: base64, mimeType: file.type });
                            };
                            reader.onerror = reject;
                            reader.readAsDataURL(file);
                          }
                        )
                    )
                  );
                  setAttachedImages((prev) => [...prev, ...newImages]);
                  event.target.value = "";
                }}
              />
              +
            </label>
            <button
              onClick={sendMessage}
              disabled={
                status === "connecting" ||
                status === "missing_url" ||
                (!input.trim() && attachedImages.length === 0)
              }
            >
              Send
            </button>
          </div>
          <div className="composer-hint">
            Press Enter to send • Shift+Enter for a new line
          </div>
        </div>
        </section>
      )}

      {activeTab === "dashboard" && (
        <section className="chat-shell">
          <Dashboard />
        </section>
      )}

      {activeTab === "audit" && (
        <section className="chat-shell">
          <AuditLogsViewer />
        </section>
      )}

      {activeTab === "logs" && (
        <section className="chat-shell">
          <LogsViewer />
        </section>
      )}
    </div>
  );
}

// Dashboard Component
function Dashboard() {
  const [portfolioData, setPortfolioData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter states
  const [strategyStatusFilter, setStrategyStatusFilter] = useState<string>('ALL');
  const [tradeStatusFilter, setTradeStatusFilter] = useState<string>('ALL');
  const [symbolFilter, setSymbolFilter] = useState<string>('');

  // Modal states
  const [selectedStrategy, setSelectedStrategy] = useState<any>(null);
  const [showStrategyModal, setShowStrategyModal] = useState(false);
  const [selectedAuditLog, setSelectedAuditLog] = useState<any>(null);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showReopenModal, setShowReopenModal] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [isClosing, setIsClosing] = useState(false);
  const [isReopening, setIsReopening] = useState(false);

  // Backtest states
  const [backtestResult, setBacktestResult] = useState<any>(null);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  // Notification state
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Evaluation error state
  const [evaluationErrors, setEvaluationErrors] = useState<any[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const response = await fetch('http://localhost:3002/api/portfolio/overview');
        if (!response.ok) throw new Error('Failed to fetch portfolio data');
        const data = await response.json();
        setPortfolioData(data);
        setError(null);
      } catch (err: any) {
        setError(err.message || 'Failed to load portfolio data');
        console.error('Portfolio fetch error:', err);
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
        const response = await fetch('http://localhost:3002/api/logs?component=StrategyEvaluator&level=ERROR&limit=10');
        if (response.ok) {
          const data = await response.json();
          setEvaluationErrors(data.logs || []);
        }
      } catch (err) {
        console.error('Failed to fetch evaluation errors:', err);
      }
    };

    fetchEvaluationErrors();
    const interval = setInterval(fetchEvaluationErrors, 15000); // Refresh every 15s
    return () => clearInterval(interval);
  }, []);

  // Close strategy handler
  const handleCloseStrategy = async () => {
    if (!selectedStrategy || !closeReason.trim()) {
      setNotification({ type: 'error', message: 'Please provide a reason for closing the strategy' });
      return;
    }

    setIsClosing(true);
    try {
      const response = await fetch(`http://localhost:3002/api/portfolio/strategies/${selectedStrategy.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: closeReason }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to close strategy');
      }

      // Success - show notification and refresh data
      setNotification({ type: 'success', message: `Strategy "${selectedStrategy.name}" closed successfully` });
      setShowCloseModal(false);
      setShowStrategyModal(false);
      setCloseReason('');

      // Refresh portfolio data
      const refreshResponse = await fetch('http://localhost:3002/api/portfolio/overview');
      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        setPortfolioData(refreshData);
      }
    } catch (error: any) {
      setNotification({ type: 'error', message: error.message || 'Failed to close strategy' });
    } finally {
      setIsClosing(false);
    }
  };

  // Reopen strategy handler
  const handleReopenStrategy = async () => {
    if (!selectedStrategy || !reopenReason.trim()) {
      setNotification({ type: 'error', message: 'Please provide a reason for reopening the strategy' });
      return;
    }

    setIsReopening(true);
    try {
      const response = await fetch(`http://localhost:3002/api/portfolio/strategies/${selectedStrategy.id}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reopenReason }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to reopen strategy');
      }

      // Success - show notification and refresh data
      setNotification({ type: 'success', message: `Strategy "${selectedStrategy.name}" reopened successfully. Status: PENDING` });
      setShowReopenModal(false);
      setShowStrategyModal(false);
      setReopenReason('');

      // Refresh portfolio data
      const refreshResponse = await fetch('http://localhost:3002/api/portfolio/overview');
      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        setPortfolioData(refreshData);
      }
    } catch (error: any) {
      setNotification({ type: 'error', message: error.message || 'Failed to reopen strategy' });
    } finally {
      setIsReopening(false);
    }
  };

  // Backtest handler
  const handleRunBacktest = async () => {
    if (!selectedStrategy) return;

    setIsBacktesting(true);
    setBacktestError(null);
    setBacktestResult(null);

    try {
      const response = await fetch(`http://localhost:3002/api/portfolio/strategies/${selectedStrategy.id}/backtest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to run backtest');
      }

      const data = await response.json();
      setBacktestResult(data.backtest);
      setNotification({ type: 'success', message: 'Backtest completed successfully' });
    } catch (error: any) {
      setBacktestError(error.message || 'Failed to run backtest');
      setNotification({ type: 'error', message: error.message || 'Failed to run backtest' });
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
        <div style={{ marginTop: '12px', color: '#737373' }}>Loading portfolio data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-error">
        <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>Unable to Load Dashboard</div>
        <div style={{ fontSize: '14px', color: '#737373' }}>{error}</div>
        <div style={{ fontSize: '12px', color: '#737373', marginTop: '12px' }}>
          Make sure the portfolio API server is running: npm run portfolio:api:dev
        </div>
      </div>
    );
  }

  const { pnl, strategies, recentTrades, orderStats, auditTrail } = portfolioData || {};

  // Filter strategies
  const filteredStrategies = strategies?.filter((strategy: any) => {
    const matchesStatus = strategyStatusFilter === 'ALL' || strategy.status === strategyStatusFilter;
    const matchesSymbol = !symbolFilter || strategy.symbol.toLowerCase().includes(symbolFilter.toLowerCase());
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
    const aTime = getStrategyTimestamp(a) ? new Date(getStrategyTimestamp(a)).getTime() : 0;
    const bTime = getStrategyTimestamp(b) ? new Date(getStrategyTimestamp(b)).getTime() : 0;
    return bTime - aTime;
  });

  // Filter trades
  const filteredTrades = recentTrades?.filter((trade: any) => {
    const matchesStatus = tradeStatusFilter === 'ALL' || trade.status === tradeStatusFilter;
    const matchesSymbol = !symbolFilter || trade.symbol.toLowerCase().includes(symbolFilter.toLowerCase());
    return matchesStatus && matchesSymbol;
  }) || [];

  return (
    <div className="dashboard">
      {/* Evaluation Error Banner */}
      {evaluationErrors.length > 0 && (
        <div style={{
          background: '#fee',
          border: '1px solid #fcc',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '20px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '20px', marginRight: '8px' }}>⚠️</span>
            <strong style={{ fontSize: '16px', color: '#c00' }}>Strategy Evaluation Errors</strong>
          </div>
          {evaluationErrors.slice(0, 3).map((error: any, idx: number) => (
            <div key={idx} style={{
              fontSize: '14px',
              color: '#666',
              marginTop: '8px',
              paddingLeft: '28px',
            }}>
              <strong>{error.metadata?.symbol || 'Unknown'}:</strong> {error.metadata?.reason || error.message}
              <span style={{ color: '#999', marginLeft: '8px', fontSize: '12px' }}>
                {new Date(error.createdAt).toLocaleTimeString()}
              </span>
            </div>
          ))}
          {evaluationErrors.length > 3 && (
            <div style={{ fontSize: '12px', color: '#999', marginTop: '8px', paddingLeft: '28px' }}>
              +{evaluationErrors.length - 3} more errors. Check System Logs tab for details.
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
            <div className={`card-value ${(pnl?.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}`}>
              ${pnl?.realizedPnL?.toFixed(2) || '0.00'}
            </div>
          </div>
          <div className="dashboard-card">
            <div className="card-label">Open Positions</div>
            <div className="card-value">{pnl?.totalPositions || 0}</div>
          </div>
          <div className="dashboard-card">
            <div className="card-label">Active Strategies</div>
            <div className="card-value">{strategies?.filter((s: any) => s.status === 'ACTIVE').length || 0}</div>
          </div>
          <div className="dashboard-card">
            <div className="card-label">Total Orders</div>
            <div className="card-value">
              {Object.values(orderStats || {}).reduce((a: number, b: unknown) => a + (b as number), 0)}
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
                          <span className={`status-badge ${strategy.status.toLowerCase()}`}>
                            {strategy.status}
                          </span>
                        </td>
                        <td className="time-cell">
                          {getStrategyTimestamp(strategy)
                            ? new Date(getStrategyTimestamp(strategy)).toLocaleString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : '-'}
                        </td>
                        <td>{strategy.totalTrades}</td>
                        <td>{strategy.winRate.toFixed(1)}%</td>
                        <td className={strategy.totalPnL >= 0 ? 'positive' : 'negative'}>
                          ${strategy.totalPnL.toFixed(2)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="empty-row">No strategies match the filter</td>
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
                          {trade.filledAt ? new Date(trade.filledAt).toLocaleString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          }) : '-'}
                        </td>
                        <td className="strategy-cell">{trade.strategyName}</td>
                        <td className="symbol-cell">{trade.symbol}</td>
                        <td>
                          <span className={`side-badge ${trade.side.toLowerCase()}`}>
                            {trade.side}
                          </span>
                        </td>
                        <td>{trade.qty}</td>
                        <td>${trade.price?.toFixed(2) || '-'}</td>
                        <td>
                          <span className={`status-badge ${trade.status.toLowerCase()}`}>
                            {trade.status}
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="empty-row">No trades match the filter</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {(!strategies || strategies.length === 0) && (!recentTrades || recentTrades.length === 0) && (
        <div className="dashboard-empty">
          <div style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>No Trading Data Yet</div>
          <div style={{ fontSize: '14px', color: '#737373' }}>
            Start trading strategies to see portfolio metrics and performance data here.
          </div>
        </div>
      )}

      {/* Strategy Detail Modal */}
      {showStrategyModal && selectedStrategy && (
        <div className="modal-overlay" onClick={() => setShowStrategyModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">{selectedStrategy.name}</h2>
              <button className="modal-close" onClick={() => setShowStrategyModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-section">
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Symbol</div>
                    <div className="modal-value symbol-cell">{selectedStrategy.symbol}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Status</div>
                    <div className="modal-value">
                      <span className={`status-badge ${selectedStrategy.status.toLowerCase()}`}>
                        {selectedStrategy.status}
                      </span>
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Timeframe</div>
                    <div className="modal-value">{selectedStrategy.timeframe}</div>
                  </div>
                </div>
              </div>

              <div className="modal-section">
                <h3 className="modal-section-title">Performance Metrics</h3>
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Total Trades</div>
                    <div className="modal-value">{selectedStrategy.totalTrades}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Wins / Losses</div>
                    <div className="modal-value">{selectedStrategy.wins} / {selectedStrategy.losses}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Win Rate</div>
                    <div className="modal-value">{selectedStrategy.winRate.toFixed(1)}%</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Total P&L</div>
                    <div className={`modal-value ${selectedStrategy.totalPnL >= 0 ? 'positive' : 'negative'}`}>
                      ${selectedStrategy.totalPnL.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              {selectedStrategy.latestRecommendation && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Latest Recommendation</h3>
                  <div className="modal-value">
                    <span className={`status-badge ${selectedStrategy.latestRecommendation.toLowerCase()}`}>
                      {selectedStrategy.latestRecommendation}
                    </span>
                  </div>
                </div>
              )}

              {selectedStrategy.activatedAt && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Timeline</h3>
                  <div className="modal-field">
                    <div className="modal-label">Activated At</div>
                    <div className="modal-value">
                      {new Date(selectedStrategy.activatedAt).toLocaleString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </div>
                  </div>
                </div>
              )}

              {selectedStrategy.yamlContent && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Strategy Configuration</h3>
                  <pre className="yaml-content">
                    <code>{selectedStrategy.yamlContent}</code>
                  </pre>
                </div>
              )}

              {/* Backtest Section */}
              <div className="modal-section">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <h3 className="modal-section-title" style={{ margin: 0 }}>Backtest (Last 180 Bars)</h3>
                  <button
                    className="backtest-button"
                    onClick={handleRunBacktest}
                    disabled={isBacktesting}
                    style={{
                      padding: '8px 16px',
                      backgroundColor: isBacktesting ? '#d4d4d4' : '#f55036',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '14px',
                      fontWeight: 600,
                      cursor: isBacktesting ? 'not-allowed' : 'pointer',
                      transition: 'background-color 0.2s',
                    }}
                  >
                    {isBacktesting ? 'Running...' : 'Run Backtest'}
                  </button>
                </div>

                {backtestError && (
                  <div style={{
                    padding: '12px',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: '6px',
                    color: '#991b1b',
                    fontSize: '14px',
                  }}>
                    {backtestError}
                  </div>
                )}

                {backtestResult && (
                  <div className="backtest-results">
                    <div className="modal-row" style={{ marginBottom: '16px' }}>
                      <div className="modal-field">
                        <div className="modal-label">Bars Processed</div>
                        <div className="modal-value">{backtestResult.barsProcessed}</div>
                      </div>
                      <div className="modal-field">
                        <div className="modal-label">Final State</div>
                        <div className="modal-value">
                          <span className={`status-badge ${backtestResult.finalState.toLowerCase()}`}>
                            {backtestResult.finalState}
                          </span>
                        </div>
                      </div>
                      <div className="modal-field">
                        <div className="modal-label">Price Change</div>
                        <div className={`modal-value ${backtestResult.priceChangePercent >= 0 ? 'positive' : 'negative'}`}>
                          {backtestResult.priceChangePercent >= 0 ? '+' : ''}{backtestResult.priceChangePercent.toFixed(2)}%
                        </div>
                      </div>
                    </div>

                    <div className="modal-row" style={{ marginBottom: '16px' }}>
                      <div className="modal-field">
                        <div className="modal-label">Total Trades</div>
                        <div className="modal-value">{backtestResult.totalTrades}</div>
                      </div>
                      <div className="modal-field">
                        <div className="modal-label">Win Rate</div>
                        <div className="modal-value">{backtestResult.winRate.toFixed(1)}%</div>
                      </div>
                      <div className="modal-field">
                        <div className="modal-label">Realized P&L</div>
                        <div className={`modal-value ${backtestResult.realizedPnL >= 0 ? 'positive' : 'negative'}`}>
                          ${backtestResult.realizedPnL.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    <div className="modal-row" style={{ marginBottom: '16px' }}>
                      <div className="modal-field">
                        <div className="modal-label">Orders Placed</div>
                        <div className="modal-value">{backtestResult.ordersPlaced}</div>
                      </div>
                      <div className="modal-field">
                        <div className="modal-label">Orders Filled</div>
                        <div className="modal-value">{backtestResult.ordersFilled}</div>
                      </div>
                      <div className="modal-field">
                        <div className="modal-label">Stop Loss Hits</div>
                        <div className="modal-value" style={{ color: backtestResult.stopLossHits > 0 ? '#dc2626' : 'inherit' }}>
                          {backtestResult.stopLossHits}
                        </div>
                      </div>
                    </div>

                    {backtestResult.invalidations > 0 && (
                      <div style={{
                        padding: '12px',
                        backgroundColor: '#fef9c3',
                        border: '1px solid #fde047',
                        borderRadius: '6px',
                        marginBottom: '16px',
                      }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', color: '#854d0e' }}>
                          Invalidations: {backtestResult.invalidations}
                        </div>
                        <div style={{ fontSize: '13px', color: '#a16207' }}>
                          {backtestResult.invalidationReasons.map((reason: string, idx: number) => (
                            <div key={idx} style={{ marginBottom: '4px' }}>• {reason}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {backtestResult.stateTransitions.length > 0 && (
                      <div>
                        <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '14px' }}>
                          State Transitions ({backtestResult.stateTransitions.length})
                        </div>
                        <div style={{
                          maxHeight: '200px',
                          overflowY: 'auto',
                          border: '1px solid #ebe6dd',
                          borderRadius: '6px',
                          padding: '8px',
                          fontSize: '13px',
                        }}>
                          {backtestResult.stateTransitions.map((transition: any, idx: number) => (
                            <div key={idx} style={{
                              padding: '6px',
                              borderBottom: idx < backtestResult.stateTransitions.length - 1 ? '1px solid #f5f5f4' : 'none',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <div>
                                  <span style={{ fontWeight: 600 }}>Bar {transition.bar}:</span>{' '}
                                  <span className={`status-badge ${transition.from.toLowerCase()}`} style={{ fontSize: '11px', padding: '2px 6px' }}>
                                    {transition.from}
                                  </span>
                                  {' → '}
                                  <span className={`status-badge ${transition.to.toLowerCase()}`} style={{ fontSize: '11px', padding: '2px 6px' }}>
                                    {transition.to}
                                  </span>
                                </div>
                                <div style={{ color: '#737373' }}>
                                  ${transition.price.toFixed(2)}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Modal Actions Footer */}
            {selectedStrategy.status === 'ACTIVE' && (
              <div className="modal-footer">
                <button
                  className="close-strategy-button"
                  onClick={() => {
                    setShowCloseModal(true);
                  }}
                >
                  Close Strategy
                </button>
              </div>
            )}
            {selectedStrategy.status === 'CLOSED' && (
              <div className="modal-footer">
                <button
                  className="reopen-strategy-button"
                  onClick={() => {
                    setShowReopenModal(true);
                  }}
                >
                  Reopen Strategy
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Audit Trail Detail Modal */}
      {showAuditModal && selectedAuditLog && (
        <div className="modal-overlay" onClick={() => setShowAuditModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Audit Log Details</h2>
              <button className="modal-close" onClick={() => setShowAuditModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-section">
                <div className="modal-row">
                  <div className="modal-field">
                    <div className="modal-label">Event Type</div>
                    <div className="modal-value">
                      <span className={`status-badge ${selectedAuditLog.eventType.toLowerCase()}`}>
                        {selectedAuditLog.eventType}
                      </span>
                    </div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Timestamp</div>
                    <div className="modal-value">
                      {new Date(selectedAuditLog.createdAt).toLocaleString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
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
                    <div className="modal-value">{selectedAuditLog.strategyName}</div>
                  </div>
                  <div className="modal-field">
                    <div className="modal-label">Symbol</div>
                    <div className="modal-value symbol-cell">{selectedAuditLog.symbol}</div>
                  </div>
                </div>
              </div>

              {(selectedAuditLog.orderId || selectedAuditLog.brokerOrderId) && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Order Information</h3>
                  <div className="modal-row">
                    {selectedAuditLog.orderId && (
                      <div className="modal-field">
                        <div className="modal-label">Order ID</div>
                        <div className="modal-value audit-id">{selectedAuditLog.orderId}</div>
                      </div>
                    )}
                    {selectedAuditLog.brokerOrderId && (
                      <div className="modal-field">
                        <div className="modal-label">Broker Order ID</div>
                        <div className="modal-value audit-id">{selectedAuditLog.brokerOrderId}</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(selectedAuditLog.oldStatus || selectedAuditLog.newStatus) && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Status Change</h3>
                  <div className="modal-row">
                    {selectedAuditLog.oldStatus && (
                      <div className="modal-field">
                        <div className="modal-label">Old Status</div>
                        <div className="modal-value">
                          <span className={`status-badge ${selectedAuditLog.oldStatus.toLowerCase()}`}>
                            {selectedAuditLog.oldStatus}
                          </span>
                        </div>
                      </div>
                    )}
                    {selectedAuditLog.newStatus && (
                      <div className="modal-field">
                        <div className="modal-label">New Status</div>
                        <div className="modal-value">
                          <span className={`status-badge ${selectedAuditLog.newStatus.toLowerCase()}`}>
                            {selectedAuditLog.newStatus}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(selectedAuditLog.quantity || selectedAuditLog.price) && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Trade Details</h3>
                  <div className="modal-row">
                    {selectedAuditLog.quantity && (
                      <div className="modal-field">
                        <div className="modal-label">Quantity</div>
                        <div className="modal-value">{selectedAuditLog.quantity}</div>
                      </div>
                    )}
                    {selectedAuditLog.price && (
                      <div className="modal-field">
                        <div className="modal-label">Price</div>
                        <div className="modal-value">${selectedAuditLog.price.toFixed(2)}</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedAuditLog.errorMessage && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Error Message</h3>
                  <div className="error-message-full">
                    {selectedAuditLog.errorMessage}
                  </div>
                </div>
              )}

              {selectedAuditLog.metadata && (
                <div className="modal-section">
                  <h3 className="modal-section-title">Metadata</h3>
                  <pre className="yaml-content">
                    <code>{JSON.stringify(selectedAuditLog.metadata, null, 2)}</code>
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Close Strategy Confirmation Modal */}
      {showCloseModal && selectedStrategy && (
        <div className="modal-overlay" onClick={() => setShowCloseModal(false)}>
          <div className="modal-content modal-small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Close Strategy</h2>
              <button className="modal-close" onClick={() => setShowCloseModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-section">
                <p style={{ marginBottom: '16px', color: '#737373' }}>
                  You are about to close <strong>{selectedStrategy.name}</strong> ({selectedStrategy.symbol}).
                  This action will stop all trading activity for this strategy.
                </p>
                <div className="modal-field">
                  <div className="modal-label">Reason for closing *</div>
                  <textarea
                    className="close-reason-input"
                    placeholder="Enter reason (e.g., Market conditions unfavorable, Risk limit reached, etc.)"
                    value={closeReason}
                    onChange={(e) => setCloseReason(e.target.value)}
                    rows={3}
                    disabled={isClosing}
                  />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="modal-button cancel-button"
                onClick={() => {
                  setShowCloseModal(false);
                  setCloseReason('');
                }}
                disabled={isClosing}
              >
                Cancel
              </button>
              <button
                className="modal-button confirm-close-button"
                onClick={handleCloseStrategy}
                disabled={isClosing || !closeReason.trim()}
              >
                {isClosing ? 'Closing...' : 'Close Strategy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reopen Strategy Confirmation Modal */}
      {showReopenModal && selectedStrategy && (
        <div className="modal-overlay" onClick={() => setShowReopenModal(false)}>
          <div className="modal-content modal-small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Reopen Strategy</h2>
              <button className="modal-close" onClick={() => setShowReopenModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-section">
                <p style={{ marginBottom: '16px', color: '#737373' }}>
                  You are about to reopen <strong>{selectedStrategy.name}</strong> ({selectedStrategy.symbol}).
                  The strategy will be set to PENDING status and the orchestrator will automatically activate it.
                </p>
                <div className="modal-field">
                  <div className="modal-label">Reason for reopening *</div>
                  <textarea
                    className="reopen-reason-input"
                    placeholder="Enter reason (e.g., Market conditions improved, Strategy adjustments made, etc.)"
                    value={reopenReason}
                    onChange={(e) => setReopenReason(e.target.value)}
                    rows={3}
                    disabled={isReopening}
                  />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="modal-button cancel-button"
                onClick={() => {
                  setShowReopenModal(false);
                  setReopenReason('');
                }}
                disabled={isReopening}
              >
                Cancel
              </button>
              <button
                className="modal-button confirm-reopen-button"
                onClick={handleReopenStrategy}
                disabled={isReopening || !reopenReason.trim()}
              >
                {isReopening ? 'Reopening...' : 'Reopen Strategy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notification Banner */}
      {notification && (
        <div className={`notification ${notification.type}`}>
          <span>{notification.message}</span>
          <button className="notification-close" onClick={() => setNotification(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
