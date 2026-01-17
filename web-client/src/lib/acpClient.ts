type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

const STOCKS_MCP_SERVER = {
  name: "stocks-mcp",
  type: "stdio",
  command: "node",
  args: ["/Users/pradeeptadash/stocks/dist/mcp-server.js"],
  env: [],
};

type UpdateCallback = (chunk: string) => void;
type DoneCallback = () => void;
type ErrorCallback = (message: string) => void;
type SessionCallback = (sessionId: string) => void;

export class AcpClient {
  private ws: WebSocket | null = null;
  private buffer = "";
  private requestId = 1;
  private sessionId: string | null = null; // ACP agent session ID
  private gatewaySessionId: string | null = null; // Gateway session ID for reconnection
  private onChunk: UpdateCallback;
  private onDone: DoneCallback;
  private onError: ErrorCallback;
  private onSession: SessionCallback;
  private pendingSends: JsonRpcMessage[] = [];
  private needsSessionInit = false;
  private isConnecting = false;
  private sessionStarted = false;

  constructor(
    onChunk: UpdateCallback,
    onDone: DoneCallback,
    onError: ErrorCallback,
    onSession: SessionCallback
  ) {
    this.onChunk = onChunk;
    this.onDone = onDone;
    this.onError = onError;
    this.onSession = onSession;
  }

  setHandlers(
    onChunk: UpdateCallback,
    onDone: DoneCallback,
    onError: ErrorCallback,
    onSession: SessionCallback
  ): void {
    this.onChunk = onChunk;
    this.onDone = onDone;
    this.onError = onError;
    this.onSession = onSession;
  }

