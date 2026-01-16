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

## Notes
This gateway forwards JSON-RPC messages between the client and a spawned ACP agent process.
