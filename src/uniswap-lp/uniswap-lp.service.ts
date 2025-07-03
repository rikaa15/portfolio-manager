import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { 
  Token, 
  CurrencyAmount, 
  Percent, 
  TradeType
} from '@uniswap/sdk-core';
import { 
  Pool,
  computePoolAddress,
  nearestUsableTick,
  TickMath,
  Position,
  SwapRouter,
  Trade
} from '@uniswap/v3-sdk';
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json';
import { abi as SwapRouterABI } from '@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json';
import { abi as QuoterABI } from '@uniswap/v3-periphery/artifacts/contracts/lens/Quoter.sol/Quoter.json';
import {
  LiquidityPosition,
  AddLiquidityParams,
  RemoveLiquidityParams,
  CollectFeesParams,
  SwapQuoteParams,
  SwapQuoteResult,
  SwapExecuteParams,
  SwapExecuteResult,
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
import Decimal from 'decimal.js';

@Injectable()
export class UniswapLpService {
  private readonly logger = new Logger(UniswapLpService.name);
  private provider: JsonRpcProvider;
  private signer: Wallet;
  private nfpmContract: ethers.Contract & any;
  private swapRouterContract: ethers.Contract;
  private quoterContract: ethers.Contract;
  private uniswapConfig: UniswapNetworkConfig;
  private currentNetwork: UniswapNetworkName;
  private uniswapPositionManagerAddress: string;
  private swapRouterAddress: string;
  private quoterAddress: string;

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
    this.swapRouterAddress = networkConfig.contracts.swapRouter;
    this.quoterAddress = networkConfig.contracts.quoter;

    // Initialize provider and signer
    this.provider = new JsonRpcProvider(rpcUrl);
    this.signer = new Wallet(privateKey, this.provider);

    // Initialize Uniswap position manager contract
    this.nfpmContract = new ethers.Contract(
      this.uniswapPositionManagerAddress,
      NonfungiblePositionManagerABI,
      this.provider,
    );

    // Initialize swap contracts
    this.swapRouterContract = new ethers.Contract(
      this.swapRouterAddress,
      SwapRouterABI,
      this.signer
    );

    this.quoterContract = new ethers.Contract(
      this.quoterAddress,
      QuoterABI,
      this.provider
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
      if (this.currentNetwork === 'ethereum') {
        // await this.getWbtcUsdcPosition('1006358');
      } else {
        this.logger.log(
          `Skipping position check for ${this.currentNetwork} network`,
        );
      }
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
      return tx.hash;
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
      return tx.hash;
    } catch (error) {
      this.logger.error(`Failed to collect fees: ${error.message}`);
      throw error;
    }
  }

  async closeLPPosition(recipient: string, params: RemoveLiquidityParams): Promise<void> {
    try {
      await this.removeLiquidity(params)
      await this.collectFees({
        tokenId: params.tokenId,
        recipient: recipient,
        amount0Max: ethers.MaxUint256,
        amount1Max: ethers.MaxUint256,
      })
      this.logger.log(`LP position closed successfully`);
    } catch (error) {
      this.logger.error(`Failed to close LP position: ${error.message}`);
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
    startDate: string,
    endDate: string,
    interval: 'daily' | 'hourly' = 'daily',
    poolAddress = this.uniswapConfig.poolAddress,
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

  async getWbtcUsdcPosition(tokenId: string): Promise<void> {
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

  async estimateCollectFees(params: {
    tokenId: string;
    recipient: string;
    amount0Max: bigint;
    amount1Max: bigint;
  }): Promise<{
    gasEstimate: bigint;
    gasPrice: bigint;
    estimatedCostInUsd: number;
  }> {
    const { tokenId, recipient, amount0Max, amount1Max } = params;

    try {
      // Get current gas price
      const gasPrice = await this.provider.getFeeData();
      if (!gasPrice.gasPrice) {
        throw new Error('Failed to get gas price');
      }

      // Estimate gas for collect operation
      const gasEstimate = await this.nfpmContract.collect.estimateGas({
        tokenId,
        recipient,
        amount0Max,
        amount1Max,
      });

      // Calculate estimated cost in USD
      // Assuming average gas price of 20 gwei and ETH price of $2000
      const estimatedCostInEth = new Decimal((gasEstimate * gasPrice.gasPrice).toString())
      .div(ethers.parseEther('1').toString())
      .toNumber();
      const estimatedCostInUsd = estimatedCostInEth * 2000; // TODO: Get real ETH price

      return {
        gasEstimate,
        gasPrice: gasPrice.gasPrice,
        estimatedCostInUsd,
      };
    } catch (error) {
      this.logger.error(`Error estimating collect fees gas: ${error.message}`);
      throw error;
    }
  }

  /**
   * Quote a swap using Uniswap V3 Quoter contract
   */
  async quoteSwap(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    try {
      this.logger.log(`Quoting swap: ${params.amountIn} ${params.tokenIn.symbol} -> ${params.tokenOut.symbol}`);

      // Convert amount to raw format
      const amountInRaw = ethers.parseUnits(params.amountIn, params.tokenIn.decimals);

      // Quote using Quoter contract
      const quotedAmountOut = await this.quoterContract.quoteExactInputSingle.staticCall(
        params.tokenIn.address,
        params.tokenOut.address,
        params.fee,
        amountInRaw.toString(),
        0 // sqrtPriceLimitX96
      );

      // Calculate price impact (simplified)
      const amountInValue = parseFloat(params.amountIn) * (await this.getTokenPrice(params.tokenIn.address));
      const amountOutValue = parseFloat(ethers.formatUnits(quotedAmountOut, params.tokenOut.decimals)) * 
                           (await this.getTokenPrice(params.tokenOut.address));
      const priceImpact = ((amountInValue - amountOutValue) / amountInValue) * 100;

      // Calculate minimum amount out with slippage
      const slippagePercent = new Percent(params.slippageTolerance * 100, 100);
      const amountOutMin = quotedAmountOut * BigInt(100 - params.slippageTolerance * 100) / BigInt(100);

      // Estimate gas
      const gasEstimate = await this.swapRouterContract.exactInputSingle.estimateGas({
        tokenIn: params.tokenIn.address,
        tokenOut: params.tokenOut.address,
        fee: params.fee,
        recipient: await this.signer.getAddress(),
        deadline: params.deadline || Math.floor(Date.now() / 1000) + 1800, // 30 minutes
        amountIn: amountInRaw.toString(),
        amountOutMinimum: amountOutMin.toString(),
        sqrtPriceLimitX96: 0,
      });

      const gasPrice = await this.provider.getFeeData();
      const estimatedCostInUsd = this.estimateGasCostInUsd(gasEstimate, gasPrice.gasPrice);

      return {
        amountIn: params.amountIn,
        amountOut: ethers.formatUnits(quotedAmountOut, params.tokenOut.decimals),
        amountOutMin: ethers.formatUnits(amountOutMin, params.tokenOut.decimals),
        priceImpact,
        gasEstimate,
        gasPrice: gasPrice.gasPrice,
        estimatedCostInUsd,
        route: {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.fee,
        },
      };
    } catch (error) {
      this.logger.error(`Error quoting swap: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute a swap using Uniswap V3 SwapRouter
   */
  async executeSwap(params: SwapExecuteParams): Promise<SwapExecuteResult> {
    try {
      this.logger.log(`Executing swap: ${params.amountIn} ${params.tokenIn.symbol} -> ${params.tokenOut.symbol}`);

      // Convert amounts to raw format
      const amountInRaw = ethers.parseUnits(params.amountIn, params.tokenIn.decimals);
      const amountOutMinRaw = ethers.parseUnits(params.amountOutMin, params.tokenOut.decimals);

      // Approve token spending
      await this.approveToken(params.tokenIn.address, amountInRaw);

      // Prepare swap parameters
      const swapParams = {
        tokenIn: params.tokenIn.address,
        tokenOut: params.tokenOut.address,
        fee: params.fee,
        recipient: params.recipient || await this.signer.getAddress(),
        deadline: params.deadline || Math.floor(Date.now() / 1000) + 1800, // 30 minutes
        amountIn: amountInRaw.toString(),
        amountOutMinimum: amountOutMinRaw.toString(),
        sqrtPriceLimitX96: 0,
      };

      // Execute swap
      const tx = await this.swapRouterContract.exactInputSingle(swapParams);
      const receipt = await tx.wait();

      // Calculate actual amounts
      const actualAmountIn = ethers.formatUnits(amountInRaw, params.tokenIn.decimals);
      const actualAmountOut = ethers.formatUnits(amountOutMinRaw, params.tokenOut.decimals);

      // Calculate gas costs
      const gasUsed = receipt.gasUsed;
      const effectiveGasPrice = receipt.effectiveGasPrice;
      const totalCostInUsd = this.estimateGasCostInUsd(gasUsed, effectiveGasPrice);

      this.logger.log(`Swap executed successfully: ${actualAmountIn} ${params.tokenIn.symbol} -> ${actualAmountOut} ${params.tokenOut.symbol}`);
      this.logger.log(`Transaction hash: ${receipt.hash}`);

      return {
        transactionHash: receipt.hash,
        amountIn: actualAmountIn,
        amountOut: actualAmountOut,
        gasUsed,
        gasPrice: effectiveGasPrice,
        effectiveGasPrice,
        totalCostInUsd,
      };
    } catch (error) {
      this.logger.error(`Error executing swap: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get token price in USD (simplified - you may want to use a price oracle)
   */
  private async getTokenPrice(tokenAddress: string): Promise<number> {
    // This is a simplified implementation
    // In production, you should use a proper price oracle like Chainlink or CoinGecko
    const tokenConfig = this.uniswapConfig.tokens;
    
    if (tokenAddress.toLowerCase() === tokenConfig.token0.address.toLowerCase()) {
      // For WBTC, you might want to get real price from an oracle
      return 50000; // Placeholder price
    } else if (tokenAddress.toLowerCase() === tokenConfig.token1.address.toLowerCase()) {
      // USDC is pegged to $1
      return 1;
    }
    
    // For other tokens, you'd need to implement proper price fetching
    return 1;
  }

  /**
   * Estimate gas cost in USD
   */
  private estimateGasCostInUsd(gasUsed: bigint, gasPrice: bigint): number {
    const gasCostInWei = gasUsed * gasPrice;
    const gasCostInEth = parseFloat(ethers.formatEther(gasCostInWei));
    
    // Get ETH price (you might want to fetch this dynamically)
    const ethPrice = 3000; // Placeholder price
    
    return gasCostInEth * ethPrice;
  }

  /**
   * Rebalance LP position using swaps
   */
  async rebalancePosition(
    tokenId: string,
    targetRatio: number = 0.5, // Target 50/50 ratio
    maxSlippage: number = 0.005 // 0.5% max slippage
  ): Promise<void> {
    try {
      this.logger.log(`Rebalancing position ${tokenId} to ${targetRatio * 100}% ratio`);

      // Get current position
      const position = await this.getPosition(tokenId);
      
      // Calculate current amounts and values
      const wbtcAmount = parseFloat(ethers.formatUnits(position.token0BalanceRaw, position.token0.decimals));
      const usdcAmount = parseFloat(ethers.formatUnits(position.token1BalanceRaw, position.token1.decimals));
      
      // Get current prices
      const wbtcPrice = await this.getTokenPrice(position.token0.address);
      const wbtcValue = wbtcAmount * wbtcPrice;
      const usdcValue = usdcAmount;
      const totalValue = wbtcValue + usdcValue;
      
      // Calculate current ratio
      const currentRatio = wbtcValue / totalValue;
      
      // Calculate target amounts
      const targetWbtcValue = totalValue * targetRatio;
      const targetUsdcValue = totalValue * (1 - targetRatio);
      
      // Determine which token to swap
      if (currentRatio > targetRatio) {
        // Too much WBTC, need to swap WBTC for USDC
        const wbtcToSwap = (wbtcValue - targetWbtcValue) / wbtcPrice;
        
        if (wbtcToSwap > 0.001) { // Minimum swap amount
          this.logger.log(`Swapping ${wbtcToSwap.toFixed(6)} WBTC for USDC`);
          
          const quote = await this.quoteSwap({
            tokenIn: position.token0,
            tokenOut: position.token1,
            amountIn: wbtcToSwap.toString(),
            fee: Number(position.fee),
            slippageTolerance: maxSlippage,
          });
          
          await this.executeSwap({
            tokenIn: position.token0,
            tokenOut: position.token1,
            amountIn: wbtcToSwap.toString(),
            amountOutMin: quote.amountOutMin,
            fee: Number(position.fee),
            slippageTolerance: maxSlippage,
          });
        }
      } else if (currentRatio < targetRatio) {
        // Too much USDC, need to swap USDC for WBTC
        const usdcToSwap = usdcValue - targetUsdcValue;
        
        if (usdcToSwap > 1) { // Minimum swap amount
          this.logger.log(`Swapping ${usdcToSwap.toFixed(2)} USDC for WBTC`);
          
          const quote = await this.quoteSwap({
            tokenIn: position.token1,
            tokenOut: position.token0,
            amountIn: usdcToSwap.toString(),
            fee: Number(position.fee),
            slippageTolerance: maxSlippage,
          });
          
          await this.executeSwap({
            tokenIn: position.token1,
            tokenOut: position.token0,
            amountIn: usdcToSwap.toString(),
            amountOutMin: quote.amountOutMin,
            fee: Number(position.fee),
            slippageTolerance: maxSlippage,
          });
        }
      } else {
        this.logger.log('Position already balanced');
      }
    } catch (error) {
      this.logger.error(`Error rebalancing position: ${error.message}`);
      throw error;
    }
  }
}

// async function main() {
//   try {
//     console.log('Testing getPosition method...');
//     // Initialize configuration
//     const config = configuration();
//     const configService = new ConfigService<Config>(config);

//     // Create uniswap service instance
//     const uniswapService = new UniswapLpService(configService);
//     await uniswapService.bootstrap();

//     const tokenId = '1004042'; // '1006358';
//     console.log(`Calling getPosition with token ID: ${tokenId}`);

//     const position = await uniswapService.getPosition(tokenId);

//     console.log('Position retrieved successfully:');
//     console.log({ position });
//   } catch (error) {
//     console.error(`Test failed: ${error.message}`);
//     throw error;
//   }
// }

// if (require.main === module) {
//   main().catch(console.error);
// }
