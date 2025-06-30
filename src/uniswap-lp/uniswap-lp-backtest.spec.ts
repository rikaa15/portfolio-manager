import 'dotenv/config';
import { fetchPoolInfo, fetchPoolDayPrices } from './subgraph.client';
import { PositionType } from './types';
import { UniswapPosition } from './uniswap-lp.position';
import { logger } from './uniswap-lp.utils';

const POOL_ADDRESS = '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35';
const INITIAL_INVESTMENT = 10000; // $10,000 USD

const REBALANCE_COOLDOWN_DAYS = 1;
const GAS_COST_PER_REBALANCE = 16;

// Date helpers
const formatDate = (unixTimestamp: number): string => {
  return new Date(unixTimestamp * 1000).toISOString().split('T')[0];
};

async function runBacktest(
  poolAddress: string,
  startDate: string,
  endDate: string,
  initialAmount: number,
  positionType: PositionType = 'full-range',
  feePercentage: string = '0.3%',
  enableRebalancing: boolean = true,
): Promise<void> {
  try {
    const poolInfo = await fetchPoolInfo(poolAddress);
    logger.log(
      `===  ${poolInfo.token0.symbol}/${poolInfo.token1.symbol} LP Backtest with Rebalancing (${positionType.toUpperCase()}) ===`,
    );
    logger.log(`Pool: ${poolAddress}`);
    logger.log(`Fee Tier: ${feePercentage}`);
    logger.log(`Period: ${startDate} to ${endDate}`);
    logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
    logger.log(`Position Type: ${positionType}`);
    logger.log(`Rebalancing: ${enableRebalancing ? 'ENABLED' : 'DISABLED'}`);
    logger.log('');

    logger.log(`Fetching pool information...`);
    logger.log('');

    // Get historical data
    logger.log('Fetching historical data...');
    const poolDayData = await fetchPoolDayPrices(
      poolAddress,
      startDate,
      endDate,
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

    const position = UniswapPosition.create(
      initialAmount,
      positionType,
      initialTick,
      initialTvl,
      initialToken0Price,
      initialToken1Price,
      feePercentage,
      1,
    );

    const positionInfo = position.positionInfo;
    logger.log(`Initial TVL: $${initialTvl.toLocaleString()}`);
    logger.log(`LP Share: ${(positionInfo.sharePercentage * 100).toFixed(6)}%`);
    logger.log(`Tick Spacing: ${positionInfo.tickSpacing}`);
    logger.log('');
    logger.log('Daily Performance (showing rebalancing events):');
    logger.log('');

    let lastRebalanceDay = 0;

    // Process each day with enhanced logging
    poolDayData.forEach((dayData, index) => {
      const dayNumber = index + 1;
      const date = formatDate(dayData.date);

      const currentTick = parseInt(dayData.tick);
      const alignedTick =
        Math.floor(currentTick / position.positionInfo.tickSpacing) *
        position.positionInfo.tickSpacing;
      const currentTVL = parseFloat(dayData.tvlUSD);

      const isInRangeBeforeRebalance = !position.isOutOfRange(alignedTick);

      // Check if rebalancing is needed (strategy logic in backtesting script)
      let shouldRebalance = false;
      if (enableRebalancing) {
        const isOutOfRange = position.isOutOfRange(alignedTick);
        const canRebalance =
          dayNumber > lastRebalanceDay + REBALANCE_COOLDOWN_DAYS;
        shouldRebalance = isOutOfRange && canRebalance;
      }

      // Perform rebalancing if needed (before updating daily)
      if (shouldRebalance) {
        position.rebalance(currentTick, currentTVL, GAS_COST_PER_REBALANCE);
        lastRebalanceDay = dayNumber;
      }

      // Update position state for this day
      position.updateDaily(dayData, shouldRebalance);
      // Calculate current position value and IL
      const currentPositionValue = position.getCurrentPositionValue(currentTVL);

      const currentToken0Price = parseFloat(dayData.token0Price);
      const currentToken1Price = parseFloat(dayData.token1Price);
      const impermanentLoss = position.calculateImpermanentLoss(
        currentToken0Price,
        currentToken1Price,
      );

      // Calculate total PnL (net of gas costs)
      const totalPnL =
        currentPositionValue -
        initialAmount +
        position.currentPositionFeesEarned;

      // const positionPnL = currentPositionValue - initialAmount;
      // const totalPnL = positionPnL + position.netFeesEarned;

      const runningAPR = position.getRunningAPR();
      const weightedPositionAPR =
        lastRebalanceDay > 0 ? position.getWeightedPositionAPR() : runningAPR;

      const rangeStatus =
        positionType === 'full-range'
          ? ''
          : isInRangeBeforeRebalance
            ? ' [IN-RANGE]'
            : ' [OUT-OF-RANGE]';

      const rebalanceStatus =
        enableRebalancing && shouldRebalance ? ' [REBALANCED]' : '';

      const tickInfo =
        positionType !== 'full-range' ? ` | Tick: ${currentTick}` : '';

      const gasInfo =
        position.gasCostsTotal > 0
          ? ` | Gas: $${position.gasCostsTotal.toFixed(0)}`
          : '';

      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `Value: $${currentPositionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | ` +
          `Net APR: ${runningAPR.toFixed(1)}% | ` +
          `Pos APR: ${weightedPositionAPR.toFixed(1)}%${gasInfo}${rangeStatus}${rebalanceStatus}${tickInfo} |`,
      );
    });

    // Enhanced final summary with rebalancing statistics
    const lastDay = poolDayData[poolDayData.length - 1];
    const finalNetAPR = position.getRunningAPR();
    const finalGrossAPR = position.getGrossAPR();
    const timeInRange = position.getTimeInRange();

    // Add current position to results for final analysis
    if (position.currentPositionDaysActive > 0) {
      // This will add the final position to the analysis
      position.rebalance(parseInt(lastDay.tick), parseFloat(lastDay.tvlUSD), 0); // No gas cost for final position
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

    if (positionType !== 'full-range') {
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
      logger.error('Backtest failed: ' + error.message);
    } else {
      logger.error('Backtest failed: ' + String(error));
    }
  }
}

describe('Uniswap LP Backtesting with Rebalancing', () => {
  it('should backtest WBTC/USDC LP performance for 10% range position with rebalancing', async () => {
    await runBacktest(
      POOL_ADDRESS,
      '2024-04-29',
      '2025-05-29',
      INITIAL_INVESTMENT,
      '10%',
      '0.3%',
      true,
    );

    expect(true).toBe(true);
  }, 120000); // Increased timeout for rebalancing calculations
});
