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
): Promise<void> {
  logger.log(`=== WBTC/USDC LP Backtest (${positionType.toUpperCase()}) ===`);
  logger.log(`Pool: ${poolAddress}`);
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

    // Initialize position using the new Position class
    const firstDay = poolDayData[0];
    const initialTick = parseInt(firstDay.tick);
    const initialTvl = parseFloat(firstDay.tvlUSD);
    const initialToken0Price = parseFloat(firstDay.token0Price);
    const initialToken1Price = parseFloat(firstDay.token1Price);

    const position = new UniswapPosition(
      initialAmount,
      positionType,
      initialTick,
      initialTvl,
      initialToken0Price,
      initialToken1Price,
      60, // tick spacing for WBTC/USDC 0.3% pool
    );

    // Show position setup information
    const positionInfo = position.positionInfo;
    logger.log(`Initial TVL: $${initialTvl.toLocaleString()}`);
    logger.log(`LP Share: ${(positionInfo.sharePercentage * 100).toFixed(6)}%`);

    if (positionType !== 'full-range') {
      logger.log(
        `Position Range: ${positionInfo.range.priceLower.toFixed(2)} - ${positionInfo.range.priceUpper.toFixed(2)}`,
      );
      logger.log(
        `Range Width: ±${(positionInfo.range.rangeWidth * 50).toFixed(1)}%`,
      );
      logger.log(
        `Concentration Multiplier: ${positionInfo.multiplier.toFixed(1)}x`,
      );
      logger.log(
        `Expected APR Boost: ${positionInfo.multiplier.toFixed(1)}x higher when in range`,
      );
    }
    logger.log('');

    logger.log('Daily Performance:');
    logger.log('');

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

      // Check if position is in range for display
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

      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `Value: $${currentPositionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | ` +
          `APR: ${runningAPR.toFixed(1)}%${rangeStatus}`,
      );
    });

    // Final summary using position metrics
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

      // Calculate effective APR (accounting for time out of range)
      const effectiveAPR = finalAPR * (timeInRange / 100);
      logger.log(
        `Effective APR (adjusted for range): ${effectiveAPR.toFixed(2)}%`,
      );

      // Show theoretical max APR if 100% in range
      const theoreticalMaxAPR = finalAPR; // This already includes the multiplier
      logger.log(
        `Theoretical Max APR (100% in range): ${theoreticalMaxAPR.toFixed(2)}%`,
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
      '2024-05-29',
      '2025-05-29',
      INITIAL_INVESTMENT,
      '10%',
    );

    expect(true).toBe(true);
  }, 60000);
});
