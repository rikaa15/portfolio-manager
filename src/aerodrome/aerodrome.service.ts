import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet } from 'ethers';
import { BaseConfig, Config } from '../config/configuration';
import configuration from '../config/configuration';
import {
  calculatePositionAmounts,
  checkGaugeStaking,
  getAllUserPositionsForPool,
  removeLiquidity,
  collectFees,
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
  ): Promise<AerodromeLiquidityPosition[]> {
    try {
      this.logger.log(
        `Fetching all Aerodrome LP positions for user ${userAddress} in pool ${poolAddress}...`,
      );

      const { stakedPositions, unstakedPositions } =
        await getAllUserPositionsForPool(
          userAddress,
          poolAddress,
          this.config.contracts.positionManager,
          this.provider,
        );

      const allUserPositions = [...stakedPositions, ...unstakedPositions];

      if (allUserPositions.length === 0) {
        return [];
      }

      // Process positions with Promise.all for better performance
      const positions = await Promise.all(
        allUserPositions.map(async (userPosition) => {
          const { token0Balance, token1Balance } =
            await calculatePositionAmounts(
              poolAddress,
              userPosition.position,
              userPosition.poolInfo,
              this.provider,
            );

          // Determine staking status from which array the position came from
          const isStaked = stakedPositions.some(
            (p) => p.tokenId === userPosition.tokenId,
          );

          // Only check gauge for pending rewards if staked
          const pendingRewards = isStaked
            ? (
                await checkGaugeStaking(
                  userAddress,
                  userPosition.tokenId,
                  userPosition.poolInfo.gauge.address,
                  this.provider,
                )
              ).pendingRewards
            : '0';

          return {
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
            tickLower: userPosition.position.tickLower.toString(),
            tickUpper: userPosition.position.tickUpper.toString(),
            uncollectedFees0: ethers.formatUnits(
              userPosition.position.tokensOwed0,
              parseInt(userPosition.poolInfo.token0.decimals),
            ),
            uncollectedFees1: ethers.formatUnits(
              userPosition.position.tokensOwed1,
              parseInt(userPosition.poolInfo.token1.decimals),
            ),
          } as AerodromeLiquidityPosition;
        }),
      );

      return positions;
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error.message}`);
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
      const allPositions: AerodromeLiquidityPosition[] = [];

      const positionPromises = knownPools.map((poolAddress) =>
        this.getPosition(userAddress, poolAddress),
      );

      const results = await Promise.allSettled(positionPromises);

      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          allPositions.push(...result.value);
        } else if (result.status === 'rejected') {
          this.logger.warn(
            `Could not check pool ${knownPools[index]}: ${result.reason?.message}`,
          );
        }
      });

      this.logger.log(`Total positions found: ${allPositions.length}`);
      return allPositions;
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
   * Remove liquidity from a position
   */
  async removeLiquidity(tokenId: string, liquidity: string): Promise<string> {
    try {
      this.logger.log(`Removing liquidity from position ${tokenId}...`);
      
      const txHash = await removeLiquidity(
        tokenId,
        liquidity,
        this.config.contracts.positionManager,
        this.provider,
        this.signer,
      );
      
      this.logger.log(`Successfully removed liquidity: ${txHash}`);
      return txHash;
    } catch (error: any) {
      this.logger.error(`Failed to remove liquidity: ${error.message}`);
      throw error;
    }
  }

  /**
   * Collect fees from a position
   */
  async collectFees(tokenId: string): Promise<string> {
    try {
      this.logger.log(`Collecting fees from position ${tokenId}...`);
      
      const recipient = await this.getSignerAddress();
      const txHash = await collectFees(
        tokenId,
        recipient,
        this.config.contracts.positionManager,
        this.provider,
        this.signer,
      );
      
      this.logger.log(`Successfully collected fees: ${txHash}`);
      return txHash;
    } catch (error: any) {
      this.logger.error(`Failed to collect fees: ${error.message}`);
      throw error;
    }
  }
}

async function main() {
  try {
    console.log('Testing Aerodrome getPosition method...');

    const config = configuration();
    const configService = new ConfigService<Config>(config);

    // Create aerodrome service instance
    const aerodromeService = new AerodromeLpService(configService);
    await aerodromeService.bootstrap();

    const userAddress = process.env.WALLET_ADDRESS ?? '';
    const poolAddress = config.base.contracts.pools[0];

    console.log(`Testing with wallet: ${userAddress}`);
    console.log(`Testing with pool: ${poolAddress}`);

    // Test individual position
    const position = await aerodromeService.getPosition(
      userAddress,
      poolAddress,
    );

    if (position) {
      console.log('Single position found:');
      console.log(JSON.stringify(position, null, 2));
    } else {
      console.log('No position found for this wallet in the specified pool');
    }

    console.log('\n=== Testing getPositionsByOwner ===');
    const allPositions =
      await aerodromeService.getPositionsByOwner(userAddress);

    if (allPositions.length > 0) {
      console.log(`Found ${allPositions.length} total positions:`);
      allPositions.forEach((pos, index) => {
        console.log(`\nPosition ${index + 1}:`);
        console.log(`  Pool: ${pos.token0Symbol}/${pos.token1Symbol}`);
        console.log(
          `  Liquidity: ${pos.token0Balance} ${pos.token0Symbol} + ${pos.token1Balance} ${pos.token1Symbol}`,
        );
        console.log(`  Staked: ${pos.isStaked}`);
        console.log(`  Pending AERO: ${pos.pendingAeroRewards}`);
      });
    } else {
      console.log('No positions found for this wallet');
    }
  } catch (error: any) {
    console.error(`Test failed: ${error.message}`);
    throw error;
  }
}

if (require.main === module) {
  main().catch(console.error);
}
