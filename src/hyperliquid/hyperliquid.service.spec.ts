import { Test, TestingModule } from '@nestjs/testing';
import { HyperliquidService } from './hyperliquid.service';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';

function findClosestPrice(
  priceData: Array<{
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>,
  targetTime: Date
) {
  return priceData.reduce((a, b) =>
    Math.abs(a.timestamp.getTime() - targetTime.getTime()) < 
    Math.abs(b.timestamp.getTime() - targetTime.getTime()) ? a : b
  );
}

describe('HyperliquidService', () => {
  let service: HyperliquidService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [configuration],
          isGlobal: true,
        }),
      ],
      providers: [HyperliquidService],
    }).compile();

    service = module.get<HyperliquidService>(HyperliquidService);
  });

  it('runs backtest for BTC over 1 year', async () => {
    const today = new Date();
    const entryTime = new Date(today);
    entryTime.setFullYear(today.getFullYear() - 1);

    const exitTimes: Date[] = [];
    for (let i = 1; i <= 365; i++) {
      const exit = new Date(entryTime);
      exit.setDate(entryTime.getDate() + i);
      exitTimes.push(exit);
    }

    const collateral = 100;
    const leverage = 10;
    const isLong = true;
    const notional = collateral * leverage;
    const startTime = entryTime.getTime();
    const endTime = Math.max(...exitTimes.map(t => t.getTime()));

    const priceData = await service.getHistoricalPrices('BTC', '1d', startTime, endTime);

    const entry = findClosestPrice(priceData, entryTime);
    const entryPrice = entry.close;

    const results = exitTimes.map(exitTime => {
      const exit = findClosestPrice(priceData, exitTime);
      
      const priceDiff = isLong ? exit.close - entryPrice : entryPrice - exit.close;
      const pnl = (priceDiff / entryPrice) * notional;
      
      return {
        exitTime: exit.timestamp,
        exitPrice: exit.close,
        pnl,
      };
    });

    console.log(`\n[Entry @ ${entry.timestamp.toISOString()}] Price: $${entryPrice.toFixed(2)}\n`);

    for (const r of results) {
      const pnlStr = r.pnl >= 0 ? `+${r.pnl.toFixed(2)}` : r.pnl.toFixed(2);
      console.log(`[Exit @ ${r.exitTime.toISOString()}] Price: $${r.exitPrice.toFixed(2)} → PnL = $${pnlStr}`);
    }

    expect(entryPrice).toBeGreaterThan(0);
    expect(results.length).toBe(365);
    for (const r of results) {
      expect(typeof r.pnl).toBe('number');
    }
  }, 30_000);

  // WARNING: This test will execute real trade
  it('opens and closes a BTC position', async () => {
    const isLong = true;
    const open = await service.openPosition({
      coin: 'BTC',
      isLong,
      leverage: 2,
      collateral: 11,
    });

    console.log('Open response:', open);

    await new Promise(res => setTimeout(res, 3000));

    const close = await service.closePosition('BTC', isLong);

    console.log('Close response:', close);

    expect(open.status).toBe('ok');
    expect(close.status).toBe('ok');
  }, 15_000);
});
