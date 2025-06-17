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
  private readonly WBTC_USDC_POSITION_ID = '1009421';
  private readonly MONITORING_INTERVAL = 60 * 60 * 1000; // 60 minutes
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
  private readonly REBALANCE_THRESHOLD = 0.05; // 5% deviation from target ratio
  private readonly MAX_POSITION_ADJUSTMENT = 0.1; // Maximum 10% position size adjustment per day

  // Strategy state
  private outOfRangeStartTime: number | null = null;
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
      
      // Calculate net BTC delta
      // total BTC exposure combining both LP and hedge positions
      const netBtcDelta = lpBtcDelta + hedgeBtcDelta;
      const netBtcDeltaPercent = (netBtcDelta * currentPrice / positionValue) * 100;
      this.logger.log(`Net BTC delta: ${netBtcDeltaPercent.toFixed(2)}% of position value`);
      
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
        - LP BTC Delta: ${lpBtcDelta.toFixed(4)} BTC
        - Hedge BTC Delta: ${hedgeBtcDelta.toFixed(4)} BTC
        - Net BTC Delta: ${netBtcDelta.toFixed(4)} BTC (${netBtcDeltaPercent.toFixed(2)}% of position value)
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
      const needsHedgeAdjustment = !currentHedgePosition || 
        !currentHedgePosition.position || 
        parseFloat(currentHedgePosition.position.szi) === 0 ||
        Math.abs(wbtcRatio - 0.5) > 0.05 || // >5% deviation from 50/50
        currentFundingRate > this.FUNDING_RATE_THRESHOLD; // High funding rate

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
