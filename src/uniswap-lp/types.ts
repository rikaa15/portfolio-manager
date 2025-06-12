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
