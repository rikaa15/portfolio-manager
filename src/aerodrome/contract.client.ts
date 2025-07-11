import { ethers, formatUnits, JsonRpcProvider } from 'ethers';
import { ContractPoolInfo } from './types';

const POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function stakedLiquidity() external view returns (uint128)',
  'function gauge() external view returns (address)',
];

const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

const GAUGE_ABI = [
  'function rewardRate() external view returns (uint256)',
  'function periodFinish() external view returns (uint256)',
  'function rewardToken() external view returns (address)',
  'function fees0() external view returns (uint256)',
  'function fees1() external view returns (uint256)',
  'function stakedContains(address depositor, uint256 tokenId) external view returns (bool)',
  'function earned(address account, uint256 tokenId) external view returns (uint256)',
  'function stakedLength(address depositor) external view returns (uint256)',
  'function stakedByIndex(address depositor, uint256 index) external view returns (uint256)',
];

const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, int24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)',
];

function calculatePricesFromSqrtPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): { token0Price: string; token1Price: string } {
  try {
    const Q96 = BigInt(2) ** BigInt(96);
    const sqrtPriceNum = Number(sqrtPriceX96) / Number(Q96);
    const rawPrice = sqrtPriceNum * sqrtPriceNum;
    const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
    const priceToken1InToken0 = rawPrice * decimalAdjustment;

    return {
      token0Price: (1 / priceToken1InToken0).toFixed(6),
      token1Price: priceToken1InToken0.toFixed(6),
    };
  } catch (error) {
    return {
      token0Price: '0.000000',
      token1Price: '0.000000',
    };
  }
}

export async function fetchPoolInfoDirect(
  poolAddress: string,
  provider: JsonRpcProvider,
  blockNumber?: number,
): Promise<ContractPoolInfo> {
  try {
    const overrides = blockNumber ? { blockTag: blockNumber } : {};
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

    const [
      token0Address,
      token1Address,
      liquidity,
      stakedLiquidity,
      slot0,
      gaugeAddress,
    ] = await Promise.all([
      poolContract.token0(overrides),
      poolContract.token1(overrides),
      poolContract.liquidity(overrides),
      poolContract.stakedLiquidity(overrides),
      poolContract.slot0(overrides),
      poolContract.gauge(overrides),
    ]);

    const token0Contract = new ethers.Contract(
      token0Address,
      ERC20_ABI,
      provider,
    );
    const token1Contract = new ethers.Contract(
      token1Address,
      ERC20_ABI,
      provider,
    );

    const [token0Symbol, token0Decimals, token1Symbol, token1Decimals] =
      await Promise.all([
        token0Contract.symbol(overrides),
        token0Contract.decimals(overrides),
        token1Contract.symbol(overrides),
        token1Contract.decimals(overrides),
      ]);

    const gaugeContract = new ethers.Contract(
      gaugeAddress,
      GAUGE_ABI,
      provider,
    );
    const [rewardRate] = await Promise.all([
      gaugeContract.rewardRate(overrides),
    ]);

    let gaugeFees0 = '0';
    let gaugeFees1 = '0';
    try {
      const [fees0, fees1] = await Promise.all([
        gaugeContract.fees0(overrides),
        gaugeContract.fees1(overrides),
      ]);
      gaugeFees0 = fees0.toString();
      gaugeFees1 = fees1.toString();
    } catch {
      console.error('Gauge fees not available');
      // Gauge fees not available
    }

    const sqrtPriceX96 = slot0[0];
    const prices = calculatePricesFromSqrtPrice(
      sqrtPriceX96,
      Number(token0Decimals),
      Number(token1Decimals),
    );

    const liquidityUtilization =
      liquidity > 0n ? Number((stakedLiquidity * 10000n) / liquidity) / 100 : 0;

    const secondsPerDay = 86400n;
    const dailyAeroEmissionsWei = rewardRate * secondsPerDay;
    const dailyAeroEmissions = parseFloat(
      ethers.formatUnits(dailyAeroEmissionsWei, 18),
    );

    const latestBlock = await provider.getBlock(blockNumber || 'latest');
    const blockInfo = {
      number: latestBlock?.number?.toString(),
      timestamp: latestBlock?.timestamp?.toString(),
    };

    return {
      id: poolAddress.toLowerCase(),
      liquidity: liquidity.toString(),
      stakedLiquidity: stakedLiquidity.toString(),
      token0: {
        symbol: token0Symbol,
        decimals: token0Decimals.toString(),
        address: token0Address,
      },
      token1: {
        symbol: token1Symbol,
        decimals: token1Decimals.toString(),
        address: token1Address,
      },
      token0Price: prices.token0Price,
      token1Price: prices.token1Price,
      liquidityUtilization: liquidityUtilization.toFixed(2),
      dailyAeroEmissions: dailyAeroEmissions.toString(),
      gauge: {
        address: gaugeAddress,
        rewardRate: rewardRate.toString(),
        fees0: gaugeFees0,
        fees1: gaugeFees1,
      },
      blockNumber: blockInfo.number,
      timestamp: blockInfo.timestamp,
    };
  } catch (error: any) {
    throw new Error(
      `Failed to fetch pool info from contract: ${error?.message || error}`,
    );
  }
}

