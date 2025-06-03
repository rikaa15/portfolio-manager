import { ethers } from 'ethers';
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json';
import {
  fetchCurrentPoolData,
  fetchPoolDayPrices,
  fetchPoolHourPrices,
} from './subgraph.client';

/**
 * Get pool exchange rate (what Uniswap UI shows as "pool price")
 * Returns the current exchange rate between the two tokens
 */
export async function getPoolPrice(poolAddress: string): Promise<{
  token0ToToken1Rate: number; // How much token1 for 1 token0
  token1ToToken0Rate: number; // How much token0 for 1 token1
  token0Symbol: string;
  token1Symbol: string;
  formattedPrice: string;
}> {
  const poolData = await fetchCurrentPoolData(poolAddress);

  const rawToken0Price = parseFloat(poolData.token0Price);
  const rawToken1Price = parseFloat(poolData.token1Price);

  let token0ToToken1Rate: number;
  let token1ToToken0Rate: number;

  if (poolData.token0.symbol === 'WBTC' && rawToken0Price < 1) {
    token0ToToken1Rate = rawToken1Price;
    token1ToToken0Rate = rawToken0Price;
  } else {
    token0ToToken1Rate = rawToken0Price;
    token1ToToken0Rate = rawToken1Price;
  }

  console.log(`Pool Price for ${poolAddress}:`);
  console.log(
    `Raw token0Price: ${rawToken0Price}, Raw token1Price: ${rawToken1Price}`,
  );
  console.log(`Fixed rates:`);
  console.log(
    `  1 ${poolData.token0.symbol} = ${token0ToToken1Rate.toLocaleString()} ${poolData.token1.symbol}`,
  );
  console.log(
    `  1 ${poolData.token1.symbol} = ${token1ToToken0Rate.toFixed(8)} ${poolData.token0.symbol}`,
  );

  const formattedPrice = `1 ${poolData.token1.symbol} = ${token1ToToken0Rate.toFixed(8)} ${poolData.token0.symbol}`;

  return {
    token0ToToken1Rate,
    token1ToToken0Rate,
    token0Symbol: poolData.token0.symbol,
    token1Symbol: poolData.token1.symbol,
    formattedPrice,
  };
}

/**
 * Get historical pool prices (what creates the chart in Uniswap UI)
 * Returns time-series data for price charts
 */
export async function getPoolPriceHistory(
  poolAddress: string,
  startDate: string,
  endDate: string,
  interval: 'daily' | 'hourly' = 'daily',
): Promise<
  Array<{
    timestamp: number;
    date: string;
    token0Price: number;
    token1Price: number;
    tvlUSD: number;
    volumeUSD: number;
  }>
> {
  const startTime = Math.floor(new Date(startDate).getTime() / 1000);
  const endTime = Math.floor(new Date(endDate).getTime() / 1000);

  let rawData;

  if (interval === 'hourly') {
    rawData = await fetchPoolHourPrices(poolAddress, startTime, endTime);
  } else {
    rawData = await fetchPoolDayPrices(poolAddress, startTime, endTime);
  }

  const processedData = rawData.map((item) => ({
    timestamp: interval === 'hourly' ? item.periodStartUnix : item.date,
    date: new Date(
      (interval === 'hourly' ? item.periodStartUnix : item.date) * 1000,
    )
      .toISOString()
      .split('T')[0],
    token0Price: parseFloat(item.token0Price),
    token1Price: parseFloat(item.token1Price),
    tvlUSD: parseFloat(item.tvlUSD),
    volumeUSD: parseFloat(item.volumeUSD),
  }));

  console.log(
    `Pool price history for ${poolAddress}: ${processedData.length} ${interval} data points`,
  );

  return processedData;
}

/**
 * Get basic position data from tokenId
 * Pure utility function that fetches position info from blockchain
 */
export async function getPositionInfo(
  tokenId: number,
  provider: any,
  positionManagerAddress: string,
): Promise<{
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
}> {
  const contract = new ethers.Contract(
    positionManagerAddress,
    NonfungiblePositionManagerABI,
    provider,
  );

  const position = await contract.positions(tokenId);

  return {
    token0: position.token0,
    token1: position.token1,
    fee: Number(position.fee),
    tickLower: Number(position.tickLower),
    tickUpper: Number(position.tickUpper),
    liquidity: position.liquidity.toString(),
  };
}
