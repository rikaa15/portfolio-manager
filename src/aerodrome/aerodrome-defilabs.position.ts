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
   *
   * PURPOSE: Calculate the optimal token amounts (token0 and token1) needed to deploy
   * a given USD investment into a concentrated liquidity position within a specific price range.
   *
   * UNISWAP V3 MATH BACKGROUND:
   * - In Uniswap V3, liquidity positions are defined by price ranges [priceLow, priceHigh]
   * - The ratio of token0:token1 depends on where the current price sits within this range
   * - If price is at the center: roughly 50/50 split
   * - If price is near upper bound: mostly token1 (higher-value token)
   * - If price is near lower bound: mostly token0 (lower-value token)
   * - If price is outside range: 100% of one token, 0% of the other
   *
   * WHY SQRT PRICES?
   * - Uniswap V3 uses square root prices internally for mathematical efficiency
   * - This allows for constant product formula: x * y = k to work with concentrated liquidity
   * - sqrt(price) represents the "exchange rate" between tokens in Uniswap's internal math
   */
  private tokensForStrategy(
    minRange: number, // Lower price bound of the position (e.g., $100,000)
    maxRange: number, // Upper price bound of the position (e.g., $110,000)
    investment: number, // Total USD to invest (e.g., $1000)
    price: number, // Current market price (e.g., $105,000)
    decimal: number, // Decimal adjustment (token1Decimals - token0Decimals)
  ): [number, number] {
    // Returns [amount0, amount1] in token units

    // STEP 1: Convert prices to sqrt format with decimal adjustment
    // The decimal adjustment accounts for different token decimal places (e.g., USDC=6, cbBTC=8)
    const sqrtPrice = Math.sqrt(price * Math.pow(10, decimal));
    const sqrtLow = Math.sqrt(minRange * Math.pow(10, decimal));
    const sqrtHigh = Math.sqrt(maxRange * Math.pow(10, decimal));

    let delta: number, amount0: number, amount1: number;

    // CASE 1: CURRENT PRICE IS WITHIN THE RANGE (most common case)
    // When price is between minRange and maxRange, we need both tokens
    if (sqrtPrice > sqrtLow && sqrtPrice < sqrtHigh) {
      // Calculate the "delta" - this is the liquidity scaling factor
      // The denominator represents the total USD value needed for 1 unit of liquidity:
      // - (sqrtPrice - sqrtLow): USD value in token1 for 1 unit of liquidity
      // - (1/sqrtPrice - 1/sqrtHigh) * price * 10^decimal: USD value in token0 for 1 unit of liquidity
      delta =
        investment /
        (sqrtPrice -
          sqrtLow +
          (1 / sqrtPrice - 1 / sqrtHigh) * (price * Math.pow(10, decimal)));

      // Calculate token amounts by multiplying delta by the respective components
      amount1 = delta * (sqrtPrice - sqrtLow); // token1 amount (higher-value token, e.g., cbBTC)
      amount0 = delta * (1 / sqrtPrice - 1 / sqrtHigh) * Math.pow(10, decimal); // token0 amount (lower-value token, e.g., USDC)

      // CASE 2: CURRENT PRICE IS BELOW THE RANGE
      // When price < minRange, position will be 100% token0, 0% token1
      // This happens when market price is lower than our position's lower bound
    } else if (sqrtPrice < sqrtLow) {
      // All investment goes into token0 since price is below our range
      delta = investment / ((1 / sqrtLow - 1 / sqrtHigh) * price);
      amount1 = 0; // No token1 needed
      amount0 = delta * (1 / sqrtLow - 1 / sqrtHigh); // All investment in token0

      // CASE 3: CURRENT PRICE IS ABOVE THE RANGE
      // When price > maxRange, position will be 100% token1, 0% token0
      // This happens when market price is higher than our position's upper bound
    } else {
      // All investment goes into token1 since price is above our range
      delta = investment / (sqrtHigh - sqrtLow);
      amount1 = delta * (sqrtHigh - sqrtLow); // All investment in token1
      amount0 = 0; // No token0 needed
    }

    return [amount0, amount1];
  }

  /**
   * Defilab liquidityForStrategy implementation
   *
   * PURPOSE: Calculate the amount of liquidity units that can be created with given token amounts
   * within a specific price range. This is the "reverse" of tokensForStrategy.
   *
   * UNISWAP V3 LIQUIDITY MATH BACKGROUND:
   * - Liquidity (L) represents the amount of "virtual tokens" available for swapping
   * - Higher liquidity = more tokens available = lower slippage for swaps
   * - The relationship between token amounts and liquidity depends on the price range
   * - Liquidity is calculated differently based on where current price sits relative to the range
   *
   * WHY 2^96?
   * - Uniswap V3 uses Q96 fixed-point arithmetic for precision
   * - 2^96 is a scaling factor that allows fractional numbers to be represented as integers
   * - This prevents precision loss in smart contract calculations
   *
   * LIQUIDITY FORMULA LOGIC:
   * - If price below range: L = Δx / ((1/√Pa - 1/√Pb) * 10^decimals0)
   * - If price above range: L = Δy / ((√Pb - √Pa) * 10^decimals1)
   * - If price in range: L = min(L_from_x, L_from_y) - use limiting factor
   */
  private liquidityForStrategy(
    price: number, // Current market price
    low: number, // Lower price bound of position
    high: number, // Upper price bound of position
    tokens0: number, // Available amount of token0 (lower-value token)
    tokens1: number, // Available amount of token1 (higher-value token)
  ): number {
    // Returns liquidity units

    // STEP 1: Calculate decimal adjustment (same as in tokensForStrategy)
    const decimal = this.token1Decimals - this.token0Decimals;

    // STEP 2: Convert price bounds to Uniswap's Q96 format
    // Q96 format: sqrt(price * 10^decimal) * 2^96
    // This gives us the internal representation Uniswap uses for calculations
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
    // When price <= low bound, all liquidity comes from token0
    // Formula: L = token0_amount / ((2^96 * (√Ph - √Pl)) / (√Ph * √Pl) / 10^decimals0)
    if (sPrice <= sLow) {
      return (
        tokens0 /
        ((Math.pow(2, 96) * (sHigh - sLow)) / // Q96 price range difference
          sHigh / // Divide by upper bound
          sLow / // Divide by lower bound
          Math.pow(10, this.token0Decimals)) // Adjust for token0 decimals
      );

      // CASE 2: CURRENT PRICE IS WITHIN THE RANGE
      // When low < price < high, we need to check both tokens and use the limiting factor
      // Calculate liquidity from both token0 and token1, then take the minimum
    } else if (sPrice <= sHigh && sPrice > sLow) {
      // Calculate liquidity that can be provided by available token0
      // This represents how much liquidity our token0 balance can support
      const liq0 =
        tokens0 /
        ((Math.pow(2, 96) * (sHigh - sPrice)) / // Q96 difference from current to upper bound
          sHigh / // Divide by upper bound
          sPrice / // Divide by current price
          Math.pow(10, this.token0Decimals)); // Adjust for token0 decimals

      // Calculate liquidity that can be provided by available token1
      // This represents how much liquidity our token1 balance can support
      const liq1 =
        tokens1 /
        ((sPrice - sLow) / // Q96 difference from lower bound to current
          Math.pow(2, 96) / // Convert from Q96
          Math.pow(10, this.token1Decimals)); // Adjust for token1 decimals

      // The actual liquidity is limited by whichever token we have less of
      // This ensures we don't try to provide more liquidity than our token balances allow
      return Math.min(liq1, liq0);

      // CASE 3: CURRENT PRICE IS ABOVE THE RANGE
      // When price >= high bound, all liquidity comes from token1
      // Formula: L = token1_amount / ((√Ph - √Pl) / 2^96 / 10^decimals1)
    } else {
      return (
        tokens1 /
        ((sHigh - sLow) / // Q96 price range difference
          Math.pow(2, 96) / // Convert from Q96
          Math.pow(10, this.token1Decimals)) // Adjust for token1 decimals
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
   *
   * PURPOSE: Calculate the amount of fees earned per unit of liquidity over a specific time period.
   * This tells us how much fees were generated and available for distribution to all liquidity providers.
   *
   * UNISWAP V3 FEE MECHANICS BACKGROUND:
   * - Every swap in a Uniswap pool generates trading fees (typically 0.05%, 0.30%, or 1.00%)
   * - These fees are accumulated globally and tracked per unit of liquidity
   * - The pool stores "feeGrowthGlobal0X128" and "feeGrowthGlobal1X128" values
   * - These represent cumulative fees per liquidity unit since the pool's creation
   * - To get fees for a period, we subtract: current_fee_growth - previous_fee_growth
   *
   * WHY "UNBOUNDED"?
   * - "Unbounded" means we calculate total fees as if we had infinite range liquidity
   * - This gives us the theoretical maximum fees that could be earned
   * - Individual positions earn a fraction based on their actual liquidity and range
   * - Think of it as "total pie size" before we calculate our specific slice
   *
   * WHY X128 FORMAT?
   * - Uniswap uses Q128 fixed-point arithmetic for fee growth tracking
   * - 2^128 is a massive scaling factor to maintain precision with tiny fee amounts
   * - This prevents precision loss when dealing with very small fee increments
   * - Example: 0.000001 fee becomes 340,282,366,920,938,463,463,374,607,431,768,211,456 in X128
   *
   * DECIMAL NORMALIZATION:
   * - Different tokens have different decimal places (USDC=6, cbBTC=8, WETH=18)
   * - We must normalize to get actual token amounts rather than "wei" amounts
   * - Example: 1,000,000 USDC-wei = 1.0 USDC (divide by 10^6)
   * - Example: 100,000,000 cbBTC-wei = 1.0 cbBTC (divide by 10^8)
   */
  private calcUnboundedFees(
    globalfee0: string, // Current cumulative fee growth for token0 (X128 format)
    prevGlobalfee0: string, // Previous cumulative fee growth for token0 (X128 format)
    globalfee1: string, // Current cumulative fee growth for token1 (X128 format)
    prevGlobalfee1: string, // Previous cumulative fee growth for token1 (X128 format)
  ): [number, number] {
    // Returns [fee0_per_liquidity, fee1_per_liquidity] in actual token units

    // STEP 1: Convert token0 fee growth from X128 format to actual token units

    // Current token0 fee growth per liquidity unit
    // Process: X128_value → divide by 2^128 → divide by 10^decimals → actual_token_amount
    const fg0_0 =
      parseInt(globalfee0) / // Convert string to number
      Math.pow(2, 128) / // Remove X128 scaling (convert from fixed-point)
      Math.pow(10, this.token0Decimals); // Remove decimal scaling (convert from wei to actual tokens)

    // Previous token0 fee growth per liquidity unit (same process)
    const fg0_1 =
      parseInt(prevGlobalfee0) / // Convert string to number
      Math.pow(2, 128) / // Remove X128 scaling
      Math.pow(10, this.token0Decimals); // Remove decimal scaling

    // STEP 2: Convert token1 fee growth from X128 format to actual token units

    // Current token1 fee growth per liquidity unit
    const fg1_0 =
      parseInt(globalfee1) / // Convert string to number
      Math.pow(2, 128) / // Remove X128 scaling
      Math.pow(10, this.token1Decimals); // Remove decimal scaling (note: different decimals!)

    // Previous token1 fee growth per liquidity unit (same process)
    const fg1_1 =
      parseInt(prevGlobalfee1) / // Convert string to number
      Math.pow(2, 128) / // Remove X128 scaling
      Math.pow(10, this.token1Decimals); // Remove decimal scaling

    // STEP 3: Calculate fee growth delta (difference) for each token
    // This gives us the fees earned per liquidity unit during this specific time period

    const fg0 = fg0_0 - fg0_1; // Token0 fees earned per liquidity unit (in actual token0 units)
    const fg1 = fg1_0 - fg1_1; // Token1 fees earned per liquidity unit (in actual token1 units)

    // EXAMPLE INTERPRETATION:
    // If fg0 = 0.000001 and we have 1,000,000 liquidity units:
    // - We earned 0.000001 * 1,000,000 = 1.0 token0 in fees
    // If fg1 = 0.0000005 and we have 1,000,000 liquidity units:
    // - We earned 0.0000005 * 1,000,000 = 0.5 token1 in fees

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
