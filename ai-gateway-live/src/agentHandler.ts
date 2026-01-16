import { spawn } from "child_process";
import { WebSocket } from "ws";
import type { Session } from "./types.js";

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
      forwardToClient(session, line.trimEnd());
    }
  });

  child.stderr?.on("data", (buf: Buffer) => {
    const message = buf.toString().trimEnd();
    if (message) {
      console.error(`[agent][stderr] session=${session.id}: ${message}`);
    }
  });

  child.on("close", (code, signal) => {
    console.warn(
      `[agent] exited session=${session.id} code=${code} signal=${signal}`
    );
    session.child = null;
  });
}

export function writeToAgentStdin(session: Session, message: string): void {
  if (!session.child?.stdin?.writable) {
    console.error(`[agent] stdin not writable for session ${session.id}`);
    return;
  }
  session.child.stdin.write(`${message}\n`);
}

function forwardToClient(session: Session, message: string): void {
  if (!message) {
    return;
  }
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(message);
  } else {
    console.warn(
      `[ws] Dropping message (no websocket) session=${session.id}: ${message.slice(
        0,
        200
      )}`
    );
  }
}
