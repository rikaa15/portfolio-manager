import { Test, TestingModule } from '@nestjs/testing';
import { BinanceService } from './binance.service';

describe('BinanceService', () => {
  let service: BinanceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BinanceService],
    }).compile();

    service = module.get<BinanceService>(BinanceService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('gets BTCUSDT index price', async () => {
    const indexData = await service.getBTCUSDTIndexPrice();
    
    console.log(`Current spot price: $${indexData.indexPrice.toFixed(2)}`);
    
    expect(indexData.indexPrice).toBeGreaterThan(0);
    expect(indexData.time).toBeGreaterThan(0);
  });

  it('gets 24hr ticker statistics', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    
    if (btcOptions.length > 0) {
      const symbol = btcOptions[0].symbol;
      const ticker = await service.get24hrTicker(symbol);
  
      console.log(`24hr price statistics for an option contract: ${symbol} - $${ticker[0].lastPrice.toFixed(4)} (${ticker[0].priceChangePercent.toFixed(2)}%)`);
      
      expect(ticker.length).toBeGreaterThan(0);
      expect(ticker[0].lastPrice).toBeGreaterThan(0);
    }
  });

  it('gets recent trades', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    
    if (btcOptions.length > 0) {
      const symbol = btcOptions[0].symbol;
      const trades = await service.getRecentTrades(symbol, 10);
      
      console.log(`Found ${trades.length} recent trades`);
      
      expect(trades.length).toBeGreaterThan(0);
      expect(trades[0].price).toBeGreaterThan(0);
    }
  });

  it('gets available option contracts', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    const calls = btcOptions.filter(c => c.side === 'CALL');
    const puts = btcOptions.filter(c => c.side === 'PUT');
    
    console.log(` ${contracts.length} total contracts (${calls.length} calls, ${puts.length} puts)`);
    
    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts[0].symbol).toBeDefined();
    expect(contracts[0].strikePrice).toBeGreaterThan(0);
  });

  it('gets option historical data', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    
    if (btcOptions.length > 0) {
      const symbol = btcOptions[0].symbol;
      const endTime = Date.now();
      const startTime = endTime - (7 * 24 * 60 * 60 * 1000);
      
      const data = await service.getOptionHistoricalData(symbol, '1d', startTime, endTime);

      console.log(`Historical Candlistick data: ${data.length} daily candles over 7 days`);
      
      expect(data.length).toBeGreaterThan(0);
      expect(data[0].close).toBeGreaterThan(0);
    }
  });

  it('gets current Greeks data', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    
    if (btcOptions.length > 0) {
      const symbol = btcOptions[0].symbol;
      const greeks = await service.getOptionGreeks(symbol);

      console.log(`Current Greeks: Delta ${greeks[0].delta.toFixed(3)}, IV ${(greeks[0].bidIV * 100).toFixed(1)}%`);
      
      expect(greeks.length).toBeGreaterThan(0);
      expect(greeks[0].markPrice).toBeGreaterThan(0);
    }
  });
});
