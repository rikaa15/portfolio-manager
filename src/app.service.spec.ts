import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { BigNumber } from '@ethersproject/bignumber';

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
      });

      // Assert strategy meets KPI targets
      expect(result.weeklyFeeYield.every(feeYield => feeYield >= 0.003)).toBe(true); // Weekly fee yield ≥ 0.30%
      expect(Math.abs(result.averageDelta)).toBeLessThanOrEqual(0.05); // Delta between -5% and +5%
      expect(result.timeInRange).toBeGreaterThanOrEqual(0.85); // Time in range ≥ 85%
      expect(result.alpha).toBeGreaterThanOrEqual(0.15); // Alpha ≥ 15% vs BTC
    });

    it('should properly handle risk controls', async () => {
      const initialCapital = 100000;
      // Test risk management scenarios
      const scenarios = [
        {
          name: 'High gas prices',
          historicalPrices,
          fundingRates,
          gasPrices: gasPrices.map(p => ({ ...p, price: 100 })), // Simulate high gas
          expectedRebalances: 0,
        },
        {
          name: 'Extreme funding rates',
          historicalPrices,
          gasPrices,
          fundingRates: fundingRates.map(r => ({ ...r, rate: 0.01 })), // 1% funding rate
          expectedPositionClose: true,
        },
        {
          name: 'Price out of range',
          fundingRates,
          gasPrices,
          historicalPrices: historicalPrices.map(p => ({ ...p, price: p.price * 1.5 })),
          expectedRangeExit: true,
        },
      ];

      for (const scenario of scenarios) {
        const result = await runBacktest({
          historicalPrices: scenario.historicalPrices || historicalPrices,
          fundingRates: scenario.fundingRates || fundingRates,
          gasPrices: scenario.gasPrices || gasPrices,
          initialCapital,
          rangePct: 0.1,
          targetDelta: 0,
          maxMarginUsage: 0.75,
          gasThreshold: 20,
        });

        // Assert risk controls are working
        if (scenario.name === 'High gas prices') {
          expect(result.gasCosts).toBeLessThan(initialCapital * 0.01); // Gas costs < 1% of capital
        }
        if (scenario.name === 'Extreme funding rates') {
          expect(result.fundingCosts).toBeLessThan(result.lpFees * 0.2); // Funding costs < 20% of LP fees
        }
        if (scenario.name === 'Price out of range') {
          expect(result.timeInRange).toBeLessThan(0.85); // Confirms exit from range
        }
      }
    });
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
    } = params;

    let capital = initialCapital;
    let lpPosition = 0;
    let hedgePosition = 0;
    let totalFees = 0;
    let totalFundingCosts = 0;
    let totalGasCosts = 0;
    let timeInRange = 0;
    let weeklyFeeYield: number[] = [];
    let deltas: number[] = [];
    let capitalHistory: number[] = [];

    // Simulate strategy execution for each timestamp
    for (let i = 0; i < historicalPrices.length; i++) {
      const currentPrice = historicalPrices[i].price;
      const currentGas = gasPrices[i].price;
      const currentFunding = fundingRates[i].rate;

      // Skip rebalancing if gas is too high
      if (currentGas > gasThreshold) {
        continue;
      }

      // Calculate position metrics
      const priceRange = {
        lower: currentPrice * (1 - rangePct / 2),
        upper: currentPrice * (1 + rangePct / 2),
      };

      const inRange = currentPrice >= priceRange.lower && currentPrice <= priceRange.upper;
      if (inRange) timeInRange++;

      // Calculate LP position value and fees
      const lpValue = calculateLpValue(lpPosition, currentPrice, priceRange);
      const fees = calculateFees(lpValue, historicalPrices[i].volume);
      totalFees += fees;

      // Calculate and adjust hedge position
      const targetHedge = lpValue * 0.5; // 50% hedge ratio
      if (Math.abs(hedgePosition - targetHedge) / targetHedge > 0.05) {
        // Rebalance if >5% off target
        const adjustmentCost = calculateTradingCost(hedgePosition - targetHedge, currentPrice);
        hedgePosition = targetHedge;
        totalGasCosts += currentGas * 21000; // Approximate gas used
        capital -= adjustmentCost;
      }

      // Calculate funding costs
      const fundingCost = hedgePosition * currentFunding;
      totalFundingCosts += fundingCost;
      capital -= fundingCost;

      // Track metrics
      deltas.push(calculateDelta(lpPosition, hedgePosition, currentPrice));
      capitalHistory.push(capital);
      if (i % 7 === 6) { // Weekly calculations
        weeklyFeeYield.push(fees / lpValue);
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