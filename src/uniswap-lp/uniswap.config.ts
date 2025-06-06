export interface UniswapNetworkConfig {
  chainId: number;
  poolAddress: string;
  factoryAddress: string;
  hasSubgraph: boolean;
  subgraphUrl?: string;
  tokens: {
    token0: {
      address: string;
      decimals: number;
      symbol: string;
      name: string;
      isNative?: boolean;
    };
    token1: {
      address: string;
      decimals: number;
      symbol: string;
      name: string;
      isNative?: boolean;
    };
  };
}

export const UNISWAP_CONFIGS = {
  ethereum: {
    chainId: 1,
    poolAddress: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35',
    factoryAddress: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    hasSubgraph: true,
    subgraphUrl: '',
    tokens: {
      token0: {
        address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        decimals: 8,
        symbol: 'WBTC',
        name: 'Wrapped BTC',
      },
      token1: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin',
      },
    },
  },

  sepolia: {
    chainId: 11155111,
    poolAddress: '0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1', // Test pool
    factoryAddress: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
    hasSubgraph: false,
    tokens: {
      token0: {
        address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Test USDC
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin',
      },
      token1: {
        address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // Sepolia WETH
        decimals: 18,
        symbol: 'WETH',
        name: 'Wrapped Ether',
      },
    },
  },
} as const;

export type UniswapNetworkName = keyof typeof UNISWAP_CONFIGS;

export function getUniswapConfig(
  networkName: UniswapNetworkName,
): UniswapNetworkConfig {
  const config = UNISWAP_CONFIGS[networkName];
  if (!config) {
    throw new Error(
      `Uniswap configuration not found for network: ${networkName}`,
    );
  }
  return config;
}
