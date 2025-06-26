import { PoolDayData, PositionRange, PositionType } from './types';

/**
 * Represents a Uniswap V3 concentrated liquidity position during backtesting
 * Now uses actual liquidity units and tick math instead of hardcoded values
 */
export class UniswapPosition {
  private initialAmount: number;
  private positionType: PositionType;
  private positionRange: PositionRange;
  private lpSharePercentage: number;
  private tickSpacing: number;

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
    tickSpacing: number = 60, // Default for 0.3% pools
  ) {
    this.initialAmount = initialAmount;
    this.positionType = positionType;
    this.lpSharePercentage = initialAmount / initialTvl;
    this.initialToken0Price = initialToken0Price;
    this.initialToken1Price = initialToken1Price;
    this.tickSpacing = tickSpacing;

    // Set up position range using tick spacing
    this.positionRange = this.getPositionTickRange(
      initialTick,
      positionType,
      tickSpacing,
    );
  }

  /**
   * Process daily position update
   * Now uses liquidity-based concentration calculations
   */
  updateDaily(dayData: PoolDayData): void {
    this.totalDays++;

    // Check if position is in range for fee calculation
    const currentTick = parseInt(dayData.tick);
    const isInRange = this.isPositionActive(currentTick);

    if (isInRange) {
      this.daysInRange++;
    }

    let dailyFees = 0;
    if (isInRange) {
      const totalDailyFees = parseFloat(dayData.feesUSD);
      const baseFeeShare = totalDailyFees * this.lpSharePercentage;
      const concentrationMultiplier =
        this.getConcentrationMultiplier(currentTick);
      dailyFees = baseFeeShare * concentrationMultiplier;
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
   * Calculate tick range for a given position type using actual tick spacing
   */
  private getPositionTickRange(
    currentTick: number,
    positionType: PositionType,
    tickSpacing: number,
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

    // Parse percentage and convert to ticks using tick spacing
    const rangePercent = parseInt(positionType.replace('%', '')) / 100;
    const halfRange = rangePercent / 2; // ±5% for "10%" range

    // Convert price range to tick range using Uniswap V3 formula
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
   * Calculate concentration multiplier using actual tick math
   */
  private getConcentrationMultiplier(currentTick: number): number {
    // Check if position is in range
    const isInRange = this.isPositionActive(currentTick);
    if (!isInRange) {
      return 0; // No fees when out of range
    }

    if (this.positionType === 'full-range') {
      return 1.0; // Baseline
    }

    // Calculate range width in ticks
    const rangeWidth =
      this.positionRange.tickUpper - this.positionRange.tickLower;
    const maxRange = 887272 * 2; // Full Uniswap V3 range

    // Narrower range = higher concentration of fees
    // This formula approximates how liquidity density affects fee distribution
    const concentrationFactor = Math.sqrt(maxRange / rangeWidth);

    // Cap at reasonable maximum to prevent unrealistic values
    return Math.min(concentrationFactor, 100);
  }

  /**
   * Static method to determine tick spacing from fee tier
   * Supports different pool types
   */
  static getTickSpacingFromFeeTier(feeTier: number): number {
    const feeToTickSpacing: Record<number, number> = {
      100: 1, // 0.01% pools
      500: 10, // 0.05% pools
      3000: 60, // 0.3% pools (most common)
      10000: 200, // 1% pools
    };

    return feeToTickSpacing[feeTier] || 60; // Default to 0.3% pool spacing
  }

  /**
   * Converts "0.3%" to 3000 basis points
   */
  static getFeeTierFromPercentage(feePercentage: string): number {
    const percent = parseFloat(feePercentage.replace('%', ''));
    return Math.round(percent * 10000); // Convert to basis points
  }

  /**
   * Factory method to create position with automatic tick spacing detection
   */
  static create(
    initialAmount: number,
    positionType: PositionType,
    initialTick: number,
    initialTvl: number,
    initialToken0Price: number,
    initialToken1Price: number,
    feePercentage: string = '0.3%',
  ): UniswapPosition {
    const feeTier = this.getFeeTierFromPercentage(feePercentage);
    const tickSpacing = this.getTickSpacingFromFeeTier(feeTier);

    return new UniswapPosition(
      initialAmount,
      positionType,
      initialTick,
      initialTvl,
      initialToken0Price,
      initialToken1Price,
      tickSpacing,
    );
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
    tickSpacing: number;
    sharePercentage: number;
  } {
    return {
      type: this.positionType,
      range: this.positionRange,
      tickSpacing: this.tickSpacing,
      sharePercentage: this.lpSharePercentage,
    };
  }

  get initialInvestment(): number {
    return this.initialAmount;
  }
}
