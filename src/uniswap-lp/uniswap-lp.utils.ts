import { ethers } from 'ethers';
import { TickMath } from '@uniswap/v3-sdk';
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json';
import {
  fetchCurrentPoolData,
  fetchPoolDayPrices,
  fetchPoolHourPrices,
} from './subgraph.client';
import { Position, PositionRange, PositionType } from './types';

/**
 * Get pool exchange rate (what Uniswap UI shows as "pool price")
 * Returns the current exchange rate between the two tokens
 */
export async function getPoolPrice(poolAddress: string): Promise<{
  token0ToToken1Rate: number; // How much token1 for 1 token0
  token1ToToken0Rate: number; // How much token0 for 1 token1
  token0Symbol: string;
  token1Symbol: string;
  formattedPrice: string;
}> {
  const poolData = await fetchCurrentPoolData(poolAddress);

  const rawToken0Price = parseFloat(poolData.token0Price);
  const rawToken1Price = parseFloat(poolData.token1Price);

  let token0ToToken1Rate: number;
  let token1ToToken0Rate: number;

  if (poolData.token0.symbol === 'WBTC' && rawToken0Price < 1) {
    token0ToToken1Rate = rawToken1Price;
    token1ToToken0Rate = rawToken0Price;
  } else {
    token0ToToken1Rate = rawToken0Price;
    token1ToToken0Rate = rawToken1Price;
  }

  console.log(`Pool Price for ${poolAddress}:`);
  console.log(
    `Raw token0Price: ${rawToken0Price}, Raw token1Price: ${rawToken1Price}`,
  );
  console.log(`Fixed rates:`);
  console.log(
    `  1 ${poolData.token0.symbol} = ${token0ToToken1Rate.toLocaleString()} ${poolData.token1.symbol}`,
  );
  console.log(
    `  1 ${poolData.token1.symbol} = ${token1ToToken0Rate.toFixed(8)} ${poolData.token0.symbol}`,
  );

  const formattedPrice = `1 ${poolData.token1.symbol} = ${token1ToToken0Rate.toFixed(8)} ${poolData.token0.symbol}`;

  return {
    token0ToToken1Rate,
    token1ToToken0Rate,
    token0Symbol: poolData.token0.symbol,
    token1Symbol: poolData.token1.symbol,
    formattedPrice,
  };
}

/**
 * Get historical pool prices (what creates the chart in Uniswap UI)
 * Returns time-series data for price charts
 */
export async function getPoolPriceHistory(
  poolAddress: string,
  startDate: string,
  endDate: string,
  interval: 'daily' | 'hourly' = 'daily',
): Promise<
  Array<{
    timestamp: number;
    date: string;
    token0Price: number;
    token1Price: number;
    tvlUSD: number;
    volumeUSD: number;
  }>
> {
  const startTime = Math.floor(new Date(startDate).getTime() / 1000);
  const endTime = Math.floor(new Date(endDate).getTime() / 1000);

  let rawData;

  if (interval === 'hourly') {
    rawData = await fetchPoolHourPrices(poolAddress, startTime, endTime);
  } else {
    rawData = await fetchPoolDayPrices(poolAddress, startDate, endDate);
  }

  const processedData = rawData.map((item) => ({
    timestamp: interval === 'hourly' ? item.periodStartUnix : item.date,
    date: new Date(
      (interval === 'hourly' ? item.periodStartUnix : item.date) * 1000,
    )
      .toISOString()
      .split('T')[0],
    token0Price: parseFloat(item.token0Price),
    token1Price: parseFloat(item.token1Price),
    tvlUSD: parseFloat(item.tvlUSD),
    volumeUSD: parseFloat(item.volumeUSD),
  }));

  console.log(
    `Pool price history for ${poolAddress}: ${processedData.length} ${interval} data points`,
  );

  return processedData;
}

/**
 * Get basic position data from tokenId
 * Pure utility function that fetches position info from blockchain
 */
export async function getPositionInfo(
  tokenId: number,
  provider: any,
  positionManagerAddress: string,
): Promise<{
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
}> {
  const contract = new ethers.Contract(
    positionManagerAddress,
    NonfungiblePositionManagerABI,
    provider,
  );

  const position = await contract.positions(tokenId);

  return {
    token0: position.token0,
    token1: position.token1,
    fee: Number(position.fee),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
    liquidity: position.liquidity.toString(),
  };
}

export const calculateTokenAmounts = (
  liquidity: bigint,
  tickLower: bigint,
  tickUpper: bigint,
  currentTick: number,
): { amount0: bigint; amount1: bigint } => {
  try {
    const tickLowerNum = Number(tickLower);
    const tickUpperNum = Number(tickUpper);

    if (currentTick < tickLowerNum) {
      const sqrtRatioLower = TickMath.getSqrtRatioAtTick(tickLowerNum);
      const sqrtRatioUpper = TickMath.getSqrtRatioAtTick(tickUpperNum);

      const sqrtPriceLower = Number(sqrtRatioLower.toString()) / 2 ** 96;
      const sqrtPriceUpper = Number(sqrtRatioUpper.toString()) / 2 ** 96;

      const amount0 =
        (liquidity *
          BigInt(Math.floor((1 / sqrtPriceLower - 1 / sqrtPriceUpper) * 1e8))) /
        BigInt(1e8);
      return { amount0, amount1: 0n };
    } else if (currentTick >= tickUpperNum) {
      const sqrtRatioLower = TickMath.getSqrtRatioAtTick(tickLowerNum);
      const sqrtRatioUpper = TickMath.getSqrtRatioAtTick(tickUpperNum);

      const sqrtPriceLower = Number(sqrtRatioLower.toString()) / 2 ** 96;
      const sqrtPriceUpper = Number(sqrtRatioUpper.toString()) / 2 ** 96;

      const amount1 =
        (liquidity *
          BigInt(Math.floor((sqrtPriceUpper - sqrtPriceLower) * 1e6))) /
        BigInt(1e6);
      return { amount0: 0n, amount1 };
    } else {
      // Current price is in range - both tokens
      const sqrtRatioCurrent = TickMath.getSqrtRatioAtTick(currentTick);
      const sqrtRatioLower = TickMath.getSqrtRatioAtTick(tickLowerNum);
      const sqrtRatioUpper = TickMath.getSqrtRatioAtTick(tickUpperNum);

      const sqrtPriceCurrent = Number(sqrtRatioCurrent.toString()) / 2 ** 96;
      const sqrtPriceLower = Number(sqrtRatioLower.toString()) / 2 ** 96;
      const sqrtPriceUpper = Number(sqrtRatioUpper.toString()) / 2 ** 96;

      const amount0 =
        (liquidity *
          BigInt(
            Math.floor((1 / sqrtPriceCurrent - 1 / sqrtPriceUpper) * 1e8),
          )) /
        BigInt(1e8);
      const amount1 =
        (liquidity *
          BigInt(Math.floor((sqrtPriceCurrent - sqrtPriceLower) * 1e6))) /
        BigInt(1e6);

      return { amount0, amount1 };
    }
  } catch (error) {
    console.error(`Error calculating token amounts with SDK: ${error.message}`);
    return { amount0: 0n, amount1: 0n };
  }
};
export const formatTokenAmount = (
  amount: bigint | string,
  decimals: number,
  symbol: string,
  maxDecimals: number = 8,
): string => {
  const amountStr = typeof amount === 'bigint' ? amount.toString() : amount;
  const formatted = ethers.formatUnits(amountStr, decimals);
  const num = parseFloat(formatted);

  // Show 0 as exactly 0
  if (num === 0) {
    return `0 ${symbol}`;
  }

  // For very small amounts, use more decimal places
  let decimalPlaces = maxDecimals;
  if (num < 0.000001) {
    decimalPlaces = Math.max(maxDecimals, decimals); // Use full token decimals for tiny amounts
  }

  // Remove trailing zeros for cleaner display
  const limited = parseFloat(num.toFixed(decimalPlaces)).toString();
  return `${limited} ${symbol}`;
};

export const formatPositionAmounts = (
  token0Amount: string,
  token1Amount: string,
  uncollectedFees0: string,
  uncollectedFees1: string,
  token0Decimals: number,
  token1Decimals: number,
  token0Symbol: string,
  token1Symbol: string,
) => {
  return {
    token0Balance: formatTokenAmount(
      token0Amount,
      token0Decimals,
      token0Symbol,
    ),
    token1Balance: formatTokenAmount(
      token1Amount,
      token1Decimals,
      token1Symbol,
    ),
    uncollectedFees0: formatTokenAmount(
      uncollectedFees0,
      token0Decimals,
      token0Symbol,
    ),
    uncollectedFees1: formatTokenAmount(
      uncollectedFees1,
      token1Decimals,
      token1Symbol,
    ),
  };
};

/**
 * Calculate tick range for a given position type
 * Uses Uniswap V3 tick math to convert price ranges to tick bounds
 */
