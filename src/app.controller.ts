import { Controller, Get, Param } from '@nestjs/common';
import { AppService } from './app.service';
import { AerodromeLpService } from './aerodrome/aerodrome.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly aerodromeService: AerodromeLpService,
  ) {}

  @Get()
  getRoot() {
    return {
      message: 'Portfolio Manager API',
      version: '1.0.0',
      endpoints: [
        'GET /aerodrome/status - Get overview of all Aerodrome positions',
        'GET /aerodrome/positions - Get all positions',
        'GET /aerodrome/position/:poolAddress - Get specific position'
      ]
    };
  }

  @Get('aerodrome/positions')
  async getAerodromePositions() {
    const signerAddress = await this.aerodromeService.getSignerAddress();
    return this.aerodromeService.getPositionsByOwner(signerAddress);
  }

  @Get('aerodrome/position/:poolAddress')
  async getAerodromePosition(@Param('poolAddress') poolAddress: string) {
    const signerAddress = await this.aerodromeService.getSignerAddress();
    return this.aerodromeService.getPosition(signerAddress, poolAddress);
  }

  @Get('aerodrome/status')
  async getAerodromeStatus() {
    const signerAddress = await this.aerodromeService.getSignerAddress();
    const positions = await this.aerodromeService.getPositionsByOwner(signerAddress);
    
    return {
      walletAddress: signerAddress,
      totalPositions: positions.length,
      positions: positions.map(pos => ({
        tokenId: pos.tokenId,
        pool: pos.poolAddress,
        pair: `${pos.token0Symbol}/${pos.token1Symbol}`,
        liquidity: `${pos.token0Balance} ${pos.token0Symbol} + ${pos.token1Balance} ${pos.token1Symbol}`,
        isStaked: pos.isStaked,
        pendingRewards: pos.pendingAeroRewards
      }))
    };
  }
}
