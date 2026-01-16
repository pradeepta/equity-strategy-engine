import type { Session } from "./types.js";

const sessions = new Map<string, Session>();

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function hasSession(id: string): boolean {
  return sessions.has(id);
}

export function setSession(id: string, session: Session): void {
  sessions.set(id, session);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

export function createSession(
  id: string,
  agentCmd: string,
  persona?: string
): Session {
  const session: Session = {
    id,
    child: null,
    agentCmd,
    ws: null,
    cleanupTimeout: null,
    stdoutBuffer: "",
    persona,
  };
  sessions.set(id, session);
  return session;
}
