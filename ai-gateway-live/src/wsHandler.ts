import type { IncomingMessage } from "http";
import { WebSocket } from "ws";
import type { Session, JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { RECONNECT_WINDOW_MS, getAgentCommand } from "./config.js";
import {
  getSession,
  hasSession,
  createSession,
  deleteSession,
} from "./sessionManager.js";
import { spawnAgent, writeToAgentStdin } from "./agentHandler.js";

export function handleWebSocketConnection(
  ws: WebSocket,
  req: IncomingMessage
): void {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const requestedSessionId = url.searchParams.get("sessionId");
  const persona = url.searchParams.get("persona") || undefined;
  const agentCmd = url.searchParams.get("agent") || getAgentCommand(persona);
  const sessionId =
    requestedSessionId || Math.random().toString(36).substring(7);

  const session = hasSession(sessionId)
    ? reconnectToSession(sessionId, ws)
    : createNewSession(sessionId, ws, agentCmd, persona);

  ws.on("message", (data) => {
    const raw = data.toString();
    console.log(
      `[gateway][client->ws] session=${session.id}: ${raw.slice(0, 2000)}`
    );
    void handleMessage(session, raw);
  });
  ws.on("close", () => handleClose(session, sessionId));
  ws.on("error", (err) => handleError(sessionId, err));
}

function reconnectToSession(sessionId: string, ws: WebSocket): Session {
  const session = getSession(sessionId)!;
  console.log(`[ws] Reconnecting session ${sessionId}`);

  if (session.cleanupTimeout) {
    clearTimeout(session.cleanupTimeout);
    session.cleanupTimeout = null;
  }

  if (session.ws && session.ws !== ws) {
    try {
      session.ws.close();
    } catch {
      // ignore
    }
  }

  session.ws = ws;

  if (!session.child) {
    spawnAgent(session);
  }

  return session;
}

function createNewSession(
  sessionId: string,
  ws: WebSocket,
  agentCmd: string,
  persona?: string
): Session {
  console.log(`[ws] Creating new session ${sessionId}`);
  const session = createSession(sessionId, agentCmd, persona);
  session.ws = ws;
  spawnAgent(session);
  return session;
}

async function handleMessage(session: Session, rawMessage: string): Promise<void> {
  const message = rawMessage.trim();
  if (!message) return;

  try {
    const parsed = JSON.parse(message) as JsonRpcRequest;
    if (parsed.method === "gateway/stop") {
      handleStopRequest(session, parsed);
      return;
    }
    if (parsed.method === "session/new") {
      session.pendingSessionNewRequestId = parsed.id;
    }
  } catch {
    // non-JSON; pass through
  }

  if (!session.child) {
    spawnAgent(session);
  }
  writeToAgentStdin(session, message);
}

function handleStopRequest(session: Session, parsed: JsonRpcRequest): void {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: parsed.id ?? null,
      result: { stopped: true },
    };
    session.ws.send(JSON.stringify(response));
  }
}

function handleClose(session: Session, sessionId: string): void {
  console.log(`[ws] Connection closed for session ${sessionId}`);

  session.ws = null;
  session.cleanupTimeout = setTimeout(() => {
    console.log(`[ws] Cleaning up session ${sessionId}`);
    if (session.child) {
      session.child.kill();
      session.child = null;
    }
    deleteSession(sessionId);
  }, RECONNECT_WINDOW_MS);
}

function handleError(sessionId: string, err: Error): void {
  console.error(`[ws] Error in session ${sessionId}: ${err.message}`);
}
