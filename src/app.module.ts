import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { AppConfigModule } from './config/config.module';
import { FundingService } from './funding/funding.service';

@Module({
  imports: [AppConfigModule],
  controllers: [AppController],
  providers: [AppService, HyperliquidService, UniswapLpService, FundingService],
})
export class AppModule {}
