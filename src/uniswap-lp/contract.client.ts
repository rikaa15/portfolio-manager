import { ethers, JsonRpcProvider } from 'ethers';

export const POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

export const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function name() external view returns (string)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

export const MAX_UINT_128 = 2n ** 128n - 1n;

interface PoolInfo {
  id: string;
  totalValueLockedUSD?: string; // Optional since we might not calculate USD value
  liquidity: string;
  token0: {
    symbol: string;
    decimals: string;
  };
  token1: {
    symbol: string;
    decimals: string;
  };
  token0Price: string;
  token1Price: string;
}

/**
 * Fetch pool information directly from contracts (no subgraph needed)
 * This is the replacement for your subgraph-based fetchPoolInfo function
 */
export async function fetchPoolInfoDirect(
  poolAddress: string,
  provider: JsonRpcProvider,
): Promise<PoolInfo> {
  try {
    //  await debugPoolAddresses();
    const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

    const [token0Address, token1Address, liquidity, slot0] = await Promise.all([
      poolContract.token0(),
      poolContract.token1(),
      poolContract.liquidity(),
      poolContract.slot0(), // Returns [sqrtPriceX96, tick, ...]
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
        token0Contract.symbol(),
        token0Contract.decimals(),
        token1Contract.symbol(),
        token1Contract.decimals(),
      ]);

    const sqrtPriceX96 = slot0[0]; // First element from slot0
    const prices = calculatePricesFromSqrtPrice(
      sqrtPriceX96,
      token0Decimals,
      token1Decimals,
    );

    return {
      id: poolAddress.toLowerCase(),
      liquidity: liquidity.toString(),
      token0: {
        symbol: token0Symbol,
        decimals: token0Decimals.toString(),
      },
      token1: {
        symbol: token1Symbol,
        decimals: token1Decimals.toString(),
      },
      token0Price: prices.token0Price,
      token1Price: prices.token1Price,
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch pool info from contract: ${error.message}`,
    );
  }
}

/**
 * Calculate token prices from Uniswap V3 sqrtPriceX96
 * This replicates the price calculation logic that subgraphs do
 */
function calculatePricesFromSqrtPrice(
  sqrtPriceX96: bigint,
  token0Decimals: number | bigint,
  token1Decimals: number | bigint,
): { token0Price: string; token1Price: string } {
  try {
    // Convert BigInt decimals to regular numbers
    const token0Dec = Number(token0Decimals);
    const token1Dec = Number(token1Decimals);

    // Calculate price = (sqrtPriceX96 / 2^96)^2
    const sqrtPriceX96Number = Number(sqrtPriceX96);
    const Q96 = Math.pow(2, 96);
    const sqrtPrice = sqrtPriceX96Number / Q96;
    const rawPrice = sqrtPrice * sqrtPrice;

    const decimalAdjustment = Math.pow(10, token0Dec - token1Dec);
    console.log(
      'decimalAdjustment (10^(6-18)):',
      decimalAdjustment,
      '= 10^-12',
    );

    const token1PerToken0 = rawPrice * decimalAdjustment;
    const token0PerToken1 = 1 / token1PerToken0;

    return {
      token0Price: token0PerToken1.toString(),
      token1Price: token1PerToken0.toString(),
    };
  } catch (error) {
    console.error('ERROR in calculatePricesFromSqrtPrice:', error);
    return {
      token0Price: '0',
      token1Price: '0',
    };
  }
}
// async function debugPoolAddresses() {
//   try {
//     const provider = new JsonRpcProvider(
//       'https://ethereum-sepolia-rpc.publicnode.com',
//     );
//     const poolAddress = '0x3289680dd4d6c10bb19b899729cda5eef58aeff1';

//     console.log('=== CHECKING CONTRACT EXISTENCE ===');
//     const code = await provider.getCode(poolAddress);
//     console.log('Contract code exists:', code !== '0x');
//     console.log('Code length:', code.length);

//     if (code === '0x') {
//       console.log('No contract found at this address!');
//       console.log('Double-check the pool address from Uniswap UI');
//       return;
//     }

//     const POOL_ABI = [
//       'function token0() external view returns (address)',
//       'function token1() external view returns (address)',
//       'function fee() external view returns (uint24)',
//     ];

//     console.log('\n=== CHECKING UNISWAP INTERFACE URL ===');
//     console.log('Your URL shows:', poolAddress);
//     console.log('Let me verify this is the exact address...');

//     const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

//     console.log('\n=== DEBUGGING POOL TOKENS ===');
//     console.log('Pool Address:', poolAddress);

//     // Get token addresses
//     const [token0Address, token1Address, fee] = await Promise.all([
//       poolContract.token0() as any,
//       poolContract.token1() as any,
//       poolContract.fee() as any,
//     ]);

//     console.log('Fee Tier:', fee, '(', Number(fee) / 10000, '%)');

//     if (token0Address === '0x0000000000000000000000000000000000000000') {
//       console.log('TOKEN0 IS ZERO ADDRESS - This might be native ETH!');
//     }
//     if (token1Address === '0x0000000000000000000000000000000000000000') {
//       console.log('TOKEN1 IS ZERO ADDRESS - This might be native ETH!');
//     }

//     const SEPOLIA_WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
//     if (token0Address.toLowerCase() === SEPOLIA_WETH.toLowerCase()) {
//       console.log('TOKEN0 IS SEPOLIA WETH');
//     }
//     if (token1Address.toLowerCase() === SEPOLIA_WETH.toLowerCase()) {
//       console.log('TOKEN1 IS SEPOLIA WETH');
//     }

//     const [
//       token0Symbol,
//       token0Decimals,
//       token0Name,
//       token1Symbol,
//       token1Decimals,
//       token1Name,
//     ] = await Promise.all([
//       token0Address.symbol(),
//       token0Address.decimals(),
//       token0Address.name(),
//       token1Address.symbol(),
//       token1Address.decimals(),
//       token1Address.name(),
//     ]);

//     console.log('\n=== TOKEN 0 ===');
//     console.log('Address:', token0Address);
//     console.log('Symbol:', token0Symbol);
//     console.log('Name:', token0Name);
//     console.log('Decimals:', token0Decimals);

//     console.log('\n=== TOKEN 1 ===');
//     console.log('Address:', token1Address);
//     console.log('Symbol:', token1Symbol);
//     console.log('Name:', token1Name);
//     console.log('Decimals:', token1Decimals);

//     console.log('\n=== CORRECT CONFIG ===');
//     console.log(`
// sepolia: {
//   chainId: 11155111,
//   poolAddress: '${poolAddress}',
//   positionManagerAddress: '0x1238536071E1c677A632429e3655c799b22cDA52',
//   hasSubgraph: false,
//   tokens: {
//     token0: {
//       address: '${token0Address}',
//       decimals: ${token0Decimals},
//       symbol: '${token0Symbol}',
//       name: '${token0Name}',
//       ${token0Symbol === 'WETH' ? 'isNative: true,' : ''}
//     },
//     token1: {
//       address: '${token1Address}',
//       decimals: ${token1Decimals},
//       symbol: '${token1Symbol}',
//       name: '${token1Name}',
//       ${token1Symbol === 'WETH' ? 'isNative: true,' : ''}
//     },
//   },
// },`);
//   } catch (error) {
//     console.error('Error debugging pool:', error.message);
//   }
// }
