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
    const indexData = await service.getIndexPrice();
    
    console.log(`Current spot price: $${indexData.indexPrice.toFixed(2)}`);
    
    expect(indexData.indexPrice).toBeGreaterThan(0);
    expect(indexData.time).toBeGreaterThan(0);
  });

  it('gets 24hr ticker statistics', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    
    if (btcOptions.length > 0) {
      const symbol = btcOptions[0].symbol;
      const ticker = await service.getDailyPriceStats(symbol);
  
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

  it('gets option kline data', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    
    if (btcOptions.length > 0) {
      const symbol = btcOptions[0].symbol;
      const endTime = Date.now();
      const startTime = endTime - (7 * 24 * 60 * 60 * 1000);
      
      const data = await service.getOptionKlineData(symbol, '1d', startTime, endTime);

      console.log(`Historical Candlestick data: ${data.length} daily candles over 7 days`);
      
      expect(data.length).toBeGreaterThan(0);
      expect(data[0].close).toBeGreaterThan(0);
    }
  });

  it('gets current mark data', async () => {
    const contracts = await service.getOptionContracts();
    const btcOptions = contracts.filter(c => c.underlying === 'BTCUSDT');
    
    if (btcOptions.length > 0) {
      const symbol = btcOptions[0].symbol;
      const markData = await service.getOptionMarkData(symbol);

      console.log(`Current Mark Data for ${symbol}:`);
      console.log(`  Mark Price: $${markData[0].markPrice.toFixed(4)}`);
      console.log(`  Δ=${markData[0].delta.toFixed(3)}, Θ=${markData[0].theta.toFixed(3)}, Γ=${markData[0].gamma.toFixed(3)}, ν=${markData[0].vega.toFixed(3)}`);
      console.log(`  IV: Bid ${(markData[0].bidIV * 100).toFixed(1)}%, Ask ${(markData[0].askIV * 100).toFixed(1)}%`);
      console.log(`  Price Limits: $${markData[0].lowPriceLimit.toFixed(4)} - $${markData[0].highPriceLimit.toFixed(4)}`);
      
      expect(markData.length).toBeGreaterThan(0);
      expect(markData[0].markPrice).toBeGreaterThan(0);
    }
  });
});
