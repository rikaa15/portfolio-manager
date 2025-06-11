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
  private readonly WBTC_USDC_POSITION_ID = '1006358';
  private readonly MONITORING_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly FEE_COLLECTION_THRESHOLD = ethers.parseUnits('100', 6); // 100 USDC worth of fees
  
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
  private readonly FUNDING_TO_FEES_THRESHOLD = 0.2; // 20% funding to fees ratio
  private readonly CONSECUTIVE_HIGH_FUNDING_DAYS = 3;
  private readonly REBALANCE_THRESHOLD = 0.05; // 5% deviation from target ratio
  private readonly MAX_POSITION_ADJUSTMENT = 0.1; // Maximum 10% position size adjustment per day

  // Strategy state
  private outOfRangeStartTime: number | null = null;
  private consecutiveHighFundingDays = 0;
  private weeklyFees = 0;
  private weeklyFundingCosts = 0;
  private lastWeekReset = Date.now();
  private monitoringInterval: NodeJS.Timeout;
  private lastHedgeValue = 0;
  private lastHedgeRebalance = Date.now();
  private currentHedgeLeverage = 1;

  constructor(
    private readonly uniswapLpService: UniswapLpService,
    private readonly hyperliquidService: HyperliquidService,
    private readonly fundingService: FundingService,
    private readonly configService: ConfigService<Config>,
  ) {}

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
      console.log('position:', position);

      // TODO: get from subgraph / api
      const positionStartDate = '2025-06-10';
      const positionEndDate = moment().format('YYYY-MM-DD');
      const poolPriceHistory = await this.uniswapLpService.getPoolPriceHistory(positionStartDate, positionEndDate, 'daily');
      if(poolPriceHistory.length === 0) {
        this.logger.error('No pool price history found');
        return;
      }
      const initialPrice = poolPriceHistory[0].token1Price;
      const currentPrice = poolPriceHistory[poolPriceHistory.length - 1].token1Price;
      this.logger.log(`Pool price history: ${
        poolPriceHistory.length
      } days, initial BTC price: ${
        initialPrice
      }, current price: ${
        currentPrice
      }`);

      // Calculate impermanent loss
      const impermanentLoss = this.calculateImpermanentLoss(currentPrice, initialPrice);
  
      // Get current pool price
      // const poolPrice = await this.uniswapLpService.getPoolPrice();
      // console.log('poolPrice:', poolPrice);
      // const currentPrice = poolPrice.token0ToToken1Rate;
      // console.log('currentPrice:', currentPrice);

      // Calculate position metrics
      const wbtcAmount = Number(ethers.formatUnits(position.token0Balance, position.token0.decimals));
      const usdcAmount = Number(ethers.formatUnits(position.token1Balance, position.token1.decimals));
      const positionValue = wbtcAmount * currentPrice + usdcAmount;
      
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

      // Check if fees need to be collected
      const earnedFees = await this.uniswapLpService.getEarnedFees(Number(this.WBTC_USDC_POSITION_ID));  
      const btcFees = ethers.parseUnits(earnedFees.token0Fees, position.token0.decimals); // btc
      const usdcFees = ethers.parseUnits(earnedFees.token1Fees, position.token1.decimals); // usdc
      // if (token1Fees >= this.FEE_COLLECTION_THRESHOLD) {
      //   await this.collectFees();
      //   this.weeklyFees += Number(ethers.formatUnits(usdcFees, 6));
      // }

      // Calculate token ratios for rebalancing
      const wbtcValue = wbtcAmount * currentPrice;
      const wbtcRatio = wbtcValue / positionValue;
      const ratioDeviation = Math.abs(wbtcRatio - 0.5);

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
          console.log('finalHedgeSize:', finalHedgeSize);

          this.lastHedgeRebalance = Date.now();
        }
      }

      // Monitor funding rates and adjust position
      if (currentFundingRate > this.FUNDING_RATE_THRESHOLD) {
        this.consecutiveHighFundingDays++;
        // Calculate funding costs (8-hour rate * 3 for daily rate * hedge size * leverage)
        const dailyFundingCost = currentFundingRate * 3 * targetHedgeSize * this.currentHedgeLeverage;
        this.weeklyFundingCosts += dailyFundingCost;
      } else {
        this.consecutiveHighFundingDays = 0;
      }

      // Weekly metrics check
      if (Date.now() - this.lastWeekReset >= 7 * 24 * 60 * 60 * 1000) {
        const fundingToFeesRatio = this.weeklyFundingCosts / this.weeklyFees;
        
        // Check if funding costs are too high relative to fees
        if (this.consecutiveHighFundingDays >= this.CONSECUTIVE_HIGH_FUNDING_DAYS &&
            fundingToFeesRatio > this.FUNDING_TO_FEES_THRESHOLD) {
          this.logger.warn('Closing hedge due to excessive funding costs');
          await this.hyperliquidService.closePosition('BTC', false);
          this.currentHedgeLeverage = 1; // Reset leverage
        }

        // Reset weekly tracking
        this.weeklyFees = 0;
        this.weeklyFundingCosts = 0;
        this.lastWeekReset = Date.now();
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
        Weekly Fees: $${this.weeklyFees.toFixed(2)}
        Weekly Funding Costs: $${this.weeklyFundingCosts.toFixed(2)}
        Current Funding Rate: ${(currentFundingRate * 100).toFixed(4)}%
      `);

      // Check current hedge position
      const positionData = await this.hyperliquidService.getUserPosition('BTC');
      this.logger.log(`Current hedge position: ${JSON.stringify(positionData)}`);

      // Check liquidation risk
      const hedgeMarginUsage = this.currentHedgeLeverage * targetHedgeSize / positionValue;
      if (hedgeMarginUsage > this.LIQUIDATION_BUFFER) {
        this.logger.warn('Position approaching liquidation buffer, reducing leverage');
        this.currentHedgeLeverage = Math.max(this.MIN_LEVERAGE, this.currentHedgeLeverage * 0.7);
        await this.hyperliquidService.openPosition({
          coin: 'BTC',
          isLong: false,
          leverage: this.currentHedgeLeverage,
          collateral: targetHedgeSize / this.currentHedgeLeverage,
        });
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

  private async collectFees() {
    try {
      const recipientAddress = await this.uniswapLpService.getSignerAddress();
      
      await this.uniswapLpService.collectFees({
        tokenId: this.WBTC_USDC_POSITION_ID,
        recipient: recipientAddress,
        amount0Max: ethers.MaxUint256, // Collect all WBTC fees
        amount1Max: ethers.MaxUint256, // Collect all USDC fees
      });

      this.logger.log('Successfully collected fees');
    } catch (error) {
      this.logger.error(`Error collecting fees: ${error.message}`);
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
      this.weeklyFees = 0;
      this.weeklyFundingCosts = 0;
      this.consecutiveHighFundingDays = 0;
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
