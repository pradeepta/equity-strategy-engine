# Algorithmic Trading System

A complete algorithmic trading system that lets you define trading strategies in simple YAML format, compile them into type-safe executable code, backtest them against historical data, and deploy them to live trading on Alpaca.

**Now available as an MCP Server!** Use this system programmatically through the Model Context Protocol in Claude Desktop, IDEs, or custom applications.

## Features

### 🎯 Strategy Definition

- **YAML-based DSL**: Define strategies using a professional-grade Domain-Specific Language
- **29+ Strategy Types**: Including RSI, Bollinger Bands, MACD, and hybrid multi-indicator combinations
- **Multi-Symbol Support**: Apply strategies across multiple stock symbols
- **148 Pre-generated Variations**: Ready-to-use strategy variations for immediate backtesting

### ⚙️ Runtime Engine

- **FSM-Based Architecture**: Finite State Machine manages complete trade lifecycle
- **Trade Management**: Automated entry/exit, stop losses, and profit targets
- **Risk Management**: Bracket orders and position sizing built-in

### 🔒 Type Safety

- **TypeScript**: Production-ready code with zero-cost abstractions
- **End-to-End Type Checking**: From strategy definition to broker integration
- **Verified Compilation**: All code is type-checked and verified

### 🔌 MCP Server Integration

- **Model Context Protocol**: Expose all capabilities as MCP tools
- **AI-Driven Trading**: Let AI assistants compile, validate, and backtest strategies
- **7 MCP Tools**: Complete API for strategy development and analysis
- **Claude Desktop Ready**: Drop-in configuration for immediate use

### 📈 Workflow

```
YAML Strategy → Compile to Typed IR → Backtest on Historical Data → Deploy Live to Alpaca
```

## Quick Start

### Command Line Usage

1. Define your strategy in YAML
2. Compile to type-safe intermediate representation
3. Backtest against historical data
4. Deploy live with real risk management

### MCP Server Usage

Run as an MCP server and let AI assistants interact with your trading system:

```bash
npm install
npm run build
npm run mcp
```

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "stocks-trading": {
      "command": "node",
      "args": ["/absolute/path/to/stocks/dist/mcp-server.js"]
    }
  }
}
```

Then ask Claude: "List available trading strategy types" or "Create and backtest an RSI strategy"

## Documentation

- [MCP Server Guide](MCP_SERVER_GUIDE.md) - Use as Model Context Protocol server
- [Quick Start Guide](docs/QUICKSTART.md) - Get started in 15 minutes
- [Architecture](docs/ARCHITECTURE.md) - System design and architecture
- [Strategy Capabilities](docs/STRATEGY_CAPABILITIES.md) - Available strategy types
- [Complete Strategy Suite](docs/COMPLETE_STRATEGY_SUITE.md) - All 148 variations
- [Live Trading Setup](docs/LIVE_TRADING_SETUP.md) - Deployment guide

## MCP Tools Available

When running as an MCP server, the following tools are exposed:

1. **compile_strategy** - Compile YAML strategy to type-safe IR
2. **validate_strategy** - Validate strategy against schema
3. **backtest_strategy** - Run backtests with historical data
4. **list_strategy_types** - Get all available strategy types and indicators
5. **get_strategy_template** - Generate YAML templates for specific strategies
6. **analyze_strategy_performance** - Calculate performance metrics
7. **create_live_engine** - Create live trading engine (dry-run by default)

See [MCP_SERVER_GUIDE.md](MCP_SERVER_GUIDE.md) for detailed usage.
