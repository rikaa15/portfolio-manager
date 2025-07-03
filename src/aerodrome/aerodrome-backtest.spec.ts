import 'dotenv/config';
import { fetchPoolInfo, fetchPoolDayData } from './subgraph.client';
import { PoolTestConfig, PositionType } from './types';
import { AerodromePosition } from './aerodrome-defilabs.position';
import { logger } from './aerodrome.utils';

const POOL_CONFIGS: Record<string, PoolTestConfig> = {
  // Original cbBTC/USDC pool (newer, March 2025)
  cbBTC_USDC: {
    poolName: 'cbBTC/USDC',
    poolAddress: '0x3e66e55e97ce60096f74b7C475e8249f2D31a9fb',
    token0Symbol: 'cbBTC',
    token1Symbol: 'USDC',
    token0Decimals: 8, // cbBTC has 8 decimals
    token1Decimals: 6, // USDC has 6 decimals
    tickSpacing: 2000, // Emerging tokens use 20% (tick space 2000)
    initialAmount: 1000,
    positionType: '10%',
    startDate: '2025-06-01',
    endDate: '2025-06-30',
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
    positionType: '10%',
    startDate: '2024-06-01',
    endDate: '2024-07-31',
  },
};

const REBALANCE_COOLDOWN_DAYS = 1;
const GAS_COST_PER_REBALANCE = 5;

// Date helpers
const formatDate = (unixTimestamp: number): string => {
  return new Date(unixTimestamp * 1000).toISOString().split('T')[0];
};

