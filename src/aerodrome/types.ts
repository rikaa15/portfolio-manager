export interface PoolInfo {
  id: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
  totalValueLockedUSD: string;
}

export interface PoolDayData {
  date: number;
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
  token0Price: string;
  token1Price: string;
}

export interface AerodromeLiquidityPosition {
  userAddress: string;
  poolAddress: string;
  tokenId?: string;
  token0Balance: string;
  token1Balance: string;
  token0Symbol: string;
  token1Symbol: string;
  liquidityAmount: string;
  isStaked: boolean;
  pendingAeroRewards?: string;
}

export interface ContractPoolInfo {
  id: string;
  liquidity: string;
  stakedLiquidity: string;
  token0: {
    symbol: string;
    decimals: string;
    address: string;
  };
  token1: {
    symbol: string;
    decimals: string;
    address: string;
  };
  token0Price: string;
  token1Price: string;
  liquidityUtilization: string;
  dailyAeroEmissions: string;
  gauge: {
    address: string;
    rewardRate: string;
    fees0?: string;
    fees1?: string;
  };
  blockNumber?: string;
  timestamp?: string;
}

export interface PoolInfo {
  id: string;
  totalValueLockedUSD: string;
  liquidity: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
  token0Price: string;
  token1Price: string;
}

export interface PoolDayData {
  date: number;
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
  token0Price: string;
  token1Price: string;
}
