import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { Token } from '@uniswap/sdk-core';
import {
  LiquidityPosition,
  AddLiquidityParams,
  RemoveLiquidityParams,
  CollectFeesParams,
} from './types';
import { Config } from '../config/configuration';
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json';
import { getPoolPrice, getPoolPriceHistory } from './uniswap-lp.utils';
import { fetchPoolInfo } from './subgraph.client';

// Token addresses on Ethereum mainnet
// const WBTC_ADDRESS = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
// const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const WBTC_USDC_POOL_ADDRESS = '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35';

const NONFUNGIBLE_POSITION_MANAGER_ADDRESS =
  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

@Injectable()
export class UniswapLpService {
  private readonly logger = new Logger(UniswapLpService.name);
  private readonly provider: JsonRpcProvider;
  private readonly signer: Wallet;
  private readonly nfpmContract: ethers.Contract & any;

  constructor(private readonly configService: ConfigService<Config>) {
    const rpcUrl = this.configService.get('ethereum.rpcUrl', { infer: true });
    const privateKey = this.configService.get('ethereum.privateKey', {
      infer: true,
    });

    this.provider = new JsonRpcProvider(rpcUrl);
    this.signer = new Wallet(privateKey, this.provider);

    // Initialize NFT Position Manager contract
    this.nfpmContract = new ethers.Contract(
      NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
      NonfungiblePositionManagerABI,
      this.provider,
    );
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

      // Check current allowance
      const currentAllowance = await tokenContract.allowance(
        await this.signer.getAddress(),
        NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
      );

      console.log(`DEBUG ${tokenAddress}:`);
      console.log(`  Current allowance: ${currentAllowance.toString()}`);
      console.log(`  Amount needed: ${amount.toString()}`);
      console.log(
        `  Comparison (allowance < amount): ${currentAllowance < amount}`,
      );
      console.log(`  Allowance >= Amount: ${currentAllowance >= amount}`);
      // Only approve if current allowance is insufficient
      if (currentAllowance < amount) {
        this.logger.log(
          `Approving ${tokenAddress} for ${amount.toString()} tokens...`,
        );

        const approveTx = await tokenContract.approve(
          NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
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

  async bootstrap(): Promise<void> {
    try {
      this.logger.log('Initializing UniswapLpService...');

      // Test connection to provider
      const network = await this.provider.getNetwork();
      this.logger.log(
        `Connected to network: ${network.name} (chainId: ${network.chainId})`,
      );

      // Test signer
      const address = await this.signer.getAddress();
      const balance = await this.provider.getBalance(address);
      this.logger.log(`Signer address: ${address}`);
      this.logger.log(`Signer balance: ${ethers.formatEther(balance)} ETH`);

      // Get WBTC/USDC position info
      await this.getWbtcUsdcPosition();

      this.logger.log('UniswapLpService initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize UniswapLpService: ${error.message}`,
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

      return {
        tokenId,
        token0: new Token(1, position.token0, 18), // Mainnet chainId = 1
        token1: new Token(1, position.token1, 18),
        fee: position.fee,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity.toString(),
        token0Balance: position.tokensOwed0.toString(),
        token1Balance: position.tokensOwed1.toString(),
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
      // return '999399';
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

  async getEarnedFees(
    tokenId: number,
    poolAddress = WBTC_USDC_POOL_ADDRESS,
  ): Promise<{
    token0Fees: string;
    token1Fees: string;
    token0Symbol: string;
    token1Symbol: string;
  }> {
    try {
      const poolInfo = await fetchPoolInfo(poolAddress);

      const contract = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
        NonfungiblePositionManagerABI,
        this.provider,
      );

      const MaxUint128 = '340282366920938463463374607431768211455';

      const collectParams = {
        tokenId: tokenId,
        recipient: ethers.ZeroAddress,
        amount0Max: MaxUint128,
        amount1Max: MaxUint128,
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

  async getPoolPrice(poolAddress: string): Promise<{
    token0ToToken1Rate: number;
    token1ToToken0Rate: number;
    token0Symbol: string;
    token1Symbol: string;
    formattedPrice: string;
  }> {
    try {
      this.logger.log(`Getting pool price for ${poolAddress}`);
      return await getPoolPrice(poolAddress);
    } catch (error) {
      this.logger.error(
        `Error getting pool price for ${poolAddress}:`,
        error.message,
      );
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
            NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
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
            NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
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
    try {
      this.logger.log(`Fetching WBTC/USDC position #${tokenId}...`);

      const position = await this.getPosition(tokenId);
      console.log('position', position);

      // Format amounts with proper decimals
      const wbtcAmount = formatUnits(position.token0Balance, 8); // WBTC has 8 decimals
      const usdcAmount = formatUnits(position.token1Balance, 6); // USDC has 6 decimals

      // Calculate tick ranges to price
      const tickToPrice = (tick: bigint): number => {
        // Convert tick to number for the calculation since we can't use ** with bigint
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
      this.logger.log(`WBTC Amount: ${wbtcAmount}`);
      this.logger.log(`USDC Amount: ${usdcAmount}`);
      this.logger.log(`Liquidity: ${position.liquidity}`);

      // Log uncollected fees
      const wbtcFees = formatUnits(position.feeGrowthInside0LastX128, 8);
      const usdcFees = formatUnits(position.feeGrowthInside1LastX128, 6);
      this.logger.log(`Uncollected Fees:`);
      this.logger.log(`- WBTC: ${wbtcFees}`);
      this.logger.log(`- USDC: ${usdcFees}`);
    } catch (error) {
      this.logger.error(`Failed to fetch WBTC/USDC position: ${error.message}`);
      throw error;
    }
  }
}
