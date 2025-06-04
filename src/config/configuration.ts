export interface Config {
  port: number;
  walletAddress: string;
  ethereum: {
    rpcUrl: string;
    privateKey: string;
    contracts: {
      uniswapPositionManager: string;
    };
  };
  hyperliquid: {
    privateKey: string;
  };
}

export default (): Config => ({
  port: parseInt(process.env.PORT || '3000', 10),
  walletAddress: process.env.WALLET_ADDRESS || '',
  ethereum: {
    rpcUrl: process.env.ETH_RPC_URL || '',
    privateKey: process.env.PRIVATE_KEY || '',
    contracts: {
      uniswapPositionManager: process.env.UNISWAP_POSITION_MANAGER_ADDRESS || '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    },
  },
  hyperliquid: {
    privateKey: process.env.HL_KEY || '',
  },
}); 