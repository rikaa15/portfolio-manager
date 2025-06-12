import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { Token } from '@uniswap/sdk-core';
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json';
import {
  LiquidityPosition,
  AddLiquidityParams,
  RemoveLiquidityParams,
  CollectFeesParams,
} from './types';
import configuration, { Config } from '../config/configuration';
import {
  calculateTokenAmounts,
  formatPositionAmounts,
  getPoolPriceHistory,
} from './uniswap-lp.utils';
// import { fetchCurrentPoolData, fetchPoolInfo } from './subgraph.client';
import {
  ERC20_ABI,
  fetchPoolInfoDirect,
  MAX_UINT_128,
  POOL_ABI,
} from './contract.client';
import {
  UNISWAP_CONFIGS,
  UniswapNetworkConfig,
  UniswapNetworkName,
} from './uniswap.config';

@Injectable()
export class UniswapLpService {
  private readonly logger = new Logger(UniswapLpService.name);
  private provider: JsonRpcProvider;
  private signer: Wallet;
  private nfpmContract: ethers.Contract & any;
  private uniswapConfig: UniswapNetworkConfig;
  private currentNetwork: UniswapNetworkName;
  private uniswapPositionManagerAddress: string;

  constructor(private readonly configService: ConfigService<Config>) {
    this.initializeNetwork('ethereum');
  }

  private initializeNetwork(networkName: UniswapNetworkName): void {
    this.uniswapConfig = UNISWAP_CONFIGS[networkName];
    this.currentNetwork = networkName;

    const config = configuration();
    const networkConfig = config[networkName as keyof typeof config] as any;

    // Validate that the config exists
    if (!this.uniswapConfig) {
      throw new Error(
        `Uniswap configuration not found for network: ${networkName}`,
      );
    }

    const rpcUrl = networkConfig.rpcUrl;

    const privateKey = networkConfig.privateKey;

    if (!privateKey) {
      throw new Error(
        `Uniswap private key not configured ${privateKey} dsfdsfs`,
      );
    }

    this.uniswapPositionManagerAddress =
      networkConfig.contracts.uniswapPositionManager;

    // Initialize provider and signer
    this.provider = new JsonRpcProvider(rpcUrl);
    this.signer = new Wallet(privateKey, this.provider);

    // Initialize Uniswap position manager contract
    this.nfpmContract = new ethers.Contract(
      this.uniswapPositionManagerAddress,
      NonfungiblePositionManagerABI,
      this.provider,
    );

    this.logger.log(
      `Initialized Uniswap service on ${networkName} - Pool: ${this.uniswapConfig.poolAddress}`,
    );
    this.logger.log(
      `Tokens: ${this.uniswapConfig.tokens.token0.symbol}/${this.uniswapConfig.tokens.token1.symbol}`,
    );
  }

  setNetwork(networkName: UniswapNetworkName): void {
    this.logger.log(`Switching Uniswap service to ${networkName}...`);
    this.initializeNetwork(networkName);
    this.logger.log(`Successfully switched to ${networkName}`);
  }

  getCurrentNetwork(): {
    name: UniswapNetworkName;
    config: UniswapNetworkConfig;
  } {
    return {
      name: this.currentNetwork,
      config: this.uniswapConfig,
    };
  }

  async bootstrap(): Promise<void> {
    try {
      this.logger.log('Initializing UniswapLpService...');

      // Test connection to provider
      const network = await this.provider.getNetwork();
      this.logger.log(
        `Connected to network: ${network.name} (chainId: ${network.chainId})`,
      );

      if (Number(network.chainId) !== this.uniswapConfig.chainId) {
        this.logger.warn(
          `Network mismatch: RPC chainId ${network.chainId} != Uniswap config chainId ${this.uniswapConfig.chainId}`,
        );
      }

      // Test signer
      const address = await this.signer.getAddress();
      const balance = await this.provider.getBalance(address);
      this.logger.log(`Signer address: ${address}`);
      this.logger.log(`Signer balance: ${ethers.formatEther(balance)} ETH`);

      // Only call position check on mainnet
      // if (this.currentNetwork === 'ethereum') {
      //   await this.getWbtcUsdcPosition();
      // } else {
      //   this.logger.log(
      //     `Skipping position check for ${this.currentNetwork} network`,
      //   );
      // }

      this.logger.log('UniswapLpService initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize UniswapLpService: ${error.message}`,
      );
      throw error;
    }
  }

