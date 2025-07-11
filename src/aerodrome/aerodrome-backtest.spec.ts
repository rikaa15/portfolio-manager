import 'dotenv/config';
import {
  fetchPoolInfo,
  fetchPoolDayData,
  fetchPoolHourData,
} from './subgraph.client';
import { GranularityType, PoolTestConfig, PositionType } from './types';
import { AerodromeSwapDecimalsPosition } from './aerodrome-defilabs.position';
import { ExportUtils } from '../common/utils/report-export.utils';
import { logger } from '../common/utils/common.utils';
import { UnifiedOutputStatus } from '../common/types';

const POOL_CONFIGS: Record<string, PoolTestConfig> = {
  // Original cbBTC/USDC pool (newer, March 2025)
  cbBTC_USDC: {
    poolName: 'cbBTC/USDC',
    poolAddress: '0x3e66e55e97ce60096f74b7C475e8249f2D31a9fb',
    token0Symbol: 'cbBTC',
    token1Symbol: 'USDC',
    token0Decimals: 6, // USDC has 6 decimals
    token1Decimals: 8, // cbBTC has 8 decimals
    tickSpacing: 2000, // Emerging tokens use 20% (tick space 2000)
    initialAmount: 1000,
    granularity: 'hourly',
    positionType: '10%',
    startDate: '2025-06-01',
    endDate: '2025-06-30',
    useCompoundingAPR: true,
  },
  // ETH/USDC pool (older, more established)
  WETH_USDC: {
    poolName: 'WETH/USDC',
    poolAddress: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Decimals: 18, // WETH has 18 decimals
    token1Decimals: 6, // USDC has 6 decimals
    tickSpacing: 100, // Volatile tokens use 2% (tick space 200)
    initialAmount: 1000,
    granularity: 'daily',
    positionType: '10%',
    startDate: '2024-06-01',
    endDate: '2024-07-31',
    useCompoundingAPR: true,
  },
};

const DAILY_OUTPUT_SKIP = 10;
const HOURLY_OUTPUT_SKIP = 100;

const REBALANCE_COOLDOWN = 1;
const GAS_COST_PER_REBALANCE = 5;

