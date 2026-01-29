/**
 * Position Sizing Tests
 */
import {
  calculatePositionSize,
  validateBuyingPower,
  calculateAccountRisk,
  PositionSizingParams,
} from '../positionSizing';

describe('Position Sizing Utilities', () => {
  describe('calculatePositionSize', () => {
    it('should calculate position size based on risk percentage', () => {
      const params: PositionSizingParams = {
        accountValue: 10000,
        riskPercentage: 2, // 2% risk
        entryPrice: 200,
        stopPrice: 195, // $5 risk per share
      };

      const result = calculatePositionSize(params);

      // Expected: (10000 * 0.02) / 5 = 200 / 5 = 40 shares
      expect(result.shares).toBe(40);
      expect(result.notionalValue).toBe(8000); // 40 * 200
      expect(result.dollarRisk).toBe(200); // 40 * 5
      expect(result.riskPerShare).toBe(5);
    });

    it('should apply maxShares limit from strategy YAML', () => {
      const params: PositionSizingParams = {
        accountValue: 10000,
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 195,
        maxShares: 10, // Strategy YAML limit
      };

      const result = calculatePositionSize(params);

      expect(result.shares).toBe(10); // Capped by maxShares
      expect(result.appliedLimits).toContain('max-shares (10)');
    });

    it('should apply maxNotional limit', () => {
      const params: PositionSizingParams = {
        accountValue: 10000,
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 195,
        maxNotional: 2000, // $2000 max per position
      };

      const result = calculatePositionSize(params);

      // 2000 / 200 = 10 shares max
      expect(result.shares).toBe(10);
      expect(result.notionalValue).toBe(2000);
      expect(result.appliedLimits).toContain('max-notional ($2000)');
    });

    it('should apply buyingPower limit', () => {
      const params: PositionSizingParams = {
        accountValue: 10000,
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 195,
        availableBuyingPower: 1000, // Only $1000 available
      };

      const result = calculatePositionSize(params);

      // 1000 / 200 = 5 shares max
      expect(result.shares).toBe(5);
      expect(result.notionalValue).toBe(1000);
      expect(result.appliedLimits).toContain('buying-power ($1000)');
    });

    it('should throw error if account value is invalid', () => {
      const params: PositionSizingParams = {
        accountValue: 0,
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 195,
      };

      expect(() => calculatePositionSize(params)).toThrow('Invalid account value');
    });

    it('should throw error if risk percentage is invalid', () => {
      const params: PositionSizingParams = {
        accountValue: 10000,
        riskPercentage: 0,
        entryPrice: 200,
        stopPrice: 195,
      };

      expect(() => calculatePositionSize(params)).toThrow('Invalid risk percentage');
    });

    it('should throw error if stop price is on wrong side', () => {
      const params: PositionSizingParams = {
        accountValue: 10000,
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 205, // Stop above entry (wrong side for long)
      };

      expect(() => calculatePositionSize(params)).toThrow('Invalid stop price');
    });

    it('should throw error if position size is 0 due to insufficient capital', () => {
      const params: PositionSizingParams = {
        accountValue: 100, // Very small account
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 195,
      };

      expect(() => calculatePositionSize(params)).toThrow('Position size calculation resulted in 0 shares');
    });

    it('should calculate utilization percentage correctly', () => {
      const params: PositionSizingParams = {
        accountValue: 10000,
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 195,
        availableBuyingPower: 10000,
      };

      const result = calculatePositionSize(params);

      // Calculated shares = 40, notional = 8000
      // Utilization = (8000 / 10000) * 100 = 80%
      expect(result.utilizationPercent).toBeCloseTo(80, 1);
    });

    it('should handle multiple limits and report all applied', () => {
      const params: PositionSizingParams = {
        accountValue: 100000,
        riskPercentage: 5, // High risk would calculate many shares
        entryPrice: 100,
        stopPrice: 95,
        maxShares: 20, // First limit
        maxNotional: 1500, // Second limit (1500 / 100 = 15 shares)
        availableBuyingPower: 1000, // Third limit (1000 / 100 = 10 shares)
      };

      const result = calculatePositionSize(params);

      // Buying power is most restrictive
      expect(result.shares).toBe(10);
      expect(result.appliedLimits.length).toBeGreaterThan(1);
    });
  });

  describe('validateBuyingPower', () => {
    it('should validate sufficient buying power', () => {
      const result = validateBuyingPower(10, 200, 5000);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should reject insufficient buying power', () => {
      const result = validateBuyingPower(10, 200, 1000);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Insufficient buying power');
      expect(result.reason).toContain('2000');
      expect(result.reason).toContain('1000');
    });
  });

  describe('calculateAccountRisk', () => {
    it('should calculate risk percentage correctly', () => {
      const riskPercent = calculateAccountRisk(
        10, // shares
        200, // entry
        195, // stop
        10000 // account value
      );

      // Risk = 10 * (200 - 195) = 10 * 5 = $50
      // Percent = (50 / 10000) * 100 = 0.5%
      expect(riskPercent).toBeCloseTo(0.5, 2);
    });

    it('should handle larger risk amounts', () => {
      const riskPercent = calculateAccountRisk(
        40, // shares
        200, // entry
        195, // stop
        10000 // account value
      );

      // Risk = 40 * 5 = $200
      // Percent = (200 / 10000) * 100 = 2%
      expect(riskPercent).toBeCloseTo(2, 2);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle AAPL example from documentation', () => {
      // User has $15k account, AAPL at $200, stop at $195
      const params: PositionSizingParams = {
        accountValue: 15000,
        riskPercentage: 2,
        entryPrice: 200,
        stopPrice: 195,
        maxShares: 10, // From YAML
        availableBuyingPower: 10000, // $10k cash available
      };

      const result = calculatePositionSize(params);

      // Risk-based: (15000 * 0.02) / 5 = 300 / 5 = 60 shares
      // Max shares limit: 10 shares
      // Max by buying power: 10000 / 200 = 50 shares
      // Final: 10 shares (most restrictive)
      expect(result.shares).toBe(10);
      expect(result.notionalValue).toBe(2000); // $2k position
      expect(result.dollarRisk).toBe(50); // $50 risk
    });

    it('should handle NFLX example from documentation', () => {
      // NFLX at $350, stop at $340, $15k account
      const params: PositionSizingParams = {
        accountValue: 15000,
        riskPercentage: 2,
        entryPrice: 350,
        stopPrice: 340,
        maxShares: 10,
        availableBuyingPower: 8000, // After AAPL position
      };

      const result = calculatePositionSize(params);

      // Risk-based: (15000 * 0.02) / 10 = 300 / 10 = 30 shares
      // Max shares limit: 10 shares
      // Max by buying power: 8000 / 350 = 22 shares
      // Final: 10 shares
      expect(result.shares).toBe(10);
      expect(result.notionalValue).toBe(3500);
      expect(result.dollarRisk).toBe(100);
    });

    it('should prevent margin usage with proper limits', () => {
      // Small account trying to trade expensive stock
      const params: PositionSizingParams = {
        accountValue: 5000,
        riskPercentage: 2,
        entryPrice: 1000,
        stopPrice: 990,
        maxShares: 10,
        availableBuyingPower: 5000,
      };

      const result = calculatePositionSize(params);

      // Risk-based: (5000 * 0.02) / 10 = 100 / 10 = 10 shares
      // Max shares: 10 shares
      // Max by buying power: 5000 / 1000 = 5 shares
      // Final: 5 shares (buying power most restrictive)
      expect(result.shares).toBe(5);
      expect(result.notionalValue).toBe(5000); // Uses all buying power
      expect(result.dollarRisk).toBe(50); // Still only $50 risk
    });
  });
});
