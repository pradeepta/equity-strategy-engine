import { spawn } from "child_process";
import { WebSocket } from "ws";
import { AUTO_APPROVE_PERMISSIONS } from "./config.js";
import type { PermissionOption, Session } from "./types.js";

export function spawnAgent(session: Session): void {
  if (session.child) {
    return;
  }

  const child = spawn(session.agentCmd, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  session.child = child;
  console.log(`[agent] spawned for session ${session.id}: ${session.agentCmd}`);

  child.stdout?.on("data", (buf: Buffer) => {
    session.stdoutBuffer += buf.toString();
    const lines = session.stdoutBuffer.split("\n");
    session.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const payload = line.trimEnd();
      if (payload) {
        // console.log(
        //   `[agent][stdout] session=${session.id}: ${payload.slice(0, 2000)}`
        // );
      }
      maybeHandleSessionNew(session, payload);
      forwardToClient(session, payload);
    }
    tryFlushJsonBuffer(session);
  });

  child.stderr?.on("data", (buf: Buffer) => {
    const message = buf.toString().trimEnd();
    if (message) {
      console.error(`[agent][stderr] session=${session.id}: ${message}`);
    }
  });

  child.on("close", (code, signal) => {
    console.warn(
      `[agent] exited session=${session.id} code=${code} signal=${signal}`,
    );
    session.child = null;
  });
}

export function writeToAgentStdin(session: Session, message: string): void {
  if (!session.child?.stdin?.writable) {
    console.error(`[agent] stdin not writable for session ${session.id}`);
    return;
  }
  const payload = `${message}\n`;
  console.log(
    `[agent][stdin] session=${session.id}: ${payload.slice(0, 2000)}`,
  );
  session.child.stdin.write(payload);
}

function forwardToClient(session: Session, message: string): void {
  if (!message) {
    return;
  }

  // Try to handle permission requests before forwarding
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;

    // Log tool calls
    if (parsed.method?.toString().includes("tools/call")) {
      console.log(
        "[agent] MCP tool call detected:",
        parsed.method,
        parsed.params,
      );
    }

    handlePermissionRequest(session, parsed);
  } catch {
    // Not JSON or parsing error, just forward
  }

  // console.log(
  //   `[gateway][ws->client] session=${session.id}: ${message.slice(0, 500)}`,
  // );
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(message);
  } else {
    console.warn(
      `[ws] Dropping message (no websocket) session=${session.id}: ${message.slice(
        0,
        200,
      )}`,
    );
  }
}

function tryFlushJsonBuffer(session: Session): void {
  const buffer = session.stdoutBuffer.trim();
  if (!buffer) {
    return;
  }
  if (!buffer.startsWith("{") || !buffer.endsWith("}")) {
    return;
  }
  try {
    JSON.parse(buffer);
    // console.log(
    //   `[agent][stdout] session=${session.id}: ${buffer.slice(0, 2000)}`
    // );
    maybeHandleSessionNew(session, buffer);
    forwardToClient(session, buffer);
    session.stdoutBuffer = "";
  } catch {
    // Wait for more data
  }
}

function handlePermissionRequest(
  session: Session,
  parsed: Record<string, unknown>,
): void {
  // Only process permission requests
  if (parsed.method !== "session/request_permission") {
    return;
  }
  if (parsed.id === undefined) {
    return;
  }

  // Extract options and tool call info
  const params = parsed.params as Record<string, unknown> | undefined;
  const options = params?.options as Array<PermissionOption> | undefined;
  if (!options) {
    return;
  }

  const toolCallId = (params?.toolCall as Record<string, unknown>)
    ?.toolCallId as string | undefined;

  // console.log(
  //   `[agent] Permission request for session ${session.id}:`,
  //   JSON.stringify(parsed)
  // );

  // Early exit if auto-approve is disabled
  if (!AUTO_APPROVE_PERMISSIONS) {
    console.log(
      `[agent] Auto-approve disabled; not responding to permission id=${
        parsed.id
      } toolCallId=${toolCallId ?? "unknown"}`,
    );
    return;
  }

  // Option priority: allow > allow_once > allow_always > first option
  const allowOption =
    options.find((o) => o.optionId === "allow") ||
    options.find((o) => o.optionId === "allow_once") ||
    options.find((o) => o.optionId === "allow_always") ||
    options[0];

  if (!allowOption?.optionId) {
    console.warn(`[agent] No allow option found in permission request`);
    return;
  }

  // Construct and send response
  const response = {
    jsonrpc: "2.0",
    id: parsed.id,
    result: {
      outcome: {
        outcome: "selected",
        optionId: allowOption.optionId,
      },
    },
  };

  // console.log(`[agent] Permission response:`, JSON.stringify(response));
  writeToAgentStdin(session, JSON.stringify(response));
  // console.log(
  //   `[agent] Auto-approved permission id=${parsed.id} optionId=${
  //     allowOption.optionId
  //   } toolCallId=${toolCallId ?? "unknown"}`
  // );
}

function maybeHandleSessionNew(session: Session, payload: string): void {
  if (session.systemPromptSent || !session.systemPrompt) {
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (!parsed?.result?.sessionId || parsed.method) {
    return;
  }
  session.sessionId = parsed.result.sessionId;
  const requestId = Date.now();
  const promptPayload = {
    jsonrpc: "2.0",
    id: requestId,
    method: "session/prompt",
    params: {
      sessionId: session.sessionId,
      stream: true,
      prompt: [{ type: "text", text: session.systemPrompt }],
    },
  };
  console.log(
    `[agent][stdin] session=${session.id}: ${JSON.stringify(
      promptPayload,
    ).slice(0, 2000)}`,
  );
  writeToAgentStdin(session, JSON.stringify(promptPayload));
  session.systemPromptSent = true;
}