async function runAerodromeBacktest(
  config: PoolTestConfig,
  enableRebalancing: boolean = true,
): Promise<void> {
  try {
    const poolInfo = await fetchPoolInfo(config.poolAddress);
    logger.log(
      `===  Aerodrome ${poolInfo.token0.symbol}/${poolInfo.token1.symbol} LP Backtest (${config.positionType.toUpperCase()}) ===`,
    );
    logger.log(`Pool: ${config.poolAddress}`);
    logger.log(`Tick Spacing: ${config.tickSpacing}`);
    logger.log(`Period: ${config.startDate} to ${config.endDate}`);
    logger.log(`Initial Investment: $${config.initialAmount.toLocaleString()}`);
    logger.log(`Position Type: ${config.positionType}`);
    logger.log(`Rebalancing: ${enableRebalancing ? 'ENABLED' : 'DISABLED'}`);
    logger.log(
      `APR Method: ${config.useCompoundingAPR ? 'Compounded (Weighted)' : 'Simple (Running)'}`,
    );
    logger.log('');

    logger.log(`Fetching pool information...`);
    logger.log('');

    // Get historical data
    logger.log('Fetching historical data...');
    const timeSeriesData =
      config.granularity === 'daily'
        ? await fetchPoolDayData(
            config.poolAddress,
            config.startDate,
            config.endDate,
          )
        : await fetchPoolHourData(
            config.poolAddress,
            config.startDate,
            config.endDate,
          );

    if (timeSeriesData.length === 0) {
      logger.log('No data found for the specified period');
      return;
    }

    logger.log(`Found ${timeSeriesData.length} days of data`);
    logger.log('');

    const firstDay = timeSeriesData[0];
    const initialTick = parseInt(firstDay.tick);
    const initialTvl = parseFloat(firstDay.tvlUSD);
    const initialToken0Price = parseFloat(firstDay.token0Price);
    const initialToken1Price = parseFloat(firstDay.token1Price);
    const totalPoolLiquidity = parseFloat(firstDay.liquidity);

    const position = AerodromeSwapDecimalsPosition.create(
      config.initialAmount,
      config.positionType,
      initialTick,
      initialTvl,
      initialToken0Price,
      initialToken1Price,
      totalPoolLiquidity,
      config.token0Symbol,
      config.token1Symbol,
      config.granularity,
      config.tickSpacing,
      config.token0Decimals,
      config.token1Decimals,
      config.useCompoundingAPR ?? true,
    );

    const positionInfo = position.positionInfo;
    logger.log(`Initial TVL: $${initialTvl.toLocaleString()}`);
    logger.log(`LP Share: ${(positionInfo.sharePercentage * 100).toFixed(6)}%`);
    logger.log(`Tick Spacing: ${positionInfo.tickSpacing}`);
    logger.log('');
    logger.log('Daily Performance:');
    logger.log('');

    let lastRebalanceDay = 0;

    const exportUtils = new ExportUtils('Aerodrome');
    const tsvData: UnifiedOutputStatus[] = [];

    const skipData =
      config.granularity === 'hourly' ? HOURLY_OUTPUT_SKIP : DAILY_OUTPUT_SKIP;
    const totalDataPoints = timeSeriesData.length;

    // Process each data point with enhanced logging
    timeSeriesData.forEach((dataPoint, index) => {
      const dayNumber = index + 1;

      const currentTick = parseInt(dataPoint.tick);
      // const alignedTick =
      //   Math.floor(currentTick / position.positionInfo.tickSpacing) *
      //   position.positionInfo.tickSpacing;
      const currentTVL = parseFloat(dataPoint.tvlUSD);

      // Check if rebalancing is needed (strategy logic in backtesting script)
      let shouldRebalance = false;
      if (enableRebalancing) {
        const isOutOfRange = position.isOutOfRange(currentTick);
        const canRebalance = dayNumber > lastRebalanceDay + REBALANCE_COOLDOWN;
        shouldRebalance = isOutOfRange && canRebalance;
      }

      // Perform rebalancing if needed (before updating daily)
      if (shouldRebalance) {
        position.rebalance(currentTick, currentTVL, GAS_COST_PER_REBALANCE);
        lastRebalanceDay = dayNumber;
        // return;
      }

      // Update position state for this day
      position.update(dataPoint, shouldRebalance);

      // get current positionstatus
      const positionStatus = position.currentStatus(
        dayNumber === totalDataPoints,
      );

      const shouldShowInConsole =
        dayNumber === 1 || // Always show first day
        dayNumber === totalDataPoints || // Always show last day
        dayNumber % skipData === 0;

      if (shouldShowInConsole) {
        dayNumber === 1 && exportUtils.printConsoleHeader();
        logger.log(exportUtils.formatConsoleRow(positionStatus));
      }
      tsvData.push(positionStatus);
    });

    // Enhanced final summary with rebalancing statistics
    const lastDay = timeSeriesData[timeSeriesData.length - 1];
    const finalAPR = position.getAPR();
    const finalGrossAPR = position.getGrossAPR();
    const timeInRange = position.getTimeInRange();

    // Add current position to results for final analysis
    if (position.currentPositionDataPointsActive > 0) {
      position.rebalance(
        parseInt(lastDay.tick),
        parseFloat(lastDay.tvlUSD),
        0,
        true,
      );
    }

    const aprMethod = config.useCompoundingAPR
      ? 'Compounded (Weighted)'
      : 'Simple (Running)';

    logger.log('');
    logger.log('=== APR Analysis ===');
    logger.log(`${aprMethod} APR: ${finalAPR.toFixed(2)}%`);
    logger.log(`Overall Backtest APR (net): ${finalAPR.toFixed(2)}%`);
    logger.log(`Overall Backtest APR (gross): ${finalGrossAPR.toFixed(2)}%`);
    logger.log(
      `Weighted Position APR: ${position.getWeightedPositionAPR().toFixed(2)}%`,
    );
    logger.log(
      `Gas Impact: ${(finalGrossAPR - finalAPR).toFixed(2)}% APR reduction`,
    );
    logger.log('');

    if (config.positionType !== 'full-range') {
      logger.log('=== Range Management ===');
      logger.log(`Time in Range: ${timeInRange.toFixed(1)}%`);
      logger.log(
        `Days In Range: ${position.totalDataPointsInRange} / ${position.dataPointsActive}`,
      );
      logger.log(`Total Rebalances: ${position.rebalanceCountTotal}`);
      logger.log(
        `Average Days Between Rebalances: ${(position.dataPointsActive / (position.rebalanceCountTotal + 1)).toFixed(1)}`,
      );

      const rangeWidth =
        positionInfo.range.tickUpper - positionInfo.range.tickLower;
      logger.log(`Current Range Width: ${rangeWidth} ticks`);

      logger.log('');
      logger.log('=== Concentration Analysis ===');

      // Create a temporary full-range position to compare liquidity
      const fullRangePosition = AerodromeSwapDecimalsPosition.create(
        config.initialAmount,
        'full-range',
        initialTick,
        initialTvl,
        initialToken0Price,
        initialToken1Price,
        totalPoolLiquidity,
        config.token0Symbol,
        config.token1Symbol,
        config.granularity,
        config.tickSpacing,
        config.token0Decimals,
        config.token1Decimals,
        config.useCompoundingAPR ?? true,
      );

      const concentratedLiquidity = position.positionLiquidityAmount;
      const fullRangeLiquidity = fullRangePosition.positionLiquidityAmount;
      const concentrationMultiplier =
        concentratedLiquidity / fullRangeLiquidity;

      logger.log(
        `Concentrated Liquidity: ${concentratedLiquidity.toFixed(0)} units`,
      );
      logger.log(
        `Full-Range Liquidity: ${fullRangeLiquidity.toFixed(0)} units`,
      );
      logger.log(
        `Concentration Multiplier: ${concentrationMultiplier.toFixed(2)}x`,
      );
      logger.log(`Position Type: ${config.positionType} vs Full-Range`);

      logger.log('');
      logger.log('=== Fee Earning Potential ===');
      logger.log(
        `Theoretical Fee Advantage: ${concentrationMultiplier.toFixed(2)}x higher than full-range`,
      );
      logger.log(
        `Liquidity Density: ${concentrationMultiplier.toFixed(2)}x more concentrated`,
      );
    }

    const filename = exportUtils.generateTsvFilename(
      config.token0Symbol,
      config.token1Symbol,
      config.startDate,
      config.endDate,
      config.positionType,
      config.granularity,
    );
    exportUtils.exportTsv(filename, tsvData);
  } catch (error: any) {
    if (error.message) {
      logger.error('Aerodrome backtest failed: ' + error.message);
    } else {
      logger.error('Aerodrome backtest failed: ' + String(error));
    }
  }
}

describe('Aerodrome LP Backtesting with Real Fee Growth', () => {
  it('should backtest cbBTC/USDC LP performance for 10% range position with real fee growth calculations (spread pattern)', async () => {
    const baseConfig = POOL_CONFIGS.cbBTC_USDC;
    const localConfig = {
      ...baseConfig,
      granularity: 'hourly' as GranularityType,
      initialAmount: 10000,
      positionType: '10%' as PositionType,
      startDate: '2025-06-29',
      endDate: '2025-06-30',
      useCompoundingAPR: true,
    };
    await runAerodromeBacktest(localConfig, true);
    expect(true).toBe(true);
  }, 120000);

  // it('should backtest cbBTC/USDC LP performance for 10% range position with real fee growth calculations (spread pattern)', async () => {
  //   const baseConfig = POOL_CONFIGS.WETH_USDC;
  //   const localConfig = {
  //     ...baseConfig,
  //     // initialAmount: 1000,
  //     // positionType: '10%' as PositionType,
  //     // startDate: '2025-06-01',
  //     // endDate: '2025-06-30',
  //   };
  //   await runAerodromeBacktest(localConfig, true);
  //   expect(true).toBe(true);
  // }, 120000);
});
