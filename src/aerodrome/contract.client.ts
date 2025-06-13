import { ethers, JsonRpcProvider } from 'ethers';

const POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function stakedLiquidity() external view returns (uint128)',
  'function gauge() external view returns (address)',
];

const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

const GAUGE_ABI = [
  'function rewardRate() external view returns (uint256)',
  'function periodFinish() external view returns (uint256)',
  'function rewardToken() external view returns (address)',
  'function fees0() external view returns (uint256)',
  'function fees1() external view returns (uint256)',
];

export interface ContractPoolInfo {
  id: string;
  liquidity: string;
  stakedLiquidity: string;
  token0: {
    symbol: string;
    decimals: string;
    address: string;
  };
  token1: {
    symbol: string;
    decimals: string;
    address: string;
  };
  token0Price: string;
  token1Price: string;
  liquidityUtilization: string;
  dailyAeroEmissions: string;
  gauge: {
    address: string;
    rewardRate: string;
    fees0?: string;
    fees1?: string;
  };
  blockNumber?: string;
  timestamp?: string;
}

function calculatePricesFromSqrtPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): { token0Price: string; token1Price: string } {
  try {
    const Q96 = BigInt(2) ** BigInt(96);
    const sqrtPriceNum = Number(sqrtPriceX96) / Number(Q96);
    const rawPrice = sqrtPriceNum * sqrtPriceNum;
    const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
    const priceToken1InToken0 = rawPrice * decimalAdjustment;

    return {
      token0Price: (1 / priceToken1InToken0).toFixed(6),
      token1Price: priceToken1InToken0.toFixed(6),
    };
  } catch (error) {
    return {
      token0Price: '0.000000',
      token1Price: '0.000000',
    };
  }
}

export async function fetchPoolInfoDirect(
  poolAddress: string,
  provider: JsonRpcProvider,
  blockNumber?: number,
): Promise<ContractPoolInfo> {
  try {
    const overrides = blockNumber ? { blockTag: blockNumber } : {};
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

    const [
      token0Address,
      token1Address,
      liquidity,
      stakedLiquidity,
      slot0,
      gaugeAddress,
    ] = await Promise.all([
      poolContract.token0(overrides),
      poolContract.token1(overrides),
      poolContract.liquidity(overrides),
      poolContract.stakedLiquidity(overrides),
      poolContract.slot0(overrides),
      poolContract.gauge(overrides),
    ]);

    const token0Contract = new ethers.Contract(
      token0Address,
      ERC20_ABI,
      provider,
    );
    const token1Contract = new ethers.Contract(
      token1Address,
      ERC20_ABI,
      provider,
    );

    const [token0Symbol, token0Decimals, token1Symbol, token1Decimals] =
      await Promise.all([
        token0Contract.symbol(overrides),
        token0Contract.decimals(overrides),
        token1Contract.symbol(overrides),
        token1Contract.decimals(overrides),
      ]);

    const gaugeContract = new ethers.Contract(
      gaugeAddress,
      GAUGE_ABI,
      provider,
    );
    const [rewardRate] = await Promise.all([
      gaugeContract.rewardRate(overrides),
    ]);

    let gaugeFees0 = '0';
    let gaugeFees1 = '0';
    try {
      const [fees0, fees1] = await Promise.all([
        gaugeContract.fees0(overrides),
        gaugeContract.fees1(overrides),
      ]);
      gaugeFees0 = fees0.toString();
      gaugeFees1 = fees1.toString();
    } catch {
      console.error('Gauge fees not available');
      // Gauge fees not available
    }

    const sqrtPriceX96 = slot0[0];
    const prices = calculatePricesFromSqrtPrice(
      sqrtPriceX96,
      Number(token0Decimals),
      Number(token1Decimals),
    );

    const liquidityUtilization =
      liquidity > 0n ? Number((stakedLiquidity * 10000n) / liquidity) / 100 : 0;

    const secondsPerDay = 86400n;
    const dailyAeroEmissionsWei = rewardRate * secondsPerDay;
    const dailyAeroEmissions = parseFloat(
      ethers.formatUnits(dailyAeroEmissionsWei, 18),
    );

    const latestBlock = await provider.getBlock(blockNumber || 'latest');
    const blockInfo = {
      number: latestBlock?.number?.toString(),
      timestamp: latestBlock?.timestamp?.toString(),
    };

    return {
      id: poolAddress.toLowerCase(),
      liquidity: liquidity.toString(),
      stakedLiquidity: stakedLiquidity.toString(),
      token0: {
        symbol: token0Symbol,
        decimals: token0Decimals.toString(),
        address: token0Address,
      },
      token1: {
        symbol: token1Symbol,
        decimals: token1Decimals.toString(),
        address: token1Address,
      },
      token0Price: prices.token0Price,
      token1Price: prices.token1Price,
      liquidityUtilization: liquidityUtilization.toFixed(2),
      dailyAeroEmissions: dailyAeroEmissions.toString(),
      gauge: {
        address: gaugeAddress,
        rewardRate: rewardRate.toString(),
        fees0: gaugeFees0,
        fees1: gaugeFees1,
      },
      blockNumber: blockInfo.number,
      timestamp: blockInfo.timestamp,
    };
  } catch (error: any) {
    throw new Error(
      `Failed to fetch pool info from contract: ${error?.message || error}`,
    );
  }
}
