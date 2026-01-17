import { ChildProcess } from "child_process";
import { WebSocket } from "ws";

export interface Session {
  id: string;
  child: ChildProcess | null;
  agentCmd: string;
  ws: WebSocket | null;
  cleanupTimeout: NodeJS.Timeout | null;
  stdoutBuffer: string;
  persona?: string;
  pendingSessionNewRequestId?: number | string;
  systemPrompt?: string;
  systemPromptSent?: boolean;
  sessionId?: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
