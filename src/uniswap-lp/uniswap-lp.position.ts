import { PoolDayData, PositionRange, PositionType } from './types';

/**
 * Represents a Uniswap V3 concentrated liquidity position with rebalancing support
 */
export class UniswapPosition {
  private initialAmount: number;
  private currentPositionCapital: number;
  private positionType: PositionType;
  private positionRange: PositionRange;
  private lpSharePercentage: number;
  private tickSpacing: number;

  private cumulativeFees: number = 0;
  private daysInRange: number = 0;
  private totalDays: number = 0;

  private rebalanceCount: number = 0;
  private totalGasCosts: number = 0;
  private lastRebalanceDay: number = 0;

  private currentPositionDays: number = 0;
  private currentPositionFees: number = 0;
  private positionResults: Array<{
    duration: number;
    fees: number;
    gasCost: number;
    apr: number;
    startingCapital: number;
  }> = [];

  // Current prices for rebalancing calculation
  private currentToken0Price: number;
  private currentToken1Price: number;

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
    this.currentPositionCapital = initialAmount;
    this.positionType = positionType;
    this.lpSharePercentage = initialAmount / initialTvl;
    this.initialToken0Price = initialToken0Price;
    this.initialToken1Price = initialToken1Price;
    this.currentToken0Price = initialToken0Price;
    this.currentToken1Price = initialToken1Price;
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
   */
  updateDaily(
    dayData: PoolDayData,
    wasOutOfRangeAtStart: boolean = false,
  ): void {
    this.totalDays++;
    this.currentPositionDays++;

    const currentTick = parseInt(dayData.tick);
    // se aligned tick for all position-related calculations
    const alignedTick =
      Math.floor(currentTick / this.tickSpacing) * this.tickSpacing;

    const isInRange = !wasOutOfRangeAtStart;

    // Update current prices
    this.currentToken0Price = parseFloat(dayData.token0Price);
    this.currentToken1Price = parseFloat(dayData.token1Price);

    if (isInRange) {
      this.daysInRange++;
    }

    let dailyFees = 0;
    if (isInRange) {
      const totalDailyFees = parseFloat(dayData.feesUSD);
      const baseFeeShare = totalDailyFees * this.lpSharePercentage;
      const concentrationMultiplier =
        this.getConcentrationMultiplier(alignedTick);
      dailyFees = baseFeeShare * concentrationMultiplier;
    }

    this.cumulativeFees += dailyFees;
    this.currentPositionFees += dailyFees;
  }

  /**
   * Rebalance position
   * Simulates: remove liquidity -> collect fees -> swap to 50/50 -> create new position
   */
  rebalance(
    currentTick: number,
    currentTvl: number,
    gasCost: number = 16,
  ): void {
    if (this.currentPositionDays > 0) {
      const positionAPR =
        this.currentPositionDays > 0
          ? (this.currentPositionFees / this.currentPositionCapital) *
            (365 / this.currentPositionDays) *
            100
          : 0;

      this.positionResults.push({
        duration: this.currentPositionDays,
        fees: this.currentPositionFees,
        gasCost: gasCost,
        apr: positionAPR,
        startingCapital: this.currentPositionCapital,
      });

      this.currentPositionCapital += this.currentPositionFees;
    }

    // Update position range to current price
    this.positionRange = this.getPositionTickRange(
      currentTick,
      this.positionType,
      this.tickSpacing,
    );

    // Reset price references for new position (for IL calculation)
    this.initialToken0Price = this.currentToken0Price;
    this.initialToken1Price = this.currentToken1Price;

    // Update LP share based on current TVL (assuming same USD value)
    this.lpSharePercentage =
      this.getCurrentPositionValue(currentTvl) / currentTvl;

    // Add gas costs
    this.totalGasCosts += gasCost;

    // Track rebalancing
    this.rebalanceCount++;
    this.lastRebalanceDay = this.totalDays;

    this.currentPositionDays = 0;
    this.currentPositionFees = 0;
  }

  /**
   * Check if position is currently out of range
   */
  isOutOfRange(currentTick: number): boolean {
    return !this.isPositionActive(currentTick);
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
    // Use initial prices from when position was created/last rebalanced
    const priceRatio =
      currentToken0Price /
      this.initialToken0Price /
      (currentToken1Price / this.initialToken1Price);

    const sqrtPriceRatio = Math.sqrt(priceRatio);
    const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);
    const holdValue = 1;

