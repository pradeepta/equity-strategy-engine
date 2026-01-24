"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { AcpClient } from "../src/lib/acpClient";
import { mergeChunk, formatToolMessage, type ToolEvent } from "../src/lib/chatUtils";
import { MessageComponent, type ChatMessage } from "./components/MessageComponent";
import { AuditLogsViewer } from "./components/AuditLogsViewer";
import { LogsViewer } from "./components/LogsViewer";
import {
  ChatHistorySidebar,
  ChatSession,
} from "./components/ChatHistorySidebar";
import TradeCheckModal from "./components/TradeCheckModal";
import { createStrategyPrompt } from "../src/lib/tradeCheckMapper";
import type {
  TradeCheckAnalysis,
  MarketRegime,
} from "../src/lib/tradeCheckClient";
import { Dashboard } from "./components/Dashboard";

const API_BASE = "http://localhost:3002";

let sharedClient: AcpClient | null = null;

const getClient = (
  onChunk: (chunk: string) => void,
  onDone: () => void,
  onError: (message: string) => void,
  onSession: (sessionId: string) => void,
  onTool: (event: ToolEvent) => void,
) => {
  if (!sharedClient) {
    sharedClient = new AcpClient(onChunk, onDone, onError, onSession, onTool);
  } else {
    sharedClient.setHandlers(onChunk, onDone, onError, onSession, onTool);
  }
  return sharedClient;
};

