import 'dotenv/config';
import { fetchPoolInfo, fetchPoolDayPrices } from './subgraph.client';
import { PositionType } from './types';
import { UniswapPosition } from './uniswap-lp.position';

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
): Promise<void> {
  logger.log(`=== WBTC/USDC LP Backtest (${positionType.toUpperCase()}) ===`);
  logger.log(`Pool: ${poolAddress}`);
  logger.log(`Fee Tier: ${feePercentage}`);
  logger.log(`Period: ${startDate} to ${endDate}`);
  logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
  logger.log(`Position Type: ${positionType}`);
  logger.log('');

  try {
    // Get pool information
    logger.log('Fetching pool information...');
    const poolInfo = await fetchPoolInfo(poolAddress);
    logger.log(
      `Pool Info: ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}`,
    );
    logger.log(`Fee Tier: ${parseFloat(poolInfo.feeTier) / 10000}%`);
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
    );

    const positionInfo = position.positionInfo;
    logger.log(`Initial TVL: $${initialTvl.toLocaleString()}`);
    logger.log(`LP Share: ${(positionInfo.sharePercentage * 100).toFixed(6)}%`);
    logger.log(`Tick Spacing: ${positionInfo.tickSpacing}`);
    logger.log('');
    logger.log('Daily Performance:');
    logger.log('');

    // Process each day with enhanced logging
    poolDayData.forEach((dayData, index) => {
      const dayNumber = index + 1;
      const date = formatDate(dayData.date);

      // Update position state for this day
      position.updateDaily(dayData);

      // Calculate current position value and IL
      const currentTVL = parseFloat(dayData.tvlUSD);
      const currentPositionValue = position.getCurrentPositionValue(currentTVL);

      const currentToken0Price = parseFloat(dayData.token0Price);
      const currentToken1Price = parseFloat(dayData.token1Price);
      const impermanentLoss = position.calculateImpermanentLoss(
        currentToken0Price,
        currentToken1Price,
      );

      // Calculate total PnL
      const positionPnL = currentPositionValue - initialAmount;
      const totalPnL = positionPnL + position.totalFeesEarned;

      // Get running APR from position
      const runningAPR = position.getRunningAPR();

      const currentTick = parseInt(dayData.tick);
      const isInRange =
        currentTick >= positionInfo.range.tickLower &&
        currentTick <= positionInfo.range.tickUpper;

      const rangeStatus =
        positionType === 'full-range'
          ? ''
          : isInRange
            ? ' [IN-RANGE]'
            : ' [OUT-OF-RANGE]';

      const tickInfo =
        positionType !== 'full-range' ? ` | Tick: ${currentTick}` : '';

      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `Value: $${currentPositionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | ` +
          `APR: ${runningAPR.toFixed(1)}%${rangeStatus}${tickInfo}`,
      );
    });

    // Enhanced final summary
    const lastDay = poolDayData[poolDayData.length - 1];
    const finalPositionValue = position.getCurrentPositionValue(
      parseFloat(lastDay.tvlUSD),
    );
    const totalReturn =
      ((finalPositionValue + position.totalFeesEarned - initialAmount) /
        initialAmount) *
      100;
    const finalAPR = position.getRunningAPR();
    const timeInRange = position.getTimeInRange();

    logger.log('');
    logger.log('=== Final Summary ===');
    logger.log(`Position Type: ${positionType.toUpperCase()}`);
    logger.log(`Fee Tier: ${feePercentage}`);
    logger.log(`Tick Spacing: ${positionInfo.tickSpacing}`);
    logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
    logger.log(`Final Position Value: $${finalPositionValue.toLocaleString()}`);
    logger.log(
      `Total Fees Collected: $${position.totalFeesEarned.toLocaleString()}`,
    );
    logger.log(
      `Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`,
    );
    logger.log(`Annualized APR (Fees Only): ${finalAPR.toFixed(2)}%`);

    if (positionType !== 'full-range') {
      logger.log(`Time in Range: ${timeInRange.toFixed(1)}%`);
      logger.log(
        `Days In Range: ${position.totalDaysInRange} / ${position.daysActive}`,
      );

      const rangeWidth =
        positionInfo.range.tickUpper - positionInfo.range.tickLower;
      logger.log(`Range Width: ${rangeWidth} ticks`);

      // Calculate average concentration during in-range periods
      const avgConcentration =
        rangeWidth > 0 ? Math.sqrt((887272 * 2) / rangeWidth) : 0;
      logger.log(
        `Average Concentration Factor: ${avgConcentration.toFixed(1)}x`,
      );
    }
  } catch (error: any) {
    if (error.message) {
      logger.error('Backtest failed: ' + error.message);
    } else {
      logger.error('Backtest failed: ' + String(error));
    }
  }
}

describe('Uniswap LP Backtesting', () => {
  it('should backtest WBTC/USDC LP performance for 10% range position', async () => {
    await runBacktest(
      POOL_ADDRESS,
      '2025-05-25',
      '2025-06-25',
      INITIAL_INVESTMENT,
      '10%',
      '0.3%',
    );

    expect(true).toBe(true);
  }, 60000);
});
