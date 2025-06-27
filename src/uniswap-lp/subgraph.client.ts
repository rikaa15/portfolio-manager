//subgraph.client.ts
import axios from 'axios';
import 'dotenv/config';
import { CurrentPoolData, PoolDayData, PoolHourPrice, PoolInfo } from './types';

const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY;

const client = axios.create({
  baseURL:
    'https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUBGRAPH_API_KEY}`,
  },
});

const getUnixTimestamp = (dateString: string): number => {
  return Math.floor(new Date(dateString).getTime() / 1000);
};

const POOL_PRICE_QUERY = `
  query PoolPrice($poolId: ID!) {
    pool(id: $poolId) {
      token0Price
      token1Price
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
`;

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

const POOL_HOUR_PRICES_QUERY = `
  query PoolHourPrices($poolId: ID!, $startTime: Int!, $endTime: Int!) {
    poolHourDatas(
      where: { 
        pool: $poolId,
        periodStartUnix_gte: $startTime,
        periodStartUnix_lte: $endTime
      }
      orderBy: periodStartUnix
      orderDirection: asc
      first: 1000
    ) {
      periodStartUnix
      token0Price
      token1Price
      tvlUSD
      volumeUSD
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
      liquidity
      tick
    }
  }
`;

/**
 * Execute GraphQL query against Uniswap V3 subgraph
 * Generic query executor with proper error handling
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
 * Get current pool data for price fetching
 * Returns raw data with no processing
 */
export async function fetchCurrentPoolData(
  poolAddress: string,
): Promise<CurrentPoolData> {
  const formattedPoolAddress = poolAddress.toLowerCase();

  const data = await executeQuery(
    POOL_PRICE_QUERY,
    {
      poolId: formattedPoolAddress,
    },
    'PoolPrice',
  );

  if (!data?.pool) {
    throw new Error('Pool not found');
  }

  return data.pool;
}

/**
 * Get pool basic information
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
 * Get historical daily data for the pool
 */
export async function fetchPoolDayPrices(
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
    console.error('No pool day data returned from GraphQL query');
    return [];
  }

  return data.poolDayDatas;
}

export async function fetchPoolHourPrices(
  poolAddress: string,
  startTime: number,
  endTime: number,
): Promise<PoolHourPrice[]> {
  const formattedPoolAddress = poolAddress.toLowerCase();

  const data = await executeQuery(
    POOL_HOUR_PRICES_QUERY,
    {
      poolId: formattedPoolAddress,
      startTime,
      endTime,
    },
    'PoolHourPrices',
  );

  if (!data?.poolHourDatas) {
    console.error('No pool hour price data returned from GraphQL query');
    return [];
  }

  return data.poolHourDatas;
}
