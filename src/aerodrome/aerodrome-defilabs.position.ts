import { logger } from './aerodrome.utils';
import { PoolDayData, PositionRange, PositionType } from './types';

/**
 * Aerodrome Position class for BTC/stablecoin pairs
 * Based on Defilabs implementation https://github.com/DefiLab-xyz/uniswap-v3-backtest/blob/main/backtest.mjs
 */
export class AerodromePosition {
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
    startingCapital: number;
  }> = [];

  // Current and initial prices (always USD per BTC)
  private currentBtcPrice: number;
  private initialBtcPrice: number;

  // Fee growth tracking for real calculations
  private previousFeeGrowth0X128: bigint = 0n;
  private previousFeeGrowth1X128: bigint = 0n;

  // Store the exact liquidity as calculated by Defilab method
  private liquidityAmount: number = 0;
  private totalPoolLiquidity: number;

  // Token decimals for BTC/stablecoin
  private readonly token0Decimals: number = 8; // cbBTC (match btcAmount)
  private readonly token1Decimals: number = 6; // USDC (match stablecoinAmount)

  private dailyActiveFactors: number[] = [];
  private currentTick: number = 0;

  private btcAmount: number = 0; // Token0 amount
  private stablecoinAmount: number = 0; // Token1 amount

  constructor(
    initialAmount: number,
    positionType: PositionType,
    initialTick: number,
    initialTvl: number,
    initialBtcPrice: number,
    initialToken1Price: number, // Not used but kept for compatibility
    totalPoolLiquidity: number,
    tickSpacing: number = 2000,
  ) {
    this.initialAmount = initialAmount;
    this.currentPositionCapital = initialAmount;
    this.positionType = positionType;
    this.totalPoolLiquidity = totalPoolLiquidity;
    this.initialBtcPrice = initialBtcPrice;
    this.currentBtcPrice = initialBtcPrice;
    this.tickSpacing = tickSpacing;
    this.currentTick = initialTick;
    // this.lpSharePercentage = initialAmount / initialTvl;
    // Calculate position range
    this.positionRange = this.getPositionTickRange(
      initialTick,
      positionType,
      tickSpacing,
    );
    // Simple token allocation in USD terms
    this.calculateTokensAndLiquidity(initialAmount, initialBtcPrice);
  }

  // Position range calculation
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

    // For concentrated positions, work directly with BTC price
    const rangePercent = parseInt(positionType.replace('%', '')) / 100;
    const currentBtcPrice = this.currentBtcPrice; // USD per BTC

    const priceLower = currentBtcPrice * (1 - rangePercent / 2);
    const priceUpper = currentBtcPrice * (1 + rangePercent / 2);

    // Use simple tick calculation
    const rawTickLower = this.getTickFromPrice(priceLower);
    const rawTickUpper = this.getTickFromPrice(priceUpper);

    const tickLower = Math.min(
      Math.floor(rawTickLower / tickSpacing) * tickSpacing,
      Math.floor(rawTickUpper / tickSpacing) * tickSpacing,
    );

    const tickUpper = Math.max(
      Math.ceil(rawTickLower / tickSpacing) * tickSpacing,
      Math.ceil(rawTickUpper / tickSpacing) * tickSpacing,
    );

    logger.log(`[DEBUG] Position range calculation:`);
    logger.log(`[DEBUG] - Position type: ${positionType}`);
    logger.log(
      `[DEBUG] - BTC price range: $${priceLower.toLocaleString()} to $${priceUpper.toLocaleString()}`,
    );
    logger.log(`[DEBUG] - Tick range: ${tickLower} to ${tickUpper}`);

    return {
      tickLower,
      tickUpper,
      priceLower,
      priceUpper,
      rangeWidth: rangePercent,
    };
  }

  // Simplified token and liquidity calculation
  private calculateTokensAndLiquidity(
    investment: number,
    btcPrice: number,
  ): void {
    if (this.positionType === 'full-range') {
      // Simple 50/50 USD split
      const usdInBtc = investment / 2;
      const usdInStablecoin = investment / 2;

      this.btcAmount = usdInBtc / btcPrice; // BTC amount
      this.stablecoinAmount = usdInStablecoin; // Stablecoin amount

      // Use reasonable bounds for liquidity calculation
      const lowPrice = btcPrice * 0.01; // 1% of current price
      const highPrice = btcPrice * 100; // 100x current price

      this.liquidityAmount = this.liquidityForStrategy(
        btcPrice,
        lowPrice,
        highPrice,
        this.btcAmount,
        this.stablecoinAmount,
      );
    } else {
      // Use Defilab method for concentrated positions
      const decimal = this.token1Decimals - this.token0Decimals; // 6 - 8 = -2
      [this.btcAmount, this.stablecoinAmount] = this.tokensForStrategy(
        this.positionRange.priceLower,
        this.positionRange.priceUpper,
        investment,
        btcPrice,
        decimal,
      );

      this.liquidityAmount = this.liquidityForStrategy(
        btcPrice,
        this.positionRange.priceLower,
        this.positionRange.priceUpper,
        this.btcAmount,
        this.stablecoinAmount,
      );
    }

    this.lpSharePercentage = this.liquidityAmount / this.totalPoolLiquidity;
  }

  /**
   * Defilab tokensForStrategy implementation
   */
  private tokensForStrategy(
    minRange: number,
    maxRange: number,
    investment: number,
    price: number,
    decimal: number,
  ): [number, number] {
    const sqrtPrice = Math.sqrt(price * Math.pow(10, decimal));
    const sqrtLow = Math.sqrt(minRange * Math.pow(10, decimal));
    const sqrtHigh = Math.sqrt(maxRange * Math.pow(10, decimal));

    let delta: number, amount0: number, amount1: number;

    if (sqrtPrice > sqrtLow && sqrtPrice < sqrtHigh) {
      delta =
        investment /
        (sqrtPrice -
          sqrtLow +
          (1 / sqrtPrice - 1 / sqrtHigh) * (price * Math.pow(10, decimal)));
      amount1 = delta * (sqrtPrice - sqrtLow);
      amount0 = delta * (1 / sqrtPrice - 1 / sqrtHigh) * Math.pow(10, decimal);
    } else if (sqrtPrice < sqrtLow) {
      delta = investment / ((1 / sqrtLow - 1 / sqrtHigh) * price);
      amount1 = 0;
      amount0 = delta * (1 / sqrtLow - 1 / sqrtHigh);
    } else {
      delta = investment / (sqrtHigh - sqrtLow);
      amount1 = delta * (sqrtHigh - sqrtLow);
      amount0 = 0;
    }
    return [amount0, amount1];
  }

  /**
   * Defilab liquidityForStrategy implementation
   */
  private liquidityForStrategy(
    price: number,
    low: number,
    high: number,
    tokens0: number,
    tokens1: number,
  ): number {
    const decimal = this.token1Decimals - this.token0Decimals;
    const lowHigh = [
      Math.sqrt(low * Math.pow(10, decimal)) * Math.pow(2, 96),
      Math.sqrt(high * Math.pow(10, decimal)) * Math.pow(2, 96),
    ];

    const sPrice = Math.sqrt(price * Math.pow(10, decimal)) * Math.pow(2, 96);
    const sLow = Math.min(...lowHigh);
    const sHigh = Math.max(...lowHigh);

    if (sPrice <= sLow) {
      return (
        tokens0 /
        ((Math.pow(2, 96) * (sHigh - sLow)) /
          sHigh /
          sLow /
          Math.pow(10, this.token0Decimals))
      );
    } else if (sPrice <= sHigh && sPrice > sLow) {
      const liq0 =
        tokens0 /
        ((Math.pow(2, 96) * (sHigh - sPrice)) /
          sHigh /
          sPrice /
          Math.pow(10, this.token0Decimals));
      const liq1 =
        tokens1 /
        ((sPrice - sLow) / Math.pow(2, 96) / Math.pow(10, this.token1Decimals));
      return Math.min(liq1, liq0);
    } else {
      return (
        tokens1 /
        ((sHigh - sLow) / Math.pow(2, 96) / Math.pow(10, this.token1Decimals))
      );
    }
  }

  /**
   * Position value calculation (always USD)
   */
  getCurrentPositionValue(): number {
    // USD calculation
    const btcValueInUsd = this.btcAmount * this.currentBtcPrice;
    const stablecoinValueInUsd = this.stablecoinAmount;
    const totalValue = btcValueInUsd + stablecoinValueInUsd;
    return totalValue;
  }

  /**
   * Process daily update
   */
  updateDaily(dayData: PoolDayData, wasRebalancedToday: boolean = false): void {
    this.totalDays++;
    this.currentPositionDays++;

    const currentTick = parseInt(dayData.tick);
    const isInRange = !this.isOutOfRange(currentTick) && !wasRebalancedToday;

    // Update current BTC price
    this.currentBtcPrice = parseFloat(dayData.token0Price);

    if (isInRange) {
      this.daysInRange++;
    }

    // Calculate active liquidity (simplified for full-range)
    const activeLiquidityPercent =
      this.calculateActiveLiquidityForCandle(dayData);
    this.dailyActiveFactors.push(activeLiquidityPercent);

    let dailyFees = 0;
    if (isInRange) {
      try {
        dailyFees = this.calculateFeesUsingSimplifiedMethod(
          dayData,
          activeLiquidityPercent,
        );
      } catch (error) {
        logger.warn(`Fee calculation failed: ${error}`);
        dailyFees = 0;
      }
    }

    this.cumulativeFees += dailyFees;
    this.currentPositionFees += dailyFees;
  }

  /**
   * Active liquidity calculation
   */
  private calculateActiveLiquidityForCandle(dayData: PoolDayData): number {
    // For full-range positions, always return 100%
    if (this.positionType === 'full-range') {
      return 100;
    }

    // For concentrated positions, use price range logic
    const low = parseFloat(dayData.low || dayData.token0Price);
    const high = parseFloat(dayData.high || dayData.token0Price);

    if (!isFinite(low) || !isFinite(high) || low <= 0 || high <= 0) {
      return 0;
    }

    const lowTick = this.getTickFromPrice(low);
    const highTick = this.getTickFromPrice(high);
    const minTick = this.positionRange.tickLower;
    const maxTick = this.positionRange.tickUpper;

    const divider = highTick - lowTick !== 0 ? highTick - lowTick : 1;
    const ratioTrue =
      highTick - lowTick !== 0
        ? (Math.min(maxTick, highTick) - Math.max(minTick, lowTick)) / divider
        : 1;
    const ratio = highTick > minTick && lowTick < maxTick ? ratioTrue * 100 : 0;

    return isNaN(ratio) || !ratio ? 0 : ratio;
  }

  /**
   * Fee calculation with proper scaling
   */
  private calculateFeesUsingSimplifiedMethod(
    dayData: PoolDayData,
    activeLiquidityPercent: number,
  ): number {
    const currentFeeGrowth0 = BigInt(dayData.feeGrowthGlobal0X128);
    const currentFeeGrowth1 = BigInt(dayData.feeGrowthGlobal1X128);

    if (this.totalDays === 1) {
      this.previousFeeGrowth0X128 = currentFeeGrowth0;
      this.previousFeeGrowth1X128 = currentFeeGrowth1;
      return 0;
    }

    // Calculate fee growth using Defilab method
    const fg = this.calcUnboundedFees(
      currentFeeGrowth0.toString(),
      this.previousFeeGrowth0X128.toString(),
      currentFeeGrowth1.toString(),
      this.previousFeeGrowth1X128.toString(),
    );

    // Defilab's base calculation (assumes you get all fees)
    const baseFeeToken0 =
      (fg[0] * this.liquidityAmount * activeLiquidityPercent) / 100;
    const baseFeeToken1 =
      (fg[1] * this.liquidityAmount * activeLiquidityPercent) / 100;

    // Scale by your actual share of the pool to account for competition
    // Other LPs are also providing liquidity and competing for the same fees
    const feeToken0 = baseFeeToken0 * this.lpSharePercentage;
    const feeToken1 = baseFeeToken1 * this.lpSharePercentage;

    // Convert to USD
    const feesUSD = feeToken0 * this.currentBtcPrice + feeToken1;

    this.previousFeeGrowth0X128 = currentFeeGrowth0;
    this.previousFeeGrowth1X128 = currentFeeGrowth1;
    return feesUSD;
  }

  /**
   * Defilab calcUnboundedFees implementation
   */
  private calcUnboundedFees(
    globalfee0: string,
    prevGlobalfee0: string,
    globalfee1: string,
    prevGlobalfee1: string,
  ): [number, number] {
    const fg0_0 =
      parseInt(globalfee0) /
      Math.pow(2, 128) /
      Math.pow(10, this.token0Decimals);
    const fg0_1 =
      parseInt(prevGlobalfee0) /
      Math.pow(2, 128) /
      Math.pow(10, this.token0Decimals);
    const fg1_0 =
      parseInt(globalfee1) /
      Math.pow(2, 128) /
      Math.pow(10, this.token1Decimals);
    const fg1_1 =
      parseInt(prevGlobalfee1) /
      Math.pow(2, 128) /
      Math.pow(10, this.token1Decimals);

    const fg0 = fg0_0 - fg0_1;
    const fg1 = fg1_0 - fg1_1;

    return [fg0, fg1];
  }

  /**
   * Tick-to-price conversion
   */
  private getTickFromPrice(price: number): number {
    // 1. Use inverted price (cbBTC per USDC instead of USDC per cbBTC)
    // 2. Use correct decimal adjustment
    const invertedPrice = 1 / price;
    const valToLog =
      invertedPrice * Math.pow(10, this.token0Decimals - this.token1Decimals);
    const tickIDXRaw = Math.log(valToLog) / Math.log(1.0001);
    return Math.round(tickIDXRaw);
  }

  calculateImpermanentLoss(currentBtcPrice: number): number {
    const priceRatio = currentBtcPrice / this.initialBtcPrice;
    const sqrtPriceRatio = Math.sqrt(priceRatio);
    const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);
    const holdValue = 1;
    return (lpValue - holdValue) * 100;
  }

  isOutOfRange(currentTick: number): boolean {
    return !this.isPositionActive(currentTick);
  }

  private isPositionActive(currentTick: number): boolean {
    return (
      currentTick >= this.positionRange.tickLower &&
      currentTick <= this.positionRange.tickUpper
    );
  }

  rebalance(
    currentTick: number,
    currentTvl: number,
    gasCost: number = 0,
  ): void {
    // Implementation for rebalancing if needed
    this.totalGasCosts += gasCost;
    this.rebalanceCount++;
  }

  static create(
    initialAmount: number,
    positionType: PositionType,
    initialTick: number,
    initialTvl: number,
    initialToken0Price: number,
    initialToken1Price: number,
    totalPoolLiquidity: number,
    tickSpacing: number = 2000,
  ): AerodromePosition {
    return new AerodromePosition(
      initialAmount,
      positionType,
      initialTick,
      initialTvl,
      initialToken0Price,
      initialToken1Price,
      totalPoolLiquidity,
      tickSpacing,
    );
  }

  // Getters for compatibility
  getRunningAPR(): number {
    if (this.totalDays === 0) return 0;
    const netFees = this.cumulativeFees - this.totalGasCosts;
    return (netFees / this.initialAmount) * (365 / this.totalDays) * 100;
  }

  getWeightedPositionAPR(): number {
    return this.getRunningAPR();
  }
  getGrossAPR(): number {
    return this.getRunningAPR();
  }
  getTimeInRange(): number {
    return this.totalDays === 0 ? 0 : (this.daysInRange / this.totalDays) * 100;
  }

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
  get initialInvestment(): number {
    return this.initialAmount;
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
}
