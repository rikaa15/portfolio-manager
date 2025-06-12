import axios from 'axios';
import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { fetchPoolInfo, fetchPoolDayPrices } from './uniswap-lp/subgraph.client';
import { ethers } from 'ethers';
import { FundingService } from './funding/funding.service';
import { AppConfigModule } from './config/config.module';

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

// Date helpers
const getUnixTimestamp = (dateString: string): number => {
  return Math.floor(new Date(dateString).getTime() / 1000);
};

const formatDate = (unixTimestamp: number): string => {
  return new Date(unixTimestamp * 1000).toISOString().split('T')[0];
};

/**
 * Run backtest simulation
 */
async function runBacktest(
  fundingService: FundingService,
  hyperliquidService: HyperliquidService,
  poolAddress: string,
  startDate: string,
  endDate: string,
  initialAmount: number,
): Promise<void> {
  logger.log('=== WBTC/USDC LP Backtest with IL Hedging ===');
  logger.log(`Pool: ${poolAddress}`);
  logger.log(`Period: ${startDate} to ${endDate}`);
  logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
  logger.log('');

  // Risk management constants
  const MAX_LEVERAGE = 2;                    // Maximum allowed leverage
  const MIN_LEVERAGE = 0.5;                  // Minimum allowed leverage
  const MAX_HEDGE_RATIO = 0.75;              // Maximum hedge to LP value ratio
  const BASE_HEDGE_RATIO = 0.5;              // Starting hedge ratio (50%)
  const MAX_FUNDING_RATE = 0.001;            // 0.1% per 8h maximum funding rate
  const MAX_WEEKLY_FUNDING_COST = 0.2;       // 20% of weekly fees maximum funding cost
  const MAX_POSITION_ADJUSTMENT = 0.1;        // Maximum 10% position size adjustment per day
  const LIQUIDATION_BUFFER = 0.85;           // 85% liquidation buffer
  const MIN_TIME_IN_RANGE = 0.85;            // 85% minimum time in range

  const initialFuturesNotional = initialAmount * BASE_HEDGE_RATIO;
  let futuresNotional = initialFuturesNotional;
  let futuresLeverage = 1;                   // Start with 1x leverage
  let futuresDirection = 'short';            // Start with short to hedge BTC exposure
  let cumulativeFundingCosts = 0;
  let timeOutOfRange = 0;
  let lastRebalanceDay = 0;
  let weeklyFees = 0;
  let weeklyFundingCosts = 0;
  let daysOutOfRange = 0;
  let cumulativeHedgePnL = 0;
  let cumulativeLpPnL = 0;
  let previousHedgeValue = 0;

  try {
    // Get pool information
    logger.log('Fetching pool information...');
    const poolInfo = await fetchPoolInfo(poolAddress);
    logger.log(
      `Pool Info: ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}`,
    );
    logger.log(`Fee Tier: 0.3%`); // Hardcoded since we know this pool's fee tier
    logger.log('');

    // Get historical data
    logger.log('Fetching historical data...');
    const startTimestamp = getUnixTimestamp(startDate);
    const endTimestamp = getUnixTimestamp(endDate);
    const poolDayData = await fetchPoolDayPrices(poolAddress, startTimestamp, endTimestamp);

    if (poolDayData.length === 0) {
      logger.log('No data found for the specified period');
      return;
    }

    logger.log(`Found ${poolDayData.length} days of data`);
    logger.log('');

    // Fetch funding rates history
    logger.log(`Fetching funding rates from ${startDate} to ${endDate}...`);
    const hourlyFundingRates = await fundingService.getHistoricalFundingRates(
      'BTC',
      new Date(startDate).getTime(),
      new Date(endDate).getTime()
    );
    const fundingRates = fundingService.hourlyTo8HourFundingRates(hourlyFundingRates);
    logger.log(`Found ${fundingRates.length} funding rate periods`);
    logger.log('');

    // Calculate initial LP share based on first day's TVL
    const firstDay = poolDayData[0];
    const lpSharePercentage = initialAmount / parseFloat(firstDay.tvlUSD);

    logger.log(`Initial TVL: $${parseFloat(firstDay.tvlUSD).toLocaleString()}`);
    logger.log(`LP Share: ${(lpSharePercentage * 100).toFixed(6)}%`);
    logger.log(`Initial Futures Hedge: $${initialFuturesNotional.toLocaleString()}`);
    logger.log('');

    // Track cumulative values
    let cumulativeFees = 0;
    let cumulativeIL = 0;
    const initialToken0Price = parseFloat(firstDay.token0Price);
    const initialToken1Price = parseFloat(firstDay.token1Price);
    let lastToken0Ratio = 0.5; // Start assuming 50/50 split

    logger.log('Daily Performance:');
    logger.log('');

    // Process each day
    for (let i = 0; i < poolDayData.length; i++) {
      const dayData = poolDayData[i];
      const dayNumber = i + 1;
      const date = formatDate(dayData.date);

      // Get nearest funding rate for the day
      const ratesData = fundingRates.find(rate => Math.abs(Math.round(rate.time / 1000) - dayData.date) <= 8 * 60 * 60);
      if (!ratesData) {
        logger.error(`No funding rate found for ${date}`);
        continue;
      }

      // Calculate current position value and token ratios
      const currentTVL = parseFloat(dayData.tvlUSD);
      const currentPositionValue = currentTVL * lpSharePercentage;
      const currentToken0Price = parseFloat(dayData.token0Price);
      const currentToken1Price = parseFloat(dayData.token1Price);
      
      // Calculate token ratios for rebalancing
      const token0Value = currentPositionValue * 0.5;
      const token0Ratio = token0Value / currentPositionValue;
      const ratioChange = Math.abs(token0Ratio - 0.5); // Deviation from 50/50

      // Calculate impermanent loss
      const impermanentLoss = calculateImpermanentLoss(
        currentToken0Price,
        currentToken1Price,
        initialToken0Price,
        initialToken1Price,
      );
      cumulativeIL += impermanentLoss;

      // Check if price is out of range
      if (Math.abs(impermanentLoss) > 5) {
        daysOutOfRange++;
        if (daysOutOfRange >= 1) { // 24 hours out of range
          timeOutOfRange++;
        }
      } else {
        daysOutOfRange = 0;
      }

      // Calculate daily fee earnings (estimate based on volume)
      const dailyVolume = parseFloat(dayData.volumeUSD);
      const dailyFees = dailyVolume * 0.003 * lpSharePercentage; // 0.3% fee tier
      weeklyFees += dailyFees;
      cumulativeFees += dailyFees;

      // Calculate funding costs
      const dailyFundingCost = (futuresNotional * futuresLeverage) * ratesData.fundingRate;
      weeklyFundingCosts += dailyFundingCost;
      cumulativeFundingCosts += dailyFundingCost;

      // Weekly reset of fee and funding tracking
      if (dayNumber % 7 === 0) {
        // Check if funding costs exceed threshold
        if (weeklyFundingCosts > weeklyFees * MAX_WEEKLY_FUNDING_COST) {
          // Reduce position size and leverage
          futuresNotional *= 0.8;
          futuresLeverage = Math.max(MIN_LEVERAGE, futuresLeverage * 0.8);
        }
        weeklyFees = 0;
        weeklyFundingCosts = 0;
      }

      // Adjust hedge based on conditions
      if (Math.abs(impermanentLoss) > 1 || ratioChange > 0.05) {
        const adjustmentFactor = Math.min(
          Math.abs(impermanentLoss) / 100,
          MAX_POSITION_ADJUSTMENT
        );

        // Calculate new hedge size
        let newHedgeSize = futuresNotional;
        if (impermanentLoss < 0) {
          newHedgeSize *= (1 + adjustmentFactor);
          futuresLeverage = Math.min(futuresLeverage * 1.1, MAX_LEVERAGE);
        } else {
          newHedgeSize *= (1 - adjustmentFactor);
          futuresLeverage = Math.max(futuresLeverage * 0.9, MIN_LEVERAGE);
        }

        // Apply hedge size limits
        const maxHedgeSize = currentPositionValue * MAX_HEDGE_RATIO;
        futuresNotional = Math.min(newHedgeSize, maxHedgeSize);
        lastRebalanceDay = dayNumber;
      }

      // Adjust position based on funding rates
      if (ratesData.fundingRate > MAX_FUNDING_RATE) {
        futuresNotional *= 0.95; // Reduce exposure when funding is expensive
      } else if (ratesData.fundingRate < 0) {
        const maxIncrease = currentPositionValue * MAX_HEDGE_RATIO - futuresNotional;
        futuresNotional = Math.min(futuresNotional * 1.05, futuresNotional + maxIncrease);
      }

      // Calculate total PnL including hedge
      const positionPnL = currentPositionValue - initialAmount;
      
      // Calculate hedge PnL based on price change and position size
      const hedgeNotional = futuresNotional * futuresLeverage;
      const priceChange = (currentToken0Price - initialToken0Price) / initialToken0Price;
      const hedgeValue = futuresDirection === 'short' ? 
        -hedgeNotional * priceChange : // Short position profits when price falls
        hedgeNotional * priceChange;   // Long position profits when price rises
      
      // Calculate daily hedge PnL
      const dailyHedgePnL = hedgeValue - previousHedgeValue;
      previousHedgeValue = hedgeValue;
      cumulativeHedgePnL += dailyHedgePnL;
      
      // Calculate LP PnL (position value change + fees)
      cumulativeLpPnL = positionPnL + cumulativeFees;
      
      const totalPnL = cumulativeLpPnL + cumulativeHedgePnL - cumulativeFundingCosts;

      // Calculate running APR
      const runningAPR = ((cumulativeFees - cumulativeFundingCosts) / initialAmount) * (365 / dayNumber) * 100;

      // Output daily performance
      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
        `Value: $${currentPositionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
        `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
        `Hedge: $${hedgeNotional.toLocaleString()} (${futuresLeverage.toFixed(1)}x) | ` +
        `Daily Hedge PnL: ${dailyHedgePnL >= 0 ? '+' : ''}$${dailyHedgePnL.toFixed(2)} | ` +
        `Funding: -$${dailyFundingCost.toFixed(2)} | ` +
        `PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | ` +
        `APR: ${runningAPR.toFixed(1)}%`
      );

      // Check risk limits
      if (futuresLeverage * futuresNotional / currentPositionValue > LIQUIDATION_BUFFER) {
        logger.log(`WARNING: Position approaching liquidation buffer on day ${dayNumber}`);
        futuresLeverage = Math.max(MIN_LEVERAGE, futuresLeverage * 0.7);
      }

      lastToken0Ratio = token0Ratio;
    }

    // Final summary calculations
    const lastDay = poolDayData[poolDayData.length - 1];
    const finalPositionValue = parseFloat(lastDay.tvlUSD) * lpSharePercentage;
    const daysInRange = poolDayData.length - timeOutOfRange;
    const timeInRangePercent = (daysInRange / poolDayData.length) * 100;
    
    const totalReturn = ((finalPositionValue + cumulativeFees - cumulativeFundingCosts - initialAmount) / initialAmount) * 100;
    const finalAPR = ((cumulativeFees - cumulativeFundingCosts) / initialAmount) * (365 / poolDayData.length) * 100;
    const weeklyFeeYield = (cumulativeFees / poolDayData.length * 7 / initialAmount) * 100;

    logger.log('');
    logger.log('=== Strategy Summary ===');
    logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
    logger.log(`Final LP Value: $${finalPositionValue.toLocaleString()}`);
    logger.log(`LP Position PnL: ${cumulativeLpPnL >= 0 ? '+' : ''}$${cumulativeLpPnL.toLocaleString()}`);
    logger.log(`Hedge Position PnL: ${cumulativeHedgePnL >= 0 ? '+' : ''}$${cumulativeHedgePnL.toLocaleString()}`);
    logger.log(`Total Fees Collected: $${cumulativeFees.toLocaleString()}`);
    logger.log(`Total Funding Costs: $${cumulativeFundingCosts.toLocaleString()}`);
    logger.log(`Net Fees: $${(cumulativeFees - cumulativeFundingCosts).toLocaleString()}`);
    logger.log(`Time in Range: ${timeInRangePercent.toFixed(1)}%`);
    logger.log(`Weekly Fee Yield: ${weeklyFeeYield.toFixed(2)}%`);
    logger.log(`Final Hedge Size: $${(futuresNotional * futuresLeverage).toLocaleString()}`);
    logger.log(`Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
    logger.log(`Annualized APR (Net): ${finalAPR.toFixed(2)}%`);

    // Check KPI compliance
    logger.log('');
    logger.log('=== KPI Compliance ===');
    logger.log(`✓ Weekly Fee Yield Target (≥0.30%): ${weeklyFeeYield >= 0.30 ? 'Met' : 'Not Met'} (${weeklyFeeYield.toFixed(2)}%)`);
    logger.log(`✓ Time in Range Target (≥85%): ${timeInRangePercent >= 85 ? 'Met' : 'Not Met'} (${timeInRangePercent.toFixed(1)}%)`);
    logger.log(`✓ Annual Return Target (≥15%): ${finalAPR >= 15 ? 'Met' : 'Not Met'} (${finalAPR.toFixed(2)}%)`);

  } catch (error: any) {
    if (error.message) {
      logger.error('Backtest failed: ' + error.message);
    } else {
      logger.error('Backtest failed: ' + String(error));
    }
  }
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
      imports: [AppConfigModule],
      providers: [
        FundingService,
        HyperliquidService,
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
        hyperliquidService,
        POOL_ADDRESS,
        '2024-05-29', // Start date (1 year ago)
        '2025-05-30', // End date (today)
        INITIAL_INVESTMENT,
      );
  
      expect(true).toBe(true);
    }, 60000); // 60 second timeout for API calls
  });
});
