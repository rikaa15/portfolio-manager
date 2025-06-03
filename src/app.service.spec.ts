import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { BigNumber } from '@ethersproject/bignumber';
import axios from 'axios';
import 'dotenv/config';

const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY;
const POOL_ADDRESS = '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35'; // WBTC/USDC pool

const client = axios.create({
  baseURL: 'https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUBGRAPH_API_KEY}`,
  },
});

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

// Date helpers
const getUnixTimestamp = (dateString: string): number => {
  return Math.floor(new Date(dateString).getTime() / 1000);
};

const formatDate = (unixTimestamp: number): string => {
  return new Date(unixTimestamp * 1000).toISOString().split('T')[0];
};

// Interfaces
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

// Mock historical data interfaces
interface HistoricalPrice {
  timestamp: number;
  price: number;
  volume: number;
}

interface FundingRate {
  timestamp: number;
  rate: number; // 8-hour funding rate
}

interface GasPrice {
  timestamp: number;
  price: number; // in gwei
}

interface BacktestResult {
  totalReturn: number;
  lpFees: number;
  fundingCosts: number;
  gasCosts: number;
  timeInRange: number;
  averageDelta: number;
  weeklyFeeYield: number[];
  maxDrawdown: number;
  sharpeRatio: number;
  btcHoldingReturn: number;
  alpha: number;
}

interface StrategyState {
  outOfRangeTime: number;
  consecutiveHighFundingDays: number;
  lastRebalanceTime: number;
  cumulativeWeeklyFees: number;
  cumulativeWeeklyFunding: number;
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
      Logger.error(
        `Query failed: ${error.response.status} ${error.response.statusText}`,
      );
      if (error.response.data) {
        Logger.error(`Response: ${JSON.stringify(error.response.data)}`);
      }
    } else if (error.message) {
      Logger.error(`Error: ${error.message}`);
    } else {
      Logger.error(`Unknown error: ${String(error)}`);
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
    Logger.error('No pool day data returned from GraphQL query');
    return [];
  }

  return data.poolDayDatas;
}

