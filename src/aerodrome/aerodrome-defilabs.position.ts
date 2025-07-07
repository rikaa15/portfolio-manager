import { logger } from './aerodrome.utils';
import { PoolDayData, PositionRange, PositionType } from './types';

/**
 * Aerodrome Position class for BTC/stablecoin pairs
 * Based on Defilabs implementation https://github.com/DefiLab-xyz/uniswap-v3-backtest/blob/main/backtest.mjs
 *
 * - token0 = USDC (6 decimals) - matches actual pool structure
 * - token1 = cbBTC (8 decimals) - matches actual pool structure
 * - token0Price = BTC price in USD (from subgraph)
 */
export class AerodromeSwapDecimalsPosition {
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

  // Added poolTVL for full-range liquidity calculation
  private poolTVL: number;

  // Token decimals now match actual pool structure
  private readonly token0Decimals: number; // USDC (actual token0)
  private readonly token1Decimals: number; // cbBTC (actual token1)

  private dailyActiveFactors: number[] = [];
  private currentTick: number = 0;

  // Logical naming aligned with economic meaning
  private usdcAmount: number = 0; // token0 amount (USDC)
  private btcAmount: number = 0; // token1 amount (cbBTC)

  constructor(
    initialAmount: number,
    positionType: PositionType,
    initialTick: number,
    initialTvl: number,
    initialBtcPrice: number,
    initialToken1Price: number, // Not used but kept for compatibility
    totalPoolLiquidity: number,
    tickSpacing: number = 2000,
    token0Decimals: number = 6, // USDC (actual token0)
    token1Decimals: number = 8, // cbBTC (actual token1)
  ) {
    this.initialAmount = initialAmount;
    this.currentPositionCapital = initialAmount;
    this.positionType = positionType;
    this.totalPoolLiquidity = totalPoolLiquidity;
    this.initialBtcPrice = initialBtcPrice;
    this.currentBtcPrice = initialBtcPrice;
    this.tickSpacing = tickSpacing;
    this.currentTick = initialTick;

    this.token0Decimals = token0Decimals;
    this.token1Decimals = token1Decimals;

    // Added poolTVL for full-range liquidity calculation
    this.poolTVL = initialTvl;

    // Calculate position range
    this.positionRange = this.getPositionTickRange(
      initialTick,
      positionType,
      tickSpacing,
    );

    // Calculate token allocation and liquidity
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

    return {
      tickLower,
      tickUpper,
      priceLower,
      priceUpper,
      rangeWidth: rangePercent,
    };
  }

  private calculateTokensAndLiquidity(
    investment: number,
    btcPrice: number,
  ): void {
    if (this.positionType === 'full-range') {
      // Simple 50/50 USD split
      const usdInBtc = investment / 2;
      const usdInStablecoin = investment / 2;

      this.usdcAmount = usdInStablecoin; // token0 amount (USDC)
      this.btcAmount = usdInBtc / btcPrice; // token1 amount (cbBTC)

      // Use Defilab method for full-range (not TVL proportion)
      // Use very wide range to simulate "full-range" mathematically
      const veryLowPrice = btcPrice * 0.01; // 1% of current price
      const veryHighPrice = btcPrice * 100; // 100x current price

      this.liquidityAmount = this.liquidityForStrategy(
        btcPrice,
        veryLowPrice,
        veryHighPrice,
        this.btcAmount,
        this.usdcAmount,
      );
    } else {
      // Use Defilab method for concentrated positions
      const decimal = this.token0Decimals - this.token1Decimals; // 6 - 8 = -2
      [this.btcAmount, this.usdcAmount] = this.tokensForStrategy(
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
        this.usdcAmount,
      );
    }

    this.lpSharePercentage = this.liquidityAmount / this.totalPoolLiquidity;
  }

