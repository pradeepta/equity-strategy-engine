# AI Gateway — Local Rules

## Overview
WebSocket server providing AI agent interface for real-time trading advice and strategy management. Implements Agent Control Protocol (ACP) with Claude integration.

## Purpose
- Enable AI-powered trading advice via chat interface
- Expose MCP tools to AI agents for strategy operations
- Handle streaming responses for better UX
- Manage agent sessions and context

## Stack
- **Runtime:** Bun 1.1.43
- **Framework:** WebSocket-based JSON-RPC 2.0
- **AI Provider:** Anthropic Claude SDK
- **Protocol:** Agent Control Protocol (ACP)
- **Language:** TypeScript

## Key Files
- `src/index.ts` - **Main server** and WebSocket listener
  - Server initialization
  - Connection handling
  - Message routing
- `src/agentHandler.ts` - **Agent message processor**
  - Claude API integration
  - Tool execution
  - Response streaming
- `src/wsHandler.ts` - **WebSocket message handler**
  - JSON-RPC 2.0 parsing
  - Session management
  - Error handling
- `src/config.ts` - **Agent persona configuration**
  - System prompts
  - Persona definitions (blackrock_advisor, etc.)
  - Tool permissions

## Architecture

### Message Flow
```
Web Client (WebSocket)
  ↓
JSON-RPC 2.0 Request
  ↓
wsHandler (parse & validate)
  ↓
agentHandler (process with Claude)
  ├─ Load persona config
  ├─ Build system prompt
  ├─ Call Claude API (streaming)
  └─ Execute MCP tools if requested
  ↓
Stream JSON-RPC 2.0 Responses
  ↓
Web Client (render markdown)
```

### Protocol (ACP)

**Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "sendMessage",
  "params": {
    "sessionId": "uuid",
    "message": "What strategies are active?",
    "persona": "blackrock_advisor"
  },
  "id": 1
}
```

**Response (streaming):**
```json
// Chunk 1
{
  "jsonrpc": "2.0",
  "result": {
    "type": "chunk",
    "content": "Let me check the active strategies..."
  },
  "id": 1
}

// Chunk 2
{
  "jsonrpc": "2.0",
  "result": {
    "type": "chunk",
    "content": " You have 3 active strategies:\n- AAPL RSI..."
  },
  "id": 1
}

// Final
{
  "jsonrpc": "2.0",
  "result": {
    "type": "done",
    "content": "Full response text",
    "sessionId": "uuid"
  },
  "id": 1
}
```

## Conventions

### Agent Personas
Define in `src/config.ts`:

```typescript
export const PERSONAS = {
  blackrock_advisor: {
    name: 'BlackRock Advisor',
    systemPrompt: `You are a senior portfolio manager...`,
    model: 'claude-sonnet-4-5',
    temperature: 0.7,
    tools: ['get_active_strategies', 'get_portfolio_overview', ...]
  }
}
```

### Tool Integration
Agent can call MCP tools via Claude's tool use:

```typescript
// Claude requests tool
{
  type: 'tool_use',
  name: 'get_active_strategies',
  input: {}
}

// Execute via MCP client
const result = await mcpClient.callTool('get_active_strategies', {})

// Return to Claude
{
  type: 'tool_result',
  tool_use_id: '...',
  content: JSON.stringify(result)
}
```

### Session Management
- **Session ID:** UUID stored in localStorage (client-side)
- **Context:** Maintain conversation history per session
- **Timeout:** Sessions expire after 1 hour of inactivity
- **Cleanup:** Periodic cleanup of expired sessions

### Error Handling
```typescript
// Wrap all operations in try-catch
try {
  const response = await handleAgentMessage(params)
  sendSuccess(ws, id, response)
} catch (error) {
  logger.error('[AgentHandler] Error', { error })
  sendError(ws, id, error.message)
}

// Send JSON-RPC 2.0 error
function sendError(ws: WebSocket, id: number, message: string) {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id
  }))
}
```

### Logging
- **Component tagging:** `[AgentHandler]`, `[WSHandler]`
- **Structured metadata:** Include session ID, persona, user ID
- **Log levels:** error (issues), info (key events), debug (details)

Example:
```typescript
logger.info('[AgentHandler] Message received', {
  sessionId,
  persona,
  messageLength: message.length
})
```

## Development Workflow

### Running Locally
```bash
# Install dependencies (Bun)
bun install

# Development mode (port 8787)
bun run dev