export default function HomePage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "chat" | "dashboard" | "logs" | "audit"
  >("chat");
  const [attachedImages, setAttachedImages] = useState<
    { data: string; mimeType: string }[]
  >([]);
  const [isDragging, setIsDragging] = useState(false);

  // Chat history state
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [currentChatSessionId, setCurrentChatSessionId] = useState<
    string | null
  >(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isViewingOldChat, setIsViewingOldChat] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // TradeCheck modal state
  const [showTradeCheckModal, setShowTradeCheckModal] = useState(false);

  const gatewayUrl = process.env.NEXT_PUBLIC_ACP_URL;
  const persona = "blackrock_advisor";
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevMessagesLengthRef = useRef(messages.length);
  const userJustSentMessageRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const currentChatSessionIdRef = useRef<string | null>(null);
  const pendingAgentMessageRef = useRef<string>("");

  const client = useMemo(() => {
    return getClient(
      (chunk) => {
        // Track the full agent message for saving
        pendingAgentMessageRef.current = mergeChunk(
          pendingAgentMessageRef.current,
          chunk,
        );

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
      async () => {
        setStatus("ready");

        // Save the complete agent response to database
        const sessionId = currentChatSessionIdRef.current;
        const agentMessage = pendingAgentMessageRef.current;
        if (sessionId && agentMessage) {
          try {
            await fetch(`${API_BASE}/api/chat/sessions/${sessionId}/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role: "AGENT", content: agentMessage }),
            });
            // Refresh sessions to update lastMessageAt
            fetchChatSessions();
          } catch (error) {
            console.error("[Chat] Failed to save agent message:", error);
          }
        }
        pendingAgentMessageRef.current = "";
      },
      (error) => {
        setStatus("error");
        console.error(error);
        pendingAgentMessageRef.current = "";
      },
      (id) => {
        setSessionId(id);
        setStatus("ready");
      },
      (event) => {
        setMessages((prev) => [
          ...prev,
          {
            role: "tool",
            content: formatToolMessage(event),
            toolMeta: {
              kind: event.kind,
              name: event.name,
              isError: event.isError,
            },
          },
        ]);
      },
    );
  }, []);

  // Keep ref in sync with state
  useEffect(() => {
    currentChatSessionIdRef.current = currentChatSessionId;
  }, [currentChatSessionId]);

  // Chat history functions
  const fetchChatSessions = useCallback(async () => {
    setIsLoadingHistory(true);
    try {
      const response = await fetch(`${API_BASE}/api/chat/sessions`);
      if (response.ok) {
        const data = await response.json();
        setChatSessions(data.sessions);
      }
    } catch (error) {
      console.error("[Chat] Failed to fetch sessions:", error);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  const createChatSession = useCallback(async (): Promise<string | null> => {
    try {
      const gatewaySessionId = localStorage.getItem("acp_gateway_session_id");
      const agentSessionId = localStorage.getItem("acp_agent_session_id");

      const response = await fetch(`${API_BASE}/api/chat/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gatewaySessionId, agentSessionId }),
      });

      if (response.ok) {
        const data = await response.json();
        localStorage.setItem("chat_session_id", data.session.id);
        setCurrentChatSessionId(data.session.id);
        return data.session.id;
      }
    } catch (error) {
      console.error("[Chat] Failed to create session:", error);
    }
    return null;
  }, []);

  const loadChatSession = useCallback(async (chatSessionId: string) => {
    try {
      const response = await fetch(
        `${API_BASE}/api/chat/sessions/${chatSessionId}?includeMessages=true`,
      );

      if (response.ok) {
        const data = await response.json();
        // Convert DB messages to frontend format
        const loadedMessages: ChatMessage[] = data.session.messages.map(
          (msg: any) => ({
            role: msg.role.toLowerCase() as "user" | "agent",
            content: msg.content,
            imageUrls: msg.imageUrls || [],
          }),
        );
        setMessages(loadedMessages);
        setCurrentChatSessionId(chatSessionId);
        setIsViewingOldChat(true); // Mark as viewing old chat
        localStorage.setItem("chat_session_id", chatSessionId);
      }
    } catch (error) {
      console.error("[Chat] Failed to load session:", error);
    }
  }, []);

  const saveMessage = useCallback(
    async (
      chatSessionId: string,
      role: "USER" | "AGENT",
      content: string,
      images?: { data: string; mimeType: string }[],
    ) => {
      try {
        await fetch(`${API_BASE}/api/chat/sessions/${chatSessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, content, images }),
        });
      } catch (error) {
        console.error("[Chat] Failed to save message:", error);
      }
    },
    [],
  );

  const handleNewSession = useCallback(() => {
    // Clear current state
    setMessages([]);
    setCurrentChatSessionId(null);
    setIsViewingOldChat(false);
    localStorage.removeItem("chat_session_id");

    // Force new ACP session
    if (typeof window !== "undefined") {
      localStorage.removeItem("acp_gateway_session_id");
      localStorage.removeItem("acp_agent_session_id");
      window.location.reload();
    }
  }, []);

  const handleDeleteChat = useCallback(
    async (chatSessionId: string) => {
      try {
        await fetch(`${API_BASE}/api/chat/sessions/${chatSessionId}`, {
          method: "DELETE",
        });

        // If deleted current chat, start fresh
        if (chatSessionId === currentChatSessionId) {
          setMessages([]);
          setCurrentChatSessionId(null);
          localStorage.removeItem("chat_session_id");
        }

        // Refresh sidebar
        fetchChatSessions();
      } catch (error) {
        console.error("[Chat] Failed to delete session:", error);
      }
    },
    [currentChatSessionId, fetchChatSessions],
  );

  const handleRenameSession = useCallback(
    async (chatSessionId: string, newTitle: string) => {
      try {
        await fetch(`${API_BASE}/api/chat/sessions/${chatSessionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle }),
        });

        // Refresh sidebar to show new title
        fetchChatSessions();
      } catch (error) {
        console.error("[Chat] Failed to rename session:", error);
      }
    },
    [fetchChatSessions],
  );

  const handleSearch = useCallback(
    async (query: string) => {
      setSearchQuery(query);
      if (!query.trim()) {
        // If empty query, fetch all sessions
        fetchChatSessions();
        return;
      }

      setIsLoadingHistory(true);
      try {
        const response = await fetch(
          `${API_BASE}/api/chat/search?q=${encodeURIComponent(query)}`,
        );
        if (response.ok) {
          const data = await response.json();
          setChatSessions(data.results);
        }
      } catch (error) {
        console.error("[Chat] Failed to search sessions:", error);
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [fetchChatSessions],
  );

  // Load chat history on mount
  useEffect(() => {
    fetchChatSessions();

    // Restore current session if exists
    const storedChatSessionId = localStorage.getItem("chat_session_id");
    if (storedChatSessionId) {
      loadChatSession(storedChatSessionId);
    }
  }, [fetchChatSessions, loadChatSession]);

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

    console.log(
      "[HomePage] Initiating connection, storedSession:",
      storedSessionId,
    );
    hasConnectedRef.current = true;

    setStatus("connecting");
    client.connect(url.toString());

    // Always start session on page load
    // If reconnecting to an existing session, the gateway will handle it
    // If session is dead, this creates a new one
    const defaultCwd =
      process.env.NEXT_PUBLIC_ACP_CWD || "/Users/pradeeptadash/sandbox";
    client.startSession(defaultCwd);

    // Cleanup function - only reset on actual unmount
    return () => {
      console.log("[HomePage] Effect cleanup - component unmounting");
      hasConnectedRef.current = false;
    };
  }, [client, gatewayUrl]);

  // Debounced scroll handler to improve performance
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    let scrollTimeout: NodeJS.Timeout;
    const handleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const scrollDistanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;
        const isNearBottom = scrollDistanceFromBottom < 200;
        if (isNearBottom) {
          setShowScrollButton(false);
        }
      }, 100); // Debounce by 100ms
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      clearTimeout(scrollTimeout);
      container.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    const endElement = messagesEndRef.current;
    if (!container || !endElement) return;

    const isNewMessage = messages.length > prevMessagesLengthRef.current;
    const isMessageUpdate =
      messages.length === prevMessagesLengthRef.current && messages.length > 0;
    const isFirstMessage =
      prevMessagesLengthRef.current === 0 && messages.length > 0;
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
        endElement.scrollIntoView({
          behavior: isFirstMessage ? "instant" : "smooth",
        });
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
      200,
    )}px`;
  }, [input]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text && attachedImages.length === 0) return;

    // If viewing old chat, don't allow sending
    if (isViewingOldChat) {
      console.warn("[Chat] Cannot send message while viewing old chat");
      return;
    }

    // Ensure we have a chat session
    let sessionId = currentChatSessionId;
    if (!sessionId) {
      sessionId = await createChatSession();
      if (!sessionId) {
        console.error("[Chat] Failed to create chat session");
        return;
      }
      setIsViewingOldChat(false); // Mark as active session
    }

    userJustSentMessageRef.current = true;
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, images: attachedImages },
    ]);
    setInput("");
    setStatus("streaming");

    // Save user message to DB
    await saveMessage(sessionId, "USER", text, attachedImages);

    // Update session title if first message
    if (messages.length === 0) {
      const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
      try {
        await fetch(`${API_BASE}/api/chat/sessions/${sessionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        fetchChatSessions(); // Refresh sidebar
      } catch (error) {
        console.error("[Chat] Failed to update session title:", error);
      }
    }

    // Store images reference and clear
    const userImages = attachedImages;
    setAttachedImages([]);

    // Send to ACP
    client.sendPrompt(text, userImages);
  };

  const handleUseTradeCheckAnalysis = (
    analysis: TradeCheckAnalysis,
    regime: MarketRegime,
  ) => {
    const { prompt } = createStrategyPrompt(analysis, regime);
    setInput(prompt);
    // Auto-scroll to show the filled prompt
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        textareaRef.current.focus();
      }
    }, 100);
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
          }),
      ),
    );
    setAttachedImages((prev) => [...prev, ...newImages]);
  };

  const removeImage = (index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
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
        <div className="chat-with-sidebar">
          <ChatHistorySidebar
            sessions={chatSessions}
            currentSessionId={currentChatSessionId}
            isOpen={isSidebarOpen}
            onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
            onSelectSession={loadChatSession}
            onDeleteSession={handleDeleteChat}
            onRenameSession={handleRenameSession}
            onSearch={handleSearch}
            isLoading={isLoadingHistory}
            searchQuery={searchQuery}
          />
          <section className="chat-shell">
            {isViewingOldChat && (
              <div className="chat-view-only-banner">
                <strong>Viewing past conversation.</strong> This is read-only.
                Click "New Session" in the navbar to start a new conversation.
              </div>
            )}
            <div className="messages" ref={messagesContainerRef}>
              {messages.length === 0 ? (
                <div className="empty-state">Start a conversation…</div>
              ) : (
                <>
                  {messages.slice(-100).map((msg, idx) => (
                    <MessageComponent
                      key={`msg-${messages.length - 100 + idx}`}
                      message={msg}
                    />
                  ))}
                </>
              )}
              {status === "streaming" &&
                messages[messages.length - 1]?.role === "user" && (
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
              <button
                className="scroll-button"
                onClick={() =>
                  messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
                }
              >
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
                  placeholder={
                    isViewingOldChat
                      ? "Viewing past conversation (read-only)"
                      : "Message the advisor..."
                  }
                  rows={1}
                  disabled={isViewingOldChat}
                />
                <button
                  type="button"
                  className="composer-ai-analyze"
                  onClick={() => setShowTradeCheckModal(true)}
                  disabled={isViewingOldChat}
                  title="AI Trade Analysis"
                  style={{
                    background: "none",
                    border: "none",
                    fontSize: "20px",
                    cursor: isViewingOldChat ? "not-allowed" : "pointer",
                    padding: "8px 12px",
                    opacity: isViewingOldChat ? 0.5 : 1,
                  }}
                >
                  🤖
                </button>
                <label className="composer-attach">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={isViewingOldChat}
                    onChange={async (event) => {
                      if (!event.target.files) return;
                      const files = Array.from(event.target.files);
                      const imageFiles = files.filter((file) =>
                        file.type.startsWith("image/"),
                      );
                      if (!imageFiles.length) return;
                      const newImages = await Promise.all(
                        imageFiles.map(
                          (file) =>
                            new Promise<{ data: string; mimeType: string }>(
                              (resolve, reject) => {
                                const reader = new FileReader();
                                reader.onload = () => {
                                  const base64 = (
                                    reader.result as string
                                  ).split(",")[1];
                                  resolve({
                                    data: base64,
                                    mimeType: file.type,
                                  });
                                };
                                reader.onerror = reject;
                                reader.readAsDataURL(file);
                              },
                            ),
                        ),
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
                    isViewingOldChat ||
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
        </div>
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

      {/* TradeCheck AI Analysis Modal */}
      <TradeCheckModal
        isOpen={showTradeCheckModal}
        onClose={() => setShowTradeCheckModal(false)}
        onUseAnalysis={handleUseTradeCheckAnalysis}
      />
    </div>
  );
}
