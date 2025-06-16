import axios from 'axios';
import 'dotenv/config';
import { PoolDayData, PoolInfo } from './types';

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