# Production mode
bun run start
```

### Environment Variables
```bash
ANTHROPIC_API_KEY=sk-ant-...     # Claude API key
MCP_SERVER_URL=http://127.0.0.1:3001/mcp  # MCP server endpoint
PORT=8787                         # WebSocket server port
LOG_LEVEL=info                    # Logging level
```

### Testing Agent Responses
1. Start AI gateway: `bun run dev`
2. Start MCP server: `npm run mcp` (in root)
3. Open web dashboard: `cd web-client && npm run dev`
4. Navigate to Chat tab
5. Send test message: "What strategies are active?"

### Adding a New Persona
1. Add to `src/config.ts`:
   ```typescript
   export const PERSONAS = {
     ...existing,
     my_persona: {
       name: 'My Persona',
       systemPrompt: 'You are a...',
       model: 'claude-sonnet-4-5',
       temperature: 0.7,
       tools: ['tool1', 'tool2']
     }
   }
   ```
2. Update client to use new persona
3. Test with various prompts

### Adding Tool Access
1. Ensure tool exists in MCP server (`mcp-server.ts`)
2. Add tool name to persona's `tools` array in config
3. Update system prompt to mention new capability
4. Test tool execution through agent

### Debugging Issues

**WebSocket not connecting:**
- Verify server is running on correct port (8787)
- Check `NEXT_PUBLIC_ACP_URL` in web-client `.env`
- Review browser console for errors
- Check server logs for connection attempts

**Agent not responding:**
- Verify `ANTHROPIC_API_KEY` is set
- Check Claude API status
- Review server logs for errors
- Test with simple message first

**Tool execution failing:**
- Verify MCP server is running (port 3001)
- Check `MCP_SERVER_URL` is correct
- Review MCP server logs
- Test tool directly via MCP client

## Common Patterns

### Streaming Response
```typescript
async function streamAgentResponse(
  ws: WebSocket,
  requestId: number,
  messages: Message[]
) {
  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-5',
    messages,
    stream: true
  })

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta') {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        result: { type: 'chunk', content: chunk.delta.text },
        id: requestId
      }))
    }
  }

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    result: { type: 'done', content: fullText },
    id: requestId
  }))
}
```

### Tool Execution Loop
```typescript
async function handleToolUse(toolUse: ToolUse): Promise<ToolResult> {
  const mcpClient = new MCPClient(MCP_SERVER_URL)

  try {
    const result = await mcpClient.callTool(toolUse.name, toolUse.input)
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify(result)
    }
  } catch (error) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify({ error: error.message }),
      is_error: true
    }
  }
}
```

### Session Context Management
```typescript
const sessions = new Map<string, ConversationContext>()

function getOrCreateSession(sessionId: string): ConversationContext {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [],
      createdAt: Date.now(),
      lastActivity: Date.now()
    })
  }
  return sessions.get(sessionId)!
}

function updateSession(sessionId: string, message: Message) {
  const session = getOrCreateSession(sessionId)
  session.messages.push(message)
  session.lastActivity = Date.now()
}
```

## Safety Rails
- **API key security:** Never expose `ANTHROPIC_API_KEY` to client
- **Rate limiting:** Implement per-session rate limits
- **Input validation:** Sanitize all user inputs
- **Tool permissions:** Only allow whitelisted tools per persona
- **Error sanitization:** Don't expose internal errors to client

## Performance Considerations
- **Streaming:** Use streaming for better perceived performance
- **Session cleanup:** Periodic cleanup of inactive sessions
- **Connection pooling:** Reuse MCP client connections
- **Caching:** Cache persona configs and tool schemas
- **Compression:** Enable WebSocket compression for large responses

## Agent Workflow Example

**BlackRock Advisor Persona:**

1. **User:** "Should I deploy a new strategy on AAPL?"

2. **Agent gathers context:**
   - Calls `get_live_portfolio_snapshot` (real-time portfolio)
   - Calls `get_market_data` with symbol="AAPL"
   - Calls `get_active_strategies` (check for conflicts)

3. **Agent analyzes:**
   - Current portfolio exposure
   - Market conditions (volatility, trend)
   - Risk concentration

4. **Agent responds:**
   - Recommendation (yes/no/modify)
   - Reasoning based on data
   - Suggested parameters (position size, risk limits)
   - Option to create strategy if user approves

5. **If user approves:**
   - Agent calls `get_dsl_schema`
   - Creates YAML strategy
   - Calls `validate_strategy`
   - Calls `deploy_strategy`
   - Confirms deployment

## Examples

### Simple Chat Request
```json
// Request
{
  "jsonrpc": "2.0",
  "method": "sendMessage",
  "params": {
    "sessionId": "123",
    "message": "What's my portfolio P&L?",
    "persona": "blackrock_advisor"
  },
  "id": 1
}

// Agent calls get_portfolio_overview tool
// Agent responds with formatted data
```

### Strategy Deployment Request
```json
// Request
{
  "jsonrpc": "2.0",
  "method": "sendMessage",
  "params": {
    "sessionId": "123",
    "message": "Deploy RSI strategy on TSLA",
    "persona": "blackrock_advisor"
  },
  "id": 2
}

// Agent workflow:
// 1. get_live_portfolio_snapshot (check exposure)
// 2. get_market_data (TSLA recent data)
// 3. get_active_strategies (check conflicts)
// 4. get_dsl_schema (schema reference)
// 5. validate_strategy (validate YAML)
// 6. deploy_strategy (if approved)
```

---

**Related Files:**
- Root: `/CLAUDE.md` - Full project guide
- Web Client: `/web-client/src/lib/acpClient.ts` - WebSocket client
- MCP Server: `/mcp-server.ts` - Tool definitions and handlers
- Workflow: `/docs/agent-workflow-example.md` - Detailed deployment workflow