  async getEarnedFees(
    tokenId: number,
    poolAddress?: string,
  ): Promise<{
    token0Fees: string;
    token1Fees: string;
    token0Symbol: string;
    token1Symbol: string;
  }> {
    try {
      const targetPoolAddress = poolAddress || this.uniswapConfig.poolAddress;

      const poolInfo = await fetchPoolInfoDirect(
        targetPoolAddress,
        this.provider,
      );
      // this.uniswapConfig.hasSubgraph
      //   ? await fetchPoolInfo(targetPoolAddress)
      //   : await fetchPoolInfoDirect(targetPoolAddress, this.provider);

      const contract = new ethers.Contract(
        this.uniswapPositionManagerAddress,
        NonfungiblePositionManagerABI,
        this.provider,
      );

      const collectParams = {
        tokenId: tokenId,
        recipient: ethers.ZeroAddress,
        amount0Max: MAX_UINT_128,
        amount1Max: MAX_UINT_128,
      };

      const result = await contract.collect.staticCall(collectParams);

      const token0Decimals = parseInt(poolInfo.token0.decimals);
      const token1Decimals = parseInt(poolInfo.token1.decimals);

      const token0Fees = ethers.formatUnits(result.amount0, token0Decimals);
      const token1Fees = ethers.formatUnits(result.amount1, token1Decimals);

      this.logger.log(
        `Uncollected fees - ${poolInfo.token0.symbol}: ${token0Fees}, ${poolInfo.token1.symbol}: ${token1Fees}`,
      );

      return {
        token0Fees,
        token1Fees,
        token0Symbol: poolInfo.token0.symbol,
        token1Symbol: poolInfo.token1.symbol,
      };
    } catch (error) {
      this.logger.error('Error getting earned fees:', error.message);
      throw error;
    }
  }

