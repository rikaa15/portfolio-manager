import { Test, TestingModule } from '@nestjs/testing';
import { UniswapLpService } from './uniswap-lp.service';

describe('UniswapLpService', () => {
  let service: UniswapLpService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UniswapLpService],
    }).compile();

    service = module.get<UniswapLpService>(UniswapLpService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