/**
 * Calculate token amounts from liquidity using tick math
 */
export function calculateTokenAmounts(
  liquidity: bigint,
  tickLower: bigint,
  tickUpper: bigint,
  currentTick: number,
): { amount0: bigint; amount1: bigint } {
  const tickLowerNum = Number(tickLower);
  const tickUpperNum = Number(tickUpper);

  // Convert ticks to sqrt prices
  const sqrtPriceLower = getSqrtRatioAtTick(tickLowerNum);
  const sqrtPriceUpper = getSqrtRatioAtTick(tickUpperNum);
  const sqrtPriceCurrent = getSqrtRatioAtTick(currentTick);

  let amount0 = 0n;
  let amount1 = 0n;

  if (currentTick < tickLowerNum) {
    // Current price below range - all token0
    amount0 = getAmount0Delta(sqrtPriceLower, sqrtPriceUpper, liquidity);
  } else if (currentTick >= tickUpperNum) {
    // Current price above range - all token1
    amount1 = getAmount1Delta(sqrtPriceLower, sqrtPriceUpper, liquidity);
  } else {
    // Current price in range - both tokens
    amount0 = getAmount0Delta(sqrtPriceCurrent, sqrtPriceUpper, liquidity);
    amount1 = getAmount1Delta(sqrtPriceLower, sqrtPriceCurrent, liquidity);
  }

  return { amount0, amount1 };
}

/**
 * Calculate sqrt ratio at tick
 */
function getSqrtRatioAtTick(tick: number): bigint {
  // Simplified calculation: 1.0001^(tick/2) * 2^96
  const ratio = Math.pow(1.0001, tick / 2);
  const Q96 = BigInt(2) ** BigInt(96);
  return BigInt(Math.floor(ratio * Number(Q96)));
}

/**
 * Calculate amount0 delta for liquidity
 */
function getAmount0Delta(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtPriceA > sqrtPriceB) {
    [sqrtPriceA, sqrtPriceB] = [sqrtPriceB, sqrtPriceA];
  }

  const numerator = liquidity * (sqrtPriceB - sqrtPriceA);
  const denominator = (sqrtPriceB * sqrtPriceA) / BigInt(2) ** BigInt(96);

  return numerator / denominator;
}

/**
 * Calculate amount1 delta for liquidity
 */
function getAmount1Delta(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtPriceA > sqrtPriceB) {
    [sqrtPriceA, sqrtPriceB] = [sqrtPriceB, sqrtPriceA];
  }

  return (liquidity * (sqrtPriceB - sqrtPriceA)) / BigInt(2) ** BigInt(96);
}

/**
 * Check if position is staked in gauge and get pending rewards
 */
export async function checkGaugeStaking(
  userAddress: string,
  tokenId: string,
  gaugeAddress: string,
  provider: JsonRpcProvider,
): Promise<{ isStaked: boolean; pendingRewards: string }> {
  try {
    const gaugeContract = new ethers.Contract(
      gaugeAddress,
      GAUGE_ABI,
      provider,
    );

    const [isStaked, pendingRewardsWei] = await Promise.all([
      gaugeContract.stakedContains(userAddress, BigInt(tokenId)),
      gaugeContract.earned(userAddress, BigInt(tokenId)).catch(() => 0n),
    ]);

    const pendingRewards = ethers.formatUnits(pendingRewardsWei, 18); // AERO has 18 decimals

    return { isStaked, pendingRewards };
  } catch (error: any) {
    // If gauge calls fail, assume not staked
    console.warn(
      `Could not check gauge staking for ${tokenId}: ${error.message}`,
    );
    return { isStaked: false, pendingRewards: '0' };
  }
}

