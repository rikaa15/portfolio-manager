import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HyperliquidService } from './hyperliquid/hyperliquid.service';
import { UniswapLpService } from './uniswap-lp/uniswap-lp.service';
import { Logger } from '@nestjs/common';
import { AppService } from './app.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS if needed
  app.enableCors();
  
  // Initialize services
  const hyperliquidService = app.get(HyperliquidService);
  const uniswapLpService = app.get(UniswapLpService);
  const appService = app.get(AppService);

  logger.log('Initializing services...');
  
  try {
    await Promise.all([
      hyperliquidService.bootstrap(),
      uniswapLpService.bootstrap(),
      appService.bootstrap(),
    ]);
    
    const port = process.env.PORT || 3000;
    await app.listen(port);
    logger.log(`Application is running on: http://localhost:${port}`);
  } catch (error) {
    logger.error(`Failed to initialize services: ${error.message}`);
    throw error;
  }
}

bootstrap();
