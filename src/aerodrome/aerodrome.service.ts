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
      // First, try the SIMPLE Uniswap approach
      this.logger.log('Aerodrome fee calculation: Trying simple Uniswap collect.staticCall() approach');
      
      // Get the position manager contract (where your NFT lives)
      const positionManagerContract = new ethers.Contract(
        this.config.contracts.positionManager, 
        [
          'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'
        ], 
        provider
      );
      
      this.logger.log(`Checking fees for tokenId: ${tokenId}`);
      
      // Use the same approach as original Uniswap code
      const MAX_UINT_128 = BigInt('0xffffffffffffffffffffffffffffffff');
      const collectParams = {
        tokenId: tokenId,
        recipient: ethers.ZeroAddress,  // Zero address for staticCall (don't actually collect)
        amount0Max: MAX_UINT_128,       // Max possible amount
        amount1Max: MAX_UINT_128        // Max possible amount
      };
      
      this.logger.log('Simulating fee collection with collect.staticCall()...');
      
      // Static call to see how much fees we would get without actually collecting
      const result = await positionManagerContract.collect.staticCall(collectParams);
      
      this.logger.log(`collect.staticCall() result: amount0=${result.amount0}, amount1=${result.amount1}`);
      this.logger.log(`Fees available: ${ethers.formatUnits(result.amount0, parseInt(poolInfo.token0.decimals))} ${poolInfo.token0.symbol}, ${ethers.formatUnits(result.amount1, parseInt(poolInfo.token1.decimals))} ${poolInfo.token1.symbol}`);
      
      // If collect.staticCall() returned non-zero fees, use them
      if (result.amount0 > 0n || result.amount1 > 0n) {
        return {
          accruedFees0: result.amount0,
          accruedFees1: result.amount1
        };
      }
      
      // If collect.staticCall() returned 0, try alternative approach using gauge fees
      this.logger.log('collect.staticCall() returned 0, trying gauge-based fee calculation...');
      return await this.calculateFeesFromGauge(poolInfo, position, userAddress, tokenId, provider);
      
    } catch (error: any) {
      this.logger.error(`Error with collect.staticCall() approach: ${error.message}`);
      this.logger.log('Falling back to gauge-based fee calculation');
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
      this.logger.log('Calculating fees from subgraph...');
      
      // For now, let's examine what we have available in the position data
      this.logger.log('Position data available:');
      this.logger.log(`  tokensOwed0: ${position.tokensOwed0?.toString() || 'undefined'}`);
      this.logger.log(`  tokensOwed1: ${position.tokensOwed1?.toString() || 'undefined'}`);
      this.logger.log(`  feeGrowthInside0LastX128: ${position.feeGrowthInside0LastX128?.toString() || 'undefined'}`);
      this.logger.log(`  feeGrowthInside1LastX128: ${position.feeGrowthInside1LastX128?.toString() || 'undefined'}`);
      
      // Try the direct contract approach as GPT suggested
      const contractFees = await this.calculateFeesFromContract(
        poolInfo, 
        position, 
        tokenId, 
        provider
      );
      
      if (contractFees.accruedFees0 > 0n || contractFees.accruedFees1 > 0n) {
        this.logger.log('✅ Direct contract calculation succeeded!');
        return contractFees;
      }
      
      // Try to fetch fees from the subgraph
      const subgraphFees = await fetchPositionFees(tokenId);
      
      if (subgraphFees) {
        this.logger.log('Subgraph fee data found:');
        this.logger.log(`  Collected fees: ${subgraphFees.collectedFeesToken0} ${subgraphFees.token0Symbol}, ${subgraphFees.collectedFeesToken1} ${subgraphFees.token1Symbol}`);
        this.logger.log(`  Uncollected fees: ${subgraphFees.uncollectedFeesToken0 || '0'} ${subgraphFees.token0Symbol}, ${subgraphFees.uncollectedFeesToken1 || '0'} ${subgraphFees.token1Symbol}`);
        
        try {
          // Parse the subgraph fees with error handling for precision issues
          const collectedFees0 = this.safeParseUnits(subgraphFees.collectedFeesToken0, parseInt(subgraphFees.token0Decimals));
          const collectedFees1 = this.safeParseUnits(subgraphFees.collectedFeesToken1, parseInt(subgraphFees.token1Decimals));
          const uncollectedFees0 = this.safeParseUnits(subgraphFees.uncollectedFeesToken0 || '0', parseInt(subgraphFees.token0Decimals));
          const uncollectedFees1 = this.safeParseUnits(subgraphFees.uncollectedFeesToken1 || '0', parseInt(subgraphFees.token1Decimals));
          
          // Total fees = collected + uncollected
          const totalFees0 = collectedFees0 + uncollectedFees0;
          const totalFees1 = collectedFees1 + uncollectedFees1;
          
          this.logger.log(`Total subgraph fees: ${ethers.formatUnits(totalFees0, parseInt(subgraphFees.token0Decimals))} ${subgraphFees.token0Symbol}, ${ethers.formatUnits(totalFees1, parseInt(subgraphFees.token1Decimals))} ${subgraphFees.token1Symbol}`);
          
          // If subgraph returned meaningful fees, use them
          if (totalFees0 > 0n || totalFees1 > 0n) {
            return {
              accruedFees0: totalFees0,
              accruedFees1: totalFees1
            };
          }
        } catch (parseError: any) {
          this.logger.error(`Error parsing subgraph fee values: ${parseError.message}`);
          this.logger.log(`Raw values: token0=${subgraphFees.collectedFeesToken0}+${subgraphFees.uncollectedFeesToken0}, token1=${subgraphFees.collectedFeesToken1}+${subgraphFees.uncollectedFeesToken1}`);
          // Continue to fallback
        }
      } else {
        this.logger.log('No subgraph fee data found for this position');
      }
      
      // Fallback to position's tokensOwed values
      const tokensOwed0 = position.tokensOwed0 || 0n;
      const tokensOwed1 = position.tokensOwed1 || 0n;
      
      this.logger.log(`Fallback: Using position's tokensOwed values: ${ethers.formatUnits(tokensOwed0, parseInt(poolInfo.token0.decimals))} ${poolInfo.token0.symbol}, ${ethers.formatUnits(tokensOwed1, parseInt(poolInfo.token1.decimals))} ${poolInfo.token1.symbol}`);
      
      return {
        accruedFees0: tokensOwed0,
        accruedFees1: tokensOwed1
      };

    } catch (error: any) {
      this.logger.error(`Error calculating fees from subgraph: ${error.message}`);
      
      // Final fallback to position's tokensOwed
      const tokensOwed0 = position.tokensOwed0 || 0n;
      const tokensOwed1 = position.tokensOwed1 || 0n;
      
      return {
        accruedFees0: tokensOwed0,
        accruedFees1: tokensOwed1
      };
    }
  }

  /**
   * Calculate fees using direct contract calls as GPT suggested
   * Uses snapshotCumulativesInside() to get current fee growth
   */
  private async calculateFeesFromContract(
    poolInfo: any,
    position: any,
    tokenId: string,
    provider: JsonRpcProvider
  ): Promise<{ accruedFees0: bigint; accruedFees1: bigint }> {
    try {
      this.logger.log('🚀 Trying direct contract fee calculation (GPT method)...');
      
      // Get the pool contract
      const poolContract = new ethers.Contract(
        poolInfo.id, // pool address
        [
          'function snapshotCumulativesInside(int24 tickLower, int24 tickUpper) external view returns (int56, uint160, uint32, uint256, uint256)',
          'function positions(bytes32 key) external view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
        ],
        provider
      );
      
      // Fix tick parsing - ensure we get integers
      const tickLowerStr = position.tickLower?.tickIdx?.toString() || '0';
      const tickUpperStr = position.tickUpper?.tickIdx?.toString() || '0';
      const tickLower = parseInt(tickLowerStr);
      const tickUpper = parseInt(tickUpperStr);
      const liquidity = BigInt(position.liquidity);
      
      this.logger.log(`📊 Position details:`);
      this.logger.log(`  Tick range: ${tickLower} to ${tickUpper}`);
      this.logger.log(`  Liquidity: ${liquidity.toString()}`);
      
      // Validate tick values
      if (isNaN(tickLower) || isNaN(tickUpper)) {
        this.logger.log(`❌ Invalid tick values: ${tickLowerStr} -> ${tickLower}, ${tickUpperStr} -> ${tickUpper}`);
        return { accruedFees0: 0n, accruedFees1: 0n };
      }
      
      // Get current fee growth inside the position's range
      this.logger.log(`📞 Calling snapshotCumulativesInside(${tickLower}, ${tickUpper})...`);
      const snapshot = await poolContract.snapshotCumulativesInside(tickLower, tickUpper);
      
      // snapshot returns: [tickCumulativeInside, secondsPerLiquidityInsideX128, secondsInside, feeGrowthInside0X128, feeGrowthInside1X128]
      const currentFeeGrowthInside0 = snapshot[3]; // feeGrowthInside0X128
      const currentFeeGrowthInside1 = snapshot[4]; // feeGrowthInside1X128
      
      this.logger.log(`📈 Current fee growth inside:`);
      this.logger.log(`  Token0: ${currentFeeGrowthInside0.toString()}`);
      this.logger.log(`  Token1: ${currentFeeGrowthInside1.toString()}`);
      
      // Get position's last recorded fee growth
      // Try to get this from the position data we already have
      const lastFeeGrowthInside0 = BigInt(position.feeGrowthInside0LastX128 || '0');
      const lastFeeGrowthInside1 = BigInt(position.feeGrowthInside1LastX128 || '0');
      
      this.logger.log(`📜 Last recorded fee growth:`);
      this.logger.log(`  Token0: ${lastFeeGrowthInside0.toString()}`);
      this.logger.log(`  Token1: ${lastFeeGrowthInside1.toString()}`);
      
      // Check for sentinel values (uninitialized position)
      const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      const SENTINEL_THRESHOLD = MAX_UINT256 - BigInt('1000000000000000000000000000000000000000');
      
      if (lastFeeGrowthInside0 > SENTINEL_THRESHOLD || lastFeeGrowthInside1 > SENTINEL_THRESHOLD) {
        this.logger.log(`🚨 Detected sentinel values in position data - position may not be properly initialized for fee tracking`);
        // For uninitialized positions, we can't calculate fees this way
        return { accruedFees0: 0n, accruedFees1: 0n };
      }
      
      // Calculate fee deltas
      const feeGrowthDelta0 = currentFeeGrowthInside0 - lastFeeGrowthInside0;
      const feeGrowthDelta1 = currentFeeGrowthInside1 - lastFeeGrowthInside1;
      
      this.logger.log(`📊 Fee growth deltas:`);
      this.logger.log(`  Token0: ${feeGrowthDelta0.toString()}`);
      this.logger.log(`  Token1: ${feeGrowthDelta1.toString()}`);
      
      // Calculate fees: (delta * liquidity) / 2^128
      const Q128 = BigInt('0x100000000000000000000000000000000'); // 2^128
      const fees0 = (feeGrowthDelta0 * liquidity) / Q128;
      const fees1 = (feeGrowthDelta1 * liquidity) / Q128;
      
      this.logger.log(`💰 Calculated fees:`);
      this.logger.log(`  Token0: ${fees0.toString()} (${ethers.formatUnits(fees0, parseInt(poolInfo.token0.decimals))} ${poolInfo.token0.symbol})`);
      this.logger.log(`  Token1: ${fees1.toString()} (${ethers.formatUnits(fees1, parseInt(poolInfo.token1.decimals))} ${poolInfo.token1.symbol})`);
      
      return {
        accruedFees0: fees0 > 0n ? fees0 : 0n,
        accruedFees1: fees1 > 0n ? fees1 : 0n
      };
      
    } catch (error: any) {
      this.logger.error(`❌ Direct contract fee calculation failed: ${error.message}`);
      return { accruedFees0: 0n, accruedFees1: 0n };
    }
  }

  private safeParseUnits(value: string, decimals: number): bigint {
    try {
      // Handle empty or zero values
      if (!value || value === '0' || value === '') {
        return 0n;
      }
      
      // Truncate excessive decimal places that might cause parsing errors
      const parts = value.split('.');
      if (parts.length === 2 && parts[1].length > decimals) {
        // Truncate to token decimals to avoid precision errors
        const truncatedValue = parts[0] + '.' + parts[1].substring(0, decimals);
        this.logger.log(`Truncated ${value} to ${truncatedValue} for ${decimals} decimals`);
        return ethers.parseUnits(truncatedValue, decimals);
      }
      
      return ethers.parseUnits(value, decimals);
    } catch (error: any) {
      this.logger.error(`Failed to parse units for value "${value}" with ${decimals} decimals: ${error.message}`);
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
