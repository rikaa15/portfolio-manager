import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { AppConfigModule } from './config/config.module';
import { FundingService } from './funding/funding.service';
import { BinanceService } from './binance/binance.service';

@Module({
  imports: [AppConfigModule],
  controllers: [AppController],
  providers: [AppService, HyperliquidService, UniswapLpService, FundingService, BinanceService],
})
export class AppModule {}
