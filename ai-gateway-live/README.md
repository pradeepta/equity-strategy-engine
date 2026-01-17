# AI Gateway Live

WebSocket-only ACP gateway for Claude Code clients.

## Features
- WebSocket server at `ws://localhost:8787/acp`
- Multi-client support with per-session agent processes
- Reconnects via `sessionId` query param
- No HTTP endpoints, DB, memory, or learning components

## Install
```bash
npm install
```

## Run
```bash
npm run dev
```

## Configure
Environment variables:
- `PORT` (default: `8787`)
- `AGENT_CMD` (default: `npx -y @zed-industries/claude-code-acp@latest --timeout 180000`)
- `AGENT_CMD_<PERSONA>` (optional override per persona)
- `RECONNECT_WINDOW_MS` (default: 1 hour)
- `AUTO_APPROVE_PERMISSIONS` (default: `false`) - When `true`, automatically approves all tool permission requests
- `MCP_SERVERS_JSON` (optional JSON array of MCP server configs to auto-append on `session/new`)

## Connect
WebSocket endpoint: `ws://localhost:8787/acp`

Optional query params:
- `sessionId`: reconnect to an existing session
- `persona`: used to select `AGENT_CMD_<PERSONA>`
- `agent`: explicit agent command override

Example:
```
ws://localhost:8787/acp?sessionId=my-session&persona=engineer
```

## MCP Server Support

**Important:** The ACP agent (`@zed-industries/claude-code-acp`) only supports HTTP/SSE-based MCP servers, not stdio-based servers.

### How MCP Servers are Handled

1. **Client sends MCP server configs** - Clients can send any MCP server configuration (stdio, http, sse) in the `session/new` request
2. **Gateway filters unsupported types** - The gateway automatically filters out `stdio` type servers and only passes `http`/`sse` servers to the ACP agent
3. **Warnings logged** - When stdio servers are filtered out, a warning is logged with the server name

This means:
- ✅ Clients can include stdio MCP server configs without causing errors
- ⚠️ Stdio servers will be silently filtered out (with a warning logged)
- ✅ HTTP/SSE servers will work as expected

### Configuring MCP Servers

**From the client:**
```typescript
mcpServers: [
  {
    name: "stocks-mcp",
    type: "stdio",  // Will be filtered out by gateway
    command: "node",
    args: ["/path/to/mcp-server.js"]
  },
  {
    name: "example-http-mcp",
    type: "sse",  // Will be passed to ACP agent
    url: "http://localhost:3000/mcp",
    headers: [],
    env: []
  }
]
```

**Via environment variable (`MCP_SERVERS_JSON`):**
```json
[
  {
    "name": "example-mcp",
    "type": "sse",
    "url": "http://localhost:3000/mcp",
    "headers": [],
    "env": []
  }
]
```

## Auto-Approve Tool Permissions

The gateway can automatically approve tool permission requests from the ACP agent, allowing for a seamless experience without manual permission prompts.

**How it works:**
1. When the ACP agent requests permission to use a tool, it sends a `session/request_permission` JSON-RPC message
2. The gateway intercepts this message before forwarding it to the client
3. If `AUTO_APPROVE_PERMISSIONS=true`, the gateway automatically responds with an approval
4. The message is still forwarded to the client for transparency

**Option Priority:**
The gateway selects permissions in this order:
1. `allow` - Standard allow option
2. `allow_once` - Allow for this single use
3. `allow_always` - Remember the approval
4. First available option - Fallback if none of the above exist

**Configuration:**
Set `AUTO_APPROVE_PERMISSIONS=true` in your `.env` file or environment variables.

**Security Note:** Only enable auto-approve in trusted environments where you're comfortable with the agent using tools without explicit confirmation.

## Notes
This gateway forwards JSON-RPC messages between the client and a spawned ACP agent process.

The gateway automatically merges any MCP servers from `MCP_SERVERS_JSON` with those provided by the client in `session/new` requests.
