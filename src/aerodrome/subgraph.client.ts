// CHANGE: Extracted Aerodrome subgraph client based on Uniswap example pattern
import axios from 'axios';
import 'dotenv/config';

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
    }
  }
`;

const POOL_HOUR_DATA_QUERY = `
  query PoolHourData($poolId: ID!, $startTime: Int!, $endTime: Int!) {
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
      feesUSD
    }
  }
`;

export interface CurrentPoolData {
  token0Price: string;
  token1Price: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
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

export interface PoolHourData {
  periodStartUnix: number;
  token0Price: string;
  token1Price: string;
  tvlUSD: string;
  volumeUSD: string;
  feesUSD: string;
}

/**
 * Execute GraphQL query against Aerodrome subgraph
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
 * Returns raw data with no processing - useful for quick price checks
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
 * Returns comprehensive daily metrics including fees, volume, and prices
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

/**
 * Get historical hourly data for detailed analysis
 * Provides higher granularity data for intraday analysis
 */
export async function fetchPoolHourData(
  poolAddress: string,
  startTime: number,
  endTime: number,
): Promise<PoolHourData[]> {
  const formattedPoolAddress = poolAddress.toLowerCase();

  const data = await executeQuery(
    POOL_HOUR_DATA_QUERY,
    {
      poolId: formattedPoolAddress,
      startTime,
      endTime,
    },
    'PoolHourData',
  );

  if (!data?.poolHourDatas) {
    console.error('No pool hour data returned from GraphQL query');
    return [];
  }

  return data.poolHourDatas;
}
