import 'dotenv/config';

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
  uniswap: {
    positionId: string;
  };
  ethereum: {
    rpcUrl: string;
    privateKey: string;
    contracts: {
      uniswapPositionManager: string;
    };
  };
  sepolia: {
    rpcUrl: string;
    privateKey: string;
    contracts: {
      uniswapPositionManager: string;
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
  uniswap: {
    positionId: process.env.UNISWAP_POSITION_ID || '1016832',
  },
  ethereum: {
    rpcUrl: process.env.ETH_RPC_URL || '',
    privateKey: process.env.PRIVATE_KEY || '',
    contracts: {
      uniswapPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    },
  },
  sepolia: {
    rpcUrl: process.env.SEPOLIA_RPC_URL || '',
    privateKey: process.env.PRIVATE_KEY || '',
    contracts: {
      uniswapPositionManager: '0x1238536071E1c677A632429e3655c799b22cDA52',
    },
  },
  base: {
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    chainId: 8453,
    privateKey: process.env.PRIVATE_KEY,
    contracts: {
      factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
      positionManager: '0x827922686190790b37229fd06084350E74485b72',
      pools: ['0x3e66e55e97ce60096f74b7C475e8249f2D31a9fb'], // 0: default
    },
  },
  hyperliquid: {
    privateKey: process.env.HL_KEY || '',
  },
});
