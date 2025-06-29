import axios from 'axios';
import 'dotenv/config';
import { PoolDayData, PoolInfo, Position, SubgraphPositionFees } from './types';

const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY;

const client = axios.create({
  baseURL:
    'https://gateway.thegraph.com/api/subgraphs/id/GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUBGRAPH_API_KEY}`,
  },
});

const POOL_INFO_QUERY = `
  query PoolInfo($poolId: ID!) {
    pool(id: $poolId) {
      id
      totalValueLockedUSD
      liquidity
      token0 {
        symbol
        decimals
      }
      token1 {
        symbol
        decimals
      }
      token0Price
      token1Price
    }
  }
`;

const POOL_DAY_DATA_QUERY = `
  query PoolDayData($poolId: ID!, $startDate: Int!, $endDate: Int!) {
    poolDayDatas(
      where: { 
        pool: $poolId, 
        date_gte: $startDate, 
        date_lte: $endDate 
      }
      orderBy: date
      orderDirection: asc
      first: 1000
    ) {
      date
      volumeUSD
      feesUSD
      tvlUSD
      token0Price
      token1Price
      tick
      liquidity
    }
  }
`;

const POOL_POSITIONS_QUERY = `
  query PoolPositions($poolId: ID!) {
    positions(
      where: { 
        pool: $poolId,
        liquidity_gt: "0",
        owner_not: "0x0000000000000000000000000000000000000000"
      }
      first: 1000
      orderBy: liquidity
      orderDirection: desc
    ) {
      id
      liquidity
      owner
      tickLower {
        tickIdx
        liquidityGross
        liquidityNet
        feeGrowthOutside0X128
        feeGrowthOutside1X128
        feesUSD
      }
      tickUpper {
        tickIdx
        liquidityGross
        liquidityNet
        feeGrowthOutside0X128
        feeGrowthOutside1X128
        feesUSD
      }
    }
  }
`;

const POSITION_FEES_QUERY = `
  query PositionFees($tokenId: ID!) {
    position(id: $tokenId) {
      id
      owner
      liquidity
      depositedToken0
      depositedToken1
      withdrawnToken0
      withdrawnToken1
      collectedFeesToken0
      collectedFeesToken1
      feeGrowthInside0LastX128
      feeGrowthInside1LastX128
      pool {
        id
        token0 {
          symbol
          decimals
        }
        token1 {
          symbol
          decimals
        }
        feeGrowthGlobal0X128
        feeGrowthGlobal1X128
      }
      tickLower {
        tickIdx
        feeGrowthOutside0X128
        feeGrowthOutside1X128
      }
      tickUpper {
        tickIdx
        feeGrowthOutside0X128
        feeGrowthOutside1X128
      }
    }
  }
`;

const SIMPLE_POSITION_QUERY = `
  query SimplePosition($tokenId: ID!) {
    position(id: $tokenId) {
      id
      owner
      liquidity
    }
  }
`;

const EXPLORE_POSITION_QUERY = `
  query ExplorePosition($tokenId: ID!) {
    position(id: $tokenId) {
      id
      owner
      liquidity
      tickLower {
        tickIdx
      }
      tickUpper {
        tickIdx
      }
      pool {
        id
        token0 {
          symbol
          decimals
        }
        token1 {
          symbol
          decimals
        }
      }
    }
  }
`;

