import { PoolDayData, PositionRange, PositionType } from './types';

/**
 * Represents a Uniswap V3 concentrated liquidity position during backtesting
 * Tracks position state, fee earnings, and range status
 */
export class UniswapPosition {
  private initialAmount: number;
  private positionType: PositionType;
  private positionRange: PositionRange;
  private concentrationMultiplier: number;
  private lpSharePercentage: number;

  // Tracking state
  private cumulativeFees: number = 0;
  private daysInRange: number = 0;
  private totalDays: number = 0;

  // Initial prices for IL calculation
  private initialToken0Price: number;
  private initialToken1Price: number;

  constructor(
    initialAmount: number,
    positionType: PositionType,
    initialTick: number,
    initialTvl: number,
    initialToken0Price: number,
    initialToken1Price: number,
    tickSpacing: number = 60,
  ) {
    this.initialAmount = initialAmount;
    this.positionType = positionType;
    this.lpSharePercentage = initialAmount / initialTvl;
    this.initialToken0Price = initialToken0Price;
    this.initialToken1Price = initialToken1Price;

    // Set up position range based on type
    this.positionRange = this.getPositionTickRange(
      initialTick,
      positionType,
      tickSpacing,
    );
    this.concentrationMultiplier =
      this.getConcentrationMultiplier(positionType);
  }

  /**
   * Process daily position update
   * Updates fees earned, range status, and position metrics
   */
  updateDaily(dayData: PoolDayData): void {
    this.totalDays++;

    // Check if position is in range for fee calculation
    const currentTick = parseInt(dayData.tick);
    const isInRange = this.isPositionActive(currentTick);

    if (isInRange) {
      this.daysInRange++;
    }

    // Calculate daily fees using proportional approach with concentration multiplier
    let dailyFees = 0;
    if (isInRange) {
      // Use the simple proportional approach that works
      const totalDailyFees = parseFloat(dayData.feesUSD);
      const baseFeeShare = totalDailyFees * this.lpSharePercentage;
      dailyFees = baseFeeShare * this.concentrationMultiplier;
    }
    // No fees earned when out of range

    this.cumulativeFees += dailyFees;
  }

  /**
   * Calculate current position value based on TVL
   */
  getCurrentPositionValue(currentTvl: number): number {
    return currentTvl * this.lpSharePercentage;
  }

  /**
   * Calculate impermanent loss percentage
   */
  calculateImpermanentLoss(
    currentToken0Price: number,
    currentToken1Price: number,
  ): number {
    // Price ratio: relative change between token0 and token1 prices
    const priceRatio =
      currentToken0Price /
      this.initialToken0Price /
      (currentToken1Price / this.initialToken1Price);

    // Square root from constant product formula (x * y = k) used in AMMs
    const sqrtPriceRatio = Math.sqrt(priceRatio);

    // LP value formula: accounts for automatic rebalancing in AMM pools
    const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);

    // Holding value normalized to 1 (100% baseline)
    const holdValue = 1;

    // Impermanent loss: LP performance vs holding 50/50 portfolio
    return (lpValue - holdValue) * 100; // Convert to percentage
  }

  /**
   * Calculate running APR based on fees earned
   */
  getRunningAPR(): number {
    if (this.totalDays === 0) return 0;
    return (
      (this.cumulativeFees / this.initialAmount) * (365 / this.totalDays) * 100
    );
  }

  /**
   * Get time in range percentage
   */
  getTimeInRange(): number {
    if (this.totalDays === 0) return 0;
    return (this.daysInRange / this.totalDays) * 100;
  }

  /**
   * Check if current tick is within position range
   */
  private isPositionActive(currentTick: number): boolean {
    return (
      currentTick >= this.positionRange.tickLower &&
      currentTick <= this.positionRange.tickUpper
    );
  }

  /**
   * Calculate tick range for a given position type using Uniswap V3 tick math
   */
  private getPositionTickRange(
    currentTick: number,
    positionType: PositionType,
    tickSpacing: number = 60,
  ): PositionRange {
    if (positionType === 'full-range') {
      return {
        tickLower: -887272, // Uniswap V3 minimum tick
        tickUpper: 887272, // Uniswap V3 maximum tick
        priceLower: 0,
        priceUpper: Infinity,
        rangeWidth: Infinity,
      };
    }

    // Parse percentage from position type (e.g., "10%" -> 10)
    const rangePercent = parseInt(positionType.replace('%', '')) / 100;
    const halfRange = rangePercent / 2; // ±5% for "10%" range

    // Convert price range to tick range using Uniswap V3 formula
    // Price relationship: price = 1.0001^tick
    const tickRange = Math.log(1 + halfRange) / Math.log(1.0001);

    // Round to nearest valid tick (must be divisible by tickSpacing)
    const tickLower =
      Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
    const tickUpper =
      Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

    // Convert back to prices for reference
    const priceLower = Math.pow(1.0001, tickLower);
    const priceUpper = Math.pow(1.0001, tickUpper);

    return {
      tickLower,
      tickUpper,
      priceLower,
      priceUpper,
      rangeWidth: rangePercent,
    };
  }

  /**
   * Calculate concentration multiplier using range width approach
   * This avoids liquidity unit conversion issues
   */
  private getConcentrationMultiplier(positionType: PositionType): number {
    if (positionType === 'full-range') {
      return 1.0; // Baseline
    }

    // Range width approach from our previous discussion
    const fullRangeWidth = 100; // 100% price range

    const rangeWidths: Record<string, number> = {
      'full-range': 100,
      '30%': 30, // ±15% range (total 30% width)
      '20%': 20, // ±10% range (total 20% width)
      '10%': 10, // ±5% range (total 10% width)
    };

    const rangeWidth = rangeWidths[positionType] || 100;
    const concentrationRatio = fullRangeWidth / rangeWidth;

    // Apply exponential scaling - concentrated positions get exponentially more fees
    const multiplier = Math.pow(concentrationRatio, 1.8);

    // Cap the multiplier to prevent unrealistic values
    return Math.min(multiplier, 100);
  }

  // Getters for metrics
  get totalFeesEarned(): number {
    return this.cumulativeFees;
  }

  get daysActive(): number {
    return this.totalDays;
  }

  get totalDaysInRange(): number {
    return this.daysInRange;
  }

  get positionInfo(): {
    type: PositionType;
    range: PositionRange;
    multiplier: number;
    sharePercentage: number;
  } {
    return {
      type: this.positionType,
      range: this.positionRange,
      multiplier: this.concentrationMultiplier,
      sharePercentage: this.lpSharePercentage,
    };
  }

  get initialInvestment(): number {
    return this.initialAmount;
  }
}
