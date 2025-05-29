import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { AppConfigModule } from './config/config.module';

@Module({
  imports: [AppConfigModule],
  controllers: [AppController],
  providers: [AppService, HyperliquidService, UniswapLpService],
})
export class AppModule {}
