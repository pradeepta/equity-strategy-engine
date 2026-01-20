# Web Dashboard — Local Rules

## Overview
Next.js 14 single-page application providing a real-time trading dashboard with chat interface, portfolio metrics, and system monitoring.

## Stack
- **Framework:** Next.js 14.2.8 with App Router
- **Language:** TypeScript 5.3.3
- **UI:** Custom CSS (no framework), React Markdown
- **State:** React Hooks (useState, useEffect, useRef)
- **Communication:** WebSocket (ACP agent), HTTP polling (Portfolio API)

## Key Directories
- `/app/` - App router pages and layout
  - `page.tsx` - Main dashboard component (1143 lines)
  - `layout.tsx` - Root layout with metadata
  - `globals.css` - Custom design system (1015 lines)
  - `/components/` - Reusable components
    - `LogsViewer.tsx` - System logs viewer
    - `AuditLogsViewer.tsx` - Order audit trail
- `/src/lib/` - Utilities and API clients
  - `acpClient.ts` - WebSocket client for AI agent

## Component Architecture

### Main Dashboard (`page.tsx`)
Four-tab interface with shared state:

1. **Chat Tab**
   - WebSocket connection to ACP agent (port 8787)
   - Message streaming with chunk merging
   - Image attachment support (drag-and-drop)
   - Session persistence via localStorage
   - Keyboard shortcuts (Enter to send, Shift+Enter for newline)

2. **Portfolio Tab**
   - HTTP polling every 10s to Portfolio API (port 3002)
   - Metrics cards (P&L, positions, strategies, orders)
   - Position table with live unrealized P&L
   - Strategy performance table
   - Recent trades table
   - Strategy detail modal
   - Close strategy functionality

3. **Audit Logs Tab**
   - Order event tracking (submitted, filled, cancelled, etc.)
   - Filter by event type, symbol, strategy name
   - Summary statistics and breakdown
   - Detail modal with full context

4. **System Logs Tab**
   - Application logs from Winston + Prisma
   - Filter by level (ERROR, WARN, INFO, DEBUG), component, search
   - Log statistics dashboard
   - Recent errors and top components
   - Auto-refresh capability

### State Management Pattern
```typescript
// Component state
const [activeTab, setActiveTab] = useState('chat')
const [messages, setMessages] = useState([])
const [portfolioData, setPortfolioData] = useState(null)

// Data fetching with useEffect
useEffect(() => {
  const interval = setInterval(() => {
    fetchPortfolioData()
  }, 10000)
  return () => clearInterval(interval)
}, [])

// Shared WebSocket client via useMemo
const acpClient = useMemo(() => new ACPClient(url), [url])
```

## Design System

### Color Palette
Define in `globals.css` `:root`:
```css
--bg-primary: #faf8f5;      /* Warm beige background */
--color-primary: #f55036;    /* Red-orange accent */
--text-primary: #1a1a1a;     /* Near black */
--text-secondary: #737373;   /* Medium gray */
--border-color: #ebe6dd;     /* Light warm gray */
```

### Status Colors
- **Active/Success:** Green (`#10b981`)
- **Closed/Cancelled:** Gray (`#6b7280`)
- **Pending/Draft:** Amber (`#f59e0b`)
- **Filled/Submitted:** Blue (`#3b82f6`)
- **Error/Rejected:** Red (`#ef4444`)

### UI Patterns
- **Modals:** Fade-in overlay + slide-up animation
- **Tables:** Hover effects, responsive, sticky headers
- **Cards:** Grid layout with shadow on hover
- **Forms:** Custom controls matching design system
- **Loading:** Typing dots animation for streaming content
- **Notifications:** Auto-dismiss banner at top

## Conventions

### Components
- **PascalCase:** `LogsViewer`, `AuditLogsViewer`
- **One per file:** Keep components focused
- **Server components by default:** Add `'use client'` only when needed (state, effects, events)
- **Co-locate styles:** Use `globals.css` for shared styles, inline for component-specific

### State & Props
- **camelCase:** `activeTab`, `portfolioData`, `isLoading`
- **Boolean props:** Prefix with `is`, `has`, `should` (e.g., `isLoading`, `hasError`)
- **Event handlers:** Prefix with `handle` (e.g., `handleTabChange`, `handleCloseStrategy`)

### API Integration
- **Base URLs from env:** Use `NEXT_PUBLIC_*` variables
- **Error handling:** Always wrap fetch in try-catch
- **Loading states:** Show loading UI while fetching
- **Polling:** Use `setInterval` with cleanup in `useEffect`

