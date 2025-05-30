import { Test, TestingModule } from '@nestjs/testing';
import { HyperliquidService } from './hyperliquid.service';
import { ConfigModule } from '@nestjs/config';
import fetch, { Headers, Request, Response } from 'node-fetch';
import * as dotenv from 'dotenv';
dotenv.config();


globalThis.fetch = fetch as any;
globalThis.Headers = Headers as any;
globalThis.Request = Request as any;
globalThis.Response = Response as any;

describe('HyperliquidService', () => {
  let service: HyperliquidService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot()],
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

    const result = await service.backtest({
      coin: 'BTC',
      interval: '1d',
      entryTime,
      exitTimes,
      collateral: 100,
      leverage: 10,
      isLong: true,
    });

    console.log(`\n[Entry @ ${result.entryTime.toISOString()}] Price: $${result.entryPrice.toFixed(2)}\n`);

    for (const r of result.results) {
      const pnlStr = r.pnl >= 0 ? `+${r.pnl.toFixed(2)}` : r.pnl.toFixed(2);
      console.log(`[Exit @ ${r.exitTime.toISOString()}] Price: $${r.exitPrice.toFixed(2)} → PnL = $${pnlStr}`);
    }

    expect(result.entryPrice).toBeGreaterThan(0);
    expect(result.results.length).toBe(365);
    for (const r of result.results) {
      expect(typeof r.pnl).toBe('number');
    }
  }, 30_000);

  // WARNING: This test will execute real trade
  it('opens and closes a BTC position', async () => {
    const open = await service.openPosition({
      coin: 'BTC',
      isLong: true,
      leverage: 2,
      collateral: 1,
    });

    console.log('Open response:', open);

    await new Promise(res => setTimeout(res, 3000));

    const close = await service.closePosition('BTC');

    console.log('Close response:', close);

    expect(open.status).toBe('ok');
    expect(close.status).toBe('ok');
  }, 15_000);
});
