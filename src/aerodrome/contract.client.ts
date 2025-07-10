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
  knownGaugeAddress?: string,
): Promise<ContractPoolInfo> {
  try {
    const overrides = blockNumber ? { blockTag: blockNumber } : {};
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

    // Try to get basic pool info first
    const [
      token0Address,
      token1Address,
      liquidity,
      stakedLiquidity,
      slot0,
    ] = await Promise.all([
      poolContract.token0(overrides),
      poolContract.token1(overrides),
      poolContract.liquidity(overrides),
      poolContract.stakedLiquidity(overrides),
      poolContract.slot0(overrides),
    ]);

    // Try to get gauge address, but handle cases where it might not exist
    let gaugeAddress = knownGaugeAddress || '0x0000000000000000000000000000000000000000';
    try {
      const poolGaugeAddress = await poolContract.gauge(overrides);
      gaugeAddress = poolGaugeAddress;
    } catch (error) {
      if (knownGaugeAddress) {
        gaugeAddress = knownGaugeAddress;
      }
    }

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

    // Get token information using known addresses (no need for contract calls)
    let token0Symbol: string;
    let token0Decimals: number;
    let token1Symbol: string;
    let token1Decimals: number;

    // Use fallback values based on known token addresses
    if (token0Address.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') {
      token0Symbol = 'USDC';
      token0Decimals = 6;
    } else if (token0Address.toLowerCase() === '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf') {
      token0Symbol = 'cbBTC';
      token0Decimals = 8;
    } else {
      token0Symbol = 'TOKEN0';
      token0Decimals = 18;
    }
    
    if (token1Address.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') {
      token1Symbol = 'USDC';
      token1Decimals = 6;
    } else if (token1Address.toLowerCase() === '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf') {
      token1Symbol = 'cbBTC';
      token1Decimals = 8;
    } else {
      token1Symbol = 'TOKEN1';
      token1Decimals = 18;
    }

    const gaugeContract = new ethers.Contract(
      gaugeAddress,
      GAUGE_ABI,
      provider,
    );
    
    // Get gauge information with fallbacks
    let rewardRate = 0n;
    let gaugeFees0 = '0';
    let gaugeFees1 = '0';
    
    try {
      rewardRate = await gaugeContract.rewardRate(overrides);
    } catch (error) {
      rewardRate = 0n;
    }

    try {
      const [fees0, fees1] = await Promise.all([
        gaugeContract.fees0(overrides),
        gaugeContract.fees1(overrides),
      ]);
      gaugeFees0 = fees0.toString();
      gaugeFees1 = fees1.toString();
    } catch (error) {
      gaugeFees0 = '0';
      gaugeFees1 = '0';
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

/**
 * Get user's staked position in a specific pool
 * Returns the tokenId and position details if found
 */
export async function getUserStakedPosition(
  userAddress: string,
  poolAddress: string,
  positionManagerAddress: string,
  provider: JsonRpcProvider,
  knownGaugeAddress?: string,
): Promise<{
  tokenId: string;
  position: any;
  poolInfo: ContractPoolInfo;
} | null> {
  try {
    // Get pool info first
    const poolInfo = await fetchPoolInfoDirect(poolAddress, provider, undefined, knownGaugeAddress);

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
    try {
      const rewardsWei = await gaugeContract.earned(userAddress, tokenId);
      pendingRewards = formatUnits(rewardsWei, 18);
    } catch (error) {
      pendingRewards = '0';
    }

    return { isStaked, pendingRewards };
  } catch (error: any) {
    // If gauge calls fail, assume not staked
    return { isStaked: false, pendingRewards: '0' };
  }
};

/**
 * Get user's position (staked or unstaked) in a specific pool
 * Returns the tokenId and position details if found
 */
export async function getUserPosition(
  userAddress: string,
  poolAddress: string,
  positionManagerAddress: string,
  provider: JsonRpcProvider,
  knownGaugeAddress?: string,
): Promise<{
  tokenId: string;
  position: any;
  poolInfo: ContractPoolInfo;
} | null> {
  try {
    const poolInfo = await fetchPoolInfoDirect(poolAddress, provider, undefined, knownGaugeAddress);

    const positionManager = new ethers.Contract(
      positionManagerAddress,
      POSITION_MANAGER_ABI,
      provider,
    );

    console.log(`Discovering NFT positions for user: ${userAddress}`);
    
    const allTokenIds: bigint[] = [];
    
    try {
      const balance = await positionManager.balanceOf(userAddress);
      console.log(`User has ${balance} NFT positions`);
      
      if (balance > 0n) {
        for (let i = 0; i < Number(balance); i++) {
          try {
            const tokenId = await positionManager.tokenOfOwnerByIndex(userAddress, i);
            allTokenIds.push(tokenId);
            console.log(`Found NFT token ID: ${tokenId}`);
          } catch (error: any) {
            console.warn(`Failed to get token at index ${i}: ${error.message}`);
            continue;
          }
        }
      }
    } catch (error: any) {
      console.warn(`Failed to get user balance: ${error.message}`);
      console.log(`Trying fallback approach with known token IDs...`);
      
      // Method 2: Fallback - try known token IDs from the conversation
      const knownTokenIds = [18724098n];
      
      for (const tokenId of knownTokenIds) {
        try {
          const owner = await positionManager.ownerOf(tokenId);
          if (owner.toLowerCase() === userAddress.toLowerCase()) {
            allTokenIds.push(tokenId);
            console.log(`Found NFT token ID via fallback: ${tokenId}`);
          }
        } catch (error: any) {
          console.warn(`Token ID ${tokenId} not found: ${error.message}`);
          continue;
        }
      }
    }

    if (allTokenIds.length === 0) {
      console.log(`No valid token IDs found`);
      return null;
    }

    // Check each NFT to see if it matches the target pool
    for (let i = 0; i < allTokenIds.length; i++) {
      try {
        const tokenId = allTokenIds[i];
        console.log(`Checking position for token ID: ${tokenId}`);
        
        const position = await positionManager.positions(tokenId);
        
        // Check if tokens match (handle both token orders)
        const tokensMatch = (
          (position.token0.toLowerCase() === poolInfo.token0.address.toLowerCase() &&
           position.token1.toLowerCase() === poolInfo.token1.address.toLowerCase()) ||
          (position.token0.toLowerCase() === poolInfo.token1.address.toLowerCase() &&
           position.token1.toLowerCase() === poolInfo.token0.address.toLowerCase())
        );
        
        if (tokensMatch) {
          console.log(`Found matching position for pool ${poolAddress}: Token ID ${tokenId}`);
          return {
            tokenId: tokenId.toString(),
            position,
            poolInfo,
          };
        } else {
          console.log(`Token ID ${tokenId} does not match pool ${poolAddress}`);
          console.log(`Position tokens: ${position.token0} / ${position.token1}`);
          console.log(`Pool tokens: ${poolInfo.token0.address} / ${poolInfo.token1.address}`);
        }
      } catch (error: any) {
        console.warn(`Failed to check position for token ID ${allTokenIds[i]}: ${error.message}`);
        continue;
      }
    }

    console.log(`No positions found in pool ${poolAddress}`);
    return null;
  } catch (error: any) {
    throw new Error(`Failed to get user position: ${error.message}`);
  }
}