/**
 * Get pool's current tick for calculations
 */
export async function getPoolCurrentTick(
  poolAddress: string,
  provider: JsonRpcProvider,
): Promise<number> {
  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

  const slot0 = await poolContract.slot0();
  return Number(slot0.tick);
}

export async function getUserStakedPosition(
  userAddress: string,
  poolAddress: string,
  positionManagerAddress: string,
  provider: JsonRpcProvider,
): Promise<{
  tokenId: string;
  position: any;
  poolInfo: ContractPoolInfo;
} | null> {
  try {
    // Get pool info first
    const poolInfo = await fetchPoolInfoDirect(poolAddress, provider);

    // Check if user has staked positions in the gauge
    const gaugeContract = new ethers.Contract(
      poolInfo.gauge.address,
      GAUGE_ABI,
      provider,
    );

    const stakedLength = await gaugeContract.stakedLength(userAddress);

    if (stakedLength === 0n) {
      return null;
    }

    // Get the first staked NFT
    const tokenId = await gaugeContract.stakedByIndex(userAddress, 0);

    // Get position details from position manager
    const positionManager = new ethers.Contract(
      positionManagerAddress,
      POSITION_MANAGER_ABI,
      provider,
    );

    const position = await positionManager.positions(tokenId);

    return {
      tokenId: tokenId.toString(),
      position,
      poolInfo,
    };
  } catch (error: any) {
    throw new Error(`Failed to get user staked position: ${error.message}`);
  }
}

export async function getUserUnstakedPositions(
  userAddress: string,
  poolAddress: string,
  positionManagerAddress: string,
  provider: JsonRpcProvider,
): Promise<
  Array<{
    tokenId: string;
    position: any;
    poolInfo: ContractPoolInfo;
  }>
> {
  try {
    // Get pool info first
    const poolInfo = await fetchPoolInfoDirect(poolAddress, provider);

    // Get Position Manager contract
    const positionManager = new ethers.Contract(
      positionManagerAddress,
      POSITION_MANAGER_ABI,
      provider,
    );

    // Get total number of NFTs owned by user (these are unstaked)
    const balance = await positionManager.balanceOf(userAddress);

    if (balance === 0n) {
      return [];
    }

    // Get all NFT token IDs owned by user
    const unstakedPositions: Array<{
      tokenId: string;
      position: any;
      poolInfo: ContractPoolInfo;
    }> = [];

    for (let i = 0; i < Number(balance); i++) {
      const tokenId = await positionManager.tokenOfOwnerByIndex(userAddress, i);
      const position = await positionManager.positions(tokenId);

      // Check if this position belongs to our target pool
      if (
        position.token0.toLowerCase() ===
          poolInfo.token0.address.toLowerCase() &&
        position.token1.toLowerCase() === poolInfo.token1.address.toLowerCase()
      ) {
        unstakedPositions.push({
          tokenId: tokenId.toString(),
          position,
          poolInfo,
        });
      }
    }

    return unstakedPositions;
  } catch (error: any) {
    throw new Error(`Failed to get user unstaked positions: ${error.message}`);
  }
}

export async function getAllUserPositionsForPool(
  userAddress: string,
  poolAddress: string,
  positionManagerAddress: string,
  provider: JsonRpcProvider,
): Promise<{
  stakedPositions: Array<{
    tokenId: string;
    position: any;
    poolInfo: ContractPoolInfo;
  }>;
  unstakedPositions: Array<{
    tokenId: string;
    position: any;
    poolInfo: ContractPoolInfo;
  }>;
}> {
  try {
    // Get staked positions from gauge
    const stakedPosition = await getUserStakedPosition(
      userAddress,
      poolAddress,
      positionManagerAddress,
      provider,
    );

    // Get unstaked positions from user's wallet
    const unstakedPositions = await getUserUnstakedPositions(
      userAddress,
      poolAddress,
      positionManagerAddress,
      provider,
    );

    return {
      stakedPositions: stakedPosition ? [stakedPosition] : [],
      unstakedPositions: unstakedPositions,
    };
  } catch (error: any) {
    throw new Error(`Failed to get all user positions: ${error.message}`);
  }
}

/**
 * Calculate position token amounts with current pool state
 */
