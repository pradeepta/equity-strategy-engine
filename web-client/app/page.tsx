"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AcpClient } from "../src/lib/acpClient";

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-title">Trade•with•Claude</div>
        <div className="topbar-status">
          Status: {status}
          {sessionId ? ` | Session: ${sessionId}` : ""}
        </div>
      </header>

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
    </div>
  );
}
