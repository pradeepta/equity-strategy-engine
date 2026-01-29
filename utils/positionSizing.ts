/**
 * Position Sizing Utilities
 * Calculates appropriate position sizes based on account value and risk parameters
 */

export interface PositionSizingParams {
  accountValue: number;           // Total account value
  riskPercentage: number;          // Percentage of account to risk (e.g., 2 for 2%)
  entryPrice: number;              // Planned entry price
  stopPrice: number;               // Stop loss price
  maxShares?: number;              // Maximum shares allowed (from strategy YAML)
  maxNotional?: number;            // Maximum dollar value per position
  availableBuyingPower?: number;  // Available cash/margin for new positions
}

export interface PositionSizingResult {
  shares: number;                  // Calculated number of shares
  notionalValue: number;           // Total dollar value (shares * entryPrice)
  dollarRisk: number;              // Dollar risk if stop is hit
  riskPerShare: number;            // Risk per share (entryPrice - stopPrice)
  appliedLimits: string[];         // Which limits were applied
  utilizationPercent: number;      // Percentage of buying power used
}

/**
 * Calculate position size based on risk percentage and account value
 *
 * This function ensures:
 * 1. Risk per trade doesn't exceed specified percentage of account
 * 2. Position size doesn't exceed maximum shares from strategy
 * 3. Notional value doesn't exceed maximum dollar limit
 * 4. Buying power is sufficient for the trade
 *
 * @param params Position sizing parameters
 * @returns Position sizing result with calculated shares and metadata
 * @throws Error if parameters are invalid or position cannot be sized
 */
export function calculatePositionSize(params: PositionSizingParams): PositionSizingResult {
  const {
    accountValue,
    riskPercentage,
    entryPrice,
    stopPrice,
    maxShares,
    maxNotional,
    availableBuyingPower,
  } = params;

  // Validation
  if (accountValue <= 0) {
    throw new Error(`Invalid account value: ${accountValue}`);
  }
  if (riskPercentage <= 0 || riskPercentage > 100) {
    throw new Error(`Invalid risk percentage: ${riskPercentage}. Must be between 0 and 100.`);
  }
  if (entryPrice <= 0) {
    throw new Error(`Invalid entry price: ${entryPrice}`);
  }

  const appliedLimits: string[] = [];

  // Calculate risk per share (must be positive for valid position)
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  if (riskPerShare <= 0) {
    throw new Error(`Invalid stop price: ${stopPrice}. Stop must be on opposite side of entry (${entryPrice})`);
  }

  // Calculate maximum dollar risk allowed (e.g., 2% of $10,000 = $200)
  const maxDollarRisk = accountValue * (riskPercentage / 100);

  // Calculate shares based on risk
  let shares = Math.floor(maxDollarRisk / riskPerShare);
  appliedLimits.push(`risk-based (${riskPercentage}% of $${accountValue.toFixed(0)})`);

  // Apply maximum shares limit from strategy YAML
  if (maxShares !== undefined && shares > maxShares) {
    shares = maxShares;
    appliedLimits.push(`max-shares (${maxShares})`);
  }

  // Apply maximum notional limit
  if (maxNotional !== undefined) {
    const maxSharesByNotional = Math.floor(maxNotional / entryPrice);
    if (shares > maxSharesByNotional) {
      shares = maxSharesByNotional;
      appliedLimits.push(`max-notional ($${maxNotional})`);
    }
  }

  // Apply buying power limit
  if (availableBuyingPower !== undefined) {
    const maxSharesByBuyingPower = Math.floor(availableBuyingPower / entryPrice);
    if (shares > maxSharesByBuyingPower) {
      shares = maxSharesByBuyingPower;
      appliedLimits.push(`buying-power ($${availableBuyingPower.toFixed(0)})`);
    }
  }

  // Ensure at least 1 share (if affordable)
  if (shares < 1) {
    if (availableBuyingPower !== undefined && entryPrice > availableBuyingPower) {
      throw new Error(
        `Insufficient buying power: Need $${entryPrice.toFixed(2)} but only $${availableBuyingPower.toFixed(2)} available`
      );
    }
    if (maxNotional !== undefined && entryPrice > maxNotional) {
      throw new Error(
        `Entry price $${entryPrice.toFixed(2)} exceeds max notional limit $${maxNotional}`
      );
    }
    // If risk-based calculation resulted in 0 shares, the account is too small for this trade
    throw new Error(
      `Position size calculation resulted in 0 shares. Account too small for risk parameters. ` +
      `Risk per share: $${riskPerShare.toFixed(2)}, Max dollar risk: $${maxDollarRisk.toFixed(2)}`
    );
  }

  // Calculate final values
  const notionalValue = shares * entryPrice;
  const dollarRisk = shares * riskPerShare;
  const utilizationPercent = availableBuyingPower
    ? (notionalValue / availableBuyingPower) * 100
    : 0;

  return {
    shares,
    notionalValue,
    dollarRisk,
    riskPerShare,
    appliedLimits,
    utilizationPercent,
  };
}

/**
 * Validate if a position can be opened with available resources
 *
 * @param shares Number of shares to trade
 * @param entryPrice Entry price per share
 * @param availableBuyingPower Available buying power
 * @returns True if position can be opened, false otherwise
 */
export function validateBuyingPower(
  shares: number,
  entryPrice: number,
  availableBuyingPower: number
): { valid: boolean; reason?: string } {
  const notionalValue = shares * entryPrice;

  if (notionalValue > availableBuyingPower) {
    return {
      valid: false,
      reason: `Insufficient buying power: Need $${notionalValue.toFixed(2)} but only $${availableBuyingPower.toFixed(2)} available`,
    };
  }

  return { valid: true };
}

/**
 * Calculate percentage of account at risk for a given position
 *
 * @param shares Number of shares
 * @param entryPrice Entry price per share
 * @param stopPrice Stop loss price per share
 * @param accountValue Total account value
 * @returns Percentage of account at risk
 */
export function calculateAccountRisk(
  shares: number,
  entryPrice: number,
  stopPrice: number,
  accountValue: number
): number {
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const totalRisk = shares * riskPerShare;
  return (totalRisk / accountValue) * 100;
}
