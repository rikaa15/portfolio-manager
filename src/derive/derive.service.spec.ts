import { Test, TestingModule } from '@nestjs/testing';
import { DeriveService } from './derive.service';

describe('DeriveService', () => {
  let service: DeriveService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeriveService],
    }).compile();

    service = module.get<DeriveService>(DeriveService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('Get Options Trade History', async () => {
    const trades = await service.getOptionsTradeHistory({ count: 20 });
    console.log(`\nFound ${trades.length} recent BTC options trades:`);
    
    trades.slice(0, 10).forEach(trade => {
      const date = new Date(trade.timestamp).toLocaleString();
      console.log(`  ${trade.instrument_name}: ${trade.direction.toUpperCase()} ${trade.trade_amount} @ $${trade.trade_price} (${trade.liquidity_role}) [${date}]`);
    });
    
    if (trades.length > 10) {
      console.log(`  ... and ${trades.length - 10} more\n`);
    }
    
    expect(Array.isArray(trades)).toBe(true);
    if (trades.length > 0) {
      expect(trades[0]).toHaveProperty('trade_id');
      expect(trades[0]).toHaveProperty('trade_price');
      expect(trades[0]).toHaveProperty('trade_amount');
      expect(trades[0]).toHaveProperty('liquidity_role');
    }
  }, 15000);

  it('Get Option Instruments', async () => {
    const instruments = await service.getOptionInstruments();
    console.log(`\nFound ${instruments.length} BTC options instruments:`);
    
    instruments.slice(0, 10).forEach(instrument => {
      console.log(`  ${instrument.instrument_name} (${instrument.option_type?.toUpperCase()}, Strike: $${instrument.strike})`);
    });
    
    if (instruments.length > 10) {
      console.log(`  ... and ${instruments.length - 10} more\n`);
    }
    
    expect(Array.isArray(instruments)).toBe(true);
  }, 15000);

  it('Get Option Settlement History', async () => {
    const settlements = await service.getOptionSettlementHistory();
    console.log(`\nFound ${settlements.length} BTC option settlements:`);
    
    settlements.slice(0, 10).forEach(settlement => {
      const date = new Date(settlement.settlement_timestamp * 1000).toLocaleString();
      console.log(`  ${settlement.instrument_name}: Settled at $${settlement.settlement_price} (${date})`);
    });
    
    if (settlements.length > 10) {
      console.log(`  ... and ${settlements.length - 10} more\n`);
    }
    
    expect(Array.isArray(settlements)).toBe(true);
  }, 15000);

  it('Get Comprehensive Options Historical Data', async () => {
    console.log('\nFetching comprehensive BTC options data...');
    
    const data = await service.getOptionsHistoricalData(3);
    
    console.log(`\nCOMPREHENSIVE BTC OPTIONS DATA SUMMARY:`);
    console.log(`  Active Instruments: ${data.instruments.length}`);
    console.log(`  Total Trades: ${data.trades.length}`);
    console.log(`  Settlements: ${data.settlements.length}`);
    
    if (data.trades.length > 0) {
      console.log(`\nSample Recent BTC Options Trades:`);
      data.trades.slice(0, 3).forEach(trade => {
        const date = new Date(trade.timestamp).toLocaleString();
        console.log(`  ${trade.instrument_name}: ${trade.direction.toUpperCase()} ${trade.trade_amount} @ $${trade.trade_price} [${date}]`);
      });
    }
    
    expect(data).toHaveProperty('instruments');
    expect(data).toHaveProperty('trades');
    expect(data).toHaveProperty('settlements');
  }, 25000);

  it('Get Options Market Statistics', async () => {
    const stats = await service.getOptionsMarketStats();
    console.log(`\nBTC Options Market Stats:`, JSON.stringify(stats, null, 2));
    
    expect(typeof stats).toBe('object');
  }, 15000);
});