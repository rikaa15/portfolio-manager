import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { AerodromeLpService } from './aerodrome/aerodrome.service';
import { Logger } from '@nestjs/common';
import { AppService } from './app.service';
import { ConfigService } from '@nestjs/config';
import { Config } from './config/configuration';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS if needed
  app.enableCors();
  
  // Initialize services based on configuration
  const configService = app.get(ConfigService<Config>);
  const hyperliquidService = app.get(HyperliquidService);
  const appService = app.get(AppService);
  
  const lpProvider = configService.get('lpProvider');
  logger.log(`Initializing services with LP provider: ${lpProvider}...`);
  
  try {
    const initPromises = [
      hyperliquidService.bootstrap(),
      appService.bootstrap(),
    ];
    
    // Only initialize the LP service we're actually using
    if (lpProvider === 'aerodrome') {
      logger.log('Using Aerodrome LP provider');
      const aerodromeService = app.get(AerodromeLpService);
      initPromises.push(aerodromeService.bootstrap());
    } else {
      logger.log('Using Uniswap LP provider');
      const uniswapLpService = app.get(UniswapLpService);
      initPromises.push(uniswapLpService.bootstrap());
    }
    
    await Promise.all(initPromises);
    
    const port = process.env.PORT || 3000;
    await app.listen(port);
    logger.log(`Application is running on: http://localhost:${port}`);
  } catch (error) {
    logger.error(`Failed to initialize services: ${error.message}`);
    throw error;
  }
}

bootstrap();
