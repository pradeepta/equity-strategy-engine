# Algorithmic Trading System

A complete algorithmic trading system that lets you define trading strategies in simple YAML format, compile them into type-safe executable code, backtest them against historical data, and deploy them to live trading on Alpaca.

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

### 📈 Workflow

```
YAML Strategy → Compile to Typed IR → Backtest on Historical Data → Deploy Live to Alpaca
```

## Quick Start

1. Define your strategy in YAML
2. Compile to type-safe intermediate representation
3. Backtest against historical data
4. Deploy live with real risk management

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md) - Get started in 15 minutes
- [Architecture](docs/ARCHITECTURE.md) - System design and architecture
- [Strategy Capabilities](docs/STRATEGY_CAPABILITIES.md) - Available strategy types
- [Complete Strategy Suite](docs/COMPLETE_STRATEGY_SUITE.md) - All 148 variations
- [Live Trading Setup](docs/LIVE_TRADING_SETUP.md) - Deployment guide
