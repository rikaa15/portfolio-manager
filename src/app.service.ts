import { Injectable, Logger } from '@nestjs/common';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { AerodromeLpService } from './aerodrome/aerodrome.service';
import { ConfigService } from '@nestjs/config';
import { Config } from './config/configuration';
import { ethers } from 'ethers';
import { FundingService } from './funding/funding.service';
import * as moment from 'moment';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private WBTC_USDC_POSITION_ID: string;
  private AERODROME_POSITION_ID: string;
  private readonly MONITORING_INTERVAL = 10 * 60 * 1000; // 10 minutes (was 60 minutes)
  private readonly FEE_COLLECTION_THRESHOLD = 100 // 100 USDC worth of fees
  private readonly FEE_COLLECTION_GAS_THRESHOLD = 5 // 5 USDC worth of gas fees
  
  // Strategy parameters from backtesting - Aligned with BTC/USDC LP Strategy Documentation
  // Core Strategy: Hedge BTC quantity in LP position, not position value
  // - 50% hedge ratio: Short 50% of BTC quantity in LP position
  // - Dynamic scaling: Increase hedge as price approaches upper range (BTC quantity decreases)
  // - Dynamic scaling: Decrease hedge as price approaches lower range (BTC quantity increases)
  // 
  // Hedge Adjustment Strategy:
  // 1. Base hedge size = current BTC quantity in LP position
  // 2. Adjust based on WBTC ratio deviation from 50/50 target:
  //    - If WBTC ratio > 50% (too much BTC): Increase hedge to reduce exposure
  //    - If WBTC ratio < 50% (too much USDC): Decrease hedge to increase exposure
  // 3. Additional scaling based on price position within range:
  //    - Near upper range: Increase hedge (BTC quantity decreasing)
  //    - Near lower range: Decrease hedge (BTC quantity increasing)
  // 4. Apply limits: 30% minimum, 75% maximum of BTC quantity
  private readonly PRICE_RANGE_PERCENT = 0.10; // 10% price range ✅ Documentation requirement
  private readonly MAX_HEDGE_RATIO = 0.75; // 75% maximum hedge ratio
  private readonly MIN_HEDGE_RATIO = 0.3; // 30% minimum hedge ratio
  private readonly MAX_LEVERAGE = 2; // Maximum allowed leverage
  private readonly MIN_LEVERAGE = 0.5; // Minimum allowed leverage
  private readonly MAX_MARGIN_USAGE = 0.75; // 75% max margin usage
  private readonly LIQUIDATION_BUFFER = 0.85; // 85% liquidation buffer
  private readonly FUNDING_RATE_THRESHOLD = 0.001; // 0.1% per 8h funding rate threshold ✅ Documentation requirement
  private readonly GAS_THRESHOLD = 20; // $20 gas threshold
  private readonly OUT_OF_RANGE_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours in ms
  private readonly REBALANCE_THRESHOLD = 0.05; // 5% deviation from target ✅ Documentation requirement
  private readonly MAX_POSITION_ADJUSTMENT = 0.1; // Maximum 10% position size adjustment per day

  // LP Rebalancing parameters
  private readonly LP_TARGET_POSITION_VALUE = 50 // $70 amount of WBTC in LP position
  private readonly LP_REBALANCE_GAS_LIMIT = 10; // $10 gas limit for rebalancing
  private readonly LP_REBALANCE_COOLDOWN = 4 * 60 * 60 * 1000; // 4 hours between rebalances
  private readonly LP_REBALANCE_MAX_SIZE = 0.20; // 20% max position change per rebalance
  private readonly LP_REBALANCE_BOUNDARY_THRESHOLD = 0.02; // 2% from range boundary

  // Aerodrome LP Rebalancing state
  private lastAerodromeLpRebalance = 0;
  private aerodromeLpRebalanceCount = 0;
  private aerodromeOutOfRangeStartTime: number | null = null;

  // Strategy state
  private outOfRangeStartTime: number | null = null;
  private monitoringInterval: NodeJS.Timeout;
  private lastHedgeValue = 0;
  private lastHedgeRebalance = Date.now();
  private currentHedgeLeverage = 1;

  // LP Rebalancing state
  private lastLpRebalance = 0;
  private lpRebalanceCount = 0;
  private totalLpRebalanceGasCost = 0;

  constructor(
    private readonly uniswapLpService: UniswapLpService,
    private readonly hyperliquidService: HyperliquidService,
    private readonly fundingService: FundingService,
    private readonly aerodromeService: AerodromeLpService,
    private readonly configService: ConfigService<Config>,
  ) {
    this.WBTC_USDC_POSITION_ID = this.configService.get('uniswap').positionId;
    // For now¸use the first position found for Aerodrome
    this.AERODROME_POSITION_ID = '';
  }

  async bootstrap() {
    this.logger.log('Starting BTC/USDC LP strategy...');
    
    try {
      // Initial position check and setup
      await this.monitorPosition();
      
      // Start periodic monitoring
      this.monitoringInterval = setInterval(
        () => this.monitorPosition(),
        this.MONITORING_INTERVAL
      );

      this.logger.log('BTC/USDC LP strategy started successfully');
    } catch (error) {
      this.logger.error(`Failed to start BTC/USDC LP strategy: ${error.message}`);
      throw error;
    }
  }

  private async monitorPosition() {
    try {
      // Get current position state
      const position = await this.uniswapLpService.getPosition(this.WBTC_USDC_POSITION_ID);
      console.log('position:', this.WBTC_USDC_POSITION_ID, position);

      // TODO: get from subgraph / api
      const positionStartDate = this.configService.get('uniswap').positionCreationDate;
      const positionEndDate = moment().format('YYYY-MM-DD');
      const poolPriceHistory = await this.uniswapLpService.getPoolPriceHistory(positionStartDate, positionEndDate, 'daily');
      if(poolPriceHistory.length === 0) {
        this.logger.error('No pool price history found');
        return;
      }
      const initialPrice = poolPriceHistory[0].token1Price;
      const currentPrice = poolPriceHistory[poolPriceHistory.length - 1].token1Price;
      this.logger.log(`BTC price (initial): ${
        initialPrice
      }, current: ${
        currentPrice
      }`);

      const lpProvider = this.configService.get('lpProvider');
      try {
        this.logger.log(`Checking ${lpProvider} LP rebalancing...`);
        
        if (lpProvider === 'aerodrome') {
          const userAddress = await this.aerodromeService.getSignerAddress();
          const positions = await this.aerodromeService.getPositionsByOwner(userAddress);
          
          if (positions.length === 0) {
            this.logger.log('No Aerodrome positions found');
            return;
          }

          const aerodromePosition = positions[0];
          this.AERODROME_POSITION_ID = aerodromePosition.tokenId;
          
          this.logger.log(`Monitoring Aerodrome position ${aerodromePosition.tokenId}:
            Pool: ${aerodromePosition.token0Symbol}/${aerodromePosition.token1Symbol}
            Liquidity: ${aerodromePosition.liquidityAmount}
            Token0 Balance: ${aerodromePosition.token0Balance}
            Token1 Balance: ${aerodromePosition.token1Balance}
            Is Staked: ${aerodromePosition.isStaked}
            Tick Range: ${aerodromePosition.tickLower} to ${aerodromePosition.tickUpper}
          `);

          await this.checkAerodromeLpRebalancing(currentPrice, aerodromePosition);
        } else {
          await this.checkUniswapLpRebalancing(currentPrice, position);
        }
      } catch (error) {
        this.logger.error(`Error checking ${lpProvider} LP rebalancing: ${error.message}`);
      }

      // Calculate impermanent loss
      const impermanentLoss = this.calculateImpermanentLoss(currentPrice, initialPrice);
  
      // Get current pool price
      // const poolPrice = await this.uniswapLpService.getPoolPrice();
      // console.log('poolPrice:', poolPrice);
      // const currentPrice = poolPrice.token0ToToken1Rate;
      // console.log('currentPrice:', currentPrice);

      // Calculate position metrics
      const wbtcAmount = Number(ethers.formatUnits(position.token0BalanceRaw, position.token0.decimals));
      const usdcAmount = Number(ethers.formatUnits(position.token1BalanceRaw, position.token1.decimals));
      const wbtcPositionValue = wbtcAmount * currentPrice;
      const usdcPositionValue = usdcAmount;
      const positionValue = wbtcPositionValue + usdcPositionValue;

      // Calculate token ratios for rebalancing
      const wbtcRatio = wbtcPositionValue / positionValue;
      
      // Calculate BTC delta from LP position
      const lpBtcDelta = wbtcAmount;
      
      // Calculate BTC delta from hedge position
      let hedgeBtcDelta = 0;
      const currentHedgePosition = await this.hyperliquidService.getUserPosition('BTC');
      if (currentHedgePosition && currentHedgePosition.position) {
        hedgeBtcDelta = -Number(currentHedgePosition.position.szi); // Negative because it's a short position
      }
      
      // Calculate net BTC delta (LP + Hedge)
      const netBtcDelta = lpBtcDelta + hedgeBtcDelta;
      const netBtcDeltaValue = netBtcDelta * currentPrice;
      
      // Calculate LP APR
      const earnedFees = await this.uniswapLpService.getEarnedFees(Number(this.WBTC_USDC_POSITION_ID));  
      const btcFees = ethers.parseUnits(earnedFees.token0Fees, position.token0.decimals); // btc
      const usdcFees = ethers.parseUnits(earnedFees.token1Fees, position.token1.decimals); // usdc
      const btcFeesValue = Number(ethers.formatUnits(btcFees, position.token0.decimals)) * currentPrice;
      const usdcFeesValue = Number(ethers.formatUnits(usdcFees, position.token1.decimals));
      const totalFeesValue = btcFeesValue + usdcFeesValue;
      
      // Calculate time elapsed since position start
      const positionStartTime = new Date(positionStartDate).getTime();
      const timeElapsed = (Date.now() - positionStartTime) / (1000 * 60 * 60 * 24); // in days

      // Calculate APR: (fees / position value) * (365 / days elapsed)
      const lpApr = timeElapsed > 0 ? (totalFeesValue / positionValue) * (365 / timeElapsed) * 100 : 0;
      
      // Calculate net APR including impermanent loss
      const netApr = lpApr - Math.abs(impermanentLoss);
      
      // Calculate price range based on current price
      const lowerPrice = currentPrice * (1 - this.PRICE_RANGE_PERCENT / 2);
      const upperPrice = currentPrice * (1 + this.PRICE_RANGE_PERCENT / 2);

      // Check if position is in range
      const inRange = currentPrice >= lowerPrice && currentPrice <= upperPrice;
      
      if (!inRange) {
        if (!this.outOfRangeStartTime) {
          this.outOfRangeStartTime = Date.now();
        } else if (Date.now() - this.outOfRangeStartTime > this.OUT_OF_RANGE_THRESHOLD) {
          this.logger.warn('Position out of range for more than 24 hours, exiting position...');
          await this.exitPosition();
          return;
        }
      } else {
        this.outOfRangeStartTime = null;
      }

      // Get current funding rate
      const fundingData = await this.fundingService.getCurrentFundingRate('BTC');
      const currentFundingRate = fundingData.fundingRate;

      // ✅ IMPLEMENTED: Dynamic hedge size adjustment based on current WBTC ratio in LP
      // Strategy: Hedge should be proportional to BTC quantity in LP position
      // Target: Maintain 50/50 allocation, adjust hedge based on deviation from target
      
      // Calculate target hedge size based on current BTC quantity in LP
      let targetHedgeSize = wbtcAmount; // Start with full BTC quantity in LP
      
      // Adjust hedge size based on deviation from 50/50 target
      // If WBTC ratio > 50% (too much BTC), increase hedge to reduce exposure
      // If WBTC ratio < 50% (too much USDC), decrease hedge to increase exposure
      const targetRatio = 0.5; // 50/50 target
      const ratioDeviation = wbtcRatio - targetRatio; // Positive = too much BTC, Negative = too much USDC
      
      if (Math.abs(ratioDeviation) > 0.05) { // Only adjust if >5% deviation from 50/50
        if (ratioDeviation > 0) {
          // WBTC ratio > 50% (too much BTC exposure)
          // Increase hedge to reduce BTC exposure
          const adjustmentFactor = Math.min(ratioDeviation * 2, 0.5); // Cap at 50% increase
          targetHedgeSize = wbtcAmount * (1 + adjustmentFactor);
          this.logger.log(`WBTC ratio ${(wbtcRatio * 100).toFixed(1)}% > 50% target, increasing hedge by ${(adjustmentFactor * 100).toFixed(1)}%`);
        } else {
          // WBTC ratio < 50% (too much USDC exposure)
          // Decrease hedge to increase BTC exposure
          const adjustmentFactor = Math.min(Math.abs(ratioDeviation) * 2, 0.5); // Cap at 50% decrease
          targetHedgeSize = wbtcAmount * (1 - adjustmentFactor);
          this.logger.log(`WBTC ratio ${(wbtcRatio * 100).toFixed(1)}% < 50% target, decreasing hedge by ${(adjustmentFactor * 100).toFixed(1)}%`);
        }
      } else {
        this.logger.log(`WBTC ratio ${(wbtcRatio * 100).toFixed(1)}% within 5% of 50% target, no hedge adjustment needed`);
      }
      
      // Apply hedge size limits to prevent over-hedging
      const maxHedgeSize = wbtcAmount * this.MAX_HEDGE_RATIO; // 75% of BTC quantity
      const minHedgeSize = wbtcAmount * this.MIN_HEDGE_RATIO; // 30% of BTC quantity
      targetHedgeSize = Math.max(minHedgeSize, Math.min(maxHedgeSize, targetHedgeSize));
      
      // Additional dynamic scaling based on price position in range (as per documentation)
      if (inRange) {
        const pricePosition = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);
        if (pricePosition > 0.7) {
          // Price near upper range - BTC quantity in LP is decreasing, increase hedge
          targetHedgeSize = Math.min(maxHedgeSize, targetHedgeSize * 1.2);
          this.logger.log(`Price near upper range (${(pricePosition * 100).toFixed(1)}%), increasing hedge by 20%`);
        } else if (pricePosition < 0.3) {
          // Price near lower range - BTC quantity in LP is increasing, decrease hedge
          targetHedgeSize = Math.max(minHedgeSize, targetHedgeSize * 0.8);
          this.logger.log(`Price near lower range (${(pricePosition * 100).toFixed(1)}%), decreasing hedge by 20%`);
        }
      }

      // Convert hedge size from BTC quantity to USD value for position opening
      const targetHedgeValue = targetHedgeSize * currentPrice;

      // ✅ IMPLEMENTED: Check if hedge adjustment is needed based on core strategy
      let needsHedgeAdjustment = !currentHedgePosition || 
        !currentHedgePosition.position || 
        parseFloat(currentHedgePosition.position.szi) === 0 ||
        Math.abs(wbtcRatio - 0.5) > this.REBALANCE_THRESHOLD || // >5% deviation from 50/50
        currentFundingRate > this.FUNDING_RATE_THRESHOLD || // High funding rate
        Math.abs(hedgeBtcDelta + targetHedgeSize) > 0.01; // Hedge size deviation > 0.01 BTC

      // Additional check: compare current hedge size with calculated hedge size
      if (currentHedgePosition && currentHedgePosition.position && parseFloat(currentHedgePosition.position.szi) !== 0) {
        const currentHedgeSize = Math.abs(parseFloat(currentHedgePosition.position.szi)); // Convert to positive for comparison
        const hedgeSizeDifference = Math.abs(currentHedgeSize - targetHedgeSize);
        const hedgeSizeDifferencePercent = (hedgeSizeDifference / targetHedgeSize) * 100;
        
        // Only adjust if difference is more than 5%
        const hedgeAdjustmentThreshold = 1;
        if (hedgeSizeDifferencePercent <= hedgeAdjustmentThreshold) {
          needsHedgeAdjustment = false;
          this.logger.log(`Hedge adjustment skipped: current size ${currentHedgeSize.toFixed(4)} BTC vs target ${targetHedgeSize.toFixed(4)} BTC (${hedgeSizeDifferencePercent.toFixed(1)}% difference <= ${hedgeAdjustmentThreshold}% threshold)`);
        } else {
          this.logger.log(`Hedge adjustment needed: current size ${currentHedgeSize.toFixed(4)} BTC vs target ${targetHedgeSize.toFixed(4)} BTC (${hedgeSizeDifferencePercent.toFixed(1)}% difference > ${hedgeAdjustmentThreshold}% threshold)`);
        }
      }

      // Monitor funding rates and adjust position
      if (currentFundingRate > this.FUNDING_RATE_THRESHOLD) {
        // Calculate funding costs (8-hour rate * 3 for daily rate * hedge size * leverage)
        const dailyFundingCost = currentFundingRate * 3 * targetHedgeValue * this.currentHedgeLeverage;
        this.logger.log(`Current funding cost: $${dailyFundingCost.toFixed(2)} per day`);
      }

      // Log position metrics
      this.logger.log(`Position Metrics:
        WBTC Amount: ${wbtcAmount}, fees: ${ethers.formatUnits(btcFees, position.token0.decimals)}
        USDC Amount: ${usdcAmount}, fees: ${ethers.formatUnits(usdcFees, position.token1.decimals)}
        Position Value: $${positionValue.toFixed(2)}
        Price Range: $${lowerPrice.toFixed(2)} - $${upperPrice.toFixed(2)}
        Initial WBTC Price: $${initialPrice}
        Current WBTC Price: $${currentPrice}
        Impermanent Loss: ${impermanentLoss}%
        Target Hedge Size: ${targetHedgeSize.toFixed(4)} BTC ($${targetHedgeValue.toFixed(2)})
        Current Hedge Leverage: ${this.currentHedgeLeverage.toFixed(1)}x
        Current Funding Rate: ${(currentFundingRate * 100).toFixed(4)}%
        BTC Delta Metrics:
        - LP BTC size: ${lpBtcDelta.toFixed(4)} BTC
        - Hedge BTC size: ${hedgeBtcDelta.toFixed(4)} BTC
        - Net BTC delta: $${netBtcDeltaValue.toFixed(2)} (${netBtcDelta.toFixed(4)} BTC)
        Performance Metrics:
        - LP APR: ${lpApr.toFixed(2)}%
        - Net APR (including IL): ${netApr.toFixed(2)}%
        - Time Elapsed: ${timeElapsed.toFixed(1)} days
      `);

      // Check current hedge position
      if(currentHedgePosition) {
        this.logger.log(`Current hedge position (${this.hyperliquidService.walletAddress}):
          size=${currentHedgePosition.position.szi} BTC,
          value=$${currentHedgePosition.position.positionValue},
          leverage=${currentHedgePosition.position.leverage.value}x`);
      } else {
        this.logger.log('No active hedge position found');
      }

      // Log hedge adjustment reasoning
      this.logger.log(`Hedge Adjustment Analysis:
        Current WBTC Ratio: ${(wbtcRatio * 100).toFixed(1)}%
        Target Ratio: 50%
        Deviation: ${(ratioDeviation * 100).toFixed(1)}%
        Current Hedge Size: ${Math.abs(hedgeBtcDelta).toFixed(4)} BTC
        Target Hedge Size: ${targetHedgeSize.toFixed(4)} BTC
        Net BTC Delta: ${netBtcDelta.toFixed(4)} BTC ($${netBtcDeltaValue.toFixed(2)})
        Funding Rate: ${(currentFundingRate * 100).toFixed(4)}%
      `);

      if (needsHedgeAdjustment) {
        // Calculate target leverage based on conditions
        let targetLeverage = 1; // Start with 1x base leverage
        
        // Adjust leverage based on funding rate
        if (currentFundingRate > this.FUNDING_RATE_THRESHOLD) {
          // Reduce leverage when funding is expensive
          targetLeverage = Math.max(this.MIN_LEVERAGE, targetLeverage * 0.8);
        } else if (currentFundingRate < 0) {
          // Increase leverage when funding is negative (getting paid)
          targetLeverage = Math.min(this.MAX_LEVERAGE, targetLeverage * 1.2);
        }
        
        // Adjust leverage based on deviation from 50/50
        const deviationFromTarget = Math.abs(wbtcRatio - 0.5);
        if (deviationFromTarget > 0.05) {
          // Increase leverage to correct larger deviations faster
          targetLeverage = Math.min(this.MAX_LEVERAGE, targetLeverage * (1 + deviationFromTarget));
        }
        
        // Calculate final position parameters
        const collateral = targetHedgeValue / targetLeverage;
        
        // Check margin usage
        const marginUsage = targetLeverage * (collateral / positionValue);
        if (marginUsage <= this.MAX_MARGIN_USAGE) {
          this.logger.log(`Adjusting hedge position:
            Current BTC Exposure: ${(wbtcRatio * 100).toFixed(2)}%
            Target Hedge Size: ${targetHedgeSize.toFixed(4)} BTC ($${targetHedgeValue.toFixed(2)})
            Target Leverage: ${targetLeverage.toFixed(2)}x
            Collateral: $${collateral.toFixed(2)}
            Margin Usage: ${(marginUsage * 100).toFixed(2)}%
          `);

          try {
            await this.hyperliquidService.closePosition('BTC', false);
            this.logger.log('Successfully closed previous hedge position');
          } catch (error) {
            this.logger.error(`Failed to close hedge position: ${error.message}`);
            return;
          }
          
          try {
            await this.hyperliquidService.openPosition({
              coin: 'BTC',
              isLong: false,
              leverage: targetLeverage,
              collateral: collateral,
            });
            this.currentHedgeLeverage = targetLeverage;
            this.logger.log('Successfully adjusted hedge position');
          } catch (error) {
            this.logger.error(`Failed to adjust hedge position: ${error.message}`);
            return;
          }
        } else {
          this.logger.warn(`Skipping hedge adjustment - margin usage too high: ${(marginUsage * 100).toFixed(2)}%`);
        }
      } else {
        this.logger.log('No hedge adjustment needed');
      }

      // Check liquidation risk
      const hedgeMarginUsage = this.currentHedgeLeverage * targetHedgeValue / positionValue;
      if (hedgeMarginUsage > this.LIQUIDATION_BUFFER) {
        this.logger.warn('Position approaching liquidation buffer, reducing leverage');
        this.currentHedgeLeverage = Math.max(this.MIN_LEVERAGE, this.currentHedgeLeverage * 0.7);
        await this.hyperliquidService.openPosition({
          coin: 'BTC',
          isLong: false,
          leverage: this.currentHedgeLeverage,
          collateral: targetHedgeValue / this.currentHedgeLeverage,
        });
      }

      try {
        if(totalFeesValue > 0) {
          await this.collectFees(totalFeesValue);
        }
      } catch (error) {
        this.logger.error(`Error collecting fees: ${error.message}`);
      }

      // Monitor Aerodrome LP position
      // try {
      //   this.logger.log('Checking Aerodrome LP position...');
      //   await this.monitorAerodromePosition(currentPrice);
      // } catch (error) {
      //   this.logger.error(`Error monitoring Aerodrome position: ${error.message}`);
      // }
    } catch (error) {
      this.logger.error(`Error monitoring position: ${error.message}`);
    }
  }

  private calculateImpermanentLoss(
    currentToken0Price: number,
    initialToken0Price: number,
  ): number {
    // For WBTC/USDC pair, we only care about BTC price changes since USDC is pegged to $1
    const priceRatio = currentToken0Price / initialToken0Price;
    
    // Calculate IL using the standard formula for price change of one asset
    // IL = 2 * sqrt(priceRatio) / (1 + priceRatio) - 1
    const sqrtPriceRatio = Math.sqrt(priceRatio);
    const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);
    const holdValue = 1;

    // Convert to percentage
    return (lpValue - holdValue) * 100;
  }

  private async collectFees(totalFeesValue: number) {
    const recipientAddress = await this.uniswapLpService.getSignerAddress();
      const params = {
        tokenId: this.WBTC_USDC_POSITION_ID,
        recipient: recipientAddress,
        amount0Max: ethers.parseUnits('1000000', 6), // Collect all WBTC fees
        amount1Max: ethers.parseUnits('1000000', 6), // Collect all USDC fees
      }
      const { estimatedCostInUsd: gasCost } = await this.uniswapLpService.estimateCollectFees(params);
      if(gasCost < this.FEE_COLLECTION_GAS_THRESHOLD
        && totalFeesValue > this.FEE_COLLECTION_THRESHOLD
      ) {
        this.logger.log(`Collecting fees, estimated gas cost: $${gasCost.toFixed(2)}...`);
        await this.uniswapLpService.collectFees(params);
        this.logger.log('Successfully collected fees');
      } else {
        this.logger.log(`Skipping fees collection, gas cost: $${gasCost.toFixed(2)} is too high, or total fees value: $${totalFeesValue.toFixed(2)} is too low`);
      }
  }

  private async checkUniswapLpRebalancing(currentPrice: number, position: any) {
    // Get current position range
    const tickLower = Number(position.tickLower);
    const tickUpper = Number(position.tickUpper);
    
    // Convert ticks to prices
    // price_WBTC_per_USDC = 1.0001^i * 10^(decimals_WBTC - decimals_USDC)
    const tokensDecimalsDelta = Math.abs(position.token0.decimals - position.token1.decimals);
    const lowerPrice = 1.0001 ** tickLower * Math.pow(10, tokensDecimalsDelta);
    const upperPrice = 1.0001 ** tickUpper * Math.pow(10, tokensDecimalsDelta);
    this.logger.log(`Uniswap LP Lower price: ${lowerPrice}, upper price: ${upperPrice}, current price: ${currentPrice}`);

    // Calculate price position within current range
    const pricePosition = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);
    
    // Check cooldown period
    const timeSinceLastRebalance = Date.now() - this.lastLpRebalance;
    if (timeSinceLastRebalance < this.LP_REBALANCE_COOLDOWN) {
      this.logger.log('Uniswap LP rebalancing still in cooldown period');
      return; // Still in cooldown period
    }

    let rebalancingNeeded = false;
    let rebalancingAction = '';
    let newRangePercent = 0.10; // Default 10% range

    // Scenario 1: Price near upper or lower range boundary (98-100% of range)
    if (
      pricePosition <= this.LP_REBALANCE_BOUNDARY_THRESHOLD
      || pricePosition >= (1 - this.LP_REBALANCE_BOUNDARY_THRESHOLD)
    ) {
      rebalancingNeeded = true;
      rebalancingAction = 'boundary_rebalance';
      newRangePercent = 0.10; // Current price ± 10%
      this.logger.log(`Uniswap LP rebalancing triggered: Price near range boundary (${(pricePosition * 100).toFixed(1)}% of range)`);
    } else {
      this.logger.log(`Uniswap LP rebalancing not needed: Price not near range boundary (${(pricePosition * 100).toFixed(1)}% of range)`);
    }
    
    // Scenario 2: Price out of range (>1 hour)
    const isLiquidityZero = Number(position.liquidity) === 0;
    const isOutOfRange = currentPrice < lowerPrice || currentPrice > upperPrice;

    if (isOutOfRange) {
      if (!this.outOfRangeStartTime) {
        this.outOfRangeStartTime = Date.now();
      } else if (Date.now() - this.outOfRangeStartTime > 60 * 60 * 1000) { // 1 hour
        rebalancingNeeded = true;
        rebalancingAction = 'out_of_range_rebalance';
        newRangePercent = 0.10; // Current price ± 10%
        this.logger.log(`Uniswap LP rebalancing triggered: Price out of range for >1 hour`);
      }
    } else {
      this.outOfRangeStartTime = null;
    }

    if(isLiquidityZero) {
      rebalancingNeeded = true;
    }

    this.logger.log(`Uniswap LP rebalancing needed: ${rebalancingNeeded}, action: ${rebalancingAction}`);

    if (rebalancingNeeded) {
      await this.executeUniswapLpRebalancing(currentPrice, newRangePercent, rebalancingAction);
    }
  }

  private async executeUniswapLpRebalancing(currentPrice: number, newRangePercent: number, action: string) {
    this.logger.log(`Executing Uniswap LP rebalancing: ${action}`);
    
    // Get current position
    const position = await this.uniswapLpService.getPosition(this.WBTC_USDC_POSITION_ID);
    
    // Calculate new price range
    const newLowerPrice = currentPrice * (1 - newRangePercent / 2);
    const newUpperPrice = currentPrice * (1 + newRangePercent / 2);

    console.log('newLowerPrice', newLowerPrice, 'newUpperPrice', newUpperPrice);
    
    // Convert prices to ticks
    const newTickLower = Math.floor(Math.log(newLowerPrice) / Math.log(1.0001));
    const newTickUpper = Math.ceil(Math.log(newUpperPrice) / Math.log(1.0001));

    this.logger.log(`Rebalancing Uniswap LP position:
      Current range: ${(1.0001 ** Number(position.tickLower)).toFixed(2)} - ${(1.0001 ** Number(position.tickUpper)).toFixed(2)}
      New range: ${newLowerPrice.toFixed(2)} - ${newUpperPrice.toFixed(2)}
      Action: ${action}
    `);

    if(Number(position.liquidity) > 0) {
      // Remove current liquidity
      this.logger.log('Uniswap LP: Removing current liquidity...');
      const removeLiquidityTxHash = await this.uniswapLpService.removeLiquidity({
        tokenId: this.WBTC_USDC_POSITION_ID,
        liquidity: position.liquidity,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      });
      this.logger.log(`Uniswap LP: Successfully removed current liquidity: ${removeLiquidityTxHash}`);

      this.logger.log('Uniswap LP: Collecting fees...');
      const collectFeesTxHash = await this.uniswapLpService.collectFees({
        tokenId: this.WBTC_USDC_POSITION_ID,
        recipient: await this.uniswapLpService.getSignerAddress(),
        amount0Max: ethers.parseUnits('10000000', 6),
        amount1Max: ethers.parseUnits('10000000', 6),
      });
      this.logger.log(`Uniswap LP: Fees collected: ${collectFeesTxHash}`);
    }

    // Calculate new liquidity amounts based on target position value
    const targetWbtcValue = this.LP_TARGET_POSITION_VALUE / 2;
    const targetUsdcValue = this.LP_TARGET_POSITION_VALUE / 2;
    
    const newWbtcAmount = targetWbtcValue / currentPrice;
    const newUsdcAmount = targetUsdcValue;

    const addLiquidityParams = {
      token0: position.token0,
      token1: position.token1,
      fee: Number(position.fee),
      tickLower: -887220, // newTickLower,
      tickUpper: 887220, newTickUpper,
      amount0Desired: ethers.parseUnits(newWbtcAmount.toFixed(position.token0.decimals), position.token0.decimals),
      amount1Desired: ethers.parseUnits(newUsdcAmount.toFixed(position.token1.decimals), position.token1.decimals),
      amount0Min: 0, // 1% slippage
      amount1Min: 0, // 1% slippage
      recipient: await this.uniswapLpService.getSignerAddress(),
      deadline: Math.floor(Date.now() / 1000) + 3600,
    }

    this.logger.log(`Adding new liquidity:
      New WBTC amount: ${newWbtcAmount.toFixed(position.token0.decimals)} (${addLiquidityParams.amount0Desired})
      New USDC amount: ${newUsdcAmount.toFixed(position.token1.decimals)} (${addLiquidityParams.amount1Desired})
      Ticks: ${addLiquidityParams.tickLower} - ${addLiquidityParams.tickUpper}
      Recipient: ${addLiquidityParams.recipient}
      Fee: ${addLiquidityParams.fee}
    `);

    // Add new liquidity with adjusted range
    const tokenId = await this.uniswapLpService.addLiquidity(addLiquidityParams);
    this.WBTC_USDC_POSITION_ID = tokenId;
    this.logger.log(`Uniswap LP: Successfully added new liquidity, token ID: ${tokenId}`);

    // Update rebalancing state
    this.lastLpRebalance = Date.now();
    this.lpRebalanceCount++;

    this.logger.log(`Uniswap LP rebalancing completed successfully:
      Action: ${action}
      New WBTC amount: ${newWbtcAmount.toFixed(6)}
      New USDC amount: ${newUsdcAmount.toFixed(2)}
      Total rebalances: ${this.lpRebalanceCount}
    `);
  }

  private async checkAerodromeLpRebalancing(currentPrice: number, position: any) {
    const tickLower = Number(position.tickLower);
    const tickUpper = Number(position.tickUpper);
    
    const lowerPrice = Math.pow(1.0001, tickLower);
    const upperPrice = Math.pow(1.0001, tickUpper);
    
    this.logger.log(`Aerodrome LP Lower price: ${lowerPrice}, upper price: ${upperPrice}, current price: ${currentPrice}`);

    const pricePosition = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);

    const timeSinceLastRebalance = Date.now() - this.lastAerodromeLpRebalance;
    if (timeSinceLastRebalance < this.LP_REBALANCE_COOLDOWN) {
      this.logger.log('Aerodrome LP rebalancing still in cooldown period');
      return;
    }

    let rebalancingNeeded = false;
    let rebalancingAction = '';

    if (
      pricePosition <= this.LP_REBALANCE_BOUNDARY_THRESHOLD ||
      pricePosition >= (1 - this.LP_REBALANCE_BOUNDARY_THRESHOLD)
    ) {
      rebalancingNeeded = true;
      rebalancingAction = 'boundary_rebalance';
      this.logger.log(`Aerodrome LP rebalancing triggered: Price near range boundary (${(pricePosition * 100).toFixed(1)}% of range)`);
    } else {
      this.logger.log(`Aerodrome LP rebalancing not needed: Price not near range boundary (${(pricePosition * 100).toFixed(1)}% of range)`);
    }
    
    const isLiquidityZero = Number(position.liquidityAmount) === 0;
    const isOutOfRange = currentPrice < lowerPrice || currentPrice > upperPrice;

    if (isOutOfRange) {
      if (!this.aerodromeOutOfRangeStartTime) {
        this.aerodromeOutOfRangeStartTime = Date.now();
      } else if (Date.now() - this.aerodromeOutOfRangeStartTime > 60 * 60 * 1000) {
        rebalancingNeeded = true;
        rebalancingAction = 'out_of_range_rebalance';
        this.logger.log(`Aerodrome LP rebalancing triggered: Price out of range for >1 hour`);
      }
    } else {
      this.aerodromeOutOfRangeStartTime = null;
    }

    if (isLiquidityZero) {
      rebalancingNeeded = true;
      rebalancingAction = 'zero_liquidity_rebalance';
    }

    this.logger.log(`Aerodrome LP rebalancing needed: ${rebalancingNeeded}, action: ${rebalancingAction}`);

    if (rebalancingNeeded) {
      await this.executeAerodromeLpRebalancing(rebalancingAction, position);
    }
  }

  private async executeAerodromeLpRebalancing(action: string, position: any) {
    this.logger.log(`Executing Aerodrome LP rebalancing: ${action}`);
    
    try {
      if (Number(position.liquidityAmount) > 0) {
        this.logger.log('Aerodrome LP: Removing current liquidity...');
        const removeLiquidityTxHash = await this.aerodromeService.removeLiquidity(
          position.tokenId,
          position.liquidityAmount,
          position.poolAddress,
        );
        this.logger.log(`Aerodrome LP: Successfully removed current liquidity: ${removeLiquidityTxHash}`);
      }

      this.logger.log('Aerodrome LP: Collecting fees...');
      const collectFeesTxHash = await this.aerodromeService.collectFees(position.tokenId);
      this.logger.log(`Aerodrome LP: Fees collected: ${collectFeesTxHash}`);

      this.lastAerodromeLpRebalance = Date.now();
      this.aerodromeLpRebalanceCount++;

      this.logger.log(`Aerodrome LP rebalancing completed successfully:
        Action: ${action}
        Total rebalances: ${this.aerodromeLpRebalanceCount}
      `);
    } catch (error) {
      this.logger.error(`Failed to execute Aerodrome LP rebalancing: ${error.message}`);
      throw error;
    }
  }

  private async exitPosition() {
    try {
      // Get current position
      const position = await this.uniswapLpService.getPosition(this.WBTC_USDC_POSITION_ID);
      
      // Remove all liquidity
      await this.uniswapLpService.removeLiquidity({
        tokenId: this.WBTC_USDC_POSITION_ID,
        liquidity: position.liquidity,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      });

      // Close Hyperliquid hedge position
      await this.hyperliquidService.closePosition('BTC', false);

      // Reset strategy state
      this.currentHedgeLeverage = 1;
      this.outOfRangeStartTime = null;

      this.logger.log('Successfully exited position');
    } catch (error) {
      this.logger.error(`Error exiting position: ${error.message}`);
    }
  }

  onApplicationShutdown() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }
}