### WebSocket Client
- **Session management:** Store session ID in localStorage
- **Reconnection:** Handle disconnect/reconnect gracefully
- **Message format:** JSON-RPC 2.0 for ACP protocol
- **Streaming:** Merge chunks for progressive display

## API Endpoints

### Portfolio API (HTTP)
Base URL: `http://localhost:3002`

- `GET /api/portfolio/overview` - Portfolio data, strategies, trades
- `POST /api/portfolio/strategies/{id}/close` - Close active strategy
- `GET /api/logs` - System logs with filters (level, component, search)
- `GET /api/logs/stats` - Log statistics (counts by level, top components)

### ACP Agent (WebSocket)
Base URL: `ws://localhost:8787/acp`

- Protocol: JSON-RPC 2.0
- Methods: `sendMessage`, `streamResponse`
- Session: Persisted via localStorage key `acpSessionId`

## Development Workflow

### Running Locally
```bash
# Install dependencies
npm install

# Development mode (port 3000)
npm run dev

# Production build
npm run build
npm start
```

### Prerequisites
- Portfolio API server running on port 3002
- ACP Gateway running on port 8787 (optional, for chat)
- MCP server running on port 3001 (optional, for agent tools)

### Adding a New Tab
1. Add tab to `tabs` array in `page.tsx`:
   ```typescript
   const tabs = [
     { id: 'chat', label: 'Chat' },
     { id: 'new-tab', label: 'New Tab' }
   ]
   ```
2. Implement tab content in conditional render
3. Add state for tab-specific data
4. Add API integration if needed
5. Add styles to `globals.css`

### Adding a New API Endpoint
1. Implement in `portfolio-api-server.ts` (root)
2. Add TypeScript types for request/response
3. Add fetch function in component
4. Handle loading/error states
5. Update UI to display data

### Customizing Design
1. Edit CSS custom properties in `globals.css` `:root`
2. Update color palette variables
3. Modify component-specific styles
4. Test across tabs for consistency

## Testing

### Manual Testing Checklist
- **Chat:** Send message, verify streaming, test image attachment
- **Portfolio:** Verify metrics, position table, strategy table, close strategy
- **Audit Logs:** Filter by event type, verify detail modal
- **System Logs:** Filter by level/component, verify auto-refresh
- **Responsive:** Test on different screen sizes
- **Performance:** Check polling intervals, memory leaks

### Common Issues

**WebSocket not connecting:**
- Verify ACP Gateway is running on port 8787
- Check `NEXT_PUBLIC_ACP_URL` in env
- Check browser console for errors

**Portfolio data not loading:**
- Verify Portfolio API is running on port 3002
- Check network tab for failed requests
- Verify CORS settings if needed

**Styling issues:**
- Clear Next.js cache: `rm -rf .next`
- Verify CSS import in `layout.tsx`
- Check browser DevTools for CSS errors

## Safety Rails
- **No secrets in code:** Use environment variables
- **Never commit `.env.local`:** Already in `.gitignore`
- **Validate user input:** Sanitize before sending to API
- **Error boundaries:** Wrap components to catch errors
- **Session security:** Use secure WebSocket (wss://) in production

## Examples

### Adding a Modal
```typescript
const [showModal, setShowModal] = useState(false)
const [modalData, setModalData] = useState(null)

const handleOpenModal = (data) => {
  setModalData(data)
  setShowModal(true)
}

// In JSX:
{showModal && (
  <div className="modal-overlay" onClick={() => setShowModal(false)}>
    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
      {/* Modal content */}
    </div>
  </div>
)}
```

### Polling Pattern
```typescript
useEffect(() => {
  const fetchData = async () => {
    try {
      const response = await fetch('/api/endpoint')
      const data = await response.json()
      setData(data)
    } catch (error) {
      console.error('Fetch error:', error)
    }
  }

  fetchData() // Initial fetch
  const interval = setInterval(fetchData, 10000) // Poll every 10s
  return () => clearInterval(interval) // Cleanup
}, [])
```

### WebSocket Integration
```typescript
const acpClient = useMemo(() => new ACPClient(wsUrl), [wsUrl])

const sendMessage = async (text) => {
  try {
    await acpClient.sendMessage(text, sessionId)
    // Handle response
  } catch (error) {
    console.error('Send error:', error)
  }
}
```

---

**Related Files:**
- Root: `/CLAUDE.md` - Full project guide
- API: `/portfolio-api-server.ts` - Backend API implementation
- Gateway: `/ai-gateway-live/CLAUDE.md` - AI agent gateway
