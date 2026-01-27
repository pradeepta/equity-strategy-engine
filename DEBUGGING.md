# Debugging Guide - All Services

This guide explains how to debug all services (Node.js TypeScript and Python) in the trading system using VS Code/Cursor.

## Overview

The system has 6 main processes:
1. **LIVE** (Node.js/TypeScript) - Multi-strategy orchestrator (`live-multi.ts`) - Port 9229
2. **API** (Node.js/TypeScript) - Portfolio API server (`portfolio-api-server.ts`) - Port 9230
3. **MCP** (Node.js/TypeScript) - MCP tools server (`mcp-server.ts`) - Port 9231
4. **TWS** (Python) - TWS Bridge server (`tws-bridge-server/server.py`) - Port 5678
5. **WEB** (Next.js) - Web dashboard (`web-client`) - Port 9232
6. **AI** (Node.js/TypeScript) - AI Gateway (`ai-gateway-live`) - Port 9233

All processes can be debugged with breakpoints simultaneously!

---

## Quick Start - Debug All Services

### Step 1: Start Services in Debug Mode

```bash
# Terminal 1: Start all services with debugging enabled
npm run dev:all:debug
```

This starts all 6 services with debug ports open.

### Step 2: Attach Debuggers

In VS Code/Cursor:

1. Open the **Run and Debug** panel (⇧⌘D or Ctrl+Shift+D)
2. Select **"Attach to ALL Services"** from the dropdown
3. Click the green play button ▶️

This attaches debuggers to all 6 processes simultaneously!

### Step 3: Set Breakpoints

Open any file and click in the left gutter to set breakpoints:

**TypeScript/Node.js files:**
- `live/StrategyInstance.ts`
- `broker/twsAdapter.ts`
- `portfolio-api-server.ts`
- `mcp-server.ts`

**Python files:**
- `tws-bridge-server/tws/streaming_manager.py` (line 80 for bar updates)
- `tws-bridge-server/api/websocket.py`
- `tws-bridge-server/tws/bar_fetcher.py`

### Step 4: Debug!

When code execution hits your breakpoint:
- **Step Over** (F10)
- **Step Into** (F11)
- **Step Out** (⇧F11)
- **Continue** (F5)
- **Inspect variables** in the left sidebar
- **Watch expressions** in the Watch panel
- **View call stack** in the Call Stack panel

---

## Debug Individual Services

If you only want to debug one service at a time:

### Debug LIVE Orchestrator Only

```bash
# Terminal 1: Start all OTHER services normally
npm run dev:all

# Terminal 2: Stop the LIVE process (Ctrl+C in Terminal 1)
# Then run LIVE in debug mode:
npm run live:multi:debug
```

**In VS Code/Cursor:**
1. Run and Debug panel
2. Select **"Attach: LIVE (port 9229)"**
3. Click play ▶️

### Debug API Server Only

```bash
npm run portfolio:api:dev:debug
```

**Attach:** Select "Attach: API (port 9230)"

### Debug MCP Server Only

```bash
npm run mcp:dev:debug
```

**Attach:** Select "Attach: MCP (port 9231)"

### Debug Python TWS Bridge Only

```bash
npm run tws:bridge:debug
```

**Attach:** Select "Attach: TWS Python (port 5678)"

---

## Standalone Launch (Alternative Method)

You can also **launch** services directly from VS Code instead of attaching:

1. Run and Debug panel
2. Select one of:
   - **"Launch: LIVE (standalone)"**
   - **"Launch: API (standalone)"**
   - **"Launch: MCP (standalone)"**
   - **"Launch: TWS Python (standalone)"**
3. Click play ▶️

This starts the service with the debugger already attached.

**Use Case:** When you want to debug startup code that runs before you can manually attach.

---

## Debugging Tips

### Finding the Right Breakpoint Location

**1. For Real-Time Bar Updates (Python):**
Set breakpoint at `tws-bridge-server/tws/streaming_manager.py:80`
```python
def _handle_bar_update(self, reqId: int, bar):
    # DEBUG: Log EVERY callback invocation
    logger.info(f"🔔 _handle_bar_update CALLED: reqId={reqId}, bar.date={bar.date}")  # <- BREAKPOINT HERE
```

**2. For Strategy Processing (TypeScript):**
Set breakpoint at `live/StrategyInstance.ts` in `processBar()` method
```typescript
async processBar(bar: Bar, options?: { replay?: boolean }): Promise<void> {
  // BREAKPOINT at first line
  const { replay = false } = options || {};
```

**3. For Order Submission (TypeScript):**
Set breakpoint at `broker/twsAdapter.ts` in `submitOrderPlan()` method
```typescript
async submitOrderPlan(plan: OrderPlan, env: RuntimeEnv): Promise<Order[]> {
  // BREAKPOINT at first line
  const { action, side, symbol, qty } = plan;
```

**4. For WebSocket Messages (Python):**
Set breakpoint at `tws-bridge-server/api/websocket.py:113`
```python
while True:
    # Receive message from client
    data = await websocket.receive_json()  # <- BREAKPOINT HERE
```

### Conditional Breakpoints

Right-click on a breakpoint → **Edit Breakpoint** → Add condition:

