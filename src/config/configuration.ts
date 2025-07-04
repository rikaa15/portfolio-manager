import 'dotenv/config';

function getBooleanEnv(key: string, defaultValue: boolean): boolean {
  return typeof process.env[key] === 'string'
  ? process.env[key] === 'true'
  : defaultValue;
}

export interface BaseConfig {
  rpcUrl: string;
  chainId: number;
  privateKey: string;
  contracts: {
    factory: string;
    positionManager: string;
    pools: string[];
  };
}
export interface Config {
  port: number;
  walletAddress: string;
  lpProvider: 'uniswap' | 'aerodrome';
  strategy: {
    lpRebalanceEnabled: boolean;
    hedgeEnabled: boolean;
    lpTargetPositionValue: number;
    lpRebalanceRange: number;
  };
  uniswap: {
    positionId: string;
    positionCreationDate: string;
  };
  aerodrome: {
    poolAddress: string;
    gaugeAddress: string;
  };
  ethereum: {
    rpcUrl: string;
    privateKey: string;
    contracts: {
      uniswapPositionManager: string;
      swapRouter: string;
      quoter: string;
    };
  };
  sepolia: {
    rpcUrl: string;
    privateKey: string;
    contracts: {
      uniswapPositionManager: string;
      swapRouter: string;
      quoter: string;
    };
  };
  base: BaseConfig;
  hyperliquid: {
    privateKey: string;
  };
}

export default (): Config => ({
  port: parseInt(process.env.PORT || '3000', 10),
  walletAddress: process.env.WALLET_ADDRESS || '',
  strategy: {
    lpRebalanceEnabled: getBooleanEnv('LP_REBALANCING_ENABLED', true),
    hedgeEnabled: getBooleanEnv('HEDGE_ENABLED', false),
    lpTargetPositionValue: parseFloat(process.env.LP_TARGET_POSITION_VALUE || '30'),
    lpRebalanceRange: parseFloat(process.env.LP_REBALANCE_RANGE || '0.05'),
  },
  lpProvider: (process.env.LP_PROVIDER as 'uniswap' | 'aerodrome') || 'uniswap',
  uniswap: {
    positionId: process.env.UNISWAP_POSITION_ID || '1025094',
    positionCreationDate: process.env.UNISWAP_POSITION_CREATION_DATE || '2025-07-04',
  },
  aerodrome: {
    poolAddress: process.env.AERODROME_POOL_ADDRESS || '',
    gaugeAddress: process.env.AERODROME_GAUGE_ADDRESS || '',
  },
  ethereum: {
    rpcUrl: process.env.ETH_RPC_URL || '',
    privateKey: process.env.PRIVATE_KEY || '',
    contracts: {
      uniswapPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    },
  },
  sepolia: {
    rpcUrl: process.env.SEPOLIA_RPC_URL || '',
    privateKey: process.env.PRIVATE_KEY || '',
    contracts: {
      uniswapPositionManager: '0x1238536071E1c677A632429e3655c799b22cDA52',
      swapRouter: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
      quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
    },
  },
  base: {
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    chainId: 8453,
    privateKey: process.env.PRIVATE_KEY,
    contracts: {
      factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
      positionManager: '0x827922686190790b37229fd06084350E74485b72',
      pools: [
        process.env.AERODROME_POOL_ADDRESS, // User's specific pool from env
        '0x3e66e55e97ce60096f74b7C475e8249f2D31a9fb', // cbBTC/USDC (volatile)
        '0x1F40e42E92Cd3dDEC8Ac7d950A4E15378a0A7d8e', // WETH/USDC (volatile) 
        '0x0b1A513ee24972DAEf112bC777a5610d4325C9e7', // cbBTC/WBTC (stable)
      ].filter(Boolean).filter((pool, index, arr) => arr.indexOf(pool) === index), // Remove duplicates and empty values
    },
  },
  hyperliquid: {
    privateKey: process.env.HL_KEY || '',
  },
});
