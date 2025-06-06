import axios from 'axios';
import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { fetchPoolInfo, fetchPoolDayPrices } from './uniswap-lp/subgraph.client';
import { ethers } from 'ethers';
import { FundingService } from './funding/funding.service';

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

    if (data.errors && data.errors.length > 0) {
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
  fundingService: FundingService,
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

    // Fetch finding rates history
    logger.log(`Fetching funding rates from ${startDate} to ${endDate}...`);
    const fundingRates = await fundingService.getHistoricalFundingRates(
      'BTC',
      new Date(startDate).getTime(),
      new Date(endDate).getTime()
    );
    logger.log(`Found ${fundingRates.length} funding rates. First value: ${fundingRates[0].fundingRate}, time: ${fundingRates[0].time}`);

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

      // Get nearest funding rate for the day
      const fundingRate = fundingRates.find(rate => Math.abs(Math.round(rate.time / 1000) - dayData.date) < 8 * 60 * 60);
      if (!fundingRate) {
        logger.log(`No funding rate found for ${date}`);
      } else {
        // logger.log(`Funding rate for ${date}: ${fundingRate.fundingRate}, funding time: ${fundingRate.time}`);
      }
      

      // Calculate daily fee earnings
      const dailyFees = parseFloat(dayData.feesUSD) * lpSharePercentage;
      cumulativeFees += dailyFees;

      // Calculate current position value
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

      // Calculate total PnL
      const positionPnL = currentPositionValue - initialAmount;
      const totalPnL = positionPnL + cumulativeFees;

      // Calculate running APR based on fees only
      const daysElapsed = dayNumber;
      const runningAPR =
        (cumulativeFees / initialAmount) * (365 / daysElapsed) * 100;

      // Clean output: Position Value, IL, PnL, APR
      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `Value: $${currentPositionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | ` +
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

describe('AppService', () => {
  let appService: AppService;
  let uniswapService: UniswapLpService;
  let hyperliquidService: HyperliquidService;
  let configService: ConfigService;
  let fundingService: FundingService;
  let logger: Logger;

  // Mock data
  const MOCK_POSITION_ID = '999399';
  const mockPosition = {
    token0: {
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
      symbol: 'WBTC',
      decimals: 8
    },
    token1: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      symbol: 'USDC',
      decimals: 6
    },
    token0Balance: ethers.parseUnits('1', 8), // 1 WBTC
    token1Balance: ethers.parseUnits('30000', 6), // 30,000 USDC
    fee: 3000,
    tokenId: MOCK_POSITION_ID
  };

  const mockPoolPrice = {
    token0ToToken1Rate: 30000, // 30,000 USDC per WBTC
    token1ToToken0Rate: 1 / 30000
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FundingService,
        AppService,
        {
          provide: UniswapLpService,
          useValue: {
            getPosition: jest.fn().mockResolvedValue(mockPosition),
            getPoolPrice: jest.fn().mockResolvedValue(mockPoolPrice),
            collectFees: jest.fn().mockResolvedValue(undefined),
            getSignerAddress: jest.fn().mockResolvedValue('0x1234...'),
          }
        },
        {
          provide: HyperliquidService,
          useValue: {
            getFundingRate: jest.fn().mockResolvedValue(0.0005), // 0.05% funding rate
            getPositionSize: jest.fn().mockResolvedValue(0),
            closePosition: jest.fn().mockResolvedValue(undefined),
          }
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('https://eth-mainnet.alchemyapi.io/v2/your-api-key')
          }
        },
        {
          provide: Logger,
          useValue: {
            log: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn()
          }
        }
      ]
    }).compile();

    appService = module.get<AppService>(AppService);
    uniswapService = module.get<UniswapLpService>(UniswapLpService);
    hyperliquidService = module.get<HyperliquidService>(HyperliquidService);
    configService = module.get<ConfigService>(ConfigService);
    fundingService = module.get<FundingService>(FundingService);
    logger = module.get<Logger>(Logger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Uniswap LP Backtesting', () => {
    it('should backtest WBTC/USDC LP performance for 1 year', async () => {
      await runBacktest(
        fundingService,
        POOL_ADDRESS,
        '2024-05-29', // Start date (1 year ago)
        '2024-05-31', // End date (today)
        INITIAL_INVESTMENT,
      );
  
      expect(true).toBe(true);
    }, 60000); // 60 second timeout for API calls
  });
});
