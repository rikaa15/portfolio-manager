import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Config, BaseConfig } from '../config/configuration';
import { ethers, Wallet, JsonRpcProvider } from 'ethers';
import { 
  getUserPosition, 
  calculatePositionAmounts, 
  fetchPoolInfoDirect,
  getTokenInfo,
  getGaugeInfo,
} from './contract.client';
import { AerodromeLiquidityPosition } from './types';

@Injectable()
export class AerodromeLpService {
  private readonly logger = new Logger(AerodromeLpService.name);
  private provider: JsonRpcProvider;
  private signer: Wallet;
  private config: BaseConfig;

  constructor(private readonly configService: ConfigService<Config>) {
    this.initializeNetwork();
  }

  private initializeNetwork(): void {
    this.config = this.configService.get('base');

    if (!this.config?.rpcUrl) {
      throw new Error('Base RPC URL not configured');
    }

    if (!this.config?.privateKey) {
      throw new Error('Base private key not configured');
    }

    this.provider = new JsonRpcProvider(this.config.rpcUrl);
    this.signer = new Wallet(this.config.privateKey, this.provider);

    this.logger.log('Initialized Aerodrome service on Base network');
  }

  async bootstrap(): Promise<void> {
    try {
      this.logger.log('Initializing AerodromeLpService...');

      const network = await this.provider.getNetwork();
      this.logger.log(
        `Connected to Base network (chainId: ${network.chainId})`,
      );

      const address = await this.signer.getAddress();
      const balance = await this.provider.getBalance(address);
      this.logger.log(`Signer address: ${address}`);
      this.logger.log(`Signer balance: ${ethers.formatEther(balance)} ETH`);

      this.logger.log('AerodromeLpService initialized successfully');
    } catch (error: any) {
      this.logger.error(
        `Failed to initialize AerodromeLpService: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get LP positions for a user address in a specific pool
   */
  async getPosition(
    userAddress: string,
    poolAddress: string,
  ): Promise<AerodromeLiquidityPosition | null> {
    try {
      this.logger.log(
        `Fetching Aerodrome LP position for user ${userAddress} in pool ${poolAddress}...`,
      );

      const userPosition = await getUserPosition(
        userAddress,
        poolAddress,
        this.config.contracts.positionManager,
        this.provider,
        this.configService.get('aerodrome').gaugeAddress,
      );

      if (!userPosition) {
        this.logger.log(
          `No LP positions found for user ${userAddress} in pool ${poolAddress}`,
        );
        return null;
      }
      
      this.logger.log(`=== POSITION FOUND ===`);
      this.logger.log(`Token ID: ${userPosition.tokenId}`);
      this.logger.log(`Pool: ${poolAddress}`);
      this.logger.log(`Token0: ${userPosition.poolInfo.token0.symbol} (${userPosition.poolInfo.token0.address})`);
      this.logger.log(`Token1: ${userPosition.poolInfo.token1.symbol} (${userPosition.poolInfo.token1.address})`);

      const { token0Balance, token1Balance } = await calculatePositionAmounts(
        poolAddress,
        userPosition.position,
        userPosition.poolInfo,
        this.provider,
      );

      const { isStaked, pendingRewards } = await getGaugeInfo(
        userAddress,
        BigInt(userPosition.tokenId),
        userPosition.poolInfo.gauge.address,
        this.provider,
      );

      // Extract unclaimed fees from position NFT
      // Position structure: [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1]
      const tokensOwed0 = userPosition.position.tokensOwed0 || 0n;
      const tokensOwed1 = userPosition.position.tokensOwed1 || 0n;
      
      // Calculate accrued fees using gauge rewards
      const { accruedFees0, accruedFees1 } = await this.calculateAccruedFees(
        this.provider,
        userPosition.tokenId
      );
      
      // Use the larger of accrued fees vs collected fees
      const totalFees0 = accruedFees0 > tokensOwed0 ? accruedFees0 : tokensOwed0;
      const totalFees1 = accruedFees1 > tokensOwed1 ? accruedFees1 : tokensOwed1;
      
      // Format fees to human-readable strings
      const token0Fees = ethers.formatUnits(totalFees0, parseInt(userPosition.poolInfo.token0.decimals));
      const token1Fees = ethers.formatUnits(totalFees1, parseInt(userPosition.poolInfo.token1.decimals));

      const result: AerodromeLiquidityPosition = {
        userAddress,
        poolAddress,
        tokenId: userPosition.tokenId,
        token0Balance,
        token1Balance,
        token0Symbol: userPosition.poolInfo.token0.symbol,
        token1Symbol: userPosition.poolInfo.token1.symbol,
        liquidityAmount: userPosition.position.liquidity.toString(),
        isStaked,
        pendingAeroRewards: pendingRewards,
        token0Fees,
        token1Fees,
      };

      this.logger.log('=== AERODROME POSITION FOUND ===');
      this.logger.log(`Token ID: ${userPosition.tokenId}`);
      this.logger.log(
        `Liquidity: ${token0Balance} ${userPosition.poolInfo.token0.symbol} + ${token1Balance} ${userPosition.poolInfo.token1.symbol}`,
      );
      this.logger.log(`Staked: ${result.isStaked}`);
      this.logger.log(`Pending AERO rewards: ${pendingRewards}`);
      this.logger.log(`Unclaimed fees: ${token0Fees} ${userPosition.poolInfo.token0.symbol} + ${token1Fees} ${userPosition.poolInfo.token1.symbol}`);

      return result;
    } catch (error: any) {
      this.logger.error(`Failed to get position: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all LP positions for a user address across all pools
   */
  async getPositionsByOwner(
    userAddress: string,
  ): Promise<AerodromeLiquidityPosition[]> {
    try {
      this.logger.log(
        `Fetching all Aerodrome LP positions for user ${userAddress}...`,
      );

      const knownPools = this.config.contracts.pools;

      const positions: AerodromeLiquidityPosition[] = [];

      const positionPromises = knownPools.map((poolAddress) =>
        this.getPosition(userAddress, poolAddress),
      );

      const results = await Promise.allSettled(positionPromises);

      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          positions.push(result.value);
        } else if (result.status === 'rejected') {
          this.logger.warn(
            `Could not check pool ${knownPools[index]}: ${result.reason?.message}`,
          );
        }
      });

      this.logger.log(`Total positions found: ${positions.length}`);
      return positions;
    } catch (error: any) {
      this.logger.error(
        `Failed to get positions for user ${userAddress}: ${error.message}`,
      );
      throw error;
    }
  }

