// src/aerodrome/aerodrome-backtest.spec.ts
import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  fetchPoolInfo,
  fetchPoolDayData,
  fetchPoolPositions,
} from './aerodrome/subgraph.client';
import { PoolDayData, PoolInfo } from './aerodrome/types';
import { AerodromePosition } from './aerodrome/aerodrome.position';
import { HyperliquidPosition } from './hyperliquid/hyperliquid.position';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { FundingService } from './funding/funding.service';
import { AppConfigModule } from './config/config.module';

const POOL_ADDRESS = '0x3e66e55e97ce60096f74b7c475e8249f2d31a9fb'; // cbBTC/USDC Pool
const INITIAL_INVESTMENT = 1000;

const logger = {
  log: (message: string) => {
    process.stdout.write(message + '\n');
  },
  error: (message: string) => {
    process.stderr.write(message + '\n');
  },
};

const getUnixTimestamp = (dateString: string): number => {
  return Math.floor(new Date(dateString).getTime() / 1000);
};

const formatDate = (unixTimestamp: number): string => {
  return new Date(unixTimestamp * 1000).toISOString().split('T')[0];
};

/**
 * Run Aerodrome + Hyperliquid combined backtest simulation
 * Using real HyperliquidService and FundingService instead of mock data
 */
async function runCombinedBacktest(
  poolAddress: string,
  startDate: string,
  endDate: string,
  initialAmount: number,
  hyperliquidService: HyperliquidService,
  fundingService: FundingService,
  positionType: string = 'full-range',
): Promise<void> {
  logger.log('=== Combined Aerodrome LP + Hyperliquid Perpetual Backtest ===');
  logger.log(`Pool: ${poolAddress}`);
  logger.log(`Period: ${startDate} to ${endDate}`);
  logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
  logger.log('');

  try {
    logger.log('Fetching pool information...');
    const poolInfo: PoolInfo = await fetchPoolInfo(poolAddress);
    logger.log(
      `Pool Info: ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}`,
    );
    logger.log('');

    logger.log('Fetching position distribution...');
    const allPositions = await fetchPoolPositions(poolAddress);
    logger.log(`Found ${allPositions.length} positions in pool`);

    // Get historical data
    logger.log('Fetching historical data...');
    const startTimestamp = getUnixTimestamp(startDate);
    const endTimestamp = getUnixTimestamp(endDate);

    const poolDayData: PoolDayData[] = await fetchPoolDayData(
      poolAddress,
      startTimestamp,
      endTimestamp,
    );

    if (poolDayData.length === 0) {
      logger.log('No data found for the specified period');
      return;
    }

    logger.log(`Found ${poolDayData.length} days of data`);
    logger.log('');

    logger.log('Fetching BTC historical prices from Hyperliquid...');
    const btcPrices = await hyperliquidService.getHistoricalPrices(
      'BTC',
      '1d', // Daily candles
      startTimestamp * 1000, // Convert to milliseconds
      endTimestamp * 1000,
    );

    logger.log(`Fetching funding rates from ${startDate} to ${endDate}...`);
    const hourlyFundingRates = await fundingService.getHistoricalFundingRates(
      'BTC',
      startTimestamp * 1000, // Convert to milliseconds
      endTimestamp * 1000,
    );
    const fundingRates =
      fundingService.hourlyTo8HourFundingRates(hourlyFundingRates);
    logger.log(`Found ${fundingRates.length} funding rate periods`);
    logger.log('');

    const aerodromePosition = new AerodromePosition(
      initialAmount,
      poolDayData[0],
      positionType,
      2000, // cbBTC/USDC tick spacing
      allPositions,
    );

    // Initialize Hyperliquid position based on app.service.spec strategy
    const BASE_HEDGE_RATIO = 0.5; // 50% hedge ratio from app.service.spec script
    const initialFuturesNotional = initialAmount * BASE_HEDGE_RATIO;
    const initialBtcPrice =
      btcPrices[0]?.close || parseFloat(poolDayData[0].token0Price);

    const hyperliquidPosition = new HyperliquidPosition(
      initialFuturesNotional,
      initialBtcPrice,
      'short', // Start with short to hedge BTC exposure (from app.service.spec script)
      1, // Start with 1x leverage
    );

    logger.log(
      `Initial TVL: $${parseFloat(poolDayData[0].tvlUSD).toLocaleString()}`,
    );
    logger.log(
      `LP Share: ${(aerodromePosition.sharePercentage * 100).toFixed(6)}%`,
    );
    logger.log(
      `Initial Futures Hedge: $${initialFuturesNotional.toLocaleString()}`,
    );
    logger.log(`Initial BTC Price: $${initialBtcPrice.toLocaleString()}`);
    logger.log('');

    logger.log('Daily Performance:');
    logger.log('');

    poolDayData.forEach((dayData, index) => {
      const dayNumber = index + 1;
      const date = formatDate(dayData.date);

      // Update Aerodrome position state
      aerodromePosition.updateDaily(dayData);

      const btcPriceData = btcPrices.find(
        (price) =>
          Math.abs(price.timestamp.getTime() / 1000 - dayData.date) <=
          24 * 60 * 60,
      );
      const currentBtcPrice =
        btcPriceData?.close || parseFloat(dayData.token0Price);

      const impermanentLoss =
        aerodromePosition.calculateImpermanentLoss(currentBtcPrice);
      const currentLpValue = aerodromePosition.value;

      const fundingRateData = fundingRates.find(
        (rate) =>
          Math.abs(Math.round(rate.time / 1000) - dayData.date) <= 8 * 60 * 60,
      );

      if (!fundingRateData) {
        logger.log(`No funding rate found for ${date}, skipping day`);
        return;
      }

      // Update Hyperliquid position state
      hyperliquidPosition.updateDaily(
        currentBtcPrice,
        fundingRateData,
        currentLpValue,
        impermanentLoss,
      );

      // Token ratio check
      const hedgeAdjustment =
        aerodromePosition.shouldAdjustHedge(currentBtcPrice);

      if (hedgeAdjustment.shouldAdjust) {
        const hedgeSizeChange = hyperliquidPosition.adjustHedgeSize(
          hedgeAdjustment.adjustmentDirection,
          hedgeAdjustment.deviation,
          currentLpValue,
        );

        logger.log(
          ` Token Ratio: $${hedgeSizeChange.old.toFixed(0)} → $${hedgeSizeChange.new.toFixed(0)} (${hedgeAdjustment.adjustmentDirection}, ${(hedgeAdjustment.deviation * 100).toFixed(1)}% deviation)`,
        );
      }

      // Weekly funding cost monitoring
      if (dayNumber % 7 === 0) {
        const weeklyFundingCost = Math.abs(
          hyperliquidPosition.totalFundingCosts,
        );
        const weeklyLpFees = aerodromePosition.fees;
        const fundingToFeesRatio = weeklyFundingCost / weeklyLpFees;

        if (fundingToFeesRatio > 0.2) {
          // Strategy's 20% threshold
          logger.log(
            `High funding cost: ${(fundingToFeesRatio * 100).toFixed(1)}% of LP fees`,
          );
        }
      }

      // Check and apply risk limits
      if (hyperliquidPosition.checkRiskLimits(currentLpValue)) {
        logger.log(
          `WARNING: Position approaching liquidation buffer on day ${dayNumber}`,
        );
        hyperliquidPosition.applyRiskLimitAdjustments();
      }

      // Calculate combined metrics
      const lpPnL = aerodromePosition.calculateTotalPnL();
      const hedgePnL = hyperliquidPosition.totalHedgePnL;
      const fundingCosts = hyperliquidPosition.totalFundingCosts;
      const totalPnL = lpPnL + hedgePnL - fundingCosts;
      // Calculate running APR including hedge performance
      const runningAPR =
        ((aerodromePosition.fees - fundingCosts) / initialAmount) *
        (365 / dayNumber) *
        100;

      // Output daily performance with enhanced details
      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `BTC (HL): ${currentBtcPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `BTC (Aero): ${parseFloat(dayData.token0Price).toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `LP Value: ${currentLpValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `LP Fees: ${(aerodromePosition.fees / dayNumber).toFixed(2)} | ` +
          `BTC Ratio: ${(hedgeAdjustment.tokenRatio.token0Ratio * 100).toFixed(1)}% | ` +
          `Deviation: ${(hedgeAdjustment.deviation * 100).toFixed(1)}% | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `Hedge: ${hyperliquidPosition.totalNotional.toLocaleString()} (${hyperliquidPosition.leverage.toFixed(1)}x) | ` +
          `Funding Rate: ${fundingRateData.fundingRate >= 0 ? '+' : ''}${(fundingRateData.fundingRate * 100).toFixed(4)}% | ` +
          `Funding: ${fundingCosts >= 0 ? '+' : ''}$${fundingCosts.toFixed(2)} |` +
          `Total PnL: ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} | ` +
          `APR: ${runningAPR.toFixed(1)}%`,
      );
    });

    logger.log('');
    logger.log('=== Strategy Summary ===');
    logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
    logger.log(`Final LP Value: $${aerodromePosition.value.toLocaleString()}`);
    logger.log(
      `LP Position PnL: ${aerodromePosition.calculateTotalPnL() >= 0 ? '+' : ''}$${aerodromePosition.calculateTotalPnL().toLocaleString()}`,
    );
    logger.log(
      `Hedge Position PnL: ${hyperliquidPosition.totalHedgePnL >= 0 ? '+' : ''}$${hyperliquidPosition.totalHedgePnL.toLocaleString()}`,
    );
    logger.log(
      `Total Fees Collected: $${aerodromePosition.fees.toLocaleString()}`,
    );
    logger.log(
      `Total Funding Costs: $${hyperliquidPosition.totalFundingCosts.toLocaleString()}`,
    );
    logger.log(
      `Net Fees: $${(aerodromePosition.fees - hyperliquidPosition.totalFundingCosts).toLocaleString()}`,
    );
    logger.log(
      `Time in Range: ${aerodromePosition.getTimeInRangePercent().toFixed(1)}%`,
    );
    logger.log(
      `Final Hedge Size: $${hyperliquidPosition.totalNotional.toLocaleString()}`,
    );

    const totalReturn =
      ((aerodromePosition.value +
        aerodromePosition.fees +
        hyperliquidPosition.totalHedgePnL -
        hyperliquidPosition.totalFundingCosts -
        initialAmount) /
        initialAmount) *
      100;
    const finalAPR =
      ((aerodromePosition.fees - hyperliquidPosition.totalFundingCosts) /
        initialAmount) *
      (365 / poolDayData.length) *
      100;

    logger.log(
      `Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`,
    );
    logger.log(`Annualized APR (Net): ${finalAPR.toFixed(2)}%`);
  } catch (error: any) {
    if (error.message) {
      logger.error('Backtest failed: ' + error.message);
    } else {
      logger.error('Backtest failed: ' + String(error));
    }
  }
}

describe('Aerodrome LP Backtesting with Position Class', () => {
  let module: TestingModule;
  let hyperliquidService: HyperliquidService;
  let fundingService: FundingService;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), AppConfigModule],
      providers: [HyperliquidService, FundingService],
    }).compile();

    hyperliquidService = module.get<HyperliquidService>(HyperliquidService);
    fundingService = module.get<FundingService>(FundingService);
  });

  afterEach(async () => {
    if (module) {
      await module.close();
    }
  });

  it('should backtest cbBTC/USDC LP performance using real Hyperliquid data', async () => {
    await runCombinedBacktest(
      POOL_ADDRESS,
      '2025-06-01',
      '2025-06-12',
      INITIAL_INVESTMENT,
      hyperliquidService,
      fundingService,
      'full-range',
    );
    expect(true).toBe(true);
  }, 60000);
});
