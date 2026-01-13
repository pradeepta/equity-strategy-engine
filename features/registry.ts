/**
 * Feature registry and factory
 */
import { FeatureDescriptor, FeatureComputeContext, FeatureValue } from '../spec/types';
import {
  computeVWAP,
  computeEMA,
  computeLOD,
  computeVolumeZScore,
  computeRSI,
  computeBBUpper,
  computeBBMiddle,
  computeBBLower,
  computeMACDLine,
  computeMACDSignal,
  computeMACDHistogram,
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

  return registry;
}