  /**
   * Defilab tokensForStrategy implementation
   */
  private tokensForStrategy(
    minRange: number, // Lower price bound of the position (e.g., $100,000)
    maxRange: number, // Upper price bound of the position (e.g., $110,000)
    investment: number, // Total USD to invest (e.g., $1000)
    price: number, // Current market price (e.g., $105,000)
    decimal: number, // Decimal adjustment (token0Decimals - token1Decimals = 6 - 8 = -2)
  ): [number, number] {
    // Returns [usdcAmount, btcAmount] in token units
    // STEP 1: Convert prices to sqrt format with decimal adjustment
    const sqrtPrice = Math.sqrt(price * Math.pow(10, decimal));
    const sqrtLow = Math.sqrt(minRange * Math.pow(10, decimal));
    const sqrtHigh = Math.sqrt(maxRange * Math.pow(10, decimal));

    let delta: number, amount0: number, amount1: number;

    // CASE 1: CURRENT PRICE IS WITHIN THE RANGE (most common case)
    if (sqrtPrice > sqrtLow && sqrtPrice < sqrtHigh) {
      delta =
        investment /
        (sqrtPrice -
          sqrtLow +
          (1 / sqrtPrice - 1 / sqrtHigh) * (price * Math.pow(10, decimal)));

      amount0 = delta * (1 / sqrtPrice - 1 / sqrtHigh) * Math.pow(10, decimal); // USDC amount (token0)
      amount1 = delta * (sqrtPrice - sqrtLow); // cbBTC amount (token1)

      // CASE 2: CURRENT PRICE IS BELOW THE RANGE
    } else if (sqrtPrice < sqrtLow) {
      delta = investment / ((1 / sqrtLow - 1 / sqrtHigh) * price);
      amount0 = delta * (1 / sqrtLow - 1 / sqrtHigh); // All investment in USDC
      amount1 = 0; // No cbBTC needed

      // CASE 3: CURRENT PRICE IS ABOVE THE RANGE
    } else {
      delta = investment / (sqrtHigh - sqrtLow);
      amount0 = 0; // No USDC needed
      amount1 = delta * (sqrtHigh - sqrtLow); // All investment in cbBTC
    }
    return [amount0, amount1];
  }

  /**
   * Defilab liquidityForStrategy implementation
   * Now properly handles token0=USDC, token1=cbBTC
   */
  private liquidityForStrategy(
    price: number, // Current market price
    low: number, // Lower price bound of position
    high: number, // Upper price bound of position
    tokens0: number, // Available amount of token0 (USDC)
    tokens1: number, // Available amount of token1 (cbBTC)
  ): number {
    // Returns liquidity units

    // STEP 1: Calculate decimal adjustment
    const decimal = this.token0Decimals - this.token1Decimals; // 6 - 8 = -2

    // STEP 2: Convert price bounds to Uniswap's Q96 format
    const lowHigh = [
      Math.sqrt(low * Math.pow(10, decimal)) * Math.pow(2, 96), // Lower bound in Q96
      Math.sqrt(high * Math.pow(10, decimal)) * Math.pow(2, 96), // Upper bound in Q96
    ];

    // STEP 3: Convert current price to Q96 format
    const sPrice = Math.sqrt(price * Math.pow(10, decimal)) * Math.pow(2, 96);

    // STEP 4: Ensure proper ordering (sLow < sHigh)
    const sLow = Math.min(...lowHigh);
    const sHigh = Math.max(...lowHigh);

    // CASE 1: CURRENT PRICE IS BELOW THE RANGE
    if (sPrice <= sLow) {
      return (
        tokens0 /
        ((Math.pow(2, 96) * (sHigh - sLow)) /
          sHigh /
          sLow /
          Math.pow(10, this.token0Decimals)) // USDC decimals
      );

      // CASE 2: CURRENT PRICE IS WITHIN THE RANGE
    } else if (sPrice <= sHigh && sPrice > sLow) {
      // Calculate liquidity from USDC (token0)
      const liq0 =
        tokens0 /
        ((Math.pow(2, 96) * (sHigh - sPrice)) /
          sHigh /
          sPrice /
          Math.pow(10, this.token1Decimals)); // USDC decimals

      // Calculate liquidity from cbBTC (token1)
      const liq1 =
        tokens1 /
        ((sPrice - sLow) / Math.pow(2, 96) / Math.pow(10, this.token1Decimals)); // cbBTC decimals

      return Math.min(liq1, liq0);

      // CASE 3: CURRENT PRICE IS ABOVE THE RANGE
    } else {
      return (
        tokens1 /
        ((sHigh - sLow) / Math.pow(2, 96) / Math.pow(10, this.token0Decimals)) // cbBTC decimals
      );
    }
  }