export async function calculatePositionAmounts(
  poolAddress: string,
  position: any,
  poolInfo: ContractPoolInfo,
  provider: JsonRpcProvider,
): Promise<{ token0Balance: string; token1Balance: string }> {
  // Get current tick
  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const slot0 = await poolContract.slot0();

  // Calculate token amounts using tick math
  const { amount0, amount1 } = calculateTokenAmounts(
    position.liquidity,
    position.tickLower,
    position.tickUpper,
    Number(slot0.tick),
  );

  const token0Balance = ethers.formatUnits(
    amount0,
    parseInt(poolInfo.token0.decimals),
  );
  const token1Balance = ethers.formatUnits(
    amount1,
    parseInt(poolInfo.token1.decimals),
  );

  return { token0Balance, token1Balance };
}

/**
 * Get token information (symbol and decimals)
 */
export const getTokenInfo = async (
  tokenAddress: string,
  provider: JsonRpcProvider,
): Promise<{ symbol: string; decimals: number }> => {
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const [symbol, decimals] = await Promise.all([
    tokenContract.symbol(),
    tokenContract.decimals(),
  ]);

  return { symbol, decimals: Number(decimals) };
};

/**
 * Get gauge staking information for a specific tokenId
 */
export const getGaugeInfo = async (
  userAddress: string,
  tokenId: bigint,
  gaugeAddress: string,
  provider: JsonRpcProvider,
): Promise<{ isStaked: boolean; pendingRewards: string }> => {
  try {
    const gaugeContract = new ethers.Contract(
      gaugeAddress,
      GAUGE_ABI,
      provider,
    );

    const isStaked = await gaugeContract.stakedContains(userAddress, tokenId);

    let pendingRewards = '0';
    if (isStaked) {
      const rewardsWei = await gaugeContract.earned(userAddress, tokenId);
      pendingRewards = formatUnits(rewardsWei, 18); // AERO has 18 decimals
    }

    return { isStaked, pendingRewards };
  } catch (error: any) {
    // If gauge calls fail, assume not staked
    return { isStaked: false, pendingRewards: '0' };
  }
};

/**
 * Remove liquidity from a position
 */
export async function removeLiquidity(
  tokenId: string,
  liquidity: string,
  poolAddress: string,
  positionManagerAddress: string,
  provider: JsonRpcProvider,
  signer: any,
): Promise<string> {
  const positionManager = new ethers.Contract(
    positionManagerAddress,
    POSITION_MANAGER_ABI,
    signer,
  );

  const positionData = await positionManager.positions(BigInt(tokenId));
  
  const {
    2: token0Address,
    3: token1Address,
    4: fee,
    5: tickLower,
    6: tickUpper,
    7: currentLiquidity,
    10: tokensOwed0,
    11: tokensOwed1,
  } = positionData;

  const liquidityToRemove = BigInt(liquidity);
  
  if (liquidityToRemove > currentLiquidity) {
    throw new Error(
      `Cannot remove ${liquidity} liquidity. Position only has ${currentLiquidity.toString()} liquidity available.`
    );
  }
  
  const poolContract = new ethers.Contract(
    poolAddress,
    ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)'],
    provider
  );
  const slot0 = await poolContract.slot0();
  const currentTick = Number(slot0.tick);
  
  const { amount0, amount1 } = calculateTokenAmounts(
    liquidityToRemove,
    BigInt(tickLower),
    BigInt(tickUpper),
    currentTick
  );
  
  // Apply 2% slippage tolerance
  const slippageTolerance = 98n; // 98% = 2% slippage
  const amount0Min = (amount0 * slippageTolerance) / 100n;
  const amount1Min = (amount1 * slippageTolerance) / 100n;

  const params = {
    tokenId: BigInt(tokenId),
    liquidity: liquidityToRemove,
    amount0Min: amount0Min,
    amount1Min: amount1Min,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1800), // 30 minutes
  };

  const tx = await positionManager.decreaseLiquidity(params);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Collect fees from a position
 */
export async function collectFees(
  tokenId: string,
  recipient: string,
  positionManagerAddress: string,
  provider: JsonRpcProvider,
  signer: any,
): Promise<string> {
  const positionManager = new ethers.Contract(
    positionManagerAddress,
    POSITION_MANAGER_ABI,
    signer,
  );

  const positionData = await positionManager.positions(BigInt(tokenId));
  
  const {
    10: tokensOwed0,
    11: tokensOwed1,
  } = positionData;

  const params = {
    tokenId: BigInt(tokenId),
    recipient: recipient,
    amount0Max: tokensOwed0,
    amount1Max: tokensOwed1,
  };

  const tx = await positionManager.collect(params);
  const receipt = await tx.wait();
  return receipt.hash;
}
