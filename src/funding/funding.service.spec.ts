import { Test, TestingModule } from '@nestjs/testing';
import { FundingService } from './funding.service';

describe('FundingService', () => {
  let service: FundingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
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
    const startTime = new Date('2024-05-01').getTime();
    const endTime = new Date('2025-05-31').getTime();
    
    console.log('Requesting chunked data for full period:', {
      startDate: new Date(startTime).toISOString(),
      endDate: new Date(endTime).toISOString(),
      totalDays: Math.round((endTime - startTime) / (24 * 60 * 60 * 1000))
    });
    
    const history = await service.getHistoricalFundingRates('BTC', startTime, endTime);
    
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    
    const actualStartTime = Math.min(...history.map(entry => entry.time));
    const actualEndTime = Math.max(...history.map(entry => entry.time));
    
    console.log('Historical BTC funding rates:', {
      requested: {
        start: new Date(startTime).toISOString(),
        end: new Date(endTime).toISOString()
      },
      actual: {
        start: new Date(actualStartTime).toISOString(),
        end: new Date(actualEndTime).toISOString()
      },
      totalEntries: history.length,
      averageEntriesPerDay: (history.length / ((actualEndTime - actualStartTime) / (24 * 60 * 60 * 1000))).toFixed(2)
    });
  }, 120_000);
});