describe('Strategy Backtesting', () => {
  let service: AppService;
  let uniswapService: UniswapLpService;
  let hyperliquidService: HyperliquidService;
  let configService: ConfigService;

  // Mock historical data (to be loaded from external sources in production)
  const historicalPrices: HistoricalPrice[] = [
    // Sample data - in production, load from actual historical sources
    { timestamp: 1640995200, price: 46200, volume: 1000 },
    { timestamp: 1641081600, price: 47500, volume: 1200 },
    // ... more historical prices
  ];

  const fundingRates: FundingRate[] = [
    { timestamp: 1640995200, rate: 0.0008 },
    { timestamp: 1641081600, rate: 0.0012 },
    // ... more funding rates
  ];

  const gasPrices: GasPrice[] = [
    { timestamp: 1640995200, price: 50 },
    { timestamp: 1641081600, price: 45 },
    // ... more gas prices
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
        {
          provide: UniswapLpService,
          useValue: {
            getPosition: jest.fn(),
            addLiquidity: jest.fn(),
            removeLiquidity: jest.fn(),
            collectFees: jest.fn(),
            getPoolPrice: jest.fn(),
          },
        },
        {
          provide: HyperliquidService,
          useValue: {
            openPosition: jest.fn(),
            closePosition: jest.fn(),
            adjustPosition: jest.fn(),
            getFundingRate: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        Logger,
      ],
    }).compile();

    service = module.get<AppService>(AppService);
    uniswapService = module.get<UniswapLpService>(UniswapLpService);
    hyperliquidService = module.get<HyperliquidService>(HyperliquidService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('Backtest Strategy', () => {
    it('should achieve target KPIs over one year period', async () => {
      // Initialize strategy parameters
      const initialCapital = 100000; // $100k USD
      const rangePct = 0.1; // 10% range
      const targetDelta = 0; // Neutral delta target
      const maxMarginUsage = 0.75; // 75% max margin usage
      const gasThreshold = 20; // $20 gas threshold
      const fundingRateThreshold = 0.001; // 0.1% per 8h funding rate threshold
      const outOfRangeThreshold = 24 * 3600; // 24 hours
      const fundingToFeesThreshold = 0.2; // 20% funding to fees ratio threshold
      const consecutiveDaysThreshold = 3; // 3 consecutive days of high funding

      // Fetch historical pool data
      const startDate = '2024-05-29';
      const endDate = '2025-05-29';
      
      const poolInfo = await getPoolInfo(POOL_ADDRESS);
      const poolDayData = await getPoolDayData(POOL_ADDRESS, startDate, endDate);

      // Convert pool data to historical prices format
      const historicalPrices: HistoricalPrice[] = poolDayData.map(day => ({
        timestamp: day.date,
        price: parseFloat(day.token0Price), // WBTC price in USDC
        volume: parseFloat(day.volumeUSD),
      }));

      // Run backtest simulation
      const result = await runBacktest({
        historicalPrices,
        fundingRates,
        gasPrices,
        initialCapital,
        rangePct,
        targetDelta,
        maxMarginUsage,
        gasThreshold,
        fundingRateThreshold,
        outOfRangeThreshold,
        fundingToFeesThreshold,
        consecutiveDaysThreshold,
      });

      // Assert strategy meets KPI targets
      expect(result.weeklyFeeYield.every(feeYield => feeYield >= 0.003)).toBe(true); // Weekly fee yield ≥ 0.30%
      expect(Math.abs(result.averageDelta)).toBeLessThanOrEqual(0.05); // Delta between -5% and +5%
      expect(result.timeInRange).toBeGreaterThanOrEqual(0.85); // Time in range ≥ 85%
      expect(result.alpha).toBeGreaterThanOrEqual(0.15); // Alpha ≥ 15% vs BTC

      // Log detailed results
      Logger.log('=== BTC/USDC LP Strategy Backtest Results ===');
      Logger.log(`Pool: ${POOL_ADDRESS}`);
      Logger.log(`Period: ${startDate} to ${endDate}`);
      Logger.log(`Initial Investment: $${initialCapital.toLocaleString()}`);
      Logger.log(`Pool Info: ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}`);
      Logger.log(`Fee Tier: ${parseFloat(poolInfo.feeTier) / 10000}%`);
      Logger.log('');
      Logger.log(`Total Return: ${(result.totalReturn * 100).toFixed(2)}%`);
      Logger.log(`Alpha vs BTC: ${(result.alpha * 100).toFixed(2)}%`);
      Logger.log(`Time in Range: ${(result.timeInRange * 100).toFixed(2)}%`);
      Logger.log(`Total Fees: $${result.lpFees.toLocaleString()}`);
      Logger.log(`Total Funding Costs: $${result.fundingCosts.toLocaleString()}`);
      Logger.log(`Total Gas Costs: $${result.gasCosts.toLocaleString()}`);
      Logger.log(`Max Drawdown: ${(result.maxDrawdown * 100).toFixed(2)}%`);
      Logger.log(`Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);
    }, 60000); // 60 second timeout for API calls

    it('should properly handle risk controls', async () => {
      const initialCapital = 100000;
      const defaultParams = {
        initialCapital,
        rangePct: 0.1,
        targetDelta: 0,
        maxMarginUsage: 0.75,
        gasThreshold: 20,
        fundingRateThreshold: 0.001,
        outOfRangeThreshold: 24 * 3600,
        fundingToFeesThreshold: 0.2,
        consecutiveDaysThreshold: 3,
      };

      // Fetch historical pool data
      const startDate = '2024-05-29';
      const endDate = '2025-05-29';
      
      const poolInfo = await getPoolInfo(POOL_ADDRESS);
      const poolDayData = await getPoolDayData(POOL_ADDRESS, startDate, endDate);

      // Convert pool data to historical prices format
      const historicalPrices: HistoricalPrice[] = poolDayData.map(day => ({
        timestamp: day.date,
        price: parseFloat(day.token0Price),
        volume: parseFloat(day.volumeUSD),
      }));

      // Generate synthetic funding rates based on price movements
      const fundingRates: FundingRate[] = poolDayData.map((day, i) => {
        const prevPrice = i > 0 ? parseFloat(poolDayData[i-1].token0Price) : parseFloat(day.token0Price);
        const priceChange = (parseFloat(day.token0Price) - prevPrice) / prevPrice;
        // Funding rate tends to be positive when price is rising (shorts pay longs)
        return {
          timestamp: day.date,
          rate: 0.0001 + (priceChange * 0.002), // Base rate + price-dependent component
        };
      });

      // Generate synthetic gas prices
      const gasPrices: GasPrice[] = poolDayData.map(day => ({
        timestamp: day.date,
        price: 40 + Math.random() * 20, // Random gas price between 40-60 gwei
      }));

      // Test risk management scenarios
      const scenarios = [
        {
          name: 'High gas prices',
          historicalPrices,
          fundingRates,
          gasPrices: poolDayData.map(day => ({ 
            timestamp: day.date,
            price: 100 + Math.random() * 50, // Very high gas 100-150 gwei
          })),
          expectedRebalances: 0,
        },
        {
          name: 'Extreme funding rates',
          historicalPrices,
          gasPrices,
          fundingRates: poolDayData.map(day => ({
            timestamp: day.date,
            rate: 0.01, // 1% funding rate
          })),
          expectedPositionClose: true,
        },
        {
          name: 'Price out of range',
          fundingRates,
          gasPrices,
          historicalPrices: poolDayData.map((day, i) => ({
            timestamp: day.date,
            price: parseFloat(day.token0Price) * (1 + (i > 30 ? 0.5 : 0)), // 50% price increase after 30 days
            volume: parseFloat(day.volumeUSD),
          })),
          expectedRangeExit: true,
        },
        {
          name: 'High margin usage',
          historicalPrices,
          fundingRates,
          gasPrices,
          initialLeverage: 0.9, // Start with 90% margin usage
          expectedDeleveraging: true,
        },
        {
          name: 'Consecutive high funding days',
          historicalPrices,
          gasPrices,
          fundingRates: poolDayData.map((day, i) => ({
            timestamp: day.date,
            rate: i >= 5 && i <= 8 ? 0.005 : 0.0001, // High funding for 4 consecutive days
          })),
          expectedHedgeReduction: true,
        },
      ];

      for (const scenario of scenarios) {
        Logger.log(`\nTesting scenario: ${scenario.name}`);
        
        const result = await runBacktest({
          ...defaultParams,
          historicalPrices: scenario.historicalPrices || historicalPrices,
          fundingRates: scenario.fundingRates || fundingRates,
          gasPrices: scenario.gasPrices || gasPrices,
          initialCapital: scenario.initialLeverage 
            ? initialCapital / (1 - scenario.initialLeverage) 
            : initialCapital,
        });

        // Assert risk controls are working
        if (scenario.name === 'High gas prices') {
          expect(result.gasCosts).toBeLessThan(initialCapital * 0.01); // Gas costs < 1% of capital
          Logger.log(`Gas costs: $${result.gasCosts.toLocaleString()} (${(result.gasCosts/initialCapital*100).toFixed(2)}% of capital)`);
        }
        
        if (scenario.name === 'Extreme funding rates') {
          expect(result.fundingCosts).toBeLessThan(result.lpFees * 0.2); // Funding costs < 20% of LP fees
          Logger.log(`Funding costs: $${result.fundingCosts.toLocaleString()} (${(result.fundingCosts/result.lpFees*100).toFixed(2)}% of LP fees)`);
        }
        
        if (scenario.name === 'Price out of range') {
          expect(result.timeInRange).toBeLessThan(0.85); // Confirms exit from range
          Logger.log(`Time in range: ${(result.timeInRange*100).toFixed(2)}%`);
        }

        if (scenario.name === 'High margin usage') {
          const maxMarginUsage = defaultParams.maxMarginUsage;
          expect(result.averageDelta).toBeLessThanOrEqual(maxMarginUsage); // Should deleverage to maintain margin limits
          Logger.log(`Average delta: ${(result.averageDelta*100).toFixed(2)}%`);
        }

        if (scenario.name === 'Consecutive high funding days') {
          const fundingToFeesRatio = result.fundingCosts / result.lpFees;
          expect(fundingToFeesRatio).toBeLessThanOrEqual(defaultParams.fundingToFeesThreshold);
          Logger.log(`Funding to fees ratio: ${(fundingToFeesRatio*100).toFixed(2)}%`);
        }

        // Log scenario summary
        Logger.log(`Total return: ${(result.totalReturn*100).toFixed(2)}%`);
        Logger.log(`Alpha vs BTC: ${(result.alpha*100).toFixed(2)}%`);
      }
    }, 60000); // 60 second timeout for API calls
  });

  // Helper function to run backtest simulation
  async function runBacktest(params: {
    historicalPrices: HistoricalPrice[];
    fundingRates: FundingRate[];
    gasPrices: GasPrice[];
    initialCapital: number;
    rangePct: number;
    targetDelta: number;
    maxMarginUsage: number;
    gasThreshold: number;
    fundingRateThreshold: number;
    outOfRangeThreshold: number;
    fundingToFeesThreshold: number;
    consecutiveDaysThreshold: number;
  }): Promise<BacktestResult> {
    const {
      historicalPrices,
      fundingRates,
      gasPrices,
      initialCapital,
      rangePct,
      targetDelta,
      maxMarginUsage,
      gasThreshold,
      fundingRateThreshold,
      outOfRangeThreshold,
      fundingToFeesThreshold,
      consecutiveDaysThreshold,
    } = params;

    let capital = initialCapital;
    let lpPosition = initialCapital;
    let hedgePosition = initialCapital * 0.5; // Initial 50% hedge
    let totalFees = 0;
    let totalFundingCosts = 0;
    let totalGasCosts = 0;
    let timeInRange = 0;
    let weeklyFeeYield: number[] = [];
    let deltas: number[] = [];
    let capitalHistory: number[] = [];

    // Strategy state tracking
    const state: StrategyState = {
      outOfRangeTime: 0,
      consecutiveHighFundingDays: 0,
      lastRebalanceTime: 0,
      cumulativeWeeklyFees: 0,
      cumulativeWeeklyFunding: 0,
    };

    // Simulate strategy execution for each timestamp
    for (let i = 0; i < historicalPrices.length; i++) {
      const currentPrice = historicalPrices[i].price;

      // TODO: check actual gas price
      const currentGas = gasPrices[i] ? gasPrices[i].price : 0;
      const currentFunding = fundingRates[i] ? fundingRates[i].rate : 0;

      const timestamp = historicalPrices[i].timestamp;

      // Calculate position metrics
      const priceRange = {
        lower: currentPrice * (1 - rangePct / 2),
        upper: currentPrice * (1 + rangePct / 2),
      };

      const inRange = currentPrice >= priceRange.lower && currentPrice <= priceRange.upper;
      
      // Update time in range tracking
      if (inRange) {
        timeInRange++;
        state.outOfRangeTime = 0;
      } else {
        state.outOfRangeTime += timestamp - (i > 0 ? historicalPrices[i-1].timestamp : timestamp);
      }

      // Risk control: Exit if out of range for too long
      if (state.outOfRangeTime >= outOfRangeThreshold) {
        lpPosition = 0;
        hedgePosition = 0;
        continue;
      }

      // Calculate LP position value and fees
      const lpValue = calculateLpValue(lpPosition, currentPrice, priceRange);
      const fees = calculateFees(lpValue, historicalPrices[i].volume);
      totalFees += fees;
      state.cumulativeWeeklyFees += fees;

      // Dynamic hedge adjustment based on price position in range
      const pricePosition = (currentPrice - priceRange.lower) / (priceRange.upper - priceRange.lower);
      let targetHedgeRatio = 0.5; // Base 50% hedge
      
      // Scale hedge based on price position in range
      if (inRange) {
        if (pricePosition > 0.7) {
          targetHedgeRatio = 0.7; // Increase hedge as price approaches upper range
        } else if (pricePosition < 0.3) {
          targetHedgeRatio = 0.3; // Decrease hedge as price approaches lower range
        }
      }

      const targetHedge = lpValue * targetHedgeRatio;

      // Check if rebalance is needed (>5% off target)
      if (Math.abs(hedgePosition - targetHedge) / targetHedge > 0.05) {
        // Skip if gas is too high
        if (currentGas <= gasThreshold) {
          const adjustmentCost = calculateTradingCost(hedgePosition - targetHedge, currentPrice);
          hedgePosition = targetHedge;
          totalGasCosts += currentGas * 21000;
          capital -= adjustmentCost;
          state.lastRebalanceTime = timestamp;
        }
      }

      // Calculate and track funding costs
      const fundingCost = hedgePosition * currentFunding;
      totalFundingCosts += fundingCost;
      state.cumulativeWeeklyFunding += fundingCost;
      capital -= fundingCost;

      // Risk control: Check funding rate threshold
      if (currentFunding > fundingRateThreshold) {
        state.consecutiveHighFundingDays++;
        if (state.consecutiveHighFundingDays >= consecutiveDaysThreshold &&
            state.cumulativeWeeklyFunding > state.cumulativeWeeklyFees * fundingToFeesThreshold) {
          // Close hedge position if funding costs are too high
          hedgePosition = 0;
        }
      } else {
        state.consecutiveHighFundingDays = 0;
      }

      // Risk control: Check margin usage
      const currentMarginUsage = Math.abs(hedgePosition) / capital;
      if (currentMarginUsage > maxMarginUsage) {
        // Reduce hedge position to meet margin requirements
        hedgePosition = hedgePosition * (maxMarginUsage / currentMarginUsage);
      }

      // Track metrics
      deltas.push(calculateDelta(lpPosition, hedgePosition, currentPrice));
      capitalHistory.push(capital);

      // Weekly calculations
      if (i % 7 === 6) {
        weeklyFeeYield.push(state.cumulativeWeeklyFees / lpValue);
        // Reset weekly tracking
        state.cumulativeWeeklyFees = 0;
        state.cumulativeWeeklyFunding = 0;
      }
    }

    // Calculate final metrics
    const endCapital = capital + lpPosition + hedgePosition;
    const totalReturn = (endCapital - initialCapital) / initialCapital;
    const btcReturn = (historicalPrices[historicalPrices.length - 1].price - historicalPrices[0].price) / historicalPrices[0].price;
    const alpha = totalReturn - btcReturn;
    const averageDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const timeInRangeRatio = timeInRange / historicalPrices.length;

    return {
      totalReturn,
      lpFees: totalFees,
      fundingCosts: totalFundingCosts,
      gasCosts: totalGasCosts,
      timeInRange: timeInRangeRatio,
      averageDelta,
      weeklyFeeYield,
      maxDrawdown: calculateMaxDrawdown(capitalHistory, historicalPrices),
      sharpeRatio: calculateSharpeRatio(weeklyFeeYield),
      btcHoldingReturn: btcReturn,
      alpha,
    };
  }

  // Helper functions for calculations
  function calculateLpValue(position: number, price: number, range: { lower: number; upper: number }): number {
    // Simplified LP value calculation
    return position * price;
  }

  function calculateFees(lpValue: number, volume: number): number {
    // Simplified fee calculation (0.3% of volume proportional to LP share)
    return lpValue * volume * 0.003 * 0.01; // Assuming 1% pool share
  }

  function calculateTradingCost(size: number, price: number): number {
    // Simplified trading cost calculation (0.1% fee)
    return Math.abs(size * price * 0.001);
  }

  function calculateDelta(lpPosition: number, hedgePosition: number, price: number): number {
    // Calculate net delta exposure
    return (lpPosition - hedgePosition) / (lpPosition + hedgePosition);
  }

  function calculateMaxDrawdown(capitals: number[], prices: HistoricalPrice[]): number {
    let maxDrawdown = 0;
    let peak = capitals[0];
    
    for (const capital of capitals) {
      if (capital > peak) {
        peak = capital;
      }
      const drawdown = (peak - capital) / peak;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
    
    return maxDrawdown;
  }

  function calculateSharpeRatio(returns: number[]): number {
    const riskFreeRate = 0.02; // Assume 2% risk-free rate
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    return (mean - riskFreeRate) / stdDev;
  }
}); 