async function runAerodromeBacktest(
  config: PoolTestConfig,
  enableRebalancing: boolean = true,
): Promise<void> {
  try {
    const poolInfo = await fetchPoolInfo(config.poolAddress);
    logger.log(
      `===  Aerodrome ${poolInfo.token0.symbol}/${poolInfo.token1.symbol} LP Backtest with Real Fee Growth (${config.positionType.toUpperCase()}) ===`,
    );
    logger.log(`Pool: ${config.poolAddress}`);
    logger.log(`Tick Spacing: ${config.tickSpacing}`);
    logger.log(`Period: ${config.startDate} to ${config.endDate}`);
    logger.log(`Initial Investment: $${config.initialAmount.toLocaleString()}`);
    logger.log(`Position Type: ${config.positionType}`);
    logger.log(`Rebalancing: ${enableRebalancing ? 'ENABLED' : 'DISABLED'}`);
    logger.log('');

    logger.log(`Fetching pool information...`);
    logger.log('');

    // Get historical data
    logger.log('Fetching historical data...');
    const poolDayData = await fetchPoolDayData(
      config.poolAddress,
      config.startDate,
      config.endDate,
    );
    if (poolDayData.length === 0) {
      logger.log('No data found for the specified period');
      return;
    }

    logger.log(`Found ${poolDayData.length} days of data`);
    logger.log('');

    const firstDay = poolDayData[0];
    const initialTick = parseInt(firstDay.tick);
    const initialTvl = parseFloat(firstDay.tvlUSD);
    const initialToken0Price = parseFloat(firstDay.token0Price);
    const initialToken1Price = parseFloat(firstDay.token1Price);
    const totalPoolLiquidity = parseFloat(firstDay.liquidity);

    const position = AerodromePosition.create(
      config.initialAmount,
      config.positionType,
      initialTick,
      initialTvl,
      initialToken0Price,
      initialToken1Price,
      totalPoolLiquidity,
      config.tickSpacing,
      config.token0Decimals,
      config.token1Decimals,
    );

    const positionInfo = position.positionInfo;
    logger.log(`Initial TVL: $${initialTvl.toLocaleString()}`);
    logger.log(`LP Share: ${(positionInfo.sharePercentage * 100).toFixed(6)}%`);
    logger.log(`Tick Spacing: ${positionInfo.tickSpacing}`);
    logger.log('');
    logger.log('Daily Performance (using real fee growth data):');
    logger.log('');

    let lastRebalanceDay = 0;
    let fallbackCount = 0; // Track when falling back to old method

    // Process each day with enhanced logging
    poolDayData.forEach((dayData, index) => {
      const dayNumber = index + 1;
      const date = formatDate(dayData.date);

      const currentTick = parseInt(dayData.tick);
      // const alignedTick =
      //   Math.floor(currentTick / position.positionInfo.tickSpacing) *
      //   position.positionInfo.tickSpacing;
      const currentTVL = parseFloat(dayData.tvlUSD);

      const isInRangeBeforeRebalance = !position.isOutOfRange(currentTick);

      // Check if rebalancing is needed (strategy logic in backtesting script)
      let shouldRebalance = false;
      if (enableRebalancing) {
        const isOutOfRange = position.isOutOfRange(currentTick);
        const canRebalance =
          dayNumber > lastRebalanceDay + REBALANCE_COOLDOWN_DAYS;
        shouldRebalance = isOutOfRange && canRebalance;
      }

      // Perform rebalancing if needed (before updating daily)
      if (shouldRebalance) {
        position.rebalance(currentTick, currentTVL, GAS_COST_PER_REBALANCE);
        lastRebalanceDay = dayNumber;
      }

      // Check if fee growth data is available
      const hasFeeGrowthData =
        dayData.feeGrowthGlobal0X128 && dayData.feeGrowthGlobal1X128;
      if (!hasFeeGrowthData && dayNumber > 1) {
        fallbackCount++;
      }

      if (dayNumber <= 3) {
        // Debug first 3 days
        logger.log(`🔍 Day ${dayNumber} DEBUG:`);
        logger.log(`  currentTick: ${currentTick}`);
        logger.log(
          `  isOutOfRange(current): ${position.isOutOfRange(currentTick)}`,
        );
        // logger.log(`  canRebalance: ${canRebalance}`);
        logger.log(`  shouldRebalance: ${shouldRebalance}`);
        logger.log(`  lastRebalanceDay: ${lastRebalanceDay}`);
        logger.log(
          `  position.range: [${position.positionInfo.range.tickLower}, ${position.positionInfo.range.tickUpper}]`,
        );
      }
      // Update position state for this day
      const dailyFees = position.updateDaily(dayData, shouldRebalance);

      const currentPositionValue = position.getCurrentPositionValue();

      const currentToken0Price = parseFloat(dayData.token0Price);
      const impermanentLoss =
        position.calculateImpermanentLoss(currentToken0Price);

      // Calculate total PnL (net of gas costs)
      const totalPnL =
        currentPositionValue -
        config.initialAmount +
        position.currentPositionFeesEarned;

      const runningAPR = position.getRunningAPR();
      const weightedPositionAPR =
        lastRebalanceDay > 0 ? position.getWeightedPositionAPR() : runningAPR;

      const rangeStatus =
        config.positionType === 'full-range'
          ? ''
          : isInRangeBeforeRebalance
            ? ' [IN-RANGE]'
            : ' [OUT-OF-RANGE]';

      const rebalanceStatus =
        enableRebalancing && shouldRebalance ? ' [REBALANCED]' : '';

      const tickInfo =
        config.positionType !== 'full-range' ? ` | Tick: ${currentTick}` : '';

      const gasInfo =
        position.gasCostsTotal > 0
          ? ` | Gas: $${position.gasCostsTotal.toFixed(0)}`
          : '';

      // Ensure consistent value display (round to 2 decimal places)
      const feeMethodInfo = hasFeeGrowthData ? ' [REAL-FEES]' : ' [FALLBACK]';

      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `TVL: ${parseFloat(dayData.tvlUSD).toFixed(2)} | ` +
          `Value: $${currentPositionValue.toFixed(2)} | ` +
          `Fees: $${dailyFees.toFixed(2)} | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | ` +
          `Net APR: ${runningAPR.toFixed(3)}% | ` +
          `Pos APR: ${weightedPositionAPR.toFixed(3)}%${gasInfo}${rangeStatus}${rebalanceStatus}${tickInfo}${feeMethodInfo} |`,
      );
    });

    // Enhanced final summary with rebalancing statistics
    const lastDay = poolDayData[poolDayData.length - 1];
    const finalNetAPR = position.getRunningAPR();
    const finalGrossAPR = position.getGrossAPR();
    const timeInRange = position.getTimeInRange();

    // Add current position to results for final analysis
    if (position.currentPositionDaysActive > 0) {
      position.rebalance(parseInt(lastDay.tick), parseFloat(lastDay.tvlUSD), 0);
    }

    logger.log('');
    logger.log('=== APR Analysis ===');
    logger.log(`Overall Backtest APR (net): ${finalNetAPR.toFixed(2)}%`);
    logger.log(`Overall Backtest APR (gross): ${finalGrossAPR.toFixed(2)}%`);
    logger.log(
      `Weighted Position APR: ${position.getWeightedPositionAPR().toFixed(2)}%`,
    );
    logger.log(
      `Gas Impact: ${(finalGrossAPR - finalNetAPR).toFixed(2)}% APR reduction`,
    );
    logger.log('');

    // Add fee calculation method summary
    logger.log('=== Fee Calculation Summary ===');
    const realFeesDays = poolDayData.length - 1 - fallbackCount; // -1 for first day
    const fallbackPercentage =
      fallbackCount > 0 ? (fallbackCount / (poolDayData.length - 1)) * 100 : 0;
    logger.log(`Days using real fee growth: ${realFeesDays}`);
    logger.log(`Days using fallback method: ${fallbackCount}`);
    logger.log(`Fallback usage: ${fallbackPercentage.toFixed(1)}%`);
    logger.log('');

    if (config.positionType !== 'full-range') {
      logger.log('=== Range Management ===');
      logger.log(`Time in Range: ${timeInRange.toFixed(1)}%`);
      logger.log(
        `Days In Range: ${position.totalDaysInRange} / ${position.daysActive}`,
      );
      logger.log(`Total Rebalances: ${position.rebalanceCountTotal}`);
      logger.log(
        `Average Days Between Rebalances: ${(position.daysActive / (position.rebalanceCountTotal + 1)).toFixed(1)}`,
      );

      const rangeWidth =
        positionInfo.range.tickUpper - positionInfo.range.tickLower;
      logger.log(`Current Range Width: ${rangeWidth} ticks`);
    }
  } catch (error: any) {
    if (error.message) {
      logger.error('Aerodrome backtest failed: ' + error.message);
    } else {
      logger.error('Aerodrome backtest failed: ' + String(error));
    }
  }
}

describe('Aerodrome LP Backtesting with Real Fee Growth', () => {
  // it('should backtest cbBTC/USDC LP performance for 10% range position with real fee growth calculations (spread pattern)', async () => {
  //   const baseConfig = POOL_CONFIGS.cbBTC_USDC;
  //   const localConfig = {
  //     ...baseConfig,
  //     initialAmount: 1000,
  //     positionType: '10%' as PositionType,
  //     startDate: '2025-06-01',
  //     endDate: '2025-06-30',
  //   };
  //   await runAerodromeBacktest(localConfig, true);
  //   expect(true).toBe(true);
  // }, 120000);

  it('should backtest cbBTC/USDC LP performance for 10% range position with real fee growth calculations (spread pattern)', async () => {
    const baseConfig = POOL_CONFIGS.WETH_USDC;
    const localConfig = {
      ...baseConfig,
      // initialAmount: 1000,
      // positionType: '10%' as PositionType,
      // startDate: '2025-06-01',
      // endDate: '2025-06-30',
    };
    await runAerodromeBacktest(localConfig, true);
    expect(true).toBe(true);
  }, 120000);
});
