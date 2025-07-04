import { Injectable, Logger } from '@nestjs/common';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { AerodromeLpService } from './aerodrome/aerodrome.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import { Config } from './config/configuration';
import { ethers } from 'ethers';
import { FundingService } from './funding/funding.service';
import * as moment from 'moment';
import { getTokenPrice } from './aerodrome/coingecko.client';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private POSITION_ID: string;
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

  // Strategy state
  private outOfRangeStartTime: number | null = null;
  private monitoringInterval: NodeJS.Timeout;
  private initialHedgePnL = 0; // Hyperliquid realized PnL in USD
  private currentHedgeLeverage = 1;

  // LP Rebalancing state
  private lastLpRebalance = 0;

  constructor(
    private readonly uniswapLpService: UniswapLpService,
    private readonly aerodromeService: AerodromeLpService,
    private readonly hyperliquidService: HyperliquidService,
    private readonly fundingService: FundingService,
    private readonly configService: ConfigService<Config>,
  ) {
    this.POSITION_ID = this.configService.get('uniswap').positionId;
  }

  async bootstrap() {
    this.logger.log('Starting BTC/USDC LP strategy...');

    try {
      this.logger.log('Getting realized hedge PnL...');
      this.initialHedgePnL = await this.hyperliquidService.getRealizedPnL();
      this.logger.log(`Initial realized hedge PnL: $${this.initialHedgePnL.toFixed(2)}`);
    } catch (error) {
      this.logger.error(`Failed to get realized PnL: ${error.message}`);
      throw error;
    }
    
    try {
      // Initialize LP service based on provider selection
      const lpProvider = this.configService.get('lpProvider');
      if (lpProvider === 'aerodrome') {
        await this.aerodromeService.bootstrap();
        this.logger.log('Using Aerodrome as LP provider');
      } else {
        this.logger.log('Using Uniswap as LP provider');
      }
      
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
      this.logger.log('Getting current hedge position...');
      const currentHedgePosition = await this.hyperliquidService.getUserPosition('BTC');
  
      // Get current position state
      const position = await this.getLpPosition();
      const lpProvider = this.configService.get('lpProvider');
      this.logger.log(`${lpProvider} position:`, position);

      // TODO: get from subgraph / api
      const positionStartDate = this.configService.get('uniswap').positionCreationDate;
      const positionEndDate = moment().format('YYYY-MM-DD');
      const poolPriceHistory = await this.getPoolPriceHistory(positionStartDate, positionEndDate, 'daily');
      if(poolPriceHistory.length === 0) {
        this.logger.error('No pool price history found');
        return;
      }
      const initialPrice = poolPriceHistory[0].token1Price;
      const currentPrice = poolPriceHistory[poolPriceHistory.length - 1].token1Price;
      this.logger.log(`BTC price (initial): ${initialPrice}, current: ${currentPrice}`);

      if(this.configService.get('strategy').lpRebalanceEnabled) {
        // Check if LP position needs rebalancing based on price position
        try {
          this.logger.log('Checking LP rebalancing...');
          await this.checkLpRebalancing(currentPrice, position);
        } catch (error) {
          this.logger.error(`Error checking LP rebalancing: ${error.message}`);
          throw error;
        }
      }

      if(!this.configService.get('strategy').hedgeEnabled) {
        this.logger.log('Hedge is disabled, skipping...');
        return;
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
      if (currentHedgePosition && currentHedgePosition.position) {
        hedgeBtcDelta = -Number(currentHedgePosition.position.szi); // Negative because it's a short position
      }
      
      // Calculate net BTC delta (LP + Hedge)
      const netBtcDelta = lpBtcDelta + hedgeBtcDelta;
      const netBtcDeltaValue = netBtcDelta * currentPrice;
      
      // Calculate LP APR
      let earnedFees, btcFees, usdcFees, btcFeesValue, usdcFeesValue, totalFeesValue;
      let aeroRewardsValue = 0;
      let tradingFeesValue = 0;
      
      if (lpProvider === 'aerodrome') {
        const aerodromePosition = position as any;
        const token0FeesStr = aerodromePosition.token0Fees || '0';
        const token1FeesStr = aerodromePosition.token1Fees || '0';
        const pendingAeroRewards = aerodromePosition.pendingRewards || '0';
        
        btcFees = ethers.parseUnits(token0FeesStr, position.token0.decimals); // token0 = BTC
        usdcFees = ethers.parseUnits(token1FeesStr, position.token1.decimals); // token1 = USDC
        btcFeesValue = Number(ethers.formatUnits(btcFees, position.token0.decimals)) * currentPrice;
        usdcFeesValue = Number(ethers.formatUnits(usdcFees, position.token1.decimals));
        tradingFeesValue = btcFeesValue + usdcFeesValue;
        
        const aeroAmount = parseFloat(pendingAeroRewards);
        let aeroPrice = 0;
        
        try {
          aeroPrice = await getTokenPrice('aero', false);
        } catch (error) {
          this.logger.warn(`Failed to fetch live AERO price: ${error.message}, using fallback price`);
          try {
            aeroPrice = await getTokenPrice('aero', true);
          } catch (fallbackError) {
            this.logger.warn(`Failed to get AERO fallback price: ${fallbackError.message}, setting price to 0`);
            aeroPrice = 0;
          }
        }
        
        aeroRewardsValue = aeroAmount * aeroPrice;
      
        totalFeesValue = tradingFeesValue + aeroRewardsValue;
      } else {
        earnedFees = await this.uniswapLpService.getEarnedFees(Number(this.POSITION_ID));  
        btcFees = ethers.parseUnits(earnedFees.token0Fees, position.token0.decimals); // token0 = BTC
        usdcFees = ethers.parseUnits(earnedFees.token1Fees, position.token1.decimals); // token1 = USDC
        btcFeesValue = Number(ethers.formatUnits(btcFees, position.token0.decimals)) * currentPrice;
        usdcFeesValue = Number(ethers.formatUnits(usdcFees, position.token1.decimals));
        tradingFeesValue = btcFeesValue + usdcFeesValue;
        totalFeesValue = tradingFeesValue;
      }
      
      // Calculate time elapsed since position start
      const positionStartTime = new Date(positionStartDate).getTime();
      const timeElapsed = (Date.now() - positionStartTime) / (1000 * 60 * 60 * 24); // in days

      // Calculate APR: ((fees + hedge PnL) / position value) * (365 / days elapsed)
      const unrealizedHedgePnL = await this.hyperliquidService.getUnrealizedPnL('BTC');
      const currentHedgePnL = await this.hyperliquidService.getRealizedPnL();
      const hedgePnL = (currentHedgePnL - this.initialHedgePnL) + unrealizedHedgePnL;

      const lpAPR = timeElapsed > 0 ? (totalFeesValue / positionValue) * (365 / timeElapsed) * 100 : 0;
      const totalPositionAPR = timeElapsed > 0 ? ((totalFeesValue + hedgePnL) / positionValue) * (365 / timeElapsed) * 100 : 0;
      
      // Calculate net APR including impermanent loss
      const netApr = totalPositionAPR - Math.abs(impermanentLoss);
      
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
          this.logger.log(`${position.token0.symbol} ratio ${(wbtcRatio * 100).toFixed(1)}% > 50% target, increasing hedge by ${(adjustmentFactor * 100).toFixed(1)}%`);
        } else {
          // WBTC ratio < 50% (too much USDC exposure)
          // Decrease hedge to increase BTC exposure
          const adjustmentFactor = Math.min(Math.abs(ratioDeviation) * 2, 0.5); // Cap at 50% decrease
          targetHedgeSize = wbtcAmount * (1 - adjustmentFactor);
          this.logger.log(`${position.token0.symbol} ratio ${(wbtcRatio * 100).toFixed(1)}% < 50% target, decreasing hedge by ${(adjustmentFactor * 100).toFixed(1)}%`);
        }
      } else {
        this.logger.log(`${position.token0.symbol} ratio ${(wbtcRatio * 100).toFixed(1)}% within 5% of 50% target, no hedge adjustment needed`);
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
        ${position.token0.symbol} Amount: ${wbtcAmount}, fees: ${ethers.formatUnits(btcFees, position.token0.decimals)}
        ${position.token1.symbol} Amount: ${usdcAmount}, fees: ${ethers.formatUnits(usdcFees, position.token1.decimals)}
        Position Value: $${positionValue.toFixed(2)}
        Price Range: $${lowerPrice.toFixed(2)} - $${upperPrice.toFixed(2)}
        Initial ${position.token0.symbol} Price: $${initialPrice}
        Current ${position.token0.symbol} Price: $${currentPrice}
        Impermanent Loss: ${impermanentLoss}%
        Target Hedge Size: ${targetHedgeSize.toFixed(4)} BTC ($${targetHedgeValue.toFixed(2)})
        Current Hedge Leverage: ${this.currentHedgeLeverage.toFixed(1)}x
        Current Funding Rate: ${(currentFundingRate * 100).toFixed(4)}%
        BTC Delta Metrics:
        - LP BTC size: ${lpBtcDelta.toFixed(4)} BTC
        - Hedge BTC size: ${hedgeBtcDelta.toFixed(4)} BTC
        - Net BTC delta: $${netBtcDeltaValue.toFixed(2)} (${netBtcDelta.toFixed(4)} BTC)
        Performance Metrics:
        - LP Fees: $${totalFeesValue.toFixed(4)}${lpProvider === 'aerodrome' ? ` (${position.token0.symbol}: $${btcFeesValue.toFixed(4)} + ${position.token1.symbol}: $${usdcFeesValue.toFixed(4)} + AERO: $${aeroRewardsValue.toFixed(4)})` : ''}
        - Hedge PnL: $${hedgePnL.toFixed(2)} (initial=$${this.initialHedgePnL.toFixed(2)}, current=$${currentHedgePnL.toFixed(2)}, unrealized=$${unrealizedHedgePnL.toFixed(2)})
        - LP APR: ${lpAPR.toFixed(2)}%
        - Total Position APR (LP + Hedge): ${totalPositionAPR.toFixed(2)}%
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
        Current ${position.token0.symbol} Ratio: ${(wbtcRatio * 100).toFixed(1)}%
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
          this.logger.warn(`Skipping hedge adjustment - margin usage too high: ${(marginUsage * 100).toFixed(4)}%`);
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
        if(tradingFeesValue > 0 && lpProvider !== 'aerodrome') {
          // Only collect fees for Uniswap provider
          await this.collectFees(tradingFeesValue);
        }
      } catch (error) {
        this.logger.error(`Error collecting fees: ${error.message}`);
      }
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
        tokenId: this.POSITION_ID,
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

  /**
   * Get LP position data from either Uniswap or Aerodrome
   * Always returns BTC as token0, USDC as token1 for consistency
   */
  private async getLpPosition() {
    const lpProvider = this.configService.get('lpProvider');
    
    if (lpProvider === 'aerodrome') {
      const signerAddress = await this.aerodromeService.getSignerAddress();
      const poolAddress = this.configService.get('aerodrome').poolAddress;
      const position = await this.aerodromeService.getPosition(signerAddress, poolAddress);
      
      if (!position) {
        throw new Error(`No Aerodrome position found in pool ${poolAddress}`);
      }
      
      // Normalize Aerodrome position: always return BTC as token0, USDC as token1
      let btcBalance, usdcBalance, btcSymbol, usdcSymbol;
      let btcBalanceRaw, usdcBalanceRaw;
      let token0Fees, token1Fees;
      
      if (position.token0Symbol.toLowerCase().includes('btc')) {
        // token0 is BTC, token1 is USDC - use as-is
        btcBalance = position.token0Balance;
        usdcBalance = position.token1Balance;
        btcSymbol = position.token0Symbol;
        usdcSymbol = position.token1Symbol;
        btcBalanceRaw = ethers.parseUnits(position.token0Balance, 8).toString();
        usdcBalanceRaw = ethers.parseUnits(position.token1Balance, 6).toString();
        token0Fees = position.token0Fees; // BTC fees
        token1Fees = position.token1Fees; // USDC fees
      } else {
        // token0 is USDC, token1 is BTC - swap to normalize
        btcBalance = position.token1Balance;
        usdcBalance = position.token0Balance;
        btcSymbol = position.token1Symbol;
        usdcSymbol = position.token0Symbol;
        btcBalanceRaw = ethers.parseUnits(position.token1Balance, 8).toString();
        usdcBalanceRaw = ethers.parseUnits(position.token0Balance, 6).toString();
        token0Fees = position.token1Fees; // BTC fees (originally token1)
        token1Fees = position.token0Fees; // USDC fees (originally token0)
      }
      
      return {
        token0BalanceRaw: btcBalanceRaw,
        token1BalanceRaw: usdcBalanceRaw,
        token0Balance: `${btcBalance} ${btcSymbol}`,
        token1Balance: `${usdcBalance} ${usdcSymbol}`,
        token0: { decimals: 8, symbol: btcSymbol },
        token1: { decimals: 6, symbol: usdcSymbol },
        liquidity: position.liquidityAmount,
        isStaked: position.isStaked,
        pendingRewards: position.pendingAeroRewards,
        token0Fees,
        token1Fees,
      };
    } else {
      // Use existing Uniswap logic (already returns BTC as token0, USDC as token1)
      return await this.uniswapLpService.getPosition(this.POSITION_ID);
    }
  }

  /**
   * Get pool price history from either provider
   */
  private async getPoolPriceHistory(startDate: string, endDate: string, interval: 'daily' | 'hourly') {
    const lpProvider = this.configService.get('lpProvider');
    
    if (lpProvider === 'aerodrome') {
      // For now, use Uniswap price data as reference since both are BTC/USDC
      // TODO: Implement Aerodrome-specific price history if needed
      return await this.uniswapLpService.getPoolPriceHistory(startDate, endDate, interval);
    } else {
      return await this.uniswapLpService.getPoolPriceHistory(startDate, endDate, interval);
    }
  }

  private async exitPosition() {
    try {
      // Get current position
      const position = await this.uniswapLpService.getPosition(this.POSITION_ID);
      
      // Remove all liquidity
      await this.uniswapLpService.removeLiquidity({
        tokenId: this.POSITION_ID,
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

  private async checkLpRebalancing(currentPrice: number, position: any) {
    // Get current position range
    const tickLower = Number(position.tickLower);
    const tickUpper = Number(position.tickUpper);
    
    // Convert ticks to prices
    // price_WBTC_per_USDC = 1.0001^i * 10^(decimals_WBTC - decimals_USDC)
    const tokensDecimalsDelta = Math.abs(position.token0.decimals - position.token1.decimals);
    const lowerPrice = 1.0001 ** tickLower * Math.pow(10, tokensDecimalsDelta);
    const upperPrice = 1.0001 ** tickUpper * Math.pow(10, tokensDecimalsDelta);
    this.logger.log(`LP Lower price: ${lowerPrice}, upper price: ${upperPrice}, current price: ${currentPrice}`);

    // Calculate price position within current range
    const pricePosition = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);
    
    // Check cooldown period
    const timeSinceLastRebalance = Date.now() - this.lastLpRebalance;
    if (timeSinceLastRebalance < 1000 * 60) {
      this.logger.log('LP rebalancing still in cooldown period');
      return; // Still in cooldown period
    }

    let rebalancingNeeded = false;
    let rebalancingAction = '';
    let newRangePercent = 0.10; // Default 10% range
    
    // Scenario 2: Price out of range (>1 hour)
    const isLiquidityZero = Number(position.liquidity) === 0;
    const isOutOfRange = currentPrice < lowerPrice || currentPrice > upperPrice;

    if (isOutOfRange) {
      rebalancingNeeded = true;
      rebalancingAction = 'out_of_range_rebalance';
      this.logger.log(`LP rebalancing triggered: Price out of range`);
    }

    // test
    // await this.uniswapLpService.rebalancePosition(this.POSITION_ID, 20, 0.5, 0.005);

    if(isLiquidityZero) {
      rebalancingNeeded = true;
    }

    this.logger.log(`LP rebalancing needed: ${rebalancingNeeded}`);

    if (rebalancingNeeded) {
      await this.executeLpRebalancing(currentPrice, rebalancingAction);
    }
  }

  private async executeLpRebalancing(currentPrice: number, action: string) {
    this.logger.log(`Executing LP rebalancing: ${action}`);

    const { lpTargetPositionValue, lpRebalanceRange } =  this.configService.get('strategy');
    
    // Get current position
    const position = await this.uniswapLpService.getPosition(this.POSITION_ID);

    const tokensDecimalsDelta = Math.abs(position.token0.decimals - position.token1.decimals);
    const lowerPrice = 1.0001 ** Number(position.tickLower) * Math.pow(10, tokensDecimalsDelta);
    const upperPrice = 1.0001 ** Number(position.tickUpper) * Math.pow(10, tokensDecimalsDelta);
    
    // Calculate new price range
    const newLowerPrice = currentPrice * (1 - lpRebalanceRange / 2);
    const newUpperPrice = currentPrice * (1 + lpRebalanceRange / 2);
    
    // Convert prices to ticks
    const newTickLower = Math.floor(Math.log(newLowerPrice) / Math.log(1.0001));
    const newTickUpper = Math.ceil(Math.log(newUpperPrice) / Math.log(1.0001));

    this.logger.log(`Rebalancing LP position:
      Current range: ${lowerPrice.toFixed(2)} - ${upperPrice.toFixed(2)}
      New range: ${newLowerPrice.toFixed(2)} - ${newUpperPrice.toFixed(2)}
      Action: ${action}
    `);

    if(Number(position.liquidity) > 0) {
      // Remove current liquidity
      this.logger.log('LP: Removing current liquidity...');
      const removeLiquidityTxHash = await this.uniswapLpService.removeLiquidity({
        tokenId: this.POSITION_ID,
        liquidity: position.liquidity,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      });
      this.logger.log(`LP: Successfully removed current liquidity: ${removeLiquidityTxHash}`);

      this.logger.log('LP: Collecting fees...');
      const collectFeesTxHash = await this.uniswapLpService.collectFees({
        tokenId: this.POSITION_ID,
        recipient: await this.uniswapLpService.getSignerAddress(),
        amount0Max: ethers.parseUnits('10000000', 6),
        amount1Max: ethers.parseUnits('10000000', 6),
      });
      this.logger.log(`Fees collected: ${collectFeesTxHash}`);
    }

    // Calculate new liquidity amounts based on target position value
    const targetWbtcValue = lpTargetPositionValue / 2;
    const targetUsdcValue = lpTargetPositionValue / 2;
    
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
    const newPositionId = await this.uniswapLpService.addLiquidity(addLiquidityParams);
    this.POSITION_ID = newPositionId;
    this.logger.log(`LP: Successfully added new liquidity, position ID: ${newPositionId}`);

    // Update rebalancing state
    this.lastLpRebalance = Date.now();

    this.logger.log(`LP rebalancing completed successfully:
      Action: ${action}
      New WBTC amount: ${newWbtcAmount.toFixed(6)}
      New USDC amount: ${newUsdcAmount.toFixed(2)}
      LP position ID: ${newPositionId}
    `);
  }

  onApplicationShutdown() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }
}
