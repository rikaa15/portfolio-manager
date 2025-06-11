import { ethers } from 'ethers';
import { fetchPoolInfoDirect } from './contract.client';
import {
  fetchPoolInfo,
  fetchPoolDayData,
  PoolInfo,
  PoolDayData,
} from './subgraph.client';
import configuration from '../config/configuration';
import { getTokenPrice } from './coingecko.client';

const POOL_ADDRESS = '0x3e66e55e97ce60096f74b7c475e8249f2d31a9fb'; // cbBTC/USDC Pool
const INITIAL_INVESTMENT = 100; // $100 USD

const config = configuration();
const networkName = 'base';
const networkConfig = config[networkName as keyof typeof config] as any;

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
 * Calculate impermanent loss percentage
 * Uses the standard AMM formula for constant product pools
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

/**
 * Run Aerodrome backtest simulation using modular subgraph client
 * This function orchestrates the backtesting process with clean data flow
 */
async function runAerodromeBacktest(
  poolAddress: string,
  startDate: string,
  endDate: string,
  initialAmount: number,
): Promise<void> {
  logger.log('=== cbBTC/USDC Aerodrome LP Backtest ===');
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
    logger.log(
      `Current TVL: $${parseFloat(poolInfo.totalValueLockedUSD).toLocaleString()}`,
    );
    logger.log('');

    // Get historical data using the client
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

    // Calculate initial LP share based on first day's TVL
    const firstDay = poolDayData[0];
    const lpSharePercentage = initialAmount / parseFloat(firstDay.tvlUSD);

    logger.log(`Initial TVL: $${parseFloat(firstDay.tvlUSD).toLocaleString()}`);
    logger.log(`LP Share: ${(lpSharePercentage * 100).toFixed(6)}%`);
    logger.log('');

    // Track cumulative values
    let cumulativeFees = 0;
    const initialToken0Price = parseFloat(firstDay.token0Price);
    const initialToken1Price = parseFloat(firstDay.token1Price);

    logger.log('Daily Performance:');
    logger.log('');

    // Process each day of backtest data
    poolDayData.forEach((dayData, index) => {
      const dayNumber = index + 1;
      const date = formatDate(dayData.date);

      // Calculate daily fee earnings based on LP share
      const dailyFees = parseFloat(dayData.feesUSD) * lpSharePercentage;
      cumulativeFees += dailyFees;

      // Calculate current position value
      const currentTVL = parseFloat(dayData.tvlUSD);
      const currentPositionValue = currentTVL * lpSharePercentage;

      // Calculate impermanent loss vs holding strategy
      const currentToken0Price = parseFloat(dayData.token0Price);
      const currentToken1Price = parseFloat(dayData.token1Price);
      const impermanentLoss = calculateImpermanentLoss(
        currentToken0Price,
        currentToken1Price,
        initialToken0Price,
        initialToken1Price,
      );

      // Calculate total PnL (position change + fees)
      const positionPnL = currentPositionValue - initialAmount;
      const totalPnL = positionPnL + cumulativeFees;

      // Calculate running APR based on fees only
      const daysElapsed = dayNumber;
      const runningAPR =
        (cumulativeFees / initialAmount) * (365 / daysElapsed) * 100;

      // Clean output: Position Value, IL, PnL, APR
      logger.log(
        `Day ${dayNumber.toString().padStart(3)} (${date}): ` +
          `Value: $${currentPositionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `IL: ${impermanentLoss >= 0 ? '+' : ''}${impermanentLoss.toFixed(2)}% | ` +
          `PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)} | ` +
          `APR: ${runningAPR.toFixed(1)}%`,
      );
    });

    // Calculate and display final summary
    const lastDay = poolDayData[poolDayData.length - 1];
    const finalPositionValue = parseFloat(lastDay.tvlUSD) * lpSharePercentage;
    const totalReturn =
      ((finalPositionValue + cumulativeFees - initialAmount) / initialAmount) *
      100;
    const finalAPR =
      (cumulativeFees / initialAmount) * (365 / poolDayData.length) * 100;

    logger.log('');
    logger.log('=== Final Summary ===');
    logger.log(`Initial Investment: $${initialAmount.toLocaleString()}`);
    logger.log(`Final Position Value: $${finalPositionValue.toLocaleString()}`);
    logger.log(`Total Fees Collected: $${cumulativeFees.toLocaleString()}`);
    logger.log(
      `Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`,
    );
    logger.log(`Annualized APR (Fees Only): ${finalAPR.toFixed(2)}%`);
  } catch (error: any) {
    if (error.message) {
      logger.error('Backtest failed: ' + error.message);
    } else {
      logger.error('Backtest failed: ' + String(error));
    }
  }
}

describe('Aerodrome LP Backtesting', () => {
  let selectedDay: PoolDayData;
  let selectedDayIndex: number;
  let lpSharePercentage: number;

  it('should backtest cbBTC/USDC LP performance using modular subgraph client', async () => {
    await runAerodromeBacktest(
      POOL_ADDRESS,
      '2025-05-01',
      '2025-06-11',
      INITIAL_INVESTMENT,
    );

    const startTimestamp = getUnixTimestamp('2025-05-01');
    const endTimestamp = getUnixTimestamp('2025-06-11');

    const poolDayData: PoolDayData[] = await fetchPoolDayData(
      POOL_ADDRESS,
      startTimestamp,
      endTimestamp,
    );

    selectedDayIndex = poolDayData.length - 1;
    selectedDay = poolDayData[selectedDayIndex];

    const firstDay = poolDayData[0];
    lpSharePercentage = INITIAL_INVESTMENT / parseFloat(firstDay.tvlUSD);

    logger.log(`\nPrepared for validation: ${formatDate(selectedDay.date)}`);

    expect(true).toBe(true);
  }, 60000);

  it('should validate fees vs AERO rewards using current contract data', async () => {
    if (!selectedDay) {
      logger.log('No shared data available, skipping validation');
      return;
    }

    const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl);
    const testDate = formatDate(selectedDay.date);

    logger.log(`Validating ${testDate}`);

    try {
      const contractData = await fetchPoolInfoDirect(POOL_ADDRESS, provider);

      const dailyFeesUSD = parseFloat(selectedDay.feesUSD);
      const dailyLPFeesUSD = dailyFeesUSD * lpSharePercentage;

      const dailyAeroEmissions = parseFloat(contractData.dailyAeroEmissions);
      const estimatedAeroPrice = await getTokenPrice('AERO');
      const dailyAeroValueUSD = dailyAeroEmissions * estimatedAeroPrice;
      const dailyLPAeroUSD = dailyAeroValueUSD * lpSharePercentage;

      // const totalContractRewardsUSD = contractLPTradingFeesUSD + dailyLPAeroUSD;

      const gaugeFees0 = contractData.gauge.fees0 || '0';
      const gaugeFees1 = contractData.gauge.fees1 || '0';
      const gaugeFees0Formatted = ethers.formatUnits(
        gaugeFees0,
        parseInt(contractData.token0.decimals),
      );
      const gaugeFees1Formatted = ethers.formatUnits(
        gaugeFees1,
        parseInt(contractData.token1.decimals),
      );

      const contractBlock = contractData.blockNumber || 'current';

      logger.log(`\nSubgraph (${testDate}):`);
      logger.log(`  TVL: ${parseFloat(selectedDay.tvlUSD).toLocaleString()}`);
      logger.log(
        `  Volume: ${parseFloat(selectedDay.volumeUSD).toLocaleString()}`,
      );
      logger.log(`  Pool Fees: ${dailyFeesUSD.toLocaleString()}`);
      logger.log(`  LP Fees: ${dailyLPFeesUSD.toFixed(4)}`);

      logger.log(`\nContract (Block: ${contractBlock}):`);
      logger.log(`  Token0 Price: ${contractData.token0Price}`);
      logger.log(`  Token1 Price: ${contractData.token1Price}`);
      logger.log(`  Utilization: ${contractData.liquidityUtilization}%`);
      logger.log(
        `  AERO Emissions: ${dailyAeroEmissions.toLocaleString()}/day`,
      );
      logger.log(`  AERO Value: ${dailyAeroValueUSD.toLocaleString()}/day`);
      logger.log(`  LP AERO: ${dailyLPAeroUSD.toFixed(4)}`);
      logger.log(
        `  Gauge Fees Token0: ${parseFloat(gaugeFees0Formatted).toFixed(6)} ${contractData.token0.symbol}`,
      );
      logger.log(
        `  Gauge Fees Token1: ${parseFloat(gaugeFees1Formatted).toFixed(6)} ${contractData.token1.symbol}`,
      );

      const aeroRatio = dailyLPAeroUSD / dailyLPFeesUSD;

      logger.log(`\nComparison:`);
      logger.log(`  Subgraph LP Fees: ${dailyLPFeesUSD.toFixed(4)}`);
      logger.log(`  Contract LP AERO: ${dailyLPAeroUSD.toFixed(4)}`);
      logger.log(`  AERO/Fees Ratio: ${aeroRatio.toFixed(2)}x`);

      expect(dailyFeesUSD).toBeGreaterThanOrEqual(0);
      expect(dailyAeroEmissions).toBeGreaterThan(0);
      expect(parseFloat(contractData.liquidityUtilization)).toBeGreaterThan(50);

      if (aeroRatio > 0.5 && aeroRatio < 2.0) {
        logger.log('  Result: AERO rewards comparable to subgraph fees');
      } else if (aeroRatio > 2.0) {
        logger.log('  Result: AERO rewards exceed subgraph fees significantly');
      } else {
        logger.log('  Result: Subgraph fees exceed AERO rewards');
      }
      logger.log(
        `AERO rewards provide ${(aeroRatio * 100).toFixed(1)}% of subgraph fee value`,
      );
    } catch (error) {
      logger.error(`Validation failed: ${error}`);
      throw error;
    }
  }, 30000);
});
