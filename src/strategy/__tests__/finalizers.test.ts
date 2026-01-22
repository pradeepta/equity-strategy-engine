import { finalizeLong, finalizeShort } from '../finalizers';
import type { CandidateInput } from '../finalizers';
import type { Metrics, Constraints } from '../metrics';

const mockMetrics: Metrics = {
  atr: 1.0,
  trend20: 2.0,
  trend40: 1.5,
  rangeHigh20: 105,
  rangeLow20: 95,
  rangeHigh40: 110,
  rangeLow40: 90,
  hod: 106,
  lod: 94,
  currentPrice: 100,
  ema20: 99,
  vwap: 100,
  bbUpper: 104,
  bbLower: 96,
  adx: 25,
};

const mockConstraints: Constraints = {
  maxRiskPerTrade: 100,
  rrTarget: 3.0,
  maxEntryDistancePct: 3.0,
  entryTimeoutBars: 10,
  rthOnly: true,
};

describe('finalizeLong', () => {
  it('should return valid candidate when all hard gates pass', () => {
    const input: CandidateInput = {
      name: 'Test Long',
      family: 'test',
      side: 'buy',
      entryLow: 101,
      entryHigh: 102,
      stop: 99,
      target: 111,
      params: {},
    };

    const result = finalizeLong(input, mockMetrics, mockConstraints);

    expect(result).not.toBeNull();
    expect(result!.rrWorst).toBeGreaterThanOrEqual(mockConstraints.rrTarget);
    expect(result!.dollarRiskWorst).toBeLessThanOrEqual(mockConstraints.maxRiskPerTrade);
    expect(result!.entryDistancePct).toBeLessThanOrEqual(mockConstraints.maxEntryDistancePct);
  });

  it('should return null when stop is on wrong side', () => {
    const input: CandidateInput = {
      name: 'Test Long',
      family: 'test',
      side: 'buy',
      entryLow: 101,
      entryHigh: 102,
      stop: 103, // Stop above entry = invalid
      target: 111,
      params: {},
    };

    const result = finalizeLong(input, mockMetrics, mockConstraints);

    expect(result).toBeNull();
  });

  it('should return null when target is not beyond worst fill', () => {
    const input: CandidateInput = {
      name: 'Test Long',
      family: 'test',
      side: 'buy',
      entryLow: 101,
      entryHigh: 102,
      stop: 99,
      target: 101, // Target below worst fill = invalid
      params: {},
    };

    const result = finalizeLong(input, mockMetrics, mockConstraints);

    expect(result).toBeNull();
  });

  it('should return null when R:R does not meet target', () => {
    const input: CandidateInput = {
      name: 'Test Long',
      family: 'test',
      side: 'buy',
      entryLow: 101,
      entryHigh: 102,
      stop: 99,
      target: 104, // R:R = (104-102)/(102-99) = 0.67 < 3.0
      params: {},
    };

    const result = finalizeLong(input, mockMetrics, mockConstraints);

    expect(result).toBeNull();
  });

  it('should return null when entry distance exceeds max', () => {
    const input: CandidateInput = {
      name: 'Test Long',
      family: 'test',
      side: 'buy',
      entryLow: 105,
      entryHigh: 106, // Entry mid = 105.5, distance = 5.5% > 3%
      stop: 103,
      target: 115,
      params: {},
    };

    const result = finalizeLong(input, mockMetrics, mockConstraints);

    expect(result).toBeNull();
  });
});

describe('finalizeShort', () => {
  it('should return valid candidate when all hard gates pass', () => {
    const input: CandidateInput = {
      name: 'Test Short',
      family: 'test',
      side: 'sell',
      entryHigh: 99,
      entryLow: 98,
      stop: 101,
      target: 89,
      params: {},
    };

    const result = finalizeShort(input, mockMetrics, mockConstraints);

    expect(result).not.toBeNull();
    expect(result!.rrWorst).toBeGreaterThanOrEqual(mockConstraints.rrTarget);
    expect(result!.dollarRiskWorst).toBeLessThanOrEqual(mockConstraints.maxRiskPerTrade);
    expect(result!.entryDistancePct).toBeLessThanOrEqual(mockConstraints.maxEntryDistancePct);
  });

  it('should return null when stop is on wrong side', () => {
    const input: CandidateInput = {
      name: 'Test Short',
      family: 'test',
      side: 'sell',
      entryHigh: 99,
      entryLow: 98,
      stop: 97, // Stop below entry = invalid
      target: 89,
      params: {},
    };

    const result = finalizeShort(input, mockMetrics, mockConstraints);

    expect(result).toBeNull();
  });

  it('should return null when target is not beyond worst fill', () => {
    const input: CandidateInput = {
      name: 'Test Short',
      family: 'test',
      side: 'sell',
      entryHigh: 99,
      entryLow: 98,
      stop: 101,
      target: 99, // Target above worst fill = invalid
      params: {},
    };

    const result = finalizeShort(input, mockMetrics, mockConstraints);

    expect(result).toBeNull();
  });
});