  /**
   * Position value calculation
   */
  getCurrentPositionValue(): number {
    // Calculate USD value: USDC + (cbBTC * BTC_price)
    const usdcValueInUsd = this.usdcAmount; // USDC is already in USD
    const btcValueInUsd = this.btcAmount * this.currentBtcPrice; // cbBTC * price
    const totalValue = usdcValueInUsd + btcValueInUsd;
    return totalValue;
  }

  /**
   * Process daily update
   */
  updateDaily(
    dayData: PoolDayData,
    wasRebalancedToday: boolean = false,
  ): number {
    this.totalDays++;
    this.currentPositionDays++;

    const currentTick = parseInt(dayData.tick);
    const isInRange = !this.isOutOfRange(currentTick) && !wasRebalancedToday;

    // Update current BTC price
    this.currentBtcPrice = parseFloat(dayData.token0Price);

    if (isInRange) {
      this.daysInRange++;
    }

    // Calculate active liquidity
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

    return dailyFees;
  }

  /**
   * Active liquidity calculation
   */
  private calculateActiveLiquidityForCandle(dayData: PoolDayData): number {
    if (this.positionType === 'full-range') {
      return 100; // Always 100% active = always earning fees
    }

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
   * Fee calculation with proper token assignments
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

    // Calculate base fees (before scaling by LP share)
    const baseFeeToken0 =
      (fg[0] * this.liquidityAmount * activeLiquidityPercent) / 100; // USDC fees
    const baseFeeToken1 =
      (fg[1] * this.liquidityAmount * activeLiquidityPercent) / 100; // cbBTC fees

    // Scale by actual LP share percentage
    const feeToken0 = baseFeeToken0; // * this.lpSharePercentage; // USDC fees
    const feeToken1 = baseFeeToken1; //  * this.lpSharePercentage; // cbBTC fees

    // Convert to USD - USDC fees + (cbBTC fees * BTC price)
    const feesUSD = feeToken0 + feeToken1 * this.currentBtcPrice;

    this.previousFeeGrowth0X128 = currentFeeGrowth0;
    this.previousFeeGrowth1X128 = currentFeeGrowth1;
    return feesUSD;
  }

  /**
   * Fee growth calculation with proper decimal handling
   */
  private calcUnboundedFees(
    globalfee0: string, // Current cumulative fee growth for token0 (USDC) in X128 format
    prevGlobalfee0: string, // Previous cumulative fee growth for token0 (USDC) in X128 format
    globalfee1: string, // Current cumulative fee growth for token1 (cbBTC) in X128 format
    prevGlobalfee1: string, // Previous cumulative fee growth for token1 (cbBTC) in X128 format
  ): [number, number] {
    // Returns [fee0_per_liquidity, fee1_per_liquidity] in actual token units

    // STEP 1: Convert token0 (USDC) fee growth from X128 format
    const fg0_0 =
      parseInt(globalfee0) /
      Math.pow(2, 128) /
      Math.pow(10, this.token0Decimals); // USDC decimals (6)

    const fg0_1 =
      parseInt(prevGlobalfee0) /
      Math.pow(2, 128) /
      Math.pow(10, this.token0Decimals); // USDC decimals (6)

    // STEP 2: Convert token1 (cbBTC) fee growth from X128 format
    const fg1_0 =
      parseInt(globalfee1) /
      Math.pow(2, 128) /
      Math.pow(10, this.token1Decimals); // cbBTC decimals (8)

    const fg1_1 =
      parseInt(prevGlobalfee1) /
      Math.pow(2, 128) /
      Math.pow(10, this.token1Decimals); // cbBTC decimals (8)

    // STEP 3: Calculate fee growth delta for each token
    const fg0 = fg0_0 - fg0_1; // USDC fees earned per liquidity unit
    const fg1 = fg1_0 - fg1_1; // cbBTC fees earned per liquidity unit

    return [fg0, fg1];
  }

