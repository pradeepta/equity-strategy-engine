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
  isLoading: boolean;
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
  isLoading,
}: ChatHistorySidebarProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const groups = groupSessionsByDate(sessions);

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
                    onClick={() => onSelectSession(session.id)}
                  >
                    <span className="session-title">{session.title}</span>
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
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
}
