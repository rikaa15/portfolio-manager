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
  token0Fees?: string;
  token1Fees?: string;
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
  tick: string;
  liquidity: string;
  feeGrowthGlobal0X128: string;
  feeGrowthGlobal1X128: string;
  high: string;
  low: string;
  sqrtPrice: string;
}

export interface Position {
  id: string;
  liquidity: string;
  owner: string;
  tickLower: TickData;
  tickUpper: TickData;
}

export interface PositionRange {
  tickLower: number;
  tickUpper: number;
  // positionType: string;
  rangeWidth: number;
  priceLower: number;
  priceUpper: number;
}

export interface TickData {
  tickIdx: string;
  liquidityGross: string;
  liquidityNet: string;
  feeGrowthOutside0X128: string;
  feeGrowthOutside1X128: string;
  feesUSD: string;
}

export interface PoolTestConfig {
  poolName: string;
  poolAddress: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  tickSpacing: number;
  initialAmount: number;
  positionType: PositionType;
  startDate: string;
  endDate: string;
  granularity: GranularityType;
  useCompoundingAPR: boolean;
}

export interface PoolHourData {
  id: string;
  periodStartUnix: number;
  liquidity: string;
  sqrtPrice: string;
  token0Price: string;
  token1Price: string;
  tick: string;
  feeGrowthGlobal0X128: string;
  feeGrowthGlobal1X128: string;
  tvlUSD: string;
  volumeToken0: string;
  volumeToken1: string;
  volumeUSD: string;
  feesUSD: string;
  txCount: string;
  open: string;
  high: string;
  low: string;
  close: string;
}
export interface PaginationInfo {
  totalEntries: number;
  batchesFetched: number;
  lastTimestamp: number;
  hasMoreData: boolean;
}

export interface UnifiedOutputStatus {
  timestamp: number; // Unix timestamp of the data point
  assetComposition: string; // Comma-separated asset symbols (e.g., "cbBTC,USDC")
  assetAmounts: string; // Comma-separated asset amounts (e.g., "1.0,110000")
  totalPortfolioValue: number; // Combined value of all assets (LP position, hedge PnL, etc.)
  pnl: number; // Absolute profit/loss since inception in USD
  return: number; // Cumulative return as percentage of starting capital
  netGainVsHold: number; // Total profit/loss of strategy compared to holding the assets
  capitalUsedInTrading: number; // Actual capital actively deployed (including margin/collateral for hedges)
  totalCapitalLocked: number; // All capital locked in LP, hedge collateral, and buffers
  lpFeesEarned: number; // Total fees earned from providing liquidity
  tradingFeesPaid: number; // Total trading fees paid for rebalancing and hedging
  gasFeesPaid: number; // Total transaction (gas) fees paid on-chain in USD
  maxDrawdown: number; // Largest observed peak-to-trough loss as percentage
  maxGain: number; // Largest observed gain relative to starting value as percentage
  impermanentLoss: number; // Cumulative impermanent loss as percentage of capital
  assetExposure: number; // Current hedge exposure as percentage of the position
  rebalancingActions: number; // Number of rebalancing events taken up to this point
  notes: string; // Descriptive notes (e.g., "Start", "Rebalanced", "End")
}

export type PositionType = 'full-range' | `${number}%`;
export type GranularityType = 'daily' | 'hourly';
