import { Test, TestingModule } from '@nestjs/testing';
import { FundingService } from './funding.service';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';

describe('FundingService', () => {
  let service: FundingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [configuration],
          isGlobal: true,
        }),
      ],
      providers: [FundingService],
    }).compile();

    service = module.get<FundingService>(FundingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get current funding rates for BTC, ETH, and S', async () => {
    const coins = ['BTC', 'ETH', 'S'];
    
    for (const coin of coins) {
      const fundingRate = await service.getCurrentFundingRate(coin);
      
      expect(fundingRate).toBeDefined();
      expect(typeof fundingRate.fundingRate).toBe('number');
      expect(typeof fundingRate.markPrice).toBe('number');
      expect(typeof fundingRate.premium).toBe('number');
      expect(typeof fundingRate.oraclePrice).toBe('number');
      expect(typeof fundingRate.openInterest).toBe('number');
      
      console.log(`Current ${coin} funding rate:`, {
        fundingRate: `${(fundingRate.fundingRate * 100).toFixed(4)}% per 8 hours`,
        hourlyRate: `${(fundingRate.fundingRate / 8 * 100).toFixed(4)}% per hour`,
        markPrice: `$${fundingRate.markPrice.toLocaleString()}`,
        premium: `${(fundingRate.premium * 100).toFixed(4)}%`,
        openInterest: `${fundingRate.openInterest.toLocaleString()} ${coin}`
      });
    }
  }, 15_000);

  it('should get historical funding rates for BTC', async () => {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const now = Date.now();
    const history = await service.getHistoricalFundingRates('BTC', sevenDaysAgo, now);
    
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    
    const firstEntry = history[0];
    expect(firstEntry.coin).toBe('BTC');
    expect(typeof firstEntry.fundingRate).toBe('number');
    expect(typeof firstEntry.premium).toBe('number');
    expect(typeof firstEntry.time).toBe('number');
    
    history.forEach(entry => {
      expect(entry.time).toBeGreaterThanOrEqual(sevenDaysAgo);
      expect(entry.time).toBeLessThanOrEqual(now);
    });
    
    console.log('Historical BTC funding rates for:', {
      start: new Date(sevenDaysAgo).toISOString(),
      end: new Date(now).toISOString()
    });
    history.forEach((entry, index) => {
      console.log(`${index + 1}. ${new Date(entry.time).toISOString()} - Rate: ${(entry.fundingRate * 100).toFixed(4)}% - Premium: ${(entry.premium * 100).toFixed(4)}%`);
    });
  }, 15_000);
});
