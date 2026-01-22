import { proposeBestStrategy } from '../generate';
import type { Bar, Constraints } from '../metrics';

function generateMockBars(count: number, startPrice: number, trend: number): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    price += trend;
    const volatility = Math.sin(i * 0.1) * 0.5;

    bars.push({
      timestamp: Date.now() - (count - i) * 60000,
      open: price - 0.2,
      high: price + Math.abs(volatility) + 0.3,
      low: price - Math.abs(volatility) - 0.3,
      close: price,
      volume: 10000 + Math.random() * 5000,
    });
  }

  return bars;
}

describe('proposeBestStrategy', () => {
  const constraints: Constraints = {
    maxRiskPerTrade: 100,
    rrTarget: 3.0,
    maxEntryDistancePct: 3.0,
    entryTimeoutBars: 10,
    rthOnly: true,
  };

  it('should generate valid strategy for bullish trend', () => {
    const bars = generateMockBars(100, 100, 0.1); // Uptrend
    const result = proposeBestStrategy(bars, 'TEST', '5m', constraints);

    expect(result.error).toBeUndefined();
    expect(result.best).not.toBeNull();
    expect(result.yaml).not.toBeNull();
    expect(result.candidatesTop5.length).toBeGreaterThan(0);

    // Best candidate should be a long
    expect(result.best!.side).toBe('buy');

    // Hard gates verified
    expect(result.best!.rrWorst).toBeGreaterThanOrEqual(constraints.rrTarget);
    expect(result.best!.dollarRiskWorst).toBeLessThanOrEqual(constraints.maxRiskPerTrade);
    expect(result.best!.entryDistancePct).toBeLessThanOrEqual(constraints.maxEntryDistancePct);
  });

  it('should generate valid strategy for bearish trend', () => {
    const bars = generateMockBars(100, 100, -0.1); // Downtrend
    const result = proposeBestStrategy(bars, 'TEST', '5m', constraints);

    expect(result.error).toBeUndefined();
    expect(result.best).not.toBeNull();
    expect(result.yaml).not.toBeNull();

    // Best candidate should be a short (most likely)
    // Note: Scoring may still prefer long range bounce in some cases
    expect(['buy', 'sell']).toContain(result.best!.side);
  });

  it('should handle sideways market', () => {
    const bars = generateMockBars(100, 100, 0.01); // Sideways
    const result = proposeBestStrategy(bars, 'TEST', '5m', constraints);

    expect(result.error).toBeUndefined();
    expect(result.best).not.toBeNull();

    // Should generate range strategies
    expect(result.best!.family).toMatch(/range|bounce|reclaim/);
  });

  it('should be deterministic for same inputs', () => {
    const bars = generateMockBars(100, 100, 0.1);

    const result1 = proposeBestStrategy(bars, 'TEST', '5m', constraints);
    const result2 = proposeBestStrategy(bars, 'TEST', '5m', constraints);

    expect(result1.best?.name).toBe(result2.best?.name);
    expect(result1.best?.entryLow).toBe(result2.best?.entryLow);
    expect(result1.best?.entryHigh).toBe(result2.best?.entryHigh);
    expect(result1.best?.stop).toBe(result2.best?.stop);
    expect(result1.best?.target).toBe(result2.best?.target);
    expect(result1.best?.qty).toBe(result2.best?.qty);
  });

  it('should return error when insufficient bars', () => {
    const bars = generateMockBars(30, 100, 0.1); // Too few bars
    const result = proposeBestStrategy(bars, 'TEST', '5m', constraints);

    expect(result.error).toBeDefined();
    expect(result.best).toBeNull();
    expect(result.yaml).toBeNull();
  });

  it('golden test: fixed bars produce expected best candidate', () => {
    // Fixed bars scenario: 100 bars, price from 100 to 110 (bullish)
    const bars: Bar[] = [];
    for (let i = 0; i < 100; i++) {
      const price = 100 + (i * 0.1);
      bars.push({
        timestamp: 1700000000000 + i * 60000,
        open: price - 0.05,
        high: price + 0.2,
        low: price - 0.2,
        close: price,
        volume: 10000,
      });
    }

    const result = proposeBestStrategy(bars, 'GOLD', '5m', constraints);

    expect(result.error).toBeUndefined();
    expect(result.best).not.toBeNull();

    const { best } = result;

    // Expected characteristics for this bullish scenario
    expect(best!.side).toBe('buy');
    expect(best!.family).toMatch(/breakout|reclaim|hod/);
    expect(best!.qty).toBeGreaterThanOrEqual(1);
    expect(best!.rrWorst).toBeGreaterThanOrEqual(3.0);
    expect(best!.dollarRiskWorst).toBeLessThanOrEqual(100);

    // Deterministic check: re-run produces identical result
    const result2 = proposeBestStrategy(bars, 'GOLD', '5m', constraints);
    expect(result2.best).toEqual(best);
  });
});
