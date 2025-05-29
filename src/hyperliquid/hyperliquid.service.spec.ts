import { Test, TestingModule } from '@nestjs/testing';
import { HyperliquidService } from './hyperliquid.service';

describe('HyperliquidService', () => {
  let service: HyperliquidService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HyperliquidService],
    }).compile();

    service = module.get<HyperliquidService>(HyperliquidService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
