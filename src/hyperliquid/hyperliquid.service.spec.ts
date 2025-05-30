import { Test, TestingModule } from '@nestjs/testing';
import { HyperliquidService } from './hyperliquid.service';
import { ConfigService } from '@nestjs/config';
import fetch from 'node-fetch';
import { Headers, Request, Response } from 'node-fetch';

globalThis.fetch = fetch as any;
globalThis.Headers = Headers as any;
globalThis.Request = Request as any;
globalThis.Response = Response as any;

describe('HyperliquidService', () => {
  let service: HyperliquidService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HyperliquidService, ConfigService],
    }).compile();

    service = module.get<HyperliquidService>(HyperliquidService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
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
});
