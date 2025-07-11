import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AerodromeLpService } from './aerodrome.service';
import configuration from '../config/configuration';
import { ethers } from 'ethers';

const config = configuration();

const POOL_ADDRESS = '0x3e66e55e97ce60096f74b7C475e8249f2D31a9fb';

describe('AerodromeLpService Integration Tests', () => {
  let service: AerodromeLpService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AerodromeLpService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'base') {
                return config.base;
              }
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AerodromeLpService>(AerodromeLpService);
  });

  it('should get position for user and pool', async () => {
    const userAddress = process.env.WALLET_ADDRESS;
    const poolAddress = POOL_ADDRESS;

    const position = await service.getPosition(userAddress, poolAddress);

    console.log('Position result:', position);
    expect(position).toBeDefined();
  });

  it('should get all positions by owner', async () => {
    const userAddress = process.env.WALLET_ADDRESS;

    const positions = await service.getPositionsByOwner(userAddress);

    console.log(`Positions owned by ${userAddress}:`, positions);
    expect(positions).toBeDefined();
    expect(Array.isArray(positions)).toBe(true);
  });

  it('should test rebalancing logic', async () => {
    const userAddress = process.env.WALLET_ADDRESS;
    const positions = await service.getPositionsByOwner(userAddress);
    
    if (positions.length === 0) {
      console.log('No positions found for rebalancing test');
      return;
    }

    const position = positions[0];
    console.log('Testing rebalancing logic with position:', position.tokenId);
    console.log('LP_PROVIDER:', process.env.LP_PROVIDER);
    
    const rpcUrl = process.env.BASE_RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const poolContract = new ethers.Contract(
      POOL_ADDRESS,
      ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)'],
      provider
    );
    
    const slot0 = await poolContract.slot0();
    const currentTick = Number(slot0.tick);
    const currentPoolPrice = Math.pow(1.0001, currentTick);
    
    const tickLower = Number(position.tickLower);
    const tickUpper = Number(position.tickUpper);
    const lowerPrice = Math.pow(1.0001, tickLower);
    const upperPrice = Math.pow(1.0001, tickUpper);
    
    console.log(`Position range: $${lowerPrice.toFixed(6)} - $${upperPrice.toFixed(6)}`);
    console.log(`Current pool price: $${currentPoolPrice.toFixed(6)} (BTC ~$${(1/currentPoolPrice).toFixed(0)})`);
    
    const isOutOfRange = currentTick < tickLower || currentTick > tickUpper;
    const pricePosition = (currentTick - tickLower) / (tickUpper - tickLower);
    
    console.log(`Is out of range: ${isOutOfRange}`);
    if (!isOutOfRange) {
      console.log(`Price position in range: ${(pricePosition * 100).toFixed(1)}%`);
    } else {
      console.log(`Current tick ${currentTick} is ${currentTick < tickLower ? 'below' : 'above'} range [${tickLower}, ${tickUpper}]`);
    }
    
    const nearBoundary = !isOutOfRange && (pricePosition <= 0.02 || pricePosition >= 0.98);
    console.log(`Near boundary (2%): ${nearBoundary}`);
    
    const shouldRebalance = isOutOfRange || nearBoundary || Number(position.liquidityAmount) === 0;
    console.log(`Should rebalance: ${shouldRebalance}`);
    
    expect(position).toBeDefined();
    expect(typeof lowerPrice).toBe('number');
    expect(typeof upperPrice).toBe('number');
    expect(typeof currentPoolPrice).toBe('number');
  });
});