  /**
   * Tick calculation with proper decimal adjustment
   */
  private getTickFromPrice(price: number): number {
    // STEP 1: Invert price to match pool's token assignment
    // Pool: token0/token1 = USDC/cbBTC, but price is "BTC price in USD"
    // So we need USDC-per-cbBTC ratio, which is 1/price
    const invertedPrice = 1 / price;

    // STEP 2: Apply decimal adjustment for token precision
    // Now using token1 - token0 (cbBTC - USDC = 8 - 6 = +2)
    const valToLog =
      invertedPrice * Math.pow(10, this.token1Decimals - this.token0Decimals);

    // STEP 3: Convert to tick using Uniswap's logarithmic formula
    const tickIDXRaw = Math.log(valToLog) / Math.log(1.0001);

    // STEP 4: Round to nearest integer tick
    return Math.round(tickIDXRaw);
  }

  // Impermanent loss calculation
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
    // Store completed position results for weighted APR calculation
    if (this.currentPositionDays > 0) {
      this.positionResults.push({
        duration: this.currentPositionDays,
        fees: this.currentPositionFees,
        gasCost: gasCost,
        startingCapital: this.currentPositionCapital,
      });
    }

    // Update capital with ONLY earned fees (gas costs paid in native token, not LP tokens)
    this.currentPositionCapital += this.currentPositionFees;

    this.initialBtcPrice = this.currentBtcPrice; // Reset IL baseline
    // Update position range to current price
    this.positionRange = this.getPositionTickRange(
      currentTick,
      this.positionType,
      this.tickSpacing,
    );

    // Recalculate liquidity units for new position with new capital
    this.calculateTokensAndLiquidity(
      this.currentPositionCapital,
      this.currentBtcPrice,
    );

    // Track gas costs separately (for APR calculations only)
    this.totalGasCosts += gasCost;

    // Reset position tracking for new position
    this.currentPositionDays = 0;
    this.currentPositionFees = 0;

    // Update counters
    this.rebalanceCount++;
    this.lastRebalanceDay = this.totalDays;
  }

  // Static factory method with proper default decimals
  static create(
    initialAmount: number,
    positionType: PositionType,
    initialTick: number,
    initialTvl: number,
    initialToken0Price: number,
    initialToken1Price: number,
    totalPoolLiquidity: number,
    tickSpacing: number = 2000,
    token0Decimals: number = 6, // USDC (actual token0)
    token1Decimals: number = 8, // cbBTC (actual token1)
  ): AerodromeSwapDecimalsPosition {
    return new AerodromeSwapDecimalsPosition(
      initialAmount,
      positionType,
      initialTick,
      initialTvl,
      initialToken0Price,
      initialToken1Price,
      totalPoolLiquidity,
      tickSpacing,
      token0Decimals,
      token1Decimals,
    );
  }

  getRunningAPR(): number {
    if (this.totalDays === 0) return 0;
    const netFees = this.cumulativeFees - this.totalGasCosts;
    return (netFees / this.initialAmount) * (365 / this.totalDays) * 100;
  }

  getWeightedPositionAPR(): number {
    if (this.positionResults.length === 0) return 0;

    let totalWeightedAPR = 0;
    let totalDays = 0;

    for (const position of this.positionResults) {
      const netFees = position.fees - position.gasCost;
      const netAPR =
        (netFees / position.startingCapital) * (365 / position.duration) * 100;
      totalWeightedAPR += netAPR * position.duration;
      totalDays += position.duration;
    }

    return totalDays > 0 ? totalWeightedAPR / totalDays : 0;
  }

  getGrossAPR(): number {
    if (this.totalDays === 0) return 0;
    return (
      (this.cumulativeFees / this.initialAmount) * (365 / this.totalDays) * 100
    );
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

  get positionLiquidityAmount(): number {
    return this.liquidityAmount;
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

  get completedPositions(): Array<{
    duration: number;
    fees: number;
    gasCost: number;
    startingCapital: number;
  }> {
    return [...this.positionResults];
  }

  get tokenAmounts(): {
    usdc: number;
    btc: number;
  } {
    return {
      usdc: this.usdcAmount,
      btc: this.btcAmount,
    };
  }
}
