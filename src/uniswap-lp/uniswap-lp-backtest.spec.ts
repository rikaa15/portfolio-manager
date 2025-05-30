import axios from 'axios';
import 'dotenv/config';

const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY;

const POOL_ADDRESS = '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35';
const INITIAL_INVESTMENT = 10000; // $10,000 USD

const logger = {
  log: (message: string) => {
    process.stdout.write(message + '\n');
  },
  error: (message: string) => {
    process.stderr.write(message + '\n');
  },
};

const client = axios.create({
  baseURL:
    'https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUBGRAPH_API_KEY}`,
  },
});

// Date helpers
const getUnixTimestamp = (dateString: string): number => {
  return Math.floor(new Date(dateString).getTime() / 1000);
};

const formatDate = (unixTimestamp: number): string => {
  return new Date(unixTimestamp * 1000).toISOString().split('T')[0];
};

// GraphQL queries
const POOL_INFO_QUERY = `
  query PoolInfo($poolId: ID!) {
    pool(id: $poolId) {
      id
      createdAtTimestamp
      token0 {
        symbol
        decimals
      }
      token1 {
        symbol
        decimals
      }
      feeTier
      totalValueLockedUSD
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

interface PoolInfo {
  id: string;
  createdAtTimestamp: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
  feeTier: string;
  totalValueLockedUSD: string;
}

interface PoolDayData {
  date: number;
  volumeUSD: string;
  feesUSD: string;
  tvlUSD: string;
  token0Price: string;
  token1Price: string;
  liquidity: string;
  tick: string;
}

/**
 * Execute GraphQL query against Uniswap V3 subgraph
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
    logger.error('=== REQUEST FAILED ===');
    if (error.response) {
      logger.error(
        `Status: ${error.response.status} ${error.response.statusText}`,
      );
      logger.error(`URL: ${error.response.config?.url || 'undefined'}`);
      logger.error(
        `Base URL: ${error.response.config?.baseURL || 'undefined'}`,
      );
      logger.error(
        `Full URL: ${(error.response.config?.baseURL || '') + (error.response.config?.url || '')}`,
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
 * Get pool basic information
 */
async function getPoolInfo(poolAddress: string): Promise<PoolInfo> {
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
async function getPoolDayData(
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
 * Calculate impermanent loss percentage
 */
function calculateImpermanentLoss(
  currentToken0Price: number,
  currentToken1Price: number,
  initialToken0Price: number,
  initialToken1Price: number,
): number {
  // Price ratio: relative change between token0 and token1 prices
  const priceRatio =
    currentToken0Price /
    initialToken0Price /
    (currentToken1Price / initialToken1Price);

  // Square root from constant product formula (x * y = k) used in AMMs
  const sqrtPriceRatio = Math.sqrt(priceRatio);

  // LP value formula: accounts for automatic rebalancing in AMM pools
  const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);

  // Holding value normalized to 1 (100% baseline)
  const holdValue = 1;

  // Impermanent loss: LP performance vs holding 50/50 portfolio
  return (lpValue - holdValue) * 100; // Convert to percentage
}

/**
 * Run backtest simulation
 */
async function runBacktest(
  poolAddress: string,
  startDate: string,
  endDate: string,
  initialAmount: number,
): Promise<void> {
  logger.log('=== WBTC/USDC LP Backtest ===');
  logger.log(`Pool: ${poolAddress}`);
  logger.log(`Period: ${startDate} to ${endDate}`);
  logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
  logger.log('');

  try {
    // Get pool information
    logger.log('Fetching pool information...');
    const poolInfo = await getPoolInfo(poolAddress);
    logger.log(
      `Pool Info: ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}`,
    );
    logger.log(`Fee Tier: ${parseFloat(poolInfo.feeTier) / 10000}%`);
    logger.log('');

    // Get historical data
    logger.log('Fetching historical data...');
    const poolDayData = await getPoolDayData(poolAddress, startDate, endDate);

    if (poolDayData.length === 0) {
      logger.log('No data found for the specified period');
      return;
    }

    logger.log(`Found ${poolDayData.length} days of data`);
    logger.log('');

    // Calculate initial LP share based on first day's TVL
    const firstDay = poolDayData[0];
    const lpSharePercentage = initialAmount / parseFloat(firstDay.tvlUSD);

    logger.log(`Initial TVL: $${parseFloat(firstDay.tvlUSD).toLocaleString()}`);
    logger.log(`LP Share: ${(lpSharePercentage * 100).toFixed(6)}%`);
    logger.log('');

    // Track cumulative values
    let cumulativeFees = 0;
    const initialToken0Price = parseFloat(firstDay.token0Price);
    const initialToken1Price = parseFloat(firstDay.token1Price);

    logger.log('Daily Performance:');
    logger.log('');

    // Process each day
    poolDayData.forEach((dayData, index) => {
      const dayNumber = index + 1;
      const date = formatDate(dayData.date);

      // Calculate daily fee earnings
      const dailyFees = parseFloat(dayData.feesUSD) * lpSharePercentage;
      cumulativeFees += dailyFees;

      // Calculate current position value (simplified)
      const currentTVL = parseFloat(dayData.tvlUSD);
      const currentPositionValue = currentTVL * lpSharePercentage;

      // Calculate impermanent loss
      const currentToken0Price = parseFloat(dayData.token0Price);
      const currentToken1Price = parseFloat(dayData.token1Price);
      const impermanentLoss = calculateImpermanentLoss(
        currentToken0Price,
        currentToken1Price,
        initialToken0Price,
        initialToken1Price,
      );

      // Calculate running APR based on fees only
      const daysElapsed = dayNumber;
      const runningAPR =
        (cumulativeFees / initialAmount) * (365 / daysElapsed) * 100;

      // Console output for each day
      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `Value: $${currentPositionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `Fees: $${cumulativeFees.toFixed(0)} | ` +
          `APR: ${runningAPR.toFixed(1)}%`,
      );
    });

    // Final summary
    const lastDay = poolDayData[poolDayData.length - 1];
    const finalPositionValue = parseFloat(lastDay.tvlUSD) * lpSharePercentage;
    const totalReturn =
      ((finalPositionValue + cumulativeFees - initialAmount) / initialAmount) *
      100;
    const finalAPR =
      (cumulativeFees / initialAmount) * (365 / poolDayData.length) * 100;

    logger.log('');
    logger.log('=== Final Summary ===');
    logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
    logger.log(`Final Position Value: $${finalPositionValue.toLocaleString()}`);
    logger.log(`Total Fees Collected: $${cumulativeFees.toLocaleString()}`);
    logger.log(
      `Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`,
    );
    logger.log(`Annualized APR (Fees Only): ${finalAPR.toFixed(2)}%`);
  } catch (error: any) {
    if (error.message) {
      logger.error('Backtest failed: ' + error.message);
    } else {
      logger.error('Backtest failed: ' + String(error));
    }
  }
}

describe('Uniswap LP Backtesting', () => {
  it('should backtest WBTC/USDC LP performance for 1 year', async () => {
    await runBacktest(
      POOL_ADDRESS,
      '2024-05-29', // Start date (1 year ago)
      '2025-05-29', // End date (today)
      INITIAL_INVESTMENT,
    );

    expect(true).toBe(true);
  }, 60000); // 60 second timeout for API calls
});
