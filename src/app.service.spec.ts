import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import 'dotenv/config';
import { fetchPoolInfo, fetchPoolDayPrices } from './uniswap-lp/subgraph.client';

// Create a logger instance with a specific context
const logger = new Logger('StrategyBacktesting');

// Enable debug mode for tests
beforeAll(() => {
  // This ensures logs are shown during tests
  jest.spyOn(logger, 'log').mockImplementation((message) => {
    console.log(message);
  });
});

const POOL_ADDRESS = '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35'; // WBTC/USDC pool

// Core interfaces
interface HistoricalPrice {
  timestamp: number;
  price: number;
  volume: number;
}

interface FundingRate {
  timestamp: number;
  rate: number;
}

interface GasPrice {
  timestamp: number;
  price: number;
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

function getUnixTimestamp(dateString: string): number {
  return Math.floor(new Date(dateString).getTime() / 1000);
}

describe('Strategy Backtesting', () => {
  let service: AppService;
  let uniswapService: UniswapLpService;
  let hyperliquidService: HyperliquidService;
  let configService: ConfigService;

  // Mock data
  const fundingRates: FundingRate[] = [
    { timestamp: 1640995200, rate: 0.0008 },
    { timestamp: 1641081600, rate: 0.0012 },
  ];

  const gasPrices: GasPrice[] = [
    { timestamp: 1640995200, price: 50 },
    { timestamp: 1641081600, price: 45 },
  ];

  beforeEach(async () => {
    // Add console.log to verify test setup
    console.log('Setting up test module...');
    
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
      // Add console.log to verify test execution
      console.log('Starting backtest...');

      const initialCapital = 100000;
      const rangePct = 0.1;
      const targetDelta = 0;
      const maxMarginUsage = 0.75;
      const gasThreshold = 20;
      const fundingRateThreshold = 0.001;
      const outOfRangeThreshold = 24 * 3600;
      const fundingToFeesThreshold = 0.2;
      const consecutiveDaysThreshold = 3;

      const startDate = '2024-05-29';
      const endDate = '2025-05-29';
      
      const poolInfo = await fetchPoolInfo(POOL_ADDRESS);
      const poolDayData = await fetchPoolDayPrices(POOL_ADDRESS, getUnixTimestamp(startDate), getUnixTimestamp(endDate));

      const historicalPrices: HistoricalPrice[] = poolDayData.map(day => ({
        timestamp: day.date,
        price: parseFloat(day.token0Price),
        volume: parseFloat(day.volumeUSD),
      }));

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

      logger.log('=== BTC/USDC LP Strategy Backtest Results ===');
      logger.log(`Pool: ${POOL_ADDRESS}`);
      logger.log(`Period: ${startDate} to ${endDate}`);
      logger.log(`Initial Investment: $${initialCapital.toLocaleString()}`);
      logger.log(`Pool Info: ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}`);
      logger.log(`Fee Tier: ${parseFloat(poolInfo.totalValueLockedUSD) / 10000}%`);
      logger.log(`Total Return: ${(result.totalReturn * 100).toFixed(2)}%`);
      logger.log(`Alpha vs BTC: ${(result.alpha * 100).toFixed(2)}%`);
      logger.log(`Time in Range: ${(result.timeInRange * 100).toFixed(2)}%`);
      logger.log(`Total Fees: $${result.lpFees.toLocaleString()}`);
      logger.log(`Total Funding Costs: $${result.fundingCosts.toLocaleString()}`);
      logger.log(`Total Gas Costs: $${result.gasCosts.toLocaleString()}`);
      logger.log(`Max Drawdown: ${(result.maxDrawdown * 100).toFixed(2)}%`);
      logger.log(`Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);

      expect(result.weeklyFeeYield.every(feeYield => feeYield >= 0.003)).toBe(true);
      // expect(Math.abs(result.averageDelta)).toBeLessThanOrEqual(0.05);
      expect(result.timeInRange).toBeGreaterThanOrEqual(0.85);
      expect(result.alpha).toBeGreaterThanOrEqual(0.15);
    }, 60000);
  });
});

// Helper functions
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
  let hedgePosition = initialCapital * 0.5;
  let totalFees = 0;
  let totalFundingCosts = 0;
  let totalGasCosts = 0;
  let timeInRange = 0;
  let weeklyFeeYield: number[] = [];
  let deltas: number[] = [];
  let capitalHistory: number[] = [];

  const state: StrategyState = {
    outOfRangeTime: 0,
    consecutiveHighFundingDays: 0,
    lastRebalanceTime: 0,
    cumulativeWeeklyFees: 0,
    cumulativeWeeklyFunding: 0,
  };

  for (let i = 0; i < historicalPrices.length; i++) {
    const currentPrice = historicalPrices[i].price;
    const currentGas = gasPrices[i] ? gasPrices[i].price : 0;
    const currentFunding = fundingRates[i] ? fundingRates[i].rate : 0;
    const timestamp = historicalPrices[i].timestamp;

    const priceRange = {
      lower: currentPrice * (1 - rangePct / 2),
      upper: currentPrice * (1 + rangePct / 2),
    };

    const inRange = currentPrice >= priceRange.lower && currentPrice <= priceRange.upper;
    
    if (inRange) {
      timeInRange++;
      state.outOfRangeTime = 0;
    } else {
      state.outOfRangeTime += timestamp - (i > 0 ? historicalPrices[i-1].timestamp : timestamp);
    }

    if (state.outOfRangeTime >= outOfRangeThreshold) {
      lpPosition = 0;
      hedgePosition = 0;
      continue;
    }

    const lpValue = calculateLpValue(lpPosition, currentPrice, priceRange);
    const fees = calculateFees(lpValue, historicalPrices[i].volume);
    totalFees += fees;
    state.cumulativeWeeklyFees += fees;

    const pricePosition = (currentPrice - priceRange.lower) / (priceRange.upper - priceRange.lower);
    let targetHedgeRatio = 0.5;
    
    if (inRange) {
      if (pricePosition > 0.7) {
        targetHedgeRatio = 0.7;
      } else if (pricePosition < 0.3) {
        targetHedgeRatio = 0.3;
      }
    }

    const targetHedge = lpValue * targetHedgeRatio;

    if (Math.abs(hedgePosition - targetHedge) / targetHedge > 0.05) {
      if (currentGas <= gasThreshold) {
        const adjustmentCost = calculateTradingCost(hedgePosition - targetHedge, currentPrice);
        hedgePosition = targetHedge;
        totalGasCosts += currentGas * 21000;
        capital -= adjustmentCost;
        state.lastRebalanceTime = timestamp;
      }
    }

    const fundingCost = hedgePosition * currentFunding;
    totalFundingCosts += fundingCost;
    state.cumulativeWeeklyFunding += fundingCost;
    capital -= fundingCost;

    if (currentFunding > fundingRateThreshold) {
      state.consecutiveHighFundingDays++;
      if (state.consecutiveHighFundingDays >= consecutiveDaysThreshold &&
          state.cumulativeWeeklyFunding > state.cumulativeWeeklyFees * fundingToFeesThreshold) {
        hedgePosition = 0;
      }
    } else {
      state.consecutiveHighFundingDays = 0;
    }

    const currentMarginUsage = Math.abs(hedgePosition) / capital;
    if (currentMarginUsage > maxMarginUsage) {
      hedgePosition = hedgePosition * (maxMarginUsage / currentMarginUsage);
    }

    deltas.push(calculateDelta(lpPosition, hedgePosition, currentPrice));
    capitalHistory.push(capital);

    if (i % 7 === 6) {
      weeklyFeeYield.push(state.cumulativeWeeklyFees / lpValue);
      state.cumulativeWeeklyFees = 0;
      state.cumulativeWeeklyFunding = 0;
    }
  }

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

function calculateLpValue(position: number, price: number, range: { lower: number; upper: number }): number {
  return position * price;
}

function calculateFees(lpValue: number, volume: number): number {
  return lpValue * volume * 0.003 * 0.01;
}

function calculateTradingCost(size: number, price: number): number {
  return Math.abs(size * price * 0.001);
}

function calculateDelta(lpPosition: number, hedgePosition: number, price: number): number {
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
  const riskFreeRate = 0.02;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  return (mean - riskFreeRate) / stdDev;
} 