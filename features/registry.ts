/**
 * Feature registry and factory
 */
import { FeatureDescriptor, FeatureComputeContext, FeatureValue } from '../spec/types';
import {
  computeVWAP,
  computeEMA,
  computeLOD,
  computeHOD,
  computeVolumeZScore,
  computeVolumeSMA,
  computeVolumeEMA,
  computeRSI,
  computeBBUpper,
  computeBBMiddle,
  computeBBLower,
  computeMACDLine,
  computeMACDSignal,
  computeMACDHistogram,
  computeSMA150,
  computeSMA200,
  computeSMA50Rising,
  computeSMA150Rising,
  computeSMA200Rising,
  computeFiftyTwoWeekHigh,
  computeFiftyTwoWeekLow,
  computeCupHandleConfidence,
  computeATR,
  computeADX,
  computeStochasticK,
  computeStochasticD,
  computeOBV,
  computeCCI,
  computeWilliamsR,
} from './indicators';
import { computeAbsorption, computeDelta } from './microstructure';

// ============================================================================
// Built-in Features
// ============================================================================

const BUILTIN_FEATURES: Record<string, FeatureDescriptor> = {
  open: {
    name: 'open',
    type: 'builtin',
    builtinName: 'open',
  },
  high: {
    name: 'high',
    type: 'builtin',
    builtinName: 'high',
  },
  low: {
    name: 'low',
    type: 'builtin',
    builtinName: 'low',
  },
  close: {
    name: 'close',
    type: 'builtin',
    builtinName: 'close',
  },
  volume: {
    name: 'volume',
    type: 'builtin',
    builtinName: 'volume',
  },
  price: {
    name: 'price',
    type: 'builtin',
    builtinName: 'close', // alias
  },
};

// ============================================================================
// Feature Registry
// ============================================================================

export class FeatureRegistry {
  private features: Map<string, FeatureDescriptor> = new Map();

  constructor() {
    // Register builtins
    for (const [name, desc] of Object.entries(BUILTIN_FEATURES)) {
      this.features.set(name, desc);
    }
  }

  registerFeature(name: string, desc: FeatureDescriptor): void {
    this.features.set(name, desc);
  }

  getFeature(name: string): FeatureDescriptor | null {
    return this.features.get(name) || null;
  }

  getAllFeatures(): Map<string, FeatureDescriptor> {
    return new Map(this.features);
  }

  /**
   * Get a feature's direct dependencies
   */
  getDependencies(name: string): string[] {
    const feature = this.getFeature(name);
    return feature?.dependencies || [];
  }

  /**
   * Topological sort of features (respecting dependencies)
   */
  topologicalSort(featureNames: Set<string>): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected for feature: ${name}`);
      }

      visiting.add(name);

      const deps = this.getDependencies(name);
      for (const dep of deps) {
        if (featureNames.has(dep)) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      result.push(name);
    };

    for (const name of featureNames) {
      visit(name);
    }

    return result;
  }
}

// ============================================================================
// Standard Registry with Common Indicators
// ============================================================================

export function createStandardRegistry(): FeatureRegistry {
  const registry = new FeatureRegistry();

  // VWAP (Volume Weighted Average Price)
  registry.registerFeature('vwap', {
    name: 'vwap',
    type: 'indicator',
    dependencies: ['volume'],
    compute: computeVWAP,
  });

  // EMA20 (20-bar Exponential Moving Average)
  registry.registerFeature('ema20', {
    name: 'ema20',
    type: 'indicator',
    dependencies: ['close'],
    compute: (ctx: FeatureComputeContext) =>
      computeEMA(ctx.history, 'close', 20),
  });

  // EMA50 (50-bar Exponential Moving Average)
  registry.registerFeature('ema50', {
    name: 'ema50',
    type: 'indicator',
    dependencies: ['close'],
    compute: (ctx: FeatureComputeContext) =>
      computeEMA(ctx.history, 'close', 50),
  });

  // LOD (Low of Day)
  registry.registerFeature('lod', {
    name: 'lod',
    type: 'indicator',
    dependencies: [],
    compute: (ctx: FeatureComputeContext) => {
      if (!ctx.history || ctx.history.length === 0) return ctx.bar.low;
      let minLow = ctx.bar.low;
      for (const bar of ctx.history) {
        minLow = Math.min(minLow, bar.low);
      }
      return minLow;
    },
  });

  // Volume ZScore
  registry.registerFeature('volume_zscore', {
    name: 'volume_zscore',
    type: 'indicator',
    dependencies: ['volume'],
    compute: computeVolumeZScore,
  });

  // Volume SMA (Simple Moving Average of Volume)
  registry.registerFeature('volume_sma', {
    name: 'volume_sma',
    type: 'indicator',
    dependencies: ['volume'],
    compute: (ctx: FeatureComputeContext) => computeVolumeSMA(ctx, 20),
  });

  // Microstructure: Delta (stub)
  registry.registerFeature('delta', {
    name: 'delta',
    type: 'microstructure',
    dependencies: [],
    compute: computeDelta,
  });

  // Microstructure: Absorption (stub)
  registry.registerFeature('absorption', {
    name: 'absorption',
    type: 'microstructure',
    dependencies: ['volume'],
    compute: computeAbsorption,
  });

  // RSI (Relative Strength Index)
  registry.registerFeature('rsi', {
    name: 'rsi',
    type: 'indicator',
    dependencies: ['close'],
    compute: (ctx: FeatureComputeContext) => computeRSI(ctx, 14),
  });

  // Bollinger Bands - Upper Band
  registry.registerFeature('bb_upper', {
    name: 'bb_upper',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeBBUpper,
  });

  // Bollinger Bands - Middle Band (SMA)
  registry.registerFeature('bb_middle', {
    name: 'bb_middle',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeBBMiddle,
  });

  // Bollinger Bands - Lower Band
  registry.registerFeature('bb_lower', {
    name: 'bb_lower',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeBBLower,
  });

  // MACD - MACD Line (12-EMA - 26-EMA)
  registry.registerFeature('macd', {
    name: 'macd',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeMACDLine,
  });

  // MACD - Signal Line (9-EMA of MACD)
  registry.registerFeature('macd_signal', {
    name: 'macd_signal',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeMACDSignal,
  });

  // MACD - Histogram (MACD - Signal)
  registry.registerFeature('macd_histogram', {
    name: 'macd_histogram',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeMACDHistogram,
  });

  // ========== SEPA INDICATORS (Mark Minervini Growth Screener) ==========

  // SMA50 (50-day Simple Moving Average) - needed for comparisons
  registry.registerFeature('sma50', {
    name: 'sma50',
    type: 'indicator',
    dependencies: ['close'],
    compute: (ctx: FeatureComputeContext) =>
      computeEMA(ctx.history, 'close', 50), // Use EMA50 as SMA50 proxy
  });

  // SMA150 (150-day Simple Moving Average)
  registry.registerFeature('sma150', {
    name: 'sma150',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeSMA150,
  });

  // SMA200 (200-day Simple Moving Average)
  registry.registerFeature('sma200', {
    name: 'sma200',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeSMA200,
  });

  // SMA50_Rising (Is 50-day MA trending up?)
  registry.registerFeature('sma50_rising', {
    name: 'sma50_rising',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeSMA50Rising,
  });

  // SMA150_Rising (Is 150-day MA trending up?)
  registry.registerFeature('sma150_rising', {
    name: 'sma150_rising',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeSMA150Rising,
  });

  // SMA200_Rising (Is 200-day MA trending up?)
  registry.registerFeature('sma200_rising', {
    name: 'sma200_rising',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeSMA200Rising,
  });

  // 52-Week High
  registry.registerFeature('fifty_two_week_high', {
    name: 'fifty_two_week_high',
    type: 'indicator',
    dependencies: ['high'],
    compute: computeFiftyTwoWeekHigh,
  });

  // 52-Week Low
  registry.registerFeature('fifty_two_week_low', {
    name: 'fifty_two_week_low',
    type: 'indicator',
    dependencies: ['low'],
    compute: computeFiftyTwoWeekLow,
  });

  // Cup & Handle Pattern Confidence
  registry.registerFeature('cup_handle_confidence', {
    name: 'cup_handle_confidence',
    type: 'indicator',
    dependencies: ['close'],
    compute: computeCupHandleConfidence,
  });

  // HOD (High of Day)
  registry.registerFeature('hod', {
    name: 'hod',
    type: 'indicator',
    dependencies: [],
    compute: computeHOD,
  });

  // Volume EMA
  registry.registerFeature('volume_ema', {
    name: 'volume_ema',
    type: 'indicator',
    dependencies: ['volume'],
    compute: (ctx: FeatureComputeContext) => computeVolumeEMA(ctx, 20),
  });

  // ATR (Average True Range)
  registry.registerFeature('atr', {
    name: 'atr',
    type: 'indicator',
    dependencies: ['high', 'low', 'close'],
    compute: (ctx: FeatureComputeContext) => computeATR(ctx, 14),
  });

  // ADX (Average Directional Index)
  registry.registerFeature('adx', {
    name: 'adx',
    type: 'indicator',
    dependencies: ['high', 'low', 'close'],
    compute: (ctx: FeatureComputeContext) => computeADX(ctx, 14),
  });

  // Stochastic K
  registry.registerFeature('stochastic_k', {
    name: 'stochastic_k',
    type: 'indicator',
    dependencies: ['high', 'low', 'close'],
    compute: computeStochasticK,
  });

  // Stochastic D
  registry.registerFeature('stochastic_d', {
    name: 'stochastic_d',
    type: 'indicator',
    dependencies: ['high', 'low', 'close'],
    compute: computeStochasticD,
  });

  // OBV (On Balance Volume)
  registry.registerFeature('obv', {
    name: 'obv',
    type: 'indicator',
    dependencies: ['close', 'volume'],
    compute: computeOBV,
  });

  // CCI (Commodity Channel Index)
  registry.registerFeature('cci', {
    name: 'cci',
    type: 'indicator',
    dependencies: ['high', 'low', 'close'],
    compute: (ctx: FeatureComputeContext) => computeCCI(ctx, 20),
  });

  // Williams %R
  registry.registerFeature('williams_r', {
    name: 'williams_r',
    type: 'indicator',
    dependencies: ['high', 'low', 'close'],
    compute: (ctx: FeatureComputeContext) => computeWilliamsR(ctx, 14),
  });

  return registry;
}
