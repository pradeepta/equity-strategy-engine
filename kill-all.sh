#!/bin/bash
# Kill all services started by npm run dev:all:debug

echo "🛑 Stopping all services..."

# Kill Node.js processes by debug port
echo "Killing Node.js services..."
lsof -ti:9229 | xargs kill -9 2>/dev/null && echo "  ✓ Killed LIVE (port 9229)" || echo "  ⊘ LIVE not running"
lsof -ti:9230 | xargs kill -9 2>/dev/null && echo "  ✓ Killed API (port 9230)" || echo "  ⊘ API not running"
lsof -ti:9231 | xargs kill -9 2>/dev/null && echo "  ✓ Killed MCP (port 9231)" || echo "  ⊘ MCP not running"
lsof -ti:9233 | xargs kill -9 2>/dev/null && echo "  ✓ Killed AI Gateway (port 9233)" || echo "  ⊘ AI not running"

# Kill Next.js web server
lsof -ti:8001 | xargs kill -9 2>/dev/null && echo "  ✓ Killed Next.js Web (port 8001)" || echo "  ⊘ Web not running"

# Kill Python TWS bridge
echo "Killing Python TWS bridge..."
lsof -ti:3003 | xargs kill -9 2>/dev/null && echo "  ✓ Killed TWS Python (port 3003)" || echo "  ⊘ TWS not running"
pkill -f "server.py" 2>/dev/null && echo "  ✓ Killed server.py processes" || true

# Kill debugpy (Python debugger)
lsof -ti:5678 | xargs kill -9 2>/dev/null && echo "  ✓ Killed debugpy (port 5678)" || echo "  ⊘ debugpy not running"

# Kill concurrently process (parent)
pkill -f "concurrently.*dev:all:debug" 2>/dev/null && echo "  ✓ Killed concurrently" || true

# Kill any remaining ts-node processes from this project
pgrep -f "ts-node.*live-multi.ts" | xargs kill -9 2>/dev/null && echo "  ✓ Killed live-multi.ts" || true
pgrep -f "ts-node.*portfolio-api-server.ts" | xargs kill -9 2>/dev/null && echo "  ✓ Killed portfolio-api-server.ts" || true
pgrep -f "ts-node.*mcp-server.ts" | xargs kill -9 2>/dev/null && echo "  ✓ Killed mcp-server.ts" || true

# Clean up ts-node cache
if [ -d ".ts-node" ]; then
  echo "Cleaning ts-node cache..."
  rm -rf .ts-node
  echo "  ✓ Removed .ts-node cache"
fi

echo ""
echo "✅ All services stopped and cache cleared"
echo ""
echo "To restart: npm run dev:all:debug"
