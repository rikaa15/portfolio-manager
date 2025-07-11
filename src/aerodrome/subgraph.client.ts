// src/aerodrome/subgraph.client.ts
import axios from 'axios';
import 'dotenv/config';
import { PoolDayData, PoolHourData, PoolInfo } from './types';
import { logger } from '../common/utils/common.utils';

const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY;

const client = axios.create({
  baseURL:
    'https://gateway.thegraph.com/api/subgraphs/id/GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUBGRAPH_API_KEY}`,
  },
});

const getUnixTimestamp = (dateString: string): number => {
  return Math.floor(new Date(dateString).getTime() / 1000);
};

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
      feeGrowthGlobal0X128
      feeGrowthGlobal1X128
      high
      low
      sqrtPrice
    }
  }
`;

const POOL_HOUR_DATA_QUERY = `
  query PoolHourData($poolId: ID!, $startTime: Int!, $endTime: Int!, $skip: Int!) {
    poolHourDatas(
      where: { 
        pool: $poolId, 
        periodStartUnix_gte: $startTime, 
        periodStartUnix_lte: $endTime 
      }
      orderBy: periodStartUnix
      orderDirection: asc
      first: 1000
      skip: $skip
    ) {
      id
      periodStartUnix
      liquidity
      sqrtPrice
      token0Price
      token1Price
      tick
      feeGrowthGlobal0X128
      feeGrowthGlobal1X128
      tvlUSD
      volumeToken0
      volumeToken1
      volumeUSD
      feesUSD
      txCount
      open
      high
      low
      close
    }
  }
`;

/**
 * Execute GraphQL query against Aerodrome subgraph
 * Simplified version without position tracking (not needed for unstaked positions)
 */
async function executeQuery(
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
      logger.error(
        `Query failed: ${error.response.status} ${error.response.statusText}`,
      );
      if (error.response.data) {
        logger.error(`Response: ${JSON.stringify(error.response.data)}`);
      }
    } else if (error.message) {
      logger.error(`Error: ${error.message}`);
    } else {
      logger.error(`Unknown error: ${String(error)}`);
    }
    throw error;
  }
}

/**
 * Get pool information for setup and validation
 * Same structure as Uniswap but using Aerodrome subgraph
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
 * Uses same data structure as Uniswap for unified processing
 */
export async function fetchPoolDayData(
  poolAddress: string,
  startDate: string,
  endDate: string,
): Promise<PoolDayData[]> {
  const formattedPoolAddress = poolAddress.toLowerCase();
  const startTimestamp = getUnixTimestamp(startDate);
  const endTimestamp = getUnixTimestamp(endDate);

  const data = await executeQuery(
    POOL_DAY_DATA_QUERY,
    {
      poolId: formattedPoolAddress,
      startDate: startTimestamp,
      endDate: endTimestamp,
    },
    'PoolDayData',
  );

  if (!data?.poolDayDatas) {
    logger.error('No pool day data returned from GraphQL query');
    return [];
  }
  return data.poolDayDatas;
}

/**
 * Get historical hourly data for backtesting with automatic pagination
 * Handles subgraph 1000-entry limit by making multiple requests
 * Returns complete dataset for the requested time period
 */
export async function fetchPoolHourData(
  poolAddress: string,
  startDate: string,
  endDate: string,
): Promise<PoolHourData[]> {
  const formattedPoolAddress = poolAddress.toLowerCase();
  const startTimestamp = getUnixTimestamp(startDate);
  const endTimestamp = getUnixTimestamp(endDate);

  logger.log(
    `Fetching hourly data from ${startDate} to ${endDate} (${startTimestamp} to ${endTimestamp})`,
  );

  const allHourData: PoolHourData[] = [];
  let skip = 0;
  const batchSize = 1000;
  let hasMoreData = true;
  let batchCount = 0;

  // Continue fetching until we get all data or reach a reasonable limit
  while (hasMoreData && batchCount < 20) {
    // Safety limit to prevent infinite loops
    batchCount++;

    try {
      const data = await executeQuery(
        POOL_HOUR_DATA_QUERY,
        {
          poolId: formattedPoolAddress,
          startTime: startTimestamp,
          endTime: endTimestamp,
          skip,
        },
        'PoolHourData',
      );

      if (!data?.poolHourDatas || data.poolHourDatas.length === 0) {
        logger.log('No more hourly data available');
        hasMoreData = false;
        break;
      }

      const batchData = data.poolHourDatas;
      allHourData.push(...batchData);
      // If we got less than the batch size, we've reached the end
      if (batchData.length < batchSize) {
        hasMoreData = false;
      } else {
        skip += batchSize;
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      logger.error(`Error fetching batch ${batchCount}: ${error}`);
      // Continue with what we have rather than failing completely
      hasMoreData = false;
    }
  }

  logger.log(
    `Completed fetching hourly data. Total entries: ${allHourData.length}`,
  );

  // Sort by timestamp to ensure chronological order
  allHourData.sort((a, b) => a.periodStartUnix - b.periodStartUnix);

  return allHourData;
}

/**
 * Get statistics about available data for a pool
 * Useful for understanding data completeness before backtesting
 */
export async function getDataCoverage(
  poolAddress: string,
  startDate: string,
  endDate: string,
): Promise<{
  dailyEntries: number;
  hourlyEntries: number;
  expectedHourlyEntries: number;
  coveragePercentage: number;
  firstEntry: number;
  lastEntry: number;
}> {
  // const formattedPoolAddress = poolAddress.toLowerCase();
  const startTimestamp = getUnixTimestamp(startDate);
  const endTimestamp = getUnixTimestamp(endDate);

  // Calculate expected hourly entries
  const hoursDiff = Math.floor((endTimestamp - startTimestamp) / 3600);

  // Get actual data
  const [dailyData, hourlyData] = await Promise.all([
    fetchPoolDayData(poolAddress, startDate, endDate),
    fetchPoolHourData(poolAddress, startDate, endDate),
  ]);

  const firstEntry = hourlyData.length > 0 ? hourlyData[0].periodStartUnix : 0;
  const lastEntry =
    hourlyData.length > 0
      ? hourlyData[hourlyData.length - 1].periodStartUnix
      : 0;

  return {
    dailyEntries: dailyData.length,
    hourlyEntries: hourlyData.length,
    expectedHourlyEntries: hoursDiff,
    coveragePercentage: hourlyData.length / hoursDiff,
    firstEntry,
    lastEntry,
  };
}
