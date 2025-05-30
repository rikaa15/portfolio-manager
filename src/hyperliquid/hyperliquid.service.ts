import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as hl from "@nktkas/hyperliquid";
import { Hex } from "@nktkas/hyperliquid";

@Injectable()
export class HyperliquidService {
  private readonly logger = new Logger(HyperliquidService.name);
  private readonly transport = new hl.HttpTransport();
  private readonly client = new hl.PublicClient({ transport: this.transport });

  constructor(private configService: ConfigService) {}

  async bootstrap() {
    const walletAddress = this.configService.get<Hex>('WALLET_ADDRESS');
    const userState = await this.client.clearinghouseState({ user: walletAddress });
    this.logger.log('HyperliquidService bootstrap completed');
  }

  async backtest({
    coin,
    interval,
    entryTime,
    exitTimes,
    collateral,
    leverage,
    isLong,
  }: {
    coin: string;
    interval: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";
    entryTime: Date;
    exitTimes: Date[];
    collateral: number;
    leverage: number;
    isLong: boolean;
  })
   {
    const notional = collateral * leverage;
    const startTime = entryTime.getTime();
    const endTime = Math.max(...exitTimes.map(t => t.getTime()));

    const candles = await this.client.candleSnapshot({
      coin: coin,
      interval,
      startTime,
      endTime,
    });

    const candleData = candles.map((c: any) => ({
      ts: new Date(Number(c.T)),
      close: parseFloat(c.c),
    }));

    const findClosest = (target: Date) =>
      candleData.reduce((a, b) =>
        Math.abs(a.ts.getTime() - target.getTime()) < Math.abs(b.ts.getTime() - target.getTime()) ? a : b
      );

    const entry = findClosest(entryTime);
    const entryPrice = entry.close;

    const results = exitTimes.map(t => {
      const exit = findClosest(t);
      const exitPrice = exit.close;
      const priceDiff = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
      const pnl = (priceDiff / entryPrice) * notional;
      return {
        exitTime: exit.ts,
        exitPrice,
        pnl,
      };
    });

    return {
      entryTime: entry.ts,
      entryPrice,
      results,
    };
  }
}
