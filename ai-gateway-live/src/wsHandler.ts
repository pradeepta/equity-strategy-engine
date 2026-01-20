import type { IncomingMessage } from "http";
import { WebSocket } from "ws";
import type { Session, JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { AUTO_MCP_SERVERS, RECONNECT_WINDOW_MS, getAgentCommand } from "./config.js";
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
    // console.log(
    //   `[gateway][client->ws] session=${session.id}: ${raw.slice(0, 2000)}`
    // );
    void handleMessage(session, raw);
  });
  ws.on("close", () => handleClose(session, sessionId));
  ws.on("error", (err) => handleError(sessionId, err));
}

function filterSupportedMcpServers(
  servers: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  // ACP agent supports stdio, http, and sse types - no filtering needed
  return servers;
}

function mergeMcpServers(
  incoming: Array<Record<string, unknown>>,
  autoServers: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (autoServers.length === 0) {
    return filterSupportedMcpServers(incoming);
  }
  if (incoming.length === 0) {
    return filterSupportedMcpServers(autoServers);
  }
  const seenNames = new Set<string>();
  const merged: Array<Record<string, unknown>> = [];
  const pushServer = (server: Record<string, unknown>) => {
    const name = server?.name;
    if (typeof name === "string") {
      if (seenNames.has(name)) return;
      seenNames.add(name);
    }
    merged.push(server);
  };
  incoming.forEach(pushServer);
  autoServers.forEach(pushServer);
  return filterSupportedMcpServers(merged);
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
  let messageToWrite = message;

  try {
    const parsed = JSON.parse(message) as JsonRpcRequest;
    if (parsed.method === "gateway/stop") {
      handleStopRequest(session, parsed);
      return;
    }
    if (parsed.method === "session/new") {
      session.pendingSessionNewRequestId = parsed.id;
      const params = (parsed.params || {}) as Record<string, unknown>;
      const incomingServers = Array.isArray(params.mcpServers)
        ? (params.mcpServers as Array<Record<string, unknown>>)
        : [];
      console.log(`[ws] session/new incoming servers:`, JSON.stringify(incomingServers, null, 2));
      console.log(`[ws] AUTO_MCP_SERVERS:`, JSON.stringify(AUTO_MCP_SERVERS, null, 2));
      const mergedServers = mergeMcpServers(incomingServers, AUTO_MCP_SERVERS);
      console.log(`[ws] merged servers:`, JSON.stringify(mergedServers, null, 2));
      if (
        mergedServers.length !== incomingServers.length ||
        mergedServers.some((s, i) => s !== incomingServers[i])
      ) {
        parsed.params = {
          ...params,
          mcpServers: mergedServers,
        };
        messageToWrite = JSON.stringify(parsed);
        console.log(`[ws] modified session/new message:`, messageToWrite);
      }
      if (mergedServers.length > 0) {
        session.mcpServers = mergedServers;
      }
    }
  } catch {
    // non-JSON; pass through
  }

  if (!session.child) {
    spawnAgent(session);
  }
  writeToAgentStdin(session, messageToWrite);
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
