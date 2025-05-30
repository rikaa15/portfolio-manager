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
  private monitoringInterval: NodeJS.Timeout;

  constructor(
    private readonly uniswapLpService: UniswapLpService,
    private readonly hyperliquidService: HyperliquidService,
    private readonly configService: ConfigService<Config>,
  ) {}

  async bootstrap() {
    this.logger.log('Starting BTC/USDC LP strategy...');
    
    try {
      // Initial position check
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

  async onApplicationShutdown() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }

  private async monitorPosition() {
    try {
      // Get current position state
      const position = await this.uniswapLpService.getPosition(this.WBTC_USDC_POSITION_ID);
      
      // Check if fees need to be collected
      const usdcFees = ethers.getBigInt(position.token1Balance); // USDC is token
      if (usdcFees >= this.FEE_COLLECTION_THRESHOLD) {
        await this.collectFees();
      }

      // Calculate position metrics for hedging
      const wbtcAmount = ethers.formatUnits(position.token0Balance, 8);
      const usdcAmount = ethers.formatUnits(position.token1Balance, 6);
      
      this.logger.log('Position Metrics:');
      this.logger.log(`WBTC Amount: ${wbtcAmount}`);
      this.logger.log(`USDC Amount: ${usdcAmount}`);
      
      // TODO: Implement hedging logic with Hyperliquid
      // This will be implemented once we have more details about the
      // Hyperliquid integration and hedging strategy requirements

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
}
