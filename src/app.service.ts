import { Injectable, Logger } from '@nestjs/common';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import { Config } from './config/configuration';
import { ethers } from 'ethers';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly WBTC_USDC_POSITION_ID = '999399';
  private readonly MONITORING_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly FEE_COLLECTION_THRESHOLD = ethers.parseUnits('100', 6); // 100 USDC worth of fees
  
  // Strategy parameters
  private readonly PRICE_RANGE_PERCENT = 0.10; // 10% price range
  private readonly TARGET_HEDGE_RATIO = 0.5; // 50% hedge ratio
  private readonly MAX_MARGIN_USAGE = 0.75; // 75% max margin usage
  private readonly FUNDING_RATE_THRESHOLD = 0.001; // 0.1% per 8h funding rate threshold
  private readonly GAS_THRESHOLD = 20; // $20 gas threshold
  private readonly OUT_OF_RANGE_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours in ms
  private readonly FUNDING_TO_FEES_THRESHOLD = 0.2; // 20% funding to fees ratio
  private readonly CONSECUTIVE_HIGH_FUNDING_DAYS = 3;
  private readonly REBALANCE_THRESHOLD = 0.05; // 5% deviation from target ratio

  // Strategy state
  private outOfRangeStartTime: number | null = null;
  private consecutiveHighFundingDays = 0;
  private weeklyFees = 0;
  private weeklyFundingCosts = 0;
  private lastWeekReset = Date.now();
  private monitoringInterval: NodeJS.Timeout;

  constructor(
    private readonly uniswapLpService: UniswapLpService,
    private readonly hyperliquidService: HyperliquidService,
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
      
      // Get current pool price
      const poolPrice = await this.uniswapLpService.getPoolPrice(position.token0.address);
      const currentPrice = poolPrice.token0ToToken1Rate;

      // Calculate position metrics
      const wbtcAmount = ethers.formatUnits(position.token0Balance, 8);
      const usdcAmount = ethers.formatUnits(position.token1Balance, 6);
      const positionValue = Number(wbtcAmount) * currentPrice + Number(usdcAmount);
      
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
      const usdcFees = ethers.getBigInt(position.token1Balance);
      if (usdcFees >= this.FEE_COLLECTION_THRESHOLD) {
        await this.collectFees();
        this.weeklyFees += Number(ethers.formatUnits(usdcFees, 6));
      }

      // Calculate target hedge size based on position value and price position in range
      const pricePosition = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);
      let targetHedgeRatio = this.TARGET_HEDGE_RATIO;

      // Dynamic hedge scaling based on price position in range
      if (inRange) {
        if (pricePosition > 0.7) {
          targetHedgeRatio = 0.7; // Increase hedge as price approaches upper range
        } else if (pricePosition < 0.3) {
          targetHedgeRatio = 0.3; // Decrease hedge as price approaches lower range
        }
      }

      const targetHedgeSize = positionValue * targetHedgeRatio;

      // TODO: Get current hedge position size from Hyperliquid
      // const currentHedgeSize = await this.hyperliquidService.getPositionSize();
      const currentHedgeSize = 0; // Placeholder

      // Check if rebalance is needed
      const hedgeDeviation = Math.abs(currentHedgeSize - targetHedgeSize) / targetHedgeSize;
      
      if (hedgeDeviation > this.REBALANCE_THRESHOLD) {
        // Get gas price from config service
        const rpcUrl = this.configService.get('ethereum.rpcUrl', { infer: true });
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const gasPrice = await provider.getFeeData();
        const gasPriceInUSD = Number(ethers.formatUnits(gasPrice.gasPrice, 'gwei')) * 0.00005; // Approximate USD cost per gas unit

        if (gasPriceInUSD <= this.GAS_THRESHOLD) {
          // TODO: Adjust Hyperliquid hedge position
          this.logger.log(`Rebalancing hedge position to ${targetHedgeSize} USD`);
          /*
          await this.hyperliquidService.adjustPosition({
            size: targetHedgeSize,
            leverage: Math.min(1 / this.MAX_MARGIN_USAGE, 10) // Cap leverage at 10x
          });
          */
        } else {
          this.logger.warn(`Skipping rebalance due to high gas price: $${gasPriceInUSD}`);
        }
      }

      // Monitor funding rates
      // TODO: Get actual funding rate from Hyperliquid
      // const fundingRate = await this.hyperliquidService.getFundingRate();
      const fundingRate = 0; // Placeholder

      if (fundingRate > this.FUNDING_RATE_THRESHOLD) {
        this.consecutiveHighFundingDays++;
        // Accumulate funding costs (simplified calculation)
        this.weeklyFundingCosts += currentHedgeSize * fundingRate;
      } else {
        this.consecutiveHighFundingDays = 0;
      }

      // Check weekly metrics reset
      if (Date.now() - this.lastWeekReset >= 7 * 24 * 60 * 60 * 1000) {
        const fundingToFeesRatio = this.weeklyFundingCosts / this.weeklyFees;
        
        // Check if funding costs are too high relative to fees
        if (this.consecutiveHighFundingDays >= this.CONSECUTIVE_HIGH_FUNDING_DAYS &&
            fundingToFeesRatio > this.FUNDING_TO_FEES_THRESHOLD) {
          this.logger.warn('Closing hedge due to excessive funding costs');
          // TODO: Close Hyperliquid hedge position
          // await this.hyperliquidService.closePosition();
        }

        // Reset weekly tracking
        this.weeklyFees = 0;
        this.weeklyFundingCosts = 0;
        this.lastWeekReset = Date.now();
      }

      // Log position metrics
      this.logger.log('Position Metrics:');
      this.logger.log(`WBTC Amount: ${wbtcAmount}`);
      this.logger.log(`USDC Amount: ${usdcAmount}`);
      this.logger.log(`Position Value: $${positionValue.toFixed(2)}`);
      this.logger.log(`Current Price: $${currentPrice.toFixed(2)}`);
      this.logger.log(`Price Range: $${lowerPrice.toFixed(2)} - $${upperPrice.toFixed(2)}`);
      this.logger.log(`Target Hedge Size: $${targetHedgeSize.toFixed(2)}`);
      this.logger.log(`Weekly Fees: $${this.weeklyFees.toFixed(2)}`);
      this.logger.log(`Weekly Funding Costs: $${this.weeklyFundingCosts.toFixed(2)}`);

    } catch (error) {
      this.logger.error(`Error monitoring position: ${error.message}`);
    }
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

      // TODO: Close Hyperliquid hedge position
      // await this.hyperliquidService.closePosition();

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
