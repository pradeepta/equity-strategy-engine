"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AcpClient } from "../src/lib/acpClient";

type ChatMessage = {
  role: "user" | "agent";
  content: string;
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
  const gatewayUrl = process.env.NEXT_PUBLIC_ACP_URL;
  const persona = "blackrock_advisor";

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
    const url = new URL(gatewayUrl);
    url.searchParams.set("persona", persona);
    url.searchParams.set("sessionId", crypto.randomUUID());

    setStatus("connecting");
    client.connect(url.toString());
    client.startSession("/");
  }, [client, gatewayUrl]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setStatus("streaming");
    client.sendPrompt(text);
  };

  return (
    <div className="container">
      <div className="card">
        <h1>Stock Advisor Chat</h1>
        <p className="status">
          Status: {status}
          {sessionId ? ` | Session: ${sessionId}` : ""}
        </p>
      </div>

      <div className="card messages">
        {messages.length === 0 && (
          <div className="status">Start a conversation…</div>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
      </div>

      <div className="card inputRow">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about market positioning..."
        />
        <button
          onClick={sendMessage}
          disabled={status === "connecting" || status === "missing_url"}
        >
          Send
        </button>
      </div>
    </div>
  );
}