  private async approveToken(
    tokenAddress: string,
    amount: bigint,
  ): Promise<void> {
    try {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ERC20_ABI,
        this.signer,
      );

      const currentAllowance = await tokenContract.allowance(
        await this.signer.getAddress(),
        this.uniswapPositionManagerAddress,
      );

      if (currentAllowance < amount) {
        this.logger.log(
          `Approving ${tokenAddress} for ${amount.toString()} tokens...`,
        );

        const approveTx = await tokenContract.approve(
          this.uniswapPositionManagerAddress,
          ethers.MaxUint256,
        );

        await approveTx.wait();
        this.logger.log(`Token approval confirmed: ${approveTx.hash}`);
      } else {
        this.logger.log(
          `Token ${tokenAddress} already has sufficient allowance`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to approve token ${tokenAddress}: ${error.message}`,
      );
      throw error;
    }
  }

  async getPositionsByOwner(ownerAddress: string): Promise<string[]> {
    try {
      // Get number of positions
      const numPositions = await this.nfpmContract.balanceOf(ownerAddress);

      // Fetch all position IDs
      const calls = [];
      for (let i = 0; i < numPositions; i++) {
        calls.push(this.nfpmContract.tokenOfOwnerByIndex(ownerAddress, i));
      }

      const positionIds = await Promise.all(calls);
      return positionIds.map((id) => id.toString());
    } catch (error) {
      this.logger.error(
        `Failed to get positions for owner ${ownerAddress}: ${error.message}`,
      );
      throw error;
    }
  }

  async getPosition(tokenId: string): Promise<LiquidityPosition> {
    try {
      const position = await this.nfpmContract.positions(tokenId);

      // Fetch token information from contracts
      const token0Contract = new ethers.Contract(
        position.token0,
        ERC20_ABI,
        this.provider,
      );
      const token1Contract = new ethers.Contract(
        position.token1,
        ERC20_ABI,
        this.provider,
      );

      const [
        token0Decimals,
        token0Symbol,
        token0Name,
        token1Decimals,
        token1Symbol,
        token1Name,
      ] = await Promise.all([
        token0Contract.decimals(),
        token0Contract.symbol(),
        token0Contract.name(),
        token1Contract.decimals(),
        token1Contract.symbol(),
        token1Contract.name(),
      ]);

      let token0Amount = '0';
      let token1Amount = '0';

      if (position.liquidity > 0n) {
        try {
          const poolContract = new ethers.Contract(
            this.uniswapConfig.poolAddress,
            POOL_ABI,
            this.provider,
          );
          const slot0 = await poolContract.slot0();
          const currentTick = slot0.tick;

          const { amount0, amount1 } = calculateTokenAmounts(
            position.liquidity,
            position.tickLower,
            position.tickUpper,
            Number(currentTick),
          );

          token0Amount = amount0.toString();
          token1Amount = amount1.toString();
        } catch (error) {
          this.logger.warn(
            `Could not calculate token amounts from liquidity: ${error.message}`,
          );
        }
      } else {
        this.logger.log('Position has 0 liquidity (closed position)');
      }

      const uncollectedFees0 = position.tokensOwed0.toString();
      const uncollectedFees1 = position.tokensOwed1.toString();

      const formattedAmounts = formatPositionAmounts(
        token0Amount,
        token1Amount,
        uncollectedFees0,
        uncollectedFees1,
        Number(token0Decimals),
        Number(token1Decimals),
        token0Symbol,
        token1Symbol,
      );

      this.logger.log('=== POSITION SUMMARY ===');
      this.logger.log(`Position ID: ${tokenId}`);
      this.logger.log(
        `Liquidity: ${formattedAmounts.token0Balance} + ${formattedAmounts.token1Balance}`,
      );
      this.logger.log(
        `Uncollected fees: ${formattedAmounts.uncollectedFees0} + ${formattedAmounts.uncollectedFees1}`,
      );

      return {
        tokenId,
        token0: new Token(
          this.uniswapConfig.chainId,
          position.token0,
          Number(token0Decimals),
          token0Symbol,
          token0Name,
        ),
        token1: new Token(
          this.uniswapConfig.chainId,
          position.token1,
          Number(token1Decimals),
          token1Symbol,
          token1Name,
        ),
        fee: position.fee,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity.toString(),
        token0BalanceRaw: token0Amount,
        token1BalanceRaw: token1Amount,
        uncollectedFees0Raw: uncollectedFees0,
        uncollectedFees1Raw: uncollectedFees1,
        token0Balance: formattedAmounts.token0Balance,
        token1Balance: formattedAmounts.token1Balance,
        uncollectedFees0: formattedAmounts.uncollectedFees0,
        uncollectedFees1: formattedAmounts.uncollectedFees1,
        feeGrowthInside0LastX128: position.feeGrowthInside0LastX128.toString(),
        feeGrowthInside1LastX128: position.feeGrowthInside1LastX128.toString(),
      };
    } catch (error) {
      this.logger.error(`Failed to get position ${tokenId}: ${error.message}`);
      throw error;
    }
  }

  async addLiquidity(params: AddLiquidityParams): Promise<string> {
    try {
      this.logger.log('Approving tokens for liquidity addition...');

      await Promise.all([
        this.approveToken(params.token0.address, BigInt(params.amount0Desired)),
        this.approveToken(params.token1.address, BigInt(params.amount1Desired)),
      ]);

      const tx = await this.nfpmContract.connect(this.signer).mint({
        token0: params.token0.address,
        token1: params.token1.address,
        fee: params.fee,
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        amount0Desired: params.amount0Desired,
        amount1Desired: params.amount1Desired,
        amount0Min: params.amount0Min,
        amount1Min: params.amount1Min,
        recipient: params.recipient,
        deadline: params.deadline,
      });

      const receipt = await tx.wait();
      let tokenId: string | undefined;

      for (const log of receipt.logs) {
        try {
          const parsed = this.nfpmContract.interface.parseLog(log);
          if (
            parsed &&
            (parsed.name === 'Transfer' || parsed.name === 'IncreaseLiquidity')
          ) {
            if (parsed.args.tokenId) {
              tokenId = parsed.args.tokenId.toString();
              break;
            }
          }
        } catch {
          // Skip logs that can't be parsed
          continue;
        }
      }

      if (!tokenId) {
        throw new Error('Could not find token ID in transaction receipt');
      }

      this.logger.log(`Liquidity added successfully. Token ID: ${tokenId}`);
      return tokenId;
    } catch (error) {
      this.logger.error(`Failed to add liquidity: ${error.message}`);
      throw error;
    }
  }

  async removeLiquidity(params: RemoveLiquidityParams): Promise<void> {
    try {
      const tx = await this.nfpmContract
        .connect(this.signer)
        .decreaseLiquidity({
          tokenId: params.tokenId,
          liquidity: params.liquidity,
          amount0Min: params.amount0Min,
          amount1Min: params.amount1Min,
          deadline: params.deadline,
        });

      await tx.wait();
      this.logger.log(
        `Liquidity decreased successfully. Transaction: ${tx.hash}`,
      );
    } catch (error) {
      this.logger.error(`Failed to remove liquidity: ${error.message}`);
      throw error;
    }
  }

  async collectFees(params: CollectFeesParams): Promise<void> {
    try {
      const tx = await this.nfpmContract.connect(this.signer).collect({
        tokenId: params.tokenId,
        recipient: params.recipient,
        amount0Max: params.amount0Max,
        amount1Max: params.amount1Max,
      });

      await tx.wait();
    } catch (error) {
      this.logger.error(`Failed to collect fees: ${error.message}`);
      throw error;
    }
  }

  async getPoolPrice(poolAddress?: string): Promise<{
    token0ToToken1Rate: number;
    token1ToToken0Rate: number;
    token0Symbol: string;
    token1Symbol: string;
    formattedPrice: string;
  }> {
    try {
      const targetPoolAddress = poolAddress || this.uniswapConfig.poolAddress;

      this.logger.log(`Getting pool price for ${targetPoolAddress}`);

      // Use the same hybrid approach as getEarnedFees
      const poolData = await fetchPoolInfoDirect(
        targetPoolAddress,
        this.provider,
      );
      //  this.uniswapConfig.hasSubgraph
      //   ? await fetchCurrentPoolData(targetPoolAddress)
      //   : await fetchPoolInfoDirect(targetPoolAddress, this.provider);

      const token0Price = parseFloat(poolData.token0Price); // token0 per token1
      const token1Price = parseFloat(poolData.token1Price); // token1 per token0

      const token0ToToken1Rate = token1Price; // How much token1 for 1 token0
      const token1ToToken0Rate = token0Price; // How much token0 for 1 token1

      let formattedPrice: string;

      if (token1ToToken0Rate > token0ToToken1Rate) {
        // token1 is more valuable (like WETH > USDC)
        formattedPrice = `1 ${poolData.token1.symbol} = ${token1ToToken0Rate.toLocaleString()} ${poolData.token0.symbol}`;
      } else {
        // token0 is more valuable (like WBTC > USDC)
        formattedPrice = `1 ${poolData.token0.symbol} = ${token0ToToken1Rate.toLocaleString()} ${poolData.token1.symbol}`;
      }

      return {
        token0ToToken1Rate,
        token1ToToken0Rate,
        token0Symbol: poolData.token0.symbol,
        token1Symbol: poolData.token1.symbol,
        formattedPrice,
      };
    } catch (error) {
      this.logger.error(`Error getting pool price: ${error.message}`);
      throw error;
    }
  }

  async getPoolPriceHistory(
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
    try {
      this.logger.log(
        `Getting pool price history for ${poolAddress} from ${startDate} to ${endDate} (${interval})`,
      );
      return await getPoolPriceHistory(
        poolAddress,
        startDate,
        endDate,
        interval,
      );
    } catch (error) {
      this.logger.error(
        `Error getting pool price history for ${poolAddress}:`,
        error.message,
      );
      throw error;
    }
  }

  async setupTokenApprovals(tokens: string[]): Promise<void> {
    this.logger.log(
      'Setting up bulk token approvals for better performance...',
    );

    const maxApproval = ethers.MaxUint256;
    const signerAddress = await this.signer.getAddress();

    // Process all tokens in parallel
    const approvalPromises = tokens.map(async (tokenAddress) => {
      try {
        const tokenContract = new ethers.Contract(
          tokenAddress,
          [...ERC20_ABI, 'function decimals() external view returns (uint8)'],
          this.signer,
        );

        const [decimals, currentAllowance] = await Promise.all([
          tokenContract.decimals(),
          tokenContract.allowance(
            signerAddress,
            this.uniswapPositionManagerAddress,
          ),
        ]);

        const needsApproval = currentAllowance === 0n;

        this.logger.log(
          `${tokenAddress} - Current allowance: ${ethers.formatUnits(currentAllowance, decimals)} - Needs approval: ${needsApproval}`,
        );

        if (needsApproval) {
          this.logger.log(
            `Approving ${tokenAddress} (${decimals} decimals)...`,
          );

          const tx = await tokenContract.approve(
            this.uniswapPositionManagerAddress,
            maxApproval,
          );

          await tx.wait();
          this.logger.log(`Approved ${tokenAddress}`);
        } else {
          this.logger.log(`${tokenAddress} already approved`);
        }
      } catch (error) {
        this.logger.warn(`Failed to approve ${tokenAddress}: ${error.message}`);
      }
    });

    await Promise.all(approvalPromises);
    this.logger.log('Bulk approval setup complete');
  }

  async getWbtcUsdcPosition(tokenId: string = '999399'): Promise<void> {
    const token0Symbol = this.uniswapConfig.tokens.token0.symbol;
    const token1Symbol = this.uniswapConfig.tokens.token1.symbol;

    try {
      this.logger.log(
        `Fetching ${token0Symbol}/${token1Symbol} position #${tokenId}...`,
      );

      const position = await this.getPosition(tokenId);
      console.log('position', position);

      const token0Amount = formatUnits(
        position.token0Balance,
        this.uniswapConfig.tokens.token0.decimals,
      );
      const token1Amount = formatUnits(
        position.token1Balance,
        this.uniswapConfig.tokens.token1.decimals,
      );

      // Calculate tick ranges to price
      const tickToPrice = (tick: bigint): number => {
        const tickNumber = Number(tick);
        return 1.0001 ** tickNumber;
      };

      const lowerPrice = tickToPrice(position.tickLower);
      const upperPrice = tickToPrice(position.tickUpper);

      this.logger.log('Position Details:');
      this.logger.log(`Token ID: ${position.tokenId}`);
      this.logger.log(`Fee Tier: ${Number(position.fee) / 10000}%`);
      this.logger.log(
        `Price Range: $${lowerPrice.toFixed(2)} - $${upperPrice.toFixed(2)}`,
      );
      this.logger.log(`${token0Symbol} Amount: ${token0Amount}`);
      this.logger.log(`${token1Symbol} Amount: ${token1Amount}`);
      this.logger.log(`Liquidity: ${position.liquidity}`);

      const token0Fees = formatUnits(
        position.feeGrowthInside0LastX128,
        this.uniswapConfig.tokens.token0.decimals,
      );
      const token1Fees = formatUnits(
        position.feeGrowthInside1LastX128,
        this.uniswapConfig.tokens.token1.decimals,
      );

      this.logger.log(`Uncollected Fees:`);
      this.logger.log(`- ${token0Symbol}: ${token0Fees}`);
      this.logger.log(`- ${token1Symbol}: ${token1Fees}`);
    } catch (error) {
      this.logger.error(
        `Failed to fetch ${token0Symbol}/${token1Symbol} position: ${error.message}`,
      );
      throw error;
    }
  }

  async getSignerAddress(): Promise<string> {
    return this.signer.getAddress();
  }
}

async function main() {
  try {
    console.log('Testing getPosition method...');
    // Initialize configuration
    const config = configuration();
    const configService = new ConfigService<Config>(config);

    // Create uniswap service instance
    const uniswapService = new UniswapLpService(configService);
    await uniswapService.bootstrap();

    const tokenId = '1004042'; // '1006358';
    console.log(`Calling getPosition with token ID: ${tokenId}`);

    const position = await uniswapService.getPosition(tokenId);

    console.log('Position retrieved successfully:');
    console.log({ position });
  } catch (error) {
    console.error(`Test failed: ${error.message}`);
    throw error;
  }
}

if (require.main === module) {
  main().catch(console.error);
}
