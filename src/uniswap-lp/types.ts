import { Token } from '@uniswap/sdk-core';
import { BigNumberish } from 'ethers';

export interface LiquidityPosition {
  tokenId: string;
  token0: Token;
  token1: Token;
  fee: bigint;
  tickLower: bigint;
  tickUpper: bigint;
  liquidity: string;
  token0BalanceRaw: string;
  token1BalanceRaw: string;
  uncollectedFees0Raw: string;
  uncollectedFees1Raw: string;
  token0Balance: string; // e.g., "0.00000485 WBTC"
  token1Balance: string; // e.g., "0.526934 USDC"
  uncollectedFees0: string; // e.g., "0 WBTC"
  uncollectedFees1: string; // e.g., "0 USDC"
  feeGrowthInside0LastX128: string;
  feeGrowthInside1LastX128: string;
}
export interface AddLiquidityParams {
  token0: Token;
  token1: Token;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: BigNumberish;
  amount1Desired: BigNumberish;
  amount0Min: BigNumberish;
  amount1Min: BigNumberish;
  recipient: string;
  deadline: number;
}

export interface RemoveLiquidityParams {
  tokenId: string;
  liquidity: BigNumberish;
  amount0Min: BigNumberish;
  amount1Min: BigNumberish;
  deadline: number;
}

export interface CollectFeesParams {
  tokenId: string;
  recipient: string;
  amount0Max: BigNumberish;
  amount1Max: BigNumberish;
}

/**
 * Individual position data from subgraph
 */
export interface Position {
  id: string;
  tickLower: string;
  tickUpper: string;
  liquidity: string;
  depositedToken0: string;
  depositedToken1: string;
  withdrawnToken0: string;
  withdrawnToken1: string;
  collectedFeesToken0: string;
  collectedFeesToken1: string;
  feeGrowthInside0LastX128: string;
  feeGrowthInside1LastX128: string;
}

/**
 * Position range information for tick-based calculations
 */
export interface PositionRange {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  rangeWidth: number; // percentage width (e.g., 0.1 for 10%)
}

/**
 * Tick data from subgraph for liquidity distribution analysis
 */
export interface Tick {
  id: string;
  tickIdx: string;
  liquidityGross: string;
  liquidityNet: string;
  price0: string;
  price1: string;
}
export interface PoolInfo {
  id: string;
  createdAtTimestamp: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
  feeTier: string;
  totalValueLockedUSD: string;
}

// Types for position configuration
export type PositionType = 'full-range' | '10%' | '20%' | '30%';

export interface PositionRange {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  rangeWidth: number;
}

// Interface for pool day data (should match your existing structure)
export interface PoolDayData {
  date: number;
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
  token0Price: string;
  token1Price: string;
  liquidity: string;
  tick: string;
  high?: string;
  low?: string;
}

export interface PoolDayPrice {
  date: number;
  token0Price: string;
  token1Price: string;
  tvlUSD: string;
  volumeUSD: string;
}

/**
 * Fee calculation result
 */
export interface FeeCalculationResult {
  dailyFees: number;
  concentrationMultiplier: number;
  timeInRangeFactor: number;
  liquidityShare: number;
}

export interface FormattedLiquidityPosition extends LiquidityPosition {
  formattedAmounts: {
    liquidityToken0: string; // e.g., "0.00000485 WBTC"
    liquidityToken1: string; // e.g., "0.526934 USDC"
    walletToken0: string; // e.g., "1.25 WBTC"
    walletToken1: string; // e.g., "5000.0 USDC"
    uncollectedFees0: string; // e.g., "<0.001 WBTC"
    uncollectedFees1: string; // e.g., "<0.001 USDC"
  };
}

export interface CurrentPoolData {
  token0Price: string;
  token1Price: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
}

export interface PoolHourPrice {
  periodStartUnix: number;
  token0Price: string;
  token1Price: string;
  tvlUSD: string;
  volumeUSD: string;
}

export interface SwapQuoteParams {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: string; // Amount in human readable format (e.g., "1.5")
  fee: number; // Fee tier (e.g., 3000 for 0.3%)
  slippageTolerance: number; // Slippage tolerance as decimal (e.g., 0.005 for 0.5%)
  deadline?: number; // Unix timestamp deadline
}

export interface SwapQuoteResult {
  // amountIn: string;
  // amountOut: string;
  amountOutMin: string;
  // priceImpact: number; // Price impact as percentage
  // gasEstimate: bigint;
  // gasPrice: bigint;
  // estimatedCostInUsd: number;
  // route: {
  //   tokenIn: Token;
  //   tokenOut: Token;
  //   fee: number;
  // };
}

export interface SwapExecuteParams {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: string;
  amountOutMin: string;
  fee: number;
  slippageTolerance: number;
  deadline?: number;
  recipient?: string;
}

/**
 * Swap execution result
 */
export interface SwapExecuteResult {
  transactionHash: string;
  amountIn: string;
  amountOut: string;
  gasUsed: bigint;
  gasPrice: bigint;
  effectiveGasPrice: bigint;
  totalCostInUsd: number;
}
