import { Token } from '@uniswap/sdk-core';
import { BigNumberish } from 'ethers';

export interface LiquidityPosition {
  tokenId: string;
  token0: Token;
  token1: Token;
  fee: bigint;
  tickLower: bigint;
  tickUpper: bigint;
  liquidity: BigNumberish;
  token0Balance: BigNumberish;
  token1Balance: BigNumberish;
  feeGrowthInside0LastX128: BigNumberish;
  feeGrowthInside1LastX128: BigNumberish;
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