  async getSignerAddress(): Promise<string> {
    return this.signer.getAddress();
  }

  /**
   * Calculate accrued fees for a position
   */
  private async calculateAccruedFees(
    provider: JsonRpcProvider,
    tokenId: string
  ): Promise<{ accruedFees0: bigint; accruedFees1: bigint }> {
    // Try collect.staticCall() first
    try {
      const positionManagerContract = new ethers.Contract(
        this.config.contracts.positionManager, 
        [
          'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'
        ], 
        provider
      );
      
      const MAX_UINT_128 = BigInt('0xffffffffffffffffffffffffffffffff');
      const collectParams = {
        tokenId: tokenId,
        recipient: ethers.ZeroAddress,
        amount0Max: MAX_UINT_128,
        amount1Max: MAX_UINT_128
      };
      
      const result = await positionManagerContract.collect.staticCall(collectParams);
      
      if (result.amount0 > 0n || result.amount1 > 0n) {
        return {
          accruedFees0: result.amount0,
          accruedFees1: result.amount1
        };
      }
    } catch (error: any) {
      this.logger.warn(`collect.staticCall() failed: ${error.message}`);
    }

    return {
      accruedFees0: 0n,
      accruedFees1: 0n
    };
  }

  /**
   * Remove liquidity from an Aerodrome position
   */
  async removeLiquidity(params: {
    tokenId: string;
    liquidity: string;
    amount0Min: number;
    amount1Min: number;
    deadline: number;
  }): Promise<string> {
    try {
      this.logger.log(`Removing liquidity from Aerodrome position ${params.tokenId}...`);

      const positionManagerContract = new ethers.Contract(
        this.config.contracts.positionManager,
        [
          'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external returns (uint256 amount0, uint256 amount1)'
        ],
        this.signer
      );

      const tx = await positionManagerContract.decreaseLiquidity({
        tokenId: params.tokenId,
        liquidity: params.liquidity,
        amount0Min: params.amount0Min,
        amount1Min: params.amount1Min,
        deadline: params.deadline,
      });

      await tx.wait();
      this.logger.log(`Liquidity removed successfully. Transaction: ${tx.hash}`);
      return tx.hash;
    } catch (error: any) {
      this.logger.error(`Failed to remove liquidity: ${error.message}`);
      throw error;
    }
  }

  /**
   * Collect fees from an Aerodrome position
   */
  async collectFees(params: {
    tokenId: string;
    recipient: string;
    amount0Max: bigint;
    amount1Max: bigint;
  }): Promise<string> {
    try {
      this.logger.log(`Collecting fees from Aerodrome position ${params.tokenId}...`);

      const positionManagerContract = new ethers.Contract(
        this.config.contracts.positionManager,
        [
          'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'
        ],
        this.signer
      );

      const tx = await positionManagerContract.collect({
        tokenId: params.tokenId,
        recipient: params.recipient,
        amount0Max: params.amount0Max,
        amount1Max: params.amount1Max,
      });

      await tx.wait();
      this.logger.log(`Fees collected successfully. Transaction: ${tx.hash}`);
      return tx.hash;
    } catch (error: any) {
      this.logger.error(`Failed to collect fees: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if an Aerodrome position is out of range
   */
  async isPositionOutOfRange(
    position: AerodromeLiquidityPosition
  ): Promise<{
    isOutOfRange: boolean;
    currentTick: number;
    tickLower: number;
    tickUpper: number;
  }> {
    try {
      const userPosition = await getUserPosition(
        position.userAddress,
        position.poolAddress,
        this.config.contracts.positionManager,
        this.provider,
        this.configService.get('aerodrome').gaugeAddress,
      );

      if (!userPosition) {
        throw new Error('Could not fetch position details');
      }

      const poolContract = new ethers.Contract(
        position.poolAddress,
        ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)'],
        this.provider
      );

      const slot0 = await poolContract.slot0();
      const currentTick = Number(slot0.tick);

      const tickLower = Number(userPosition.position.tickLower);
      const tickUpper = Number(userPosition.position.tickUpper);

      const isOutOfRange = currentTick < tickLower || currentTick > tickUpper;

      this.logger.log(`Position range check:
        Current tick: ${currentTick}
        Position range: ${tickLower} to ${tickUpper}
        Out of range: ${isOutOfRange}
      `);

      return {
        isOutOfRange,
        currentTick,
        tickLower,
        tickUpper,
      };
    } catch (error: any) {
      this.logger.error(`Failed to check position range: ${error.message}`);
      throw error;
    }
  }
}
