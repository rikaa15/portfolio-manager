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
import { fetchPositionFees } from './subgraph.client';
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

      // Extract unclaimed fees from position NFT
      // Position structure: [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1]
      const tokensOwed0 = userPosition.position.tokensOwed0 || 0n;
      const tokensOwed1 = userPosition.position.tokensOwed1 || 0n;
      
      // Calculate accrued fees using gauge rewards (pass userAddress explicitly)
      const { accruedFees0, accruedFees1 } = await this.calculateAccruedFees(
        poolAddress,
        userPosition.position,
        userPosition.poolInfo,
        this.provider,
        userAddress,  // Pass userAddress explicitly
        userPosition.tokenId  // Pass tokenId explicitly
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
   * Calculate accrued fees for a position using fee growth values
   * Similar to Uniswap V3 fee calculation mechanism
   */
  private async calculateAccruedFees(
    poolAddress: string,
    position: any,
    poolInfo: any,
    provider: JsonRpcProvider,
    userAddress: string,
    tokenId: string
  ): Promise<{ accruedFees0: bigint; accruedFees1: bigint }> {
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
      
      this.logger.log('collect.staticCall() returned 0, trying gauge-based fee calculation...');
      return await this.calculateFeesFromGauge(poolInfo, position, userAddress, tokenId, provider);
      
    } catch (error: any) {
      this.logger.error(`Error with collect.staticCall() approach: ${error.message}`);
      return await this.calculateFeesFromGauge(poolInfo, position, userAddress, tokenId, provider);
    }
  }

  /**
   * Alternative fee calculation using subgraph data
   */
  private async calculateFeesFromGauge(
    poolInfo: any,
    position: any,
    userAddress: string,
    tokenId: string,
    provider: JsonRpcProvider
  ): Promise<{ accruedFees0: bigint; accruedFees1: bigint }> {
    try {
      const contractFees = await this.calculateFeesFromContract(
        poolInfo, 
        position, 
        tokenId, 
        provider
      );
      
      if (contractFees.accruedFees0 > 0n || contractFees.accruedFees1 > 0n) {
        return contractFees;
      }
      
      const subgraphFees = await fetchPositionFees(tokenId);
      
      if (subgraphFees) {
        try {
          const collectedFees0 = this.safeParseUnits(subgraphFees.collectedFeesToken0, parseInt(subgraphFees.token0Decimals));
          const collectedFees1 = this.safeParseUnits(subgraphFees.collectedFeesToken1, parseInt(subgraphFees.token1Decimals));
          const uncollectedFees0 = this.safeParseUnits(subgraphFees.uncollectedFeesToken0 || '0', parseInt(subgraphFees.token0Decimals));
          const uncollectedFees1 = this.safeParseUnits(subgraphFees.uncollectedFeesToken1 || '0', parseInt(subgraphFees.token1Decimals));

          const totalFees0 = collectedFees0 + uncollectedFees0;
          const totalFees1 = collectedFees1 + uncollectedFees1;
          
          if (totalFees0 > 0n || totalFees1 > 0n) {
            return {
              accruedFees0: totalFees0,
              accruedFees1: totalFees1
            };
          }
        } catch (parseError: any) {
          this.logger.error(`Error parsing subgraph fee values: ${parseError.message}`);
        }
      } else {
        this.logger.log('No subgraph fee data found for this position');
      }
      
      const tokensOwed0 = position.tokensOwed0 || 0n;
      const tokensOwed1 = position.tokensOwed1 || 0n;
      
      return {
        accruedFees0: tokensOwed0,
        accruedFees1: tokensOwed1
      };

    } catch (error: any) {
      this.logger.error(`Error calculating fees from subgraph: ${error.message}`);
      
      const tokensOwed0 = position.tokensOwed0 || 0n;
      const tokensOwed1 = position.tokensOwed1 || 0n;
      
      return {
        accruedFees0: tokensOwed0,
        accruedFees1: tokensOwed1
      };
    }
  }

  /**
   * Calculate fees using direct contract calls
   * Uses snapshotCumulativesInside() to get current fee growth
   */
  private async calculateFeesFromContract(
    poolInfo: any,
    position: any,
    tokenId: string,
    provider: JsonRpcProvider
  ): Promise<{ accruedFees0: bigint; accruedFees1: bigint }> {
    try {
      const poolContract = new ethers.Contract(
        poolInfo.id,
        [
          'function snapshotCumulativesInside(int24 tickLower, int24 tickUpper) external view returns (int56, uint160, uint32, uint256, uint256)',
          'function positions(bytes32 key) external view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
        ],
        provider
      );

      const tickLowerStr = position.tickLower?.tickIdx?.toString() || '0';
      const tickUpperStr = position.tickUpper?.tickIdx?.toString() || '0';
      const tickLower = parseInt(tickLowerStr);
      const tickUpper = parseInt(tickUpperStr);
      const liquidity = BigInt(position.liquidity);
      
      if (isNaN(tickLower) || isNaN(tickUpper)) {
        return { accruedFees0: 0n, accruedFees1: 0n };
      }
      
      const snapshot = await poolContract.snapshotCumulativesInside(tickLower, tickUpper);

      const currentFeeGrowthInside0 = snapshot[3];
      const currentFeeGrowthInside1 = snapshot[4];
      
      const lastFeeGrowthInside0 = BigInt(position.feeGrowthInside0LastX128 || '0');
      const lastFeeGrowthInside1 = BigInt(position.feeGrowthInside1LastX128 || '0');
      
      const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      const SENTINEL_THRESHOLD = MAX_UINT256 - BigInt('1000000000000000000000000000000000000000');
      
      if (lastFeeGrowthInside0 > SENTINEL_THRESHOLD || lastFeeGrowthInside1 > SENTINEL_THRESHOLD) {
        return { accruedFees0: 0n, accruedFees1: 0n };
      }
      
      const feeGrowthDelta0 = currentFeeGrowthInside0 - lastFeeGrowthInside0;
      const feeGrowthDelta1 = currentFeeGrowthInside1 - lastFeeGrowthInside1;

      const Q128 = BigInt('0x100000000000000000000000000000000');
      const fees0 = (feeGrowthDelta0 * liquidity) / Q128;
      const fees1 = (feeGrowthDelta1 * liquidity) / Q128;

      return {
        accruedFees0: fees0 > 0n ? fees0 : 0n,
        accruedFees1: fees1 > 0n ? fees1 : 0n
      };
      
    } catch (error: any) {
      this.logger.warn('Direct contract fee calculation failed');
      return { accruedFees0: 0n, accruedFees1: 0n };
    }
  }

  private safeParseUnits(value: string, decimals: number): bigint {
    try {
      if (!value || value === '0' || value === '') {
        return 0n;
      }
      
      const parts = value.split('.');
      if (parts.length === 2 && parts[1].length > decimals) {
        const truncatedValue = parts[0] + '.' + parts[1].substring(0, decimals);
        return ethers.parseUnits(truncatedValue, decimals);
      }
      
      return ethers.parseUnits(value, decimals);
    } catch (error: any) {
      return 0n;
    }
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