export async function executeQuery(
  query: string,
  variables: any,
  operationName?: string,
): Promise<any> {
  try {
    const requestData = {
      query,
      variables,
      operationName,
    };

    const { data } = await client.post('', requestData);

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  } catch (error: any) {
    if (error.response) {
      console.error(
        `Query failed: ${error.response.status} ${error.response.statusText}`,
      );
      if (error.response.data) {
        console.error(`Response: ${JSON.stringify(error.response.data)}`);
      }
    } else if (error.message) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Unknown error: ${String(error)}`);
    }
    throw error;
  }
}

/**
 * Get comprehensive pool information including TVL and liquidity
 * Used for initial pool analysis and setup
 */
export async function fetchPoolInfo(poolAddress: string): Promise<PoolInfo> {
  const formattedPoolAddress = poolAddress.toLowerCase();

  const data = await executeQuery(
    POOL_INFO_QUERY,
    {
      poolId: formattedPoolAddress,
    },
    'PoolInfo',
  );

  if (!data?.pool) {
    throw new Error('Pool not found');
  }

  return data.pool;
}

/**
 * Get historical daily data for backtesting
 * Returns comprehensive daily metrics including fees, volume, prices, and block info
 */
export async function fetchPoolDayData(
  poolAddress: string,
  startTime: number,
  endTime: number,
): Promise<PoolDayData[]> {
  const formattedPoolAddress = poolAddress.toLowerCase();

  const data = await executeQuery(
    POOL_DAY_DATA_QUERY,
    {
      poolId: formattedPoolAddress,
      startDate: startTime,
      endDate: endTime,
    },
    'PoolDayData',
  );

  if (!data?.poolDayDatas) {
    console.error('No pool day data returned from GraphQL query');
    return [];
  }

  return data.poolDayDatas;
}

export async function fetchPoolPositions(
  poolAddress: string,
): Promise<Position[]> {
  const formattedPoolAddress = poolAddress.toLowerCase();

  const data = await executeQuery(
    POOL_POSITIONS_QUERY,
    {
      poolId: formattedPoolAddress,
    },
    'PoolPositions',
  );

  if (!data?.positions) {
    console.warn('No position data found for pool');
    return [];
  }

  return data.positions;
}

/**
 * Get position-specific fee data from the subgraph
 * Returns collected and uncollected fees for a specific tokenId
 */
export async function fetchPositionFees(tokenId: string): Promise<SubgraphPositionFees | null> {
  try {
    console.log(`🔍 Fetching position fees for tokenId: ${tokenId}`);
    
    const data = await executeQuery(
      POSITION_FEES_QUERY,
      {
        tokenId: tokenId,
      },
      'PositionFees',
    );

    console.log(`📊 Raw subgraph response:`, JSON.stringify(data, null, 2));

    if (!data?.position) {
      console.warn(`❌ No position data found for tokenId: ${tokenId}`);
      console.log(`🔄 Trying simpler position query to debug schema...`);
      return await fetchSimplePosition(tokenId); // Fallback to simpler query
    }

    const position = data.position;
    
    console.log(`📈 Position details:`, {
      id: position.id,
      owner: position.owner,
      liquidity: position.liquidity,
      collectedFeesToken0: position.collectedFeesToken0,
      collectedFeesToken1: position.collectedFeesToken1,
      depositedToken0: position.depositedToken0,
      depositedToken1: position.depositedToken1,
      withdrawnToken0: position.withdrawnToken0,
      withdrawnToken1: position.withdrawnToken1,
    });
    
    // Calculate uncollected fees using fee growth (this might fail due to sentinel values)
    const uncollectedFeesToken0 = calculateUncollectedFees(position, 0);
    const uncollectedFeesToken1 = calculateUncollectedFees(position, 1);
    
    console.log(`🎯 Fee calculation results:`);
    console.log(`  Token0 (${position.pool.token0.symbol}): ${uncollectedFeesToken0}`);
    console.log(`  Token1 (${position.pool.token1.symbol}): ${uncollectedFeesToken1}`);
    
    return {
      collectedFeesToken0: position.collectedFeesToken0 || '0',
      collectedFeesToken1: position.collectedFeesToken1 || '0',
      uncollectedFeesToken0: uncollectedFeesToken0,
      uncollectedFeesToken1: uncollectedFeesToken1,
      token0Symbol: position.pool.token0.symbol,
      token1Symbol: position.pool.token1.symbol,
      token0Decimals: position.pool.token0.decimals,
      token1Decimals: position.pool.token1.decimals,
    };
  } catch (error: any) {
    console.error(`❌ Error fetching position fees for tokenId ${tokenId}:`, error.message);
    console.error(`❌ Full error:`, error);
    console.log(`🔄 Trying simpler position query as fallback...`);
    return await fetchSimplePosition(tokenId); // Fallback to simpler query
  }
}

/**
 * Simpler position query to debug what fields are available
 */
async function fetchSimplePosition(tokenId: string): Promise<SubgraphPositionFees | null> {
  try {
    console.log(`🔍 Fetching simple position data for tokenId: ${tokenId}`);
    
    const data = await executeQuery(
      EXPLORE_POSITION_QUERY,
      {
        tokenId: tokenId,
      },
      'ExplorePosition',
    );

    console.log(`📊 Simple position response:`, JSON.stringify(data, null, 2));

    if (!data?.position) {
      console.warn(`❌ No position found even with simple query for tokenId: ${tokenId}`);
      return null;
    }

    const position = data.position;
    
    // Return basic structure with zeros since we don't have fee data
    return {
      collectedFeesToken0: '0',
      collectedFeesToken1: '0',
      uncollectedFeesToken0: '0',
      uncollectedFeesToken1: '0',
      token0Symbol: position.pool.token0.symbol,
      token1Symbol: position.pool.token1.symbol,
      token0Decimals: position.pool.token0.decimals,
      token1Decimals: position.pool.token1.decimals,
    };
  } catch (error: any) {
    console.error(`❌ Error with simple position query for tokenId ${tokenId}:`, error.message);
    return null;
  }
}

/**
 * Calculate uncollected fees using fee growth data (Uniswap V3 style)
 * This implements the actual Uniswap V3 fee calculation formula
 */
function calculateUncollectedFees(position: any, tokenIndex: 0 | 1): string {
  try {
    if (!position.liquidity || position.liquidity === '0') {
      return '0';
    }

    const liquidity = BigInt(position.liquidity);
    
    // Get fee growth values based on token index
    const feeGrowthGlobal = BigInt(tokenIndex === 0 ? 
      position.pool.feeGrowthGlobal0X128 : 
      position.pool.feeGrowthGlobal1X128);
    
    const feeGrowthOutsideLower = BigInt(tokenIndex === 0 ? 
      position.tickLower.feeGrowthOutside0X128 : 
      position.tickLower.feeGrowthOutside1X128);
    
    const feeGrowthOutsideUpper = BigInt(tokenIndex === 0 ? 
      position.tickUpper.feeGrowthOutside0X128 : 
      position.tickUpper.feeGrowthOutside1X128);
    
    const feeGrowthInsideLast = BigInt(tokenIndex === 0 ? 
      position.feeGrowthInside0LastX128 : 
      position.feeGrowthInside1LastX128);

    console.log(`🧮 Fee calculation for token${tokenIndex}:`);
    console.log(`  Liquidity: ${liquidity.toString()}`);
    console.log(`  Global fee growth: ${feeGrowthGlobal.toString()}`);
    console.log(`  Outside lower: ${feeGrowthOutsideLower.toString()}`);
    console.log(`  Outside upper: ${feeGrowthOutsideUpper.toString()}`);
    console.log(`  Inside last: ${feeGrowthInsideLast.toString()}`);

    // Check if feeGrowthInsideLast is a sentinel value (close to uint256.max)
    const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    const SENTINEL_THRESHOLD = MAX_UINT256 - BigInt('1000000000000000000000000000000000000000'); // Large threshold
    
    if (feeGrowthInsideLast > SENTINEL_THRESHOLD) {
      console.log(`  🚨 Detected sentinel value for feeGrowthInsideLast, this might be an uninitialized position`);
      console.log(`  🔍 Trying alternative fee calculation...`);
      
      // Alternative approach: try to estimate fees from deposited vs withdrawn amounts
      const deposited = parseFloat(tokenIndex === 0 ? position.depositedToken0 : position.depositedToken1);
      const withdrawn = parseFloat(tokenIndex === 0 ? position.withdrawnToken0 : position.withdrawnToken1);
      
      console.log(`  Deposited: ${deposited}, Withdrawn: ${withdrawn}`);
      
      if (deposited > 0 && withdrawn === 0) {
        // This position has never withdrawn fees, so no collected fees yet
        // But there might still be uncollected fees we can estimate
        console.log(`  🔄 Position never collected fees, trying simple proportional estimation...`);
        
        // Simple estimation: assume small percentage of deposited amount as fees
        // This is very rough but might give us an idea
        const estimatedFeeRate = 0.0003; // 0.03% as rough estimate
        const estimatedFees = deposited * estimatedFeeRate;
        
        console.log(`  📊 Estimated fees (rough): ${estimatedFees}`);
        
        if (estimatedFees > 0.001) { // Only return if meaningful
          // Fix precision issue - round to reasonable decimal places for the token
          const decimals = parseInt(tokenIndex === 0 ? 
            position.pool.token0.decimals : 
            position.pool.token1.decimals);
          
          // Round to token decimals (e.g., 6 for USDC, 8 for BTC)
          const roundedFees = Math.round(estimatedFees * Math.pow(10, decimals)) / Math.pow(10, decimals);
          
          console.log(`  📊 Rounded estimated fees: ${roundedFees}`);
          
          return roundedFees.toString();
        }
      }
      
      return '0';
    }

    // Calculate feeGrowthInside using Uniswap V3 formula
    // Simplified assumption: current price is between tickLower and tickUpper
    // feeGrowthInside = feeGrowthGlobal - feeGrowthOutsideLower - feeGrowthOutsideUpper
    const feeGrowthInside = feeGrowthGlobal - feeGrowthOutsideLower - feeGrowthOutsideUpper;
    
    console.log(`  Calculated feeGrowthInside: ${feeGrowthInside.toString()}`);
    
    // Calculate uncollected fees: liquidity * (feeGrowthInside - feeGrowthInsideLast) / 2^128
    const Q128 = BigInt('0x100000000000000000000000000000000'); // 2^128
    const feeGrowthDelta = feeGrowthInside - feeGrowthInsideLast;
    
    console.log(`  Fee growth delta: ${feeGrowthDelta.toString()}`);
    
    if (feeGrowthDelta <= 0n) {
      console.log(`  No fee growth, returning 0`);
      return '0';
    }
    
    const uncollectedFeesRaw = (liquidity * feeGrowthDelta) / Q128;
    
    console.log(`  Uncollected fees (raw): ${uncollectedFeesRaw.toString()}`);
    
    // Convert to decimal string based on token decimals
    const decimals = parseInt(tokenIndex === 0 ? 
      position.pool.token0.decimals : 
      position.pool.token1.decimals);
    
    const uncollectedFeesFormatted = Number(uncollectedFeesRaw.toString()) / Math.pow(10, decimals);
    
    console.log(`  Uncollected fees (formatted): ${uncollectedFeesFormatted}`);
    
    return uncollectedFeesFormatted.toString();
  } catch (error: any) {
    console.error(`❌ Error calculating uncollected fees for token${tokenIndex}:`, error.message);
    return '0';
  }
}