  checkSessionInit(callback: () => void, timeout = 2000): void {
    // Wait for timeout, if needsSessionInit is still true, session is dead
    setTimeout(() => {
      if (this.needsSessionInit) {
        console.log("[ACP] Session expired, clearing and starting fresh");
        // Clear the dead session from localStorage
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("acp_session_id");
        }
        this.sessionId = null;
        this.needsSessionInit = false;
        this.sessionStarted = false; // Reset so we can start a new session
        callback();
      }
    }, timeout);
  }

  connect(url: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log("[ACP] Already connected, skipping");
      return;
    }

    if (this.isConnecting) {
      console.log("[ACP] Connection already in progress, skipping");
      return;
    }

    // Close existing connection if it exists
    if (this.ws) {
      console.log("[ACP] Closing existing connection");
      this.ws.close();
      this.ws = null;
    }

    this.isConnecting = true;

    // Try to restore gateway session ID from localStorage
    if (typeof window !== "undefined") {
      this.gatewaySessionId = window.localStorage.getItem("acp_gateway_session_id");

      if (this.gatewaySessionId) {
        // Append gateway sessionId to URL for reconnection
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}sessionId=${this.gatewaySessionId}`;
        console.log("[ACP] Reconnecting to gateway session", this.gatewaySessionId);
      } else {
        // Generate new gateway session ID
        this.gatewaySessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
        window.localStorage.setItem("acp_gateway_session_id", this.gatewaySessionId);
        // Append to URL
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}sessionId=${this.gatewaySessionId}`;
        console.log("[ACP] Created new gateway session", this.gatewaySessionId);
      }
    }

    this.ws = new WebSocket(url);
    console.log("[ACP] connecting", url);
    this.ws.onopen = () => {
      console.log("[ACP] websocket open, readyState:", this.ws?.readyState);
      this.isConnecting = false;
      const queued = [...this.pendingSends];
      this.pendingSends = [];
      console.log("[ACP] Sending", queued.length, "queued messages");
      queued.forEach((message) => this.send(message));
    };
    this.ws.onmessage = (event) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      console.log("[ACP] message", data.slice(0, 2000));

      // If we receive any message during reconnection, session is alive
      if (this.needsSessionInit) {
        this.needsSessionInit = false;
        console.log("[ACP] Session reconnected successfully");
      }

      this.handleInbound(data);
    };
    this.ws.onerror = () => {
      console.error("[ACP] websocket error");
      this.isConnecting = false;
      this.onError("WebSocket error");
    };
    this.ws.onclose = () => {
      console.warn("[ACP] websocket closed");
      this.isConnecting = false;
    };
  }

  startSession(cwd: string, forceNew = false): void {
    // Check if we have a stored ACP agent session ID
    if (typeof window !== "undefined" && !forceNew) {
      const storedAgentSessionId = window.localStorage.getItem("acp_agent_session_id");
      if (storedAgentSessionId) {
        console.log("[ACP] Restoring agent session", storedAgentSessionId);
        this.sessionId = storedAgentSessionId;
        this.sessionStarted = true;
        this.needsSessionInit = false;
        // Notify that session is ready
        this.onSession(this.sessionId);
        return;
      }
    }

    // Prevent duplicate session/new calls (only within same page load)
    if (this.sessionStarted && !forceNew) {
      console.log("[ACP] Session already started, skipping");
      return;
    }

    // Clear stored session if forcing new session
    if (forceNew) {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem("acp_agent_session_id");
        window.localStorage.removeItem("acp_gateway_session_id");
      }
      this.sessionId = null;
      this.gatewaySessionId = null;
      this.sessionStarted = false;
      console.log("[ACP] Forcing new session");
    }

    // Clear reconnection flag since we're explicitly starting a session
    this.needsSessionInit = false;
    this.sessionStarted = true;

    const id = this.nextId();
    console.log("[ACP] session/new", { id, cwd });
    // Send the MCP server config to the ACP agent
    const mcpServers = STOCKS_MCP_SERVER ? [STOCKS_MCP_SERVER] : [];
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/new",
      params: {
        cwd,
        mcpServers,
      },
    });
  }

  sendPrompt(
    prompt: string,
    images?: { data: string; mimeType: string }[]
  ): void {
    if (!this.sessionId) {
      this.onError("Session not initialized");
      return;
    }
    const id = this.nextId();
    console.log("[ACP] session/prompt", { id, sessionId: this.sessionId });
    const payload: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }> = [];
    if (prompt) {
      payload.push({ type: "text", text: prompt });
    }
    if (images?.length) {
      images.forEach((img) => {
        payload.push({ type: "image", data: img.data, mimeType: img.mimeType });
      });
    }
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId: this.sessionId,
        stream: true,
        prompt: payload,
      },
    });
  }

  private handleInbound(chunk: string): void {
    console.log("[ACP] inbound chunk", chunk.slice(0, 2000));
    this.buffer += chunk;
    if (this.tryHandleJson(this.buffer)) {
      this.buffer = "";
      return;
    }
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line) continue;
      this.tryHandleJson(line);
    }
  }

  private tryHandleJson(payload: string): boolean {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(payload) as JsonRpcMessage;
    } catch {
      console.warn("[ACP] JSON parse pending", payload.slice(0, 2000));
      return false;
    }

    if (msg.result?.sessionId && !msg.method) {
      console.log("[ACP] session created", msg.result.sessionId);
      this.sessionId = msg.result.sessionId as string;
      // Persist agent session ID to localStorage
      if (typeof window !== "undefined") {
        window.localStorage.setItem("acp_agent_session_id", this.sessionId);
      }
      this.onSession(this.sessionId);
      return true;
    }

    if (msg.method === "session/update") {
      const update = msg.params?.update as any;
      const text = this.extractText(update?.textContent || update?.content);
      console.log("[ACP] session/update", update?.sessionUpdate, {
        hasText: text !== undefined,
      });
      if (text !== undefined) {
        this.onChunk(text);
      }
      return true;
    }

    if (msg.result?.stopReason) {
      console.log("[ACP] stopReason", msg.result.stopReason);
      this.onDone();
      return true;
    }

    if (msg.error?.message) {
      console.error("[ACP] error", msg.error.message);
      this.onError(msg.error.message);
      return true;
    }

    return true;
  }

  private extractText(content: any): string | undefined {
    if (!content) return undefined;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => (typeof item?.text === "string" ? item.text : ""))
        .join("");
    }
    if (typeof content?.text === "string") return content.text;
    return undefined;
  }

  private send(message: JsonRpcMessage): void {
    if (!this.ws) {
      this.onError("WebSocket not connected");
      return;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pendingSends.push(message);
      return;
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.pendingSends.push(message);
      this.onError("WebSocket not connected");
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  private nextId(): number {
    return this.requestId++;
  }
}
