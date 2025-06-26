import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet } from 'ethers';
import { BaseConfig, Config } from '../config/configuration';
import configuration from '../config/configuration';
import {
  calculatePositionAmounts,
  checkGaugeStaking,
  getUserStakedPosition,
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

      const userPosition = await getUserStakedPosition(
        userAddress,
        poolAddress,
        this.config.contracts.positionManager,
        this.provider,
        this.configService.get('aerodrome').gaugeAddress,
      );

      if (!userPosition) {
        this.logger.log(
          `No staked positions found for user ${userAddress} in pool ${poolAddress}`,
        );
        return null;
      }

      const { token0Balance, token1Balance } = await calculatePositionAmounts(
        poolAddress,
        userPosition.position,
        userPosition.poolInfo,
        this.provider,
      );

      const { isStaked, pendingRewards } = await checkGaugeStaking(
        userAddress,
        userPosition.tokenId,
        userPosition.poolInfo.gauge.address,
        this.provider,
      );

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
      };

      this.logger.log('=== AERODROME POSITION FOUND ===');
      this.logger.log(`Token ID: ${userPosition.tokenId}`);
      this.logger.log(
        `Liquidity: ${token0Balance} ${userPosition.poolInfo.token0.symbol} + ${token1Balance} ${userPosition.poolInfo.token1.symbol}`,
      );
      this.logger.log(`Staked: ${result.isStaked}`);
      this.logger.log(`Pending AERO rewards: ${pendingRewards}`);

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
}
// async function main() {
//   try {
//     console.log('Testing Aerodrome getPosition method...');

//     const config = configuration();
//     const configService = new ConfigService<Config>(config);

//     // Create aerodrome service instance
//     const aerodromeService = new AerodromeLpService(configService);
//     await aerodromeService.bootstrap();

//     const userAddress = process.env.WALLET_ADDRESS ?? '';
//     const poolAddress = config.base.contracts.pools[0];

//     console.log(`Testing with wallet: ${userAddress}`);
//     console.log(`Testing with pool: ${poolAddress}`);

//     // Test individual position
//     const position = await aerodromeService.getPosition(
//       userAddress,
//       poolAddress,
//     );

//     if (position) {
//       console.log('Single position found:');
//       console.log(JSON.stringify(position, null, 2));
//     } else {
//       console.log('No position found for this wallet in the specified pool');
//     }

//     console.log('\n=== Testing getPositionsByOwner ===');
//     const allPositions =
//       await aerodromeService.getPositionsByOwner(userAddress);

//     if (allPositions.length > 0) {
//       console.log(`Found ${allPositions.length} total positions:`);
//       allPositions.forEach((pos, index) => {
//         console.log(`\nPosition ${index + 1}:`);
//         console.log(`  Pool: ${pos.token0Symbol}/${pos.token1Symbol}`);
//         console.log(
//           `  Liquidity: ${pos.token0Balance} ${pos.token0Symbol} + ${pos.token1Balance} ${pos.token1Symbol}`,
//         );
//         console.log(`  Staked: ${pos.isStaked}`);
//         console.log(`  Pending AERO: ${pos.pendingAeroRewards}`);
//       });
//     } else {
//       console.log('No positions found for this wallet');
//     }
//   } catch (error: any) {
//     console.error(`Test failed: ${error.message}`);
//     throw error;
//   }
// }

// if (require.main === module) {
//   main().catch(console.error);
// }