    return (lpValue - holdValue) * 100;
  }

  /**
   * Calculate running APR based on weighted average of all positions
   */
  getRunningAPR(): number {
    if (this.totalDays === 0) return 0;

    // Net fees after gas costs
    const netFees = this.cumulativeFees - this.totalGasCosts;

    // Overall APR for the entire backtesting period
    return (netFees / this.initialAmount) * (365 / this.totalDays) * 100;
  }

  /**
   * Get current position APR (since last rebalance)
   */
  getCurrentPositionAPR(): number {
    if (this.currentPositionDays === 0) return 0;
    return (
      (this.currentPositionFees / this.currentPositionCapital) *
      (365 / this.currentPositionDays) *
      100
    );
  }

  /**
   * Get weighted average APR of all completed positions
   */
  getWeightedPositionAPR(): number {
    if (this.positionResults.length === 0) return 0;

    let totalWeightedAPR = 0;
    let totalDays = 0;

    for (const position of this.positionResults) {
      totalWeightedAPR += position.apr * position.duration;
      totalDays += position.duration;
    }

    return totalDays > 0 ? totalWeightedAPR / totalDays : 0;
  }

  /**
   * Get gross APR (before gas costs)
   */
  getGrossAPR(): number {
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
    // Use aligned tick for position activity check
    const alignedTick =
      Math.floor(currentTick / this.tickSpacing) * this.tickSpacing;
    const inRange =
      alignedTick >= this.positionRange.tickLower &&
      alignedTick <= this.positionRange.tickUpper;
    return inRange;
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
        tickLower: -887272,
        tickUpper: 887272,
        priceLower: 0,
        priceUpper: Infinity,
        rangeWidth: Infinity,
      };
    }

    // First align the current tick to tick spacing
    const alignedCurrentTick =
      Math.floor(currentTick / tickSpacing) * tickSpacing;

    const rangePercent = parseInt(positionType.replace('%', '')) / 100;
    const halfRange = rangePercent / 2;
    const tickRange = Math.log(1 + halfRange) / Math.log(1.0001);

    // Use aligned tick for calculations
    const tickLower =
      Math.floor((alignedCurrentTick - tickRange) / tickSpacing) * tickSpacing;
    const tickUpper =
      Math.ceil((alignedCurrentTick + tickRange) / tickSpacing) * tickSpacing;

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
    const alignedTick =
      Math.floor(currentTick / this.tickSpacing) * this.tickSpacing;
    const isInRange = this.isPositionActive(alignedTick);
    if (!isInRange) {
      return 0;
    }

    if (this.positionType === 'full-range') {
      return 1.0;
    }

    const rangeWidth =
      this.positionRange.tickUpper - this.positionRange.tickLower;
    const maxRange = 887272 * 2;

    const concentrationFactor = Math.sqrt(maxRange / rangeWidth);
    const cappedFactor = Math.min(concentrationFactor, 100);
    return cappedFactor;
  }

  // Getters for metrics
  get totalFeesEarned(): number {
    return this.cumulativeFees;
  }

  get netFeesEarned(): number {
    return this.cumulativeFees - this.totalGasCosts;
  }

  get gasCostsTotal(): number {
    return this.totalGasCosts;
  }

  get rebalanceCountTotal(): number {
    return this.rebalanceCount;
  }

  get daysActive(): number {
    return this.totalDays;
  }

  get totalDaysInRange(): number {
    return this.daysInRange;
  }

  get currentPositionDaysActive(): number {
    return this.currentPositionDays;
  }

  get currentPositionFeesEarned(): number {
    return this.currentPositionFees;
  }

  get completedPositions(): Array<{
    duration: number;
    fees: number;
    gasCost: number;
    apr: number;
    startingCapital: number;
  }> {
    return [...this.positionResults];
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

  static getTickSpacingFromFeeTier(feeTier: number): number {
    const feeToTickSpacing: Record<number, number> = {
      100: 1,
      500: 10,
      3000: 60,
      10000: 200,
    };
    return feeToTickSpacing[feeTier] || 60;
  }

  static getFeeTierFromPercentage(feePercentage: string): number {
    const percent = parseFloat(feePercentage.replace('%', ''));
    return Math.round(percent * 10000);
  }

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
}
