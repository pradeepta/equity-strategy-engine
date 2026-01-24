"use client";

import { useState } from "react";

export type ChatSession = {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  isActive: boolean;
};

interface ChatHistorySidebarProps {
  sessions: ChatSession[];
  currentSessionId: string | null;
  isOpen: boolean;
  onToggle: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onSearch: (query: string) => void;
  isLoading: boolean;
  searchQuery: string;
}

// Group sessions by date
function groupSessionsByDate(sessions: ChatSession[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups: { label: string; sessions: ChatSession[] }[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "This Week", sessions: [] },
    { label: "Older", sessions: [] },
  ];

  for (const session of sessions) {
    const date = new Date(session.lastMessageAt || session.createdAt);
    if (date >= today) {
      groups[0].sessions.push(session);
    } else if (date >= yesterday) {
      groups[1].sessions.push(session);
    } else if (date >= weekAgo) {
      groups[2].sessions.push(session);
    } else {
      groups[3].sessions.push(session);
    }
  }

  return groups.filter((g) => g.sessions.length > 0);
}

export function ChatHistorySidebar({
  sessions,
  currentSessionId,
  isOpen,
  onToggle,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onSearch,
  isLoading,
  searchQuery,
}: ChatHistorySidebarProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
  const groups = groupSessionsByDate(sessions);

  const handleRenameSubmit = (sessionId: string) => {
    if (editTitle.trim()) {
      onRenameSession(sessionId, editTitle.trim());
    }
    setEditingSession(null);
    setEditTitle("");
  };

  const handleSearchChange = (value: string) => {
    setLocalSearchQuery(value);
    // Debounce search
    const timeoutId = setTimeout(() => {
      onSearch(value);
    }, 300);
    return () => clearTimeout(timeoutId);
  };

  return (
    <aside className={`chat-sidebar ${isOpen ? "" : "collapsed"}`}>
      <div className="sidebar-header">
        <button
          className="sidebar-toggle"
          onClick={onToggle}
          aria-label={isOpen ? "Collapse sidebar" : "Expand sidebar"}
        >
          {isOpen ? "«" : "»"}
        </button>
        {isOpen && (
          <div className="sidebar-header-title">Chat History</div>
        )}
      </div>

      {isOpen && (
        <>
          <div className="sidebar-search">
            <input
              type="text"
              className="search-input"
              placeholder="Search chats..."
              value={localSearchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {localSearchQuery && (
              <button
                className="search-clear"
                onClick={() => {
                  setLocalSearchQuery("");
                  onSearch("");
                }}
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <div className="session-list">
          {isLoading ? (
            <div className="sidebar-loading">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="sidebar-empty">No chat history</div>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="session-group">
                <div className="session-group-title">{group.label}</div>
                {group.sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${
                      session.id === currentSessionId ? "active" : ""
                    }`}
                  >
                    {editingSession === session.id ? (
                      <div className="session-edit" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          className="session-edit-input"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleRenameSubmit(session.id);
                            } else if (e.key === "Escape") {
                              setEditingSession(null);
                              setEditTitle("");
                            }
                          }}
                          onBlur={() => handleRenameSubmit(session.id)}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <>
                        <span
                          className="session-title"
                          onClick={() => onSelectSession(session.id)}
                        >
                          {session.title}
                        </span>
                        <div className="session-actions">
                          {confirmDelete === session.id ? (
                            <div
                              className="session-confirm-delete"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                onClick={() => {
                                  onDeleteSession(session.id);
                                  setConfirmDelete(null);
                                }}
                              >
                                Yes
                              </button>
                              <button onClick={() => setConfirmDelete(null)}>
                                No
                              </button>
                            </div>
                          ) : (
                            <>
                              <button
                                className="session-rename"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingSession(session.id);
                                  setEditTitle(session.title);
                                }}
                                aria-label="Rename chat"
                              >
                                ✎
                              </button>
                              <button
                                className="session-delete"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDelete(session.id);
                                }}
                                aria-label="Delete chat"
                              >
                                ×
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
          </div>
        </>
      )}
    </aside>
  );
}
