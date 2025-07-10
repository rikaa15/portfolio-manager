import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AerodromeLpService } from './aerodrome.service';
import configuration from '../config/configuration';

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
              if (key === 'aerodrome') {
                return config.aerodrome;
              }
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AerodromeLpService>(AerodromeLpService);
    
    // Initialize the service properly
    await service.bootstrap();
  });

  it('should get position for user and pool', async () => {
    const userAddress = process.env.WALLET_ADDRESS;
    const poolAddress = POOL_ADDRESS;

    const position = await service.getPosition(userAddress, poolAddress);

    console.log('Position result:', position);
    expect(position).toBeDefined();
  }, 30000);

  it('should get all positions by owner', async () => {
    const userAddress = process.env.WALLET_ADDRESS;

    const positions = await service.getPositionsByOwner(userAddress);

    console.log(`Positions owned by ${userAddress}:`, positions);
    expect(positions).toBeDefined();
    expect(Array.isArray(positions)).toBe(true);
  }, 30000);
});