export function getPositionTickRange(
  currentTick: number,
  positionType: PositionType,
  tickSpacing: number,
): PositionRange {
  if (positionType === 'full-range') {
    // Full range: use extreme tick bounds
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

  // Convert price range to tick range
  // Price relationship: price = 1.0001^tick
  // For ±X% range: tickRange = log(1 ± X) / log(1.0001)
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
 * Check if current tick is within position range
 */
export function isPositionActive(
  currentTick: number,
  positionRange: PositionRange,
): boolean {
  return (
    currentTick >= positionRange.tickLower &&
    currentTick <= positionRange.tickUpper
  );
}

// /**
//  * Calculate the concentration multiplier for a given position type
//  * Using range width approach from previous discussion - much more reliable!
//  */
// export function getConcentrationMultiplier(
//   positionType: PositionType,
//   allPositions: Position[] = [],
// ): number {
//   if (positionType === 'full-range') {
//     return 1.0; // Baseline
//   }

//   // CHANGE: Use range width approach for concentration calculation
//   const fullRangeWidth = 100; // 100% price range

//   const rangeWidths: Record<string, number> = {
//     'full-range': 100,
//     '30%': 30, // ±15% range (total 30% width)
//     '20%': 20, // ±10% range (total 20% width)
//     '10%': 10, // ±5% range (total 10% width)
//   };

//   const rangeWidth = rangeWidths[positionType] || 100;
//   const concentrationRatio = fullRangeWidth / rangeWidth;

//   // Apply exponential scaling - concentrated positions get exponentially more fees
//   // Exponent of 1.5-2.0 matches empirical observations from Uniswap/Aerodrome
//   const multiplier = Math.pow(concentrationRatio, 1.8);

//   // Cap the multiplier to prevent unrealistic values
//   return Math.min(multiplier, 100);
// }

/**
 * Calculate impermanent loss for a concentrated position
 * This accounts for the fact that concentrated positions behave differently
 * when price moves outside their range
 */
export function calculateConcentratedImpermanentLoss(
  currentPrice: number,
  initialPrice: number,
  positionRange: PositionRange,
): number {
  // If full range, use standard IL formula
  if (positionRange.rangeWidth === Infinity) {
    const priceRatio = currentPrice / initialPrice;
    const sqrtPriceRatio = Math.sqrt(priceRatio);
    const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);
    return (lpValue - 1) * 100;
  }

  // For concentrated positions, IL calculation depends on whether we're in range
  const currentTick = Math.log(currentPrice) / Math.log(1.0001);
  const isInRange =
    currentTick >= positionRange.tickLower &&
    currentTick <= positionRange.tickUpper;

  if (isInRange) {
    // Standard IL calculation when in range
    const priceRatio = currentPrice / initialPrice;
    const sqrtPriceRatio = Math.sqrt(priceRatio);
    const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);
    return (lpValue - 1) * 100;
  } else {
    // When out of range, position becomes single-asset
    if (currentTick < positionRange.tickLower) {
      // Below range: 100% token0 (WBTC)
      // IL = current BTC value vs initial balanced value
      const priceChange = (currentPrice - initialPrice) / initialPrice;
      return priceChange * 50; // Only half the position was BTC initially
    } else {
      // Above range: 100% token1 (USDC)
      // Position is now all USDC, loses BTC upside
      const priceChange = (currentPrice - initialPrice) / initialPrice;
      return -priceChange * 50; // Lost BTC gains
    }
  }
}

/**
 * Estimate liquidity distribution for fee allocation calculations
 * This is a simplified model that can be enhanced with real tick data
 */
export function estimateLiquidityDistribution(
  currentTick: number,
  allPositions: Position[],
): Map<number, number> {
  const liquidityMap = new Map<number, number>();

  // If we have position data, use it
  if (allPositions && allPositions.length > 0) {
    allPositions.forEach((position) => {
      const tickLower = parseInt(position.tickLower);
      const tickUpper = parseInt(position.tickUpper);
      const liquidity = parseFloat(position.liquidity);

      // Distribute liquidity across the position's range
      for (let tick = tickLower; tick <= tickUpper; tick += 60) {
        // 60 = tick spacing
        const current = liquidityMap.get(tick) || 0;
        liquidityMap.set(tick, current + liquidity);
      }
    });
  } else {
    // Fallback: assume normal distribution around current tick
    const standardDeviation = 2000; // ticks
    for (let i = -10000; i <= 10000; i += 60) {
      const tick = currentTick + i;
      const distance = Math.abs(i);
      const liquidity = Math.exp(
        -(distance * distance) / (2 * standardDeviation * standardDeviation),
      );
      liquidityMap.set(tick, liquidity);
    }
  }

  return liquidityMap;
}

/**
 * Convert tick to price using Uniswap V3 formula
 */
export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

/**
 * Convert price to tick using Uniswap V3 formula
 */
export function priceToTick(price: number): number {
  return Math.log(price) / Math.log(1.0001);
}

/**
 * Calculate the percentage of total pool liquidity that a position range contains
 * This is used for more accurate fee allocation
 */
export function calculateRangeLiquidityShare(
  positionRange: PositionRange,
  liquidityDistribution: Map<number, number>,
): number {
  let rangeLiquidity = 0;
  let totalLiquidity = 0;

  for (const [tick, liquidity] of liquidityDistribution) {
    totalLiquidity += liquidity;

    if (tick >= positionRange.tickLower && tick <= positionRange.tickUpper) {
      rangeLiquidity += liquidity;
    }
  }

  return totalLiquidity > 0 ? rangeLiquidity / totalLiquidity : 0;
}
