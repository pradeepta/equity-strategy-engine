type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type UpdateCallback = (chunk: string) => void;
type DoneCallback = () => void;
type ErrorCallback = (message: string) => void;
type SessionCallback = (sessionId: string) => void;

export class AcpClient {
  private ws: WebSocket | null = null;
  private buffer = "";
  private requestId = 1;
  private sessionId: string | null = null;
  private onChunk: UpdateCallback;
  private onDone: DoneCallback;
  private onError: ErrorCallback;
  private onSession: SessionCallback;
  private pendingSends: JsonRpcMessage[] = [];

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

  connect(url: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    this.ws = new WebSocket(url);
    console.log("[ACP] connecting", url);
    this.ws.onopen = () => {
      console.log("[ACP] websocket open");
      const queued = [...this.pendingSends];
      this.pendingSends = [];
      queued.forEach((message) => this.send(message));
    };
    this.ws.onmessage = (event) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      console.log("[ACP] message", data.slice(0, 2000));
      this.handleInbound(data);
    };
    this.ws.onerror = () => {
      console.error("[ACP] websocket error");
      this.onError("WebSocket error");
    };
    this.ws.onclose = () => {
      console.warn("[ACP] websocket closed");
    };
  }

  startSession(cwd: string): void {
    const id = this.nextId();
    console.log("[ACP] session/new", { id, cwd });
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/new",
      params: {
        cwd,
        mcpServers: [],
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
