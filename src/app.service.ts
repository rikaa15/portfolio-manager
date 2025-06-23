import { Injectable, Logger } from '@nestjs/common';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import { Config } from './config/configuration';
import { ethers } from 'ethers';
import { FundingService } from './funding/funding.service';
import * as moment from 'moment';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly WBTC_USDC_POSITION_ID: string;
  private readonly MONITORING_INTERVAL = 60 * 60 * 1000; // 60 minutes
  private readonly FEE_COLLECTION_THRESHOLD = 100 // 100 USDC worth of fees
  private readonly FEE_COLLECTION_GAS_THRESHOLD = 5 // 5 USDC worth of gas fees
  
  // Strategy parameters from backtesting
  private readonly PRICE_RANGE_PERCENT = 0.10; // 10% price range
  private readonly TARGET_HEDGE_RATIO = 0.5; // 50% hedge ratio
  private readonly MAX_HEDGE_RATIO = 0.75; // 75% maximum hedge ratio
  private readonly MIN_HEDGE_RATIO = 0.3; // 30% minimum hedge ratio
  private readonly MAX_LEVERAGE = 2; // Maximum allowed leverage
  private readonly MIN_LEVERAGE = 0.5; // Minimum allowed leverage
  private readonly MAX_MARGIN_USAGE = 0.75; // 75% max margin usage
  private readonly LIQUIDATION_BUFFER = 0.85; // 85% liquidation buffer
  private readonly FUNDING_RATE_THRESHOLD = 0.001; // 0.1% per 8h funding rate threshold
  private readonly GAS_THRESHOLD = 20; // $20 gas threshold
  private readonly OUT_OF_RANGE_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours in ms
  private readonly REBALANCE_THRESHOLD = 0.05; // 5% deviation from target ratio
  private readonly MAX_POSITION_ADJUSTMENT = 0.1; // Maximum 10% position size adjustment per day

  // LP Rebalancing parameters
  private readonly LP_TARGET_POSITION_VALUE = 50 // $70 amount of WBTC in LP position
  private readonly LP_REBALANCE_GAS_LIMIT = 10; // $10 gas limit for rebalancing
  private readonly LP_REBALANCE_COOLDOWN = 4 * 60 * 60 * 1000; // 4 hours between rebalances
  private readonly LP_REBALANCE_MAX_SIZE = 0.20; // 20% max position change per rebalance
  private readonly LP_REBALANCE_BOUNDARY_THRESHOLD = 0.02; // 2% from range boundary

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
    private readonly configService: ConfigService<Config>,
  ) {
    this.WBTC_USDC_POSITION_ID = this.configService.get('uniswap').positionId;
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
      const positionStartDate = '2025-06-15';
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

      // Check if LP position needs rebalancing based on price position
      try {
        this.logger.log('Checking LP rebalancing...');
        await this.checkLpRebalancing(currentPrice, position);
      } catch (error) {
        this.logger.error(`Error checking LP rebalancing: ${error.message}`);
        throw error;
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
      const ratioDeviation = Math.abs(wbtcRatio - 0.5);
      
      // Calculate BTC delta from LP position
      const lpBtcDelta = wbtcAmount;
      
      // Calculate BTC delta from hedge position
      let hedgeBtcDelta = 0;
      const currentHedgePosition = await this.hyperliquidService.getUserPosition('BTC');
      if (currentHedgePosition && currentHedgePosition.position) {
        hedgeBtcDelta = -Number(currentHedgePosition.position.szi); // Negative because it's a short position
      }
      
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

      // Calculate target hedge size based on position value and price position in range
      const pricePosition = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);
      let targetHedgeRatio = this.TARGET_HEDGE_RATIO;

      // Dynamic hedge scaling based on price position in range
      if (inRange) {
        if (pricePosition > 0.7) {
          targetHedgeRatio = Math.min(this.MAX_HEDGE_RATIO, this.TARGET_HEDGE_RATIO * 1.2);
        } else if (pricePosition < 0.3) {
          targetHedgeRatio = Math.max(this.MIN_HEDGE_RATIO, this.TARGET_HEDGE_RATIO * 0.8);
        }
      }

      const targetHedgeSize = positionValue * targetHedgeRatio;

      // Adjust hedge based on conditions
      if (Math.abs(impermanentLoss) > 1 || ratioDeviation > this.REBALANCE_THRESHOLD) {
        const timeSinceLastRebalance = Date.now() - this.lastHedgeRebalance;
        if (timeSinceLastRebalance >= 4 * 60 * 60 * 1000) { // 4 hours minimum between rebalances
          const adjustmentFactor = Math.min(
            Math.abs(impermanentLoss) / 100,
            this.MAX_POSITION_ADJUSTMENT
          );

          // Calculate new hedge size and leverage
          let newHedgeSize = targetHedgeSize;
          if (impermanentLoss < 0) {
            newHedgeSize *= (1 + adjustmentFactor);
            this.currentHedgeLeverage = Math.min(this.currentHedgeLeverage * 1.1, this.MAX_LEVERAGE);
          } else {
            newHedgeSize *= (1 - adjustmentFactor);
            this.currentHedgeLeverage = Math.max(this.currentHedgeLeverage * 0.9, this.MIN_LEVERAGE);
          }

          // Apply hedge size limits
          const maxHedgeSize = positionValue * this.MAX_HEDGE_RATIO;
          const finalHedgeSize = Math.min(newHedgeSize, maxHedgeSize);

          this.lastHedgeRebalance = Date.now();
        }
      }

      // Monitor funding rates and adjust position
      if (currentFundingRate > this.FUNDING_RATE_THRESHOLD) {
        // Calculate funding costs (8-hour rate * 3 for daily rate * hedge size * leverage)
        const dailyFundingCost = currentFundingRate * 3 * targetHedgeSize * this.currentHedgeLeverage;
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
        Target Hedge Size: $${targetHedgeSize.toFixed(2)}
        Current Hedge Leverage: ${this.currentHedgeLeverage.toFixed(1)}x
        Current Funding Rate: ${(currentFundingRate * 100).toFixed(4)}%
        BTC Delta Metrics:
        - LP BTC size: ${lpBtcDelta.toFixed(4)} BTC
        - Hedge BTC size: ${hedgeBtcDelta.toFixed(4)} BTC
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
      
      // Start with base hedge size based on WBTC value in LP pool
      let hedgeSize = wbtcPositionValue * this.TARGET_HEDGE_RATIO;
      
      // Adjust hedge size based on price position in range
      if (inRange) {
        const pricePosition = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);
        if (pricePosition > 0.7) {
          // Increase hedge as price approaches upper range
          hedgeSize *= 1.2;
        } else if (pricePosition < 0.3) {
          // Decrease hedge as price approaches lower range
          hedgeSize *= 0.8;
        }
      }

      // Ensure hedge size doesn't exceed maximum allowed
      const maxHedgeSize = wbtcPositionValue * this.MAX_HEDGE_RATIO;
      hedgeSize = Math.min(hedgeSize, maxHedgeSize);

      // Check if we need to adjust the hedge position
      let needsHedgeAdjustment = !currentHedgePosition || 
        !currentHedgePosition.position || 
        parseFloat(currentHedgePosition.position.szi) === 0 ||
        Math.abs(wbtcRatio - 0.5) > 0.05 || // >5% deviation from 50/50
        currentFundingRate > this.FUNDING_RATE_THRESHOLD; // High funding rate

      // Additional check: compare current hedge size with calculated hedge size
      if (currentHedgePosition && currentHedgePosition.position && parseFloat(currentHedgePosition.position.szi) !== 0) {
        const currentHedgeSize = parseFloat(currentHedgePosition.position.positionValue);
        const hedgeSizeDifference = Math.abs(currentHedgeSize - hedgeSize);
        const hedgeSizeDifferencePercent = (hedgeSizeDifference / hedgeSize) * 100;
        
        // Only adjust if difference is more than 15%
        const hedgeAdjustmentThreshold = 7;
        if (hedgeSizeDifferencePercent <= hedgeAdjustmentThreshold) {
          needsHedgeAdjustment = false;
          this.logger.log(`Hedge adjustment skipped: current size $${currentHedgeSize.toFixed(2)} vs target $${hedgeSize.toFixed(2)} (${hedgeSizeDifferencePercent.toFixed(1)}% difference <= ${hedgeAdjustmentThreshold}% threshold)`);
        } else {
          this.logger.log(`Hedge adjustment needed: current size $${currentHedgeSize.toFixed(2)} vs target $${hedgeSize.toFixed(2)} (${hedgeSizeDifferencePercent.toFixed(1)}% difference > ${hedgeAdjustmentThreshold}% threshold)`);
        }
      }

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
        const collateral = hedgeSize / targetLeverage;
        
        // Check margin usage
        const marginUsage = targetLeverage * (collateral / positionValue);
        if (marginUsage <= this.MAX_MARGIN_USAGE) {
          this.logger.log(`Adjusting hedge position:
            Current BTC Exposure: ${(wbtcRatio * 100).toFixed(2)}%
            Target Hedge Size: $${hedgeSize.toFixed(2)}
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
      const hedgeMarginUsage = this.currentHedgeLeverage * hedgeSize / positionValue;
      if (hedgeMarginUsage > this.LIQUIDATION_BUFFER) {
        this.logger.warn('Position approaching liquidation buffer, reducing leverage');
        this.currentHedgeLeverage = Math.max(this.MIN_LEVERAGE, this.currentHedgeLeverage * 0.7);
        await this.hyperliquidService.openPosition({
          coin: 'BTC',
          isLong: false,
          leverage: this.currentHedgeLeverage,
          collateral: hedgeSize / this.currentHedgeLeverage,
        });
      }

      try {
        if(totalFeesValue > 0) {
          await this.collectFees(totalFeesValue);
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
    if (timeSinceLastRebalance < this.LP_REBALANCE_COOLDOWN) {
      this.logger.log('LP rebalancing still in cooldown period');
      return; // Still in cooldown period
    }

    let rebalancingNeeded = false;
    let rebalancingAction = '';
    let newRangePercent = 0.10; // Default 10% range

    // Scenario 1: Price near upper or lower range boundary (98-100% of range)
    if (pricePosition <= this.LP_REBALANCE_BOUNDARY_THRESHOLD || pricePosition >= (1 - this.LP_REBALANCE_BOUNDARY_THRESHOLD)) {
      rebalancingNeeded = true;
      rebalancingAction = 'boundary_rebalance';
      newRangePercent = 0.10; // Current price ± 10%
      this.logger.log(`LP rebalancing triggered: Price near range boundary (${(pricePosition * 100).toFixed(1)}% of range)`);
    } else {
      this.logger.log(`LP rebalancing not needed: Price not near range boundary (${(pricePosition * 100).toFixed(1)}% of range)`);
    }
    
    // Scenario 2: Price out of range (>1 hour)
    const isOutOfRange = currentPrice < lowerPrice || currentPrice > upperPrice;
    if (isOutOfRange) {
      if (!this.outOfRangeStartTime) {
        this.outOfRangeStartTime = Date.now();
      } else if (Date.now() - this.outOfRangeStartTime > 60 * 60 * 1000) { // 1 hour
        rebalancingNeeded = true;
        rebalancingAction = 'out_of_range_rebalance';
        newRangePercent = 0.10; // Current price ± 10%
        this.logger.log(`LP rebalancing triggered: Price out of range for >1 hour`);
      }
    } else {
      this.outOfRangeStartTime = null;
    }

    this.logger.log(`LP rebalancing needed: ${rebalancingNeeded}, action: ${rebalancingAction}`);

    if (rebalancingNeeded) {
      await this.executeLpRebalancing(currentPrice, newRangePercent, rebalancingAction);
    }
  }

  private async executeLpRebalancing(currentPrice: number, newRangePercent: number, action: string) {
    this.logger.log(`Executing LP rebalancing: ${action}`);
    
    // Get current position
    const position = await this.uniswapLpService.getPosition(this.WBTC_USDC_POSITION_ID);
    
    // Calculate new price range
    const newLowerPrice = currentPrice * (1 - newRangePercent / 2);
    const newUpperPrice = currentPrice * (1 + newRangePercent / 2);
    
    // Convert prices to ticks
    const newTickLower = Math.floor(Math.log(newLowerPrice) / Math.log(1.0001));
    const newTickUpper = Math.ceil(Math.log(newUpperPrice) / Math.log(1.0001));

    this.logger.log(`Rebalancing LP position:
      Current range: ${(1.0001 ** Number(position.tickLower)).toFixed(2)} - ${(1.0001 ** Number(position.tickUpper)).toFixed(2)}
      New range: ${newLowerPrice.toFixed(2)} - ${newUpperPrice.toFixed(2)}
      Action: ${action}
    `);

    if(Number(position.liquidity) > 0) {
      // Remove current liquidity
      this.logger.log('LP: Removing current liquidity...');
      await this.uniswapLpService.removeLiquidity({
        tokenId: this.WBTC_USDC_POSITION_ID,
        liquidity: position.liquidity,
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      });
      this.logger.log('LP: Successfully removed current liquidity');
    }

    // Calculate new liquidity amounts based on target position value
    const targetWbtcValue = this.LP_TARGET_POSITION_VALUE / 2;
    const targetUsdcValue = this.LP_TARGET_POSITION_VALUE / 2;
    
    const newWbtcAmount = targetWbtcValue / currentPrice;
    const newUsdcAmount = targetUsdcValue;

    // Add new liquidity with adjusted range
    await this.uniswapLpService.addLiquidity({
      token0: position.token0,
      token1: position.token1,
      fee: Number(position.fee),
      tickLower: newTickLower,
      tickUpper: newTickUpper,
      amount0Desired: ethers.parseUnits(newWbtcAmount.toFixed(position.token0.decimals), position.token0.decimals),
      amount1Desired: ethers.parseUnits(newUsdcAmount.toFixed(position.token1.decimals), position.token1.decimals),
      amount0Min: ethers.parseUnits((newWbtcAmount * 0.99).toFixed(position.token0.decimals), position.token0.decimals), // 1% slippage
      amount1Min: ethers.parseUnits((newUsdcAmount * 0.99).toFixed(position.token1.decimals), position.token1.decimals), // 1% slippage
      recipient: await this.uniswapLpService.getSignerAddress(),
      deadline: Math.floor(Date.now() / 1000) + 3600,
    });

    // Update rebalancing state
    this.lastLpRebalance = Date.now();
    this.lpRebalanceCount++;

    this.logger.log(`LP rebalancing completed successfully:
      Action: ${action}
      New WBTC amount: ${newWbtcAmount.toFixed(6)}
      New USDC amount: ${newUsdcAmount.toFixed(2)}
      Total rebalances: ${this.lpRebalanceCount}
    `);
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