**TypeScript Example:**
```typescript
symbol === "XLE"  // Only break for XLE strategies
```

**Python Example:**
```python
reqId == 1003  # Only break for specific request ID
```

### Logpoints (No Execution Pause)

Right-click in gutter → **Add Logpoint**

**TypeScript Example:**
```typescript
Processing bar for {symbol} at {bar.timestamp}
```

**Python Example:**
```python
Bar update: reqId={reqId}, date={bar.date}, close={bar.close}
```

This logs without stopping execution!

### Debug Console

When paused at a breakpoint, use the **Debug Console** panel to:

**Inspect variables:**
```javascript
// TypeScript/JavaScript
symbol
bar.close
this.lastStateName
```

```python
# Python
subscription.symbol
bar.close
len(self.subscriptions)
```

**Execute code:**
```javascript
// TypeScript
console.log(JSON.stringify(bar, null, 2))
```

```python
# Python
logger.info(f"Current subscriptions: {len(self.subscriptions)}")
```

---

## Common Issues

### Issue: "Cannot connect to runtime process"

**Solution:** Make sure the service is running in debug mode first.

```bash
# Check if process is listening on debug port
lsof -i :9229  # LIVE
lsof -i :9230  # API
lsof -i :9231  # MCP
lsof -i :5678  # TWS Python
```

### Issue: Breakpoints show as "Unverified" (gray circle)

**TypeScript:** Source maps might be off.
- Check `tsconfig.json` has `"sourceMap": true`
- Restart the service

**Python:** Path mapping might be wrong.
- Check `.vscode/launch.json` pathMappings
- Ensure you're running from correct directory

### Issue: Python breakpoints not working

**Check debugpy is installed:**
```bash
cd tws-bridge-server
source venv/bin/activate
pip show debugpy
```

**Check DEBUG_ENABLED is set:**
```bash
echo $DEBUG_ENABLED  # Should output "true"
```

**Check server logs for:**
```
🐛 Python debugger listening on port 5678
```

### Issue: Breakpoint in streaming_manager.py never hits

**Possible causes:**
1. TWS not sending updates (market closed, no trades)
2. Subscription not active (check `self.subscriptions` dict)
3. Wrong reqId (check logs for actual reqId)

**Debug steps:**
1. Set breakpoint in `subscribe()` method first to see if subscription is created
2. Check `StreamingManager` is initialized: Look for log `🔧 Streaming Manager initialized`
3. Check callback is registered: Look for log `🔧 Registered callback: <bound method...>`
4. Wait 30-60 seconds after subscription (TWS can be slow)

---

## Debug Ports Reference

| Service | Type | Debug Port | Attach Command |
|---------|------|-----------|----------------|
| LIVE | Node.js | 9229 | Attach: LIVE (port 9229) |
| API | Node.js | 9230 | Attach: API (port 9230) |
| MCP | Node.js | 9231 | Attach: MCP (port 9231) |
| TWS Python | Python | 5678 | Attach: TWS Python (port 5678) |
| WEB | Node.js | 9232 | Attach: Next.js Web (port 9232) |
| AI Gateway | Node.js | 9233 | Attach: AI Gateway (port 9233) |

---

## Environment Variables

**Enable Python debugging:**
```bash
export DEBUG_ENABLED=true
```

**Or set in npm script:**
```json
"tws:bridge:debug": "DEBUG_ENABLED=true python server.py"
```

---

## VS Code Extensions Required

Make sure you have these extensions installed:

1. **Python** (ms-python.python) - For Python debugging
2. **Debugger for Chrome** (msjsdiag.debugger-for-chrome) - For web debugging (optional)

Check installed extensions:
- Open Extensions panel (⇧⌘X)
- Search for "Python"
- Click "Install" if not already installed

---

## Advanced: Remote Debugging

If running services on a different machine:

**1. Update `.vscode/launch.json`:**
```json
{
  "name": "Attach: Remote TWS Python",
  "type": "python",
  "request": "attach",
  "connect": {
    "host": "192.168.1.100",  // Remote IP
    "port": 5678
  }
}
```

**2. Ensure port is accessible:**
```bash
# On remote machine
ufw allow 5678/tcp
```

**3. Start debugpy with public bind:**
```python
debugpy.listen(("0.0.0.0", 5678))  # Already configured in server.py
```

---

## Summary Commands

```bash
# Start all services with debugging
npm run dev:all:debug

# Individual debug mode
npm run live:multi:debug        # LIVE on port 9229
npm run portfolio:api:dev:debug # API on port 9230
npm run mcp:dev:debug           # MCP on port 9231
npm run tws:bridge:debug        # TWS Python on port 5678

# Check if debug ports are open
lsof -i :9229,:9230,:9231,:5678

# Kill a stuck debug process
kill $(lsof -t -i:9229)  # LIVE
kill $(lsof -t -i:5678)  # TWS Python
```

---

## Next Steps

1. **Start services:** `npm run dev:all:debug`
2. **Open Run & Debug panel:** ⇧⌘D
3. **Select "Attach to ALL Services"**
4. **Click play** ▶️
5. **Set breakpoints** in your code
6. **Trigger the code path** (e.g., process a bar, submit order)
7. **Debug!** Step through, inspect variables, etc.

Happy debugging! 🐛
