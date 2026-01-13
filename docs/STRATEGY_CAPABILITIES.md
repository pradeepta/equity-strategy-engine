# Strategy Capabilities

> **Complete Reference for Available Indicators, Features, and Strategy Types**

This document catalogs all technical indicators, market microstructure features, and strategy patterns available in the trading system.

---

## Table of Contents

1. [Technical Indicators](#technical-indicators)
2. [Market Microstructure Features](#market-microstructure-features)
3. [Strategy Types](#strategy-types)
4. [Builtin Features](#builtin-features)
5. [Custom Functions](#custom-functions)
6. [Usage Examples](#usage-examples)

---

## Technical Indicators

### 1. RSI (Relative Strength Index)

**Description**: Momentum oscillator measuring speed and magnitude of price changes

**Parameters**:

- `period`: Lookback period (default: 14)

**Range**: 0-100

**Usage**:

```yaml
features:
  - name: rsi
    type: indicator
    params:
      period: 14
```

**Common Patterns**:

- Overbought: RSI > 70
- Oversold: RSI < 30
- Divergence: Price makes new high/low but RSI doesn't
- Trend confirmation: RSI > 50 (bullish), RSI < 50 (bearish)

**Example Conditions**:

```yaml
# Mean reversion
arm: "rsi < 30"
trigger: "rsi > 35"

# Trend following
arm: "rsi > 50"
trigger: "rsi > 60"
```

---

### 2. Bollinger Bands

**Description**: Volatility-based bands showing standard deviation channels

**Parameters**:

- `period`: Moving average period (default: 20)
- `stdDev`: Standard deviations (default: 2)

**Output Features**:

- `bb_upper`: Upper band
- `bb_middle`: Middle band (SMA)
- `bb_lower`: Lower band
- `bb_width`: Band width (volatility measure)

**Usage**:

```yaml
features:
  - name: bb
    type: indicator
    params:
      period: 20
      stdDev: 2
```

**Common Patterns**:

- **Bounce**: Buy at lower band, sell at upper band
- **Squeeze**: Low volatility (narrow bands) → breakout imminent
- **Expansion**: High volatility (wide bands) → fade extremes
- **Walk**: Price walks along upper/lower band in strong trends

**Example Conditions**:

```yaml
# Lower band bounce
arm: "close < bb_lower"
trigger: "close > bb_lower"

# Squeeze breakout
arm: "bb_width < 0.02"
trigger: "close > bb_upper"

# Upper band rejection
arm: "close > bb_upper"
trigger: "close < bb_middle"
```

---

### 3. MACD (Moving Average Convergence Divergence)

**Description**: Trend-following momentum indicator

**Parameters**:

- `fastPeriod`: Fast EMA (default: 12)
- `slowPeriod`: Slow EMA (default: 26)
- `signalPeriod`: Signal line EMA (default: 9)

**Output Features**:

- `macd`: MACD line
- `macd_signal`: Signal line
- `macd_histogram`: Histogram (macd - signal)

**Usage**:

```yaml
features:
  - name: macd
    type: indicator
    params:
      fastPeriod: 12
      slowPeriod: 26
      signalPeriod: 9
```

**Common Patterns**:

- **Bullish Crossover**: MACD crosses above signal
- **Bearish Crossover**: MACD crosses below signal
- **Zero Line Cross**: MACD crosses above/below zero
- **Divergence**: Price diverges from MACD direction
- **Histogram Expansion**: Momentum acceleration

**Example Conditions**:

```yaml
# Bullish crossover
trigger: "macd > macd_signal"

# Zero line breakout
arm: "macd > 0"
trigger: "macd > macd_signal && macd > 0"

# Histogram divergence
trigger: "macd_histogram > 0 && macd_histogram[1] < 0"
```

---

### 4. EMA (Exponential Moving Average)

**Description**: Weighted moving average emphasizing recent prices

**Parameters**:

- `period`: Lookback period

**Usage**:

```yaml
features:
  - name: ema20
    type: indicator
    params:
      period: 20

  - name: ema50
    type: indicator
    params:
      period: 50
```

**Common Patterns**:

- **Support/Resistance**: Price bounces off EMA
- **Crossover**: Fast EMA crosses slow EMA
- **Trend Filter**: Price above EMA = bullish, below = bearish

**Example Conditions**:

```yaml
# Golden cross
arm: "ema20 > ema50"
trigger: "close > ema20"

# EMA support bounce
arm: "close < ema20"
trigger: "close > ema20"
```

---

### 5. SMA (Simple Moving Average)

**Description**: Arithmetic average of prices over period

**Parameters**:

- `period`: Lookback period

**Usage**:

```yaml
features:
  - name: sma50
    type: indicator
    params:
      period: 50
```

**Common Patterns**:

- Similar to EMA but less responsive
- Better for longer-term trends
- Classic support/resistance levels

---

### 6. VWAP (Volume Weighted Average Price)

**Description**: Average price weighted by volume

**Parameters**: None (daily reset)

**Usage**:

```yaml
features:
  - name: vwap
    type: indicator
```

**Common Patterns**:

- **Institutional Benchmark**: Price above VWAP = bullish pressure
- **Mean Reversion**: Price extremes revert to VWAP
- **Trend Filter**: Trade direction of VWAP trend

**Example Conditions**:

```yaml
# VWAP reclaim
arm: "close < vwap"
trigger: "close > vwap"

# VWAP fade
arm: "close > vwap + 0.50"
trigger: "close < vwap"
```

---

### 7. ATR (Average True Range)

**Description**: Volatility indicator measuring price range

**Parameters**:

- `period`: Lookback period (default: 14)

**Usage**:

```yaml
features:
  - name: atr
    type: indicator
    params:
      period: 14
```

**Common Uses**:

- Position sizing based on volatility
- Stop loss placement (e.g., 2x ATR)
- Volatility breakout detection

---

### 8. Stochastic Oscillator

**Description**: Momentum indicator comparing closing price to price range

**Parameters**:

- `kPeriod`: %K period (default: 14)
- `dPeriod`: %D period (default: 3)

**Output Features**:

- `stoch_k`: %K line
- `stoch_d`: %D line (smoothed %K)

**Range**: 0-100

**Usage**:

```yaml
features:
  - name: stochastic
    type: indicator
    params:
      kPeriod: 14
      dPeriod: 3
```

**Common Patterns**:

- Overbought: > 80
- Oversold: < 20
- Crossovers: %K crosses %D

---

### 9. Volume Z-Score

**Description**: Standardized volume relative to moving average

**Parameters**:

- `period`: Lookback period (default: 20)

**Usage**:

```yaml
features:
  - name: vol_zscore
    type: indicator
    params:
      period: 20
```

**Interpretation**:

- `z > 2`: Unusually high volume (2σ above mean)
- `z < -2`: Unusually low volume (2σ below mean)
- `|z| < 1`: Normal volume

**Example Conditions**:

```yaml
# High volume breakout
trigger: "close > bb_upper && vol_zscore > 2"

# Low volume consolidation
arm: "vol_zscore < 0.5"
```

---

## Market Microstructure Features

### 1. Delta (Order Flow)

**Description**: Net difference between buy and sell volume

**Type**: `microstructure`

**Usage**:

```yaml
features:
  - name: delta
    type: microstructure
```

**Interpretation**:

- Positive delta: Buying pressure
- Negative delta: Selling pressure
- Large delta: Strong directional conviction

---

### 2. Absorption

**Description**: Detects when large volume fails to move price

**Type**: `microstructure`

**Usage**:

```yaml
features:
  - name: absorption
    type: microstructure
```

**Returns**: Boolean

**Interpretation**:

- `true`: Large orders absorbed (trend exhaustion)
- Used to exit positions or anticipate reversals

---

### 3. Imbalance

**Description**: Order book imbalance indicator

**Type**: `microstructure`

**Usage**:

```yaml
features:
  - name: imbalance
    type: microstructure
```

**Interpretation**:

- Positive: Bid side heavy
- Negative: Ask side heavy

---

## Strategy Types

### 1. RSI-Based Strategies

**Count**: 30 variations

**Templates**:

1. **RSI Oversold Bounce**: Buy RSI < 30, exit RSI > 70
2. **RSI Overbought Rejection**: Short RSI > 70, exit RSI < 30
3. **RSI Divergence**: Bullish/bearish divergence detection
4. **RSI Trend Confirmation**: RSI > 50 in uptrend
5. **RSI Mean Reversion**: Extreme RSI levels
6. **RSI Breakout**: RSI crosses threshold

**Best For**:

- Range-bound markets
- Mean reversion
- Swing trading

**Expected ROI**: 2-4% per month

---

### 2. Bollinger Bands Strategies

**Count**: 30 variations

**Templates**:

1. **Lower Band Bounce**: Buy at lower band
2. **Upper Band Rejection**: Short at upper band
3. **Squeeze Breakout**: Narrow bands → breakout
4. **Expansion Fade**: Wide bands → reversion
5. **BB Walk (Upper)**: Trend following upper band
6. **BB Walk (Lower)**: Trend following lower band

**Best For**:

- Volatility detection
- Mean reversion
- Trend confirmation

**Expected ROI**: 2-5% per month

---

### 3. MACD Strategies

**Count**: 30 variations

**Templates**:

1. **Bullish Crossover**: MACD > signal
2. **Bearish Crossover**: MACD < signal
3. **Zero Line Breakout**: MACD crosses zero
4. **Histogram Divergence**: Momentum acceleration
5. **Signal Touch**: MACD touches signal line
6. **Extreme Reversal**: Counter-trend at extremes

**Best For**:

- Trending markets
- Momentum trading
- Breakout trading

**Expected ROI**: 2-4% per month

---

### 4. Hybrid Strategies

**Count**: 40 variations

**Combinations**:

#### RSI + BB Confluence

```yaml
arm: "rsi < 30 && close < bb_lower"
trigger: "rsi > 35 && close > bb_lower"
```

**Accuracy**: 60-70%

#### RSI + MACD Confirmation

```yaml
arm: "rsi > 50"
trigger: "macd > macd_signal && rsi > 60"
```

**Accuracy**: 65-75%

#### BB + MACD Crossover

```yaml
arm: "close < bb_lower"
trigger: "close > bb_lower && macd > macd_signal"
```

**Accuracy**: 60-70%

#### Triple Confluence

```yaml
arm: "rsi < 30 && close < bb_lower && macd < macd_signal"
trigger: "rsi > 35 && close > bb_lower && macd > macd_signal"
```

**Accuracy**: 70-80%

#### VWAP + Momentum

```yaml
arm: "close < vwap && rsi < 40"
trigger: "close > vwap && macd > macd_signal"
```

**Accuracy**: 65-75%

**Best For**:

- Higher probability setups
- Reduced false signals
- Multi-timeframe confluence

**Expected ROI**: 3-6% per month

---

### 5. VWAP Strategies

**Count**: 18 variations

**Templates**:

1. **VWAP Reclaim**: Fade below VWAP, reclaim entry
2. **VWAP Rejection**: Short above VWAP, failure entry
3. **VWAP Trend**: Follow price relative to VWAP
4. **VWAP + EMA**: Confluence with moving averages

**Best For**:

- Intraday trading
- Mean reversion
- Institutional flow

**Expected ROI**: 2-4% per month

---

## Builtin Features

Available in all expressions without declaration:

| Feature     | Description     | Type   |
| ----------- | --------------- | ------ |
| `open`      | Bar open price  | number |
| `high`      | Bar high price  | number |
| `low`       | Bar low price   | number |
| `close`     | Bar close price | number |
| `volume`    | Bar volume      | number |
| `timestamp` | Bar timestamp   | number |

---

## Custom Functions

Available in all expressions:

### Mathematical Functions

- `abs(x)`: Absolute value
- `min(a, b)`: Minimum of two values
- `max(a, b)`: Maximum of two values
- `round(x)`: Round to nearest integer
- `floor(x)`: Round down
- `ceil(x)`: Round up

### Range Functions

- `in_range(value, min, max)`: Check if value is within range

  ```yaml
  trigger: "in_range(close, 150.00, 151.00)"
  ```

- `clamp(value, min, max)`: Constrain value to range
  ```yaml
  trigger: "clamp(rsi, 30, 70) == rsi"
  ```

---

## Usage Examples

### Example 1: RSI Mean Reversion

```yaml
meta:
  name: "RSI Oversold Bounce"
  symbol: "AAPL"
  timeframe: "5m"

features:
  - name: rsi
    type: indicator
    params:
      period: 14

rules:
  arm: "rsi < 30"
  trigger: "rsi > 35"
  invalidate:
    when_any:
      - "rsi > 70"

orderPlans:
  - name: primary_bracket
    side: buy
    entryZone: [149.00, 150.00]
    qty: 100
    stopPrice: 147.00
    targets:
      - price: 152.00
        ratioOfPosition: 1.0
```

---

### Example 2: Bollinger Band Squeeze

```yaml
meta:
  name: "BB Squeeze Breakout"
  symbol: "TSLA"
  timeframe: "15m"

features:
  - name: bb
    type: indicator
    params:
      period: 20
      stdDev: 2
  - name: vol_zscore
    type: indicator
    params:
      period: 20

rules:
  arm: "bb_width < 0.02"
  trigger: "close > bb_upper && vol_zscore > 1.5"
  invalidate:
    when_any:
      - "close < bb_middle"

orderPlans:
  - name: primary_bracket
    side: buy
    entryZone: [200.00, 202.00]
    qty: 50
    stopPrice: 197.00
    targets:
      - price: 207.00
        ratioOfPosition: 0.5
      - price: 212.00
        ratioOfPosition: 0.5
```

---

### Example 3: Hybrid Multi-Indicator

```yaml
meta:
  name: "Triple Confluence"
  symbol: "NVDA"
  timeframe: "5m"

features:
  - name: rsi
    type: indicator
    params:
      period: 14
  - name: bb
    type: indicator
    params:
      period: 20
      stdDev: 2
  - name: macd
    type: indicator
    params:
      fastPeriod: 12
      slowPeriod: 26
      signalPeriod: 9

rules:
  arm: "rsi < 35 && close < bb_lower && macd < macd_signal"
  trigger: "rsi > 40 && close > bb_lower && macd > macd_signal"
  invalidate:
    when_any:
      - "rsi > 70"
      - "close > bb_upper"

orderPlans:
  - name: primary_bracket
    side: buy
    entryZone: [450.00, 455.00]
    qty: 20
    stopPrice: 445.00
    targets:
      - price: 465.00
        ratioOfPosition: 0.5
      - price: 475.00
        ratioOfPosition: 0.5
```

---

### Example 4: VWAP Reclaim

```yaml
meta:
  name: "VWAP Fade and Reclaim"
  symbol: "SPY"
  timeframe: "5m"

features:
  - name: vwap
    type: indicator
  - name: ema20
    type: indicator
    params:
      period: 20

rules:
  arm: "close < vwap && close > ema20"
  trigger: "close > vwap"
  invalidate:
    when_any:
      - "close < ema20"

orderPlans:
  - name: primary_bracket
    side: buy
    entryZone: [500.00, 501.00]
    qty: 100
    stopPrice: 498.00
    targets:
      - price: 504.00
        ratioOfPosition: 1.0
```

---

## Performance Guidelines

### Indicator Computation Cost

| Indicator       | Complexity | Bars Needed | Cost     |
| --------------- | ---------- | ----------- | -------- |
| RSI             | O(n)       | 14-28       | Low      |
| EMA             | O(1)       | 20-200      | Very Low |
| SMA             | O(n)       | 20-200      | Low      |
| Bollinger Bands | O(n)       | 20-50       | Low      |
| MACD            | O(1)       | 26-50       | Low      |
| VWAP            | O(1)       | Session     | Very Low |
| ATR             | O(n)       | 14-28       | Low      |
| Stochastic      | O(n)       | 14-28       | Low      |

### Recommended Combinations

**Fast Execution** (< 100μs):

- VWAP + EMA
- RSI + EMA
- MACD + EMA

**Moderate** (< 500μs):

- RSI + BB
- MACD + BB
- Triple indicators

**Complex** (< 1ms):

- 4+ indicators
- Microstructure features
- Custom computations

---

## Related Documentation

- [Architecture](ARCHITECTURE.md) - System design
- [Complete Strategy Suite](COMPLETE_STRATEGY_SUITE.md) - Pre-built strategies
- [Live Trading Setup](LIVE_TRADING_SETUP.md) - Deployment guide
- [Quick Start](QUICKSTART.md) - Getting started

---

**Last Updated**: January 13, 2026
