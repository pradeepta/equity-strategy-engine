#!/usr/bin/env node

/**
 * HTTP/SSE Transport for MCP Server
 *
 * Wraps the stdio-based MCP server in an HTTP/SSE transport layer
 * to make it compatible with the ACP agent.
 */

import express, { Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

interface McpSession {
  id: string;
  child: ChildProcess;
  buffer: string;
  responseCallbacks: Map<number | string, (response: any) => void>;
  sseClients: Set<Response>;
}

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.MCP_HTTP_PORT || '3001');
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || './dist/mcp-server.js';

// ============================================================================
// Session Management
// ============================================================================

const sessions = new Map<string, McpSession>();

function createSession(): McpSession {
  const sessionId = uuidv4();

  console.log(`[mcp-http] Creating session ${sessionId}`);
  console.log(`[mcp-http] Spawning: node ${MCP_SERVER_PATH}`);

  const child = spawn('node', [MCP_SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session: McpSession = {
    id: sessionId,
    child,
    buffer: '',
    responseCallbacks: new Map(),
    sseClients: new Set(),
  };

  child.stdout?.on('data', (buf: Buffer) => {
    const data = buf.toString();
    session.buffer += data;
    processBuffer(session);
  });

  child.stderr?.on('data', (buf: Buffer) => {
    const error = buf.toString();
    // Filter out the "running on stdio" message
    if (!error.includes('running on stdio')) {
      console.error(`[mcp-http][${sessionId}] stderr:`, error);
    }
  });

  child.on('close', (code) => {
    console.log(`[mcp-http][${sessionId}] process exited with code ${code}`);
    sessions.delete(sessionId);

    // Close all SSE connections
    for (const client of session.sseClients) {
      try {
        client.end();
      } catch {}
    }
  });

  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId: string): McpSession | undefined {
  return sessions.get(sessionId);
}

function processBuffer(session: McpSession): void {
  const lines = session.buffer.split('\n');
  session.buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const message = JSON.parse(line);
      console.log(`[mcp-http][${session.id}] <-`, JSON.stringify(message).slice(0, 200));

      // Broadcast to SSE clients
      for (const client of session.sseClients) {
        try {
          client.write(`data: ${JSON.stringify(message)}\n\n`);
        } catch (err) {
          console.error(`[mcp-http][${session.id}] Failed to send to SSE client:`, err);
          session.sseClients.delete(client);
        }
      }

      // Handle JSON-RPC responses
      if (message.id && session.responseCallbacks.has(message.id)) {
        const callback = session.responseCallbacks.get(message.id);
        callback?.(message);
        session.responseCallbacks.delete(message.id);
      }
    } catch (err) {
      console.error(`[mcp-http][${session.id}] Failed to parse message:`, line.slice(0, 100));
    }
  }
}

function sendToMcpServer(session: McpSession, message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!session.child.stdin) {
      reject(new Error('MCP server stdin not available'));
      return;
    }

    console.log(`[mcp-http][${session.id}] ->`, JSON.stringify(message).slice(0, 200));

    // Store callback for response
    if (message.id) {
      session.responseCallbacks.set(message.id, resolve);

      // Timeout after 60 seconds
      setTimeout(() => {
        if (session.responseCallbacks.has(message.id)) {
          session.responseCallbacks.delete(message.id);
          reject(new Error('MCP server request timeout'));
        }
      }, 60000);
    }

    const payload = JSON.stringify(message) + '\n';
    session.child.stdin.write(payload, (err) => {
      if (err) {
        if (message.id) {
          session.responseCallbacks.delete(message.id);
        }
        reject(err);
      } else if (!message.id) {
        // No response expected (notification)
        resolve({ success: true });
      }
    });
  });
}

// ============================================================================
// Express App
// ============================================================================

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: sessions.size,
    uptime: process.uptime(),
  });
});

// Create new session
app.post('/session', (req, res) => {
  const session = createSession();
  res.json({
    sessionId: session.id,
    message: 'Session created',
  });
});

// SSE endpoint - main transport for MCP
app.get('/sse', (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).json({ error: 'sessionId query parameter required' });
    return;
  }

  let session = getSession(sessionId);
  if (!session) {
    session = createSession();
    console.log(`[mcp-http] Created new session for SSE: ${session.id}`);
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Add client to session
  session.sseClients.add(res);
  console.log(`[mcp-http][${session.id}] SSE client connected (${session.sseClients.size} total)`);

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', sessionId: session.id })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    session?.sseClients.delete(res);
    console.log(`[mcp-http][${session?.id}] SSE client disconnected`);
  });
});

// POST endpoint for sending messages to MCP server
app.post('/message', async (req: Request, res: Response) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    res.status(400).json({ error: 'sessionId and message required' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    const response = await sendToMcpServer(session, message);
    res.json(response);
  } catch (error: any) {
    console.error(`[mcp-http][${sessionId}] Error sending message:`, error);
    res.status(500).json({
      error: 'Failed to send message',
      message: error.message,
    });
  }
});

// Close session
app.delete('/session/:sessionId', (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  session.child.kill();
  sessions.delete(sessionId);

  res.json({ message: 'Session closed' });
});

// ============================================================================
// Start Server
// ============================================================================

app.listen(PORT, () => {
  console.log(`[mcp-http] MCP HTTP/SSE server listening on http://localhost:${PORT}`);
  console.log(`[mcp-http] MCP server path: ${MCP_SERVER_PATH}`);
  console.log(`[mcp-http] Endpoints:`);
  console.log(`[mcp-http]   - GET  /health`);
  console.log(`[mcp-http]   - POST /session (create session)`);
  console.log(`[mcp-http]   - GET  /sse?sessionId=<id> (SSE transport)`);
  console.log(`[mcp-http]   - POST /message (send message)`);
  console.log(`[mcp-http]   - DELETE /session/:id (close session)`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[mcp-http] Shutting down...');
  for (const [id, session] of sessions.entries()) {
    console.log(`[mcp-http] Killing session ${id}`);
    session.child.kill();
  }
  process.exit(0);
});
