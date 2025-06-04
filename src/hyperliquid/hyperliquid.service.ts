import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as hl from '@nktkas/hyperliquid';
import { Hex } from '@nktkas/hyperliquid';
// import { Wallet } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';

@Injectable()
export class HyperliquidService {
  private readonly logger = new Logger(HyperliquidService.name);
  private readonly transport = new hl.HttpTransport();
  private readonly infoClient = new hl.InfoClient({ transport: this.transport });
  private readonly exchangeClient: hl.ExchangeClient;

  constructor(private configService: ConfigService) {
    const privateKey = this.configService.get<string>('HL_KEY');
    if (!privateKey) throw new Error('HL_KEY is not defined in environment variables.');

    const wallet = privateKeyToAccount(privateKey as Hex);
    this.exchangeClient = new hl.ExchangeClient({
      wallet,
      transport: this.transport,
    });
  }

  async bootstrap() {
    const walletAddress = this.configService.get<Hex>('WALLET_ADDRESS');
    await this.infoClient.clearinghouseState({ user: walletAddress });
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
  }) {
    const notional = collateral * leverage;
    const startTime = entryTime.getTime();
    const endTime = Math.max(...exitTimes.map(t => t.getTime()));

    const candles = await this.infoClient.candleSnapshot({
      coin,
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

  async openPosition({
    coin,
    isLong,
    leverage,
    collateral,
  }: {
    coin: string;
    isLong: boolean;
    leverage: number;
    collateral: number;
  }) {
    const mids = await this.infoClient.allMids();
    const markPrice = parseFloat(mids[coin]);
    const notional = leverage * collateral;
    const size = notional / markPrice;
  
    const meta = await this.infoClient.meta();
    const assetIndex = meta.universe.findIndex((c) => c.name === coin);
    if (assetIndex === -1) throw new Error(`Asset ${coin} not found in universe`);
    
    console.log('Asset metadata:', meta.universe[assetIndex]);
    console.log('Original mark price:', markPrice);
    console.log('Size:', size.toFixed(4));
    
 
    const isBuy = isLong;

    const aggressivePrice = isBuy 
      ? Math.round(markPrice * 2).toString() + ".0"
      : Math.round(markPrice * 0.5).toString() + ".0";
    
    const order = {
      orders: [
        {
          a: assetIndex,
          b: isBuy,
          p: aggressivePrice,
          s: size.toFixed(4),
          r: false,
          t: { limit: { tif: "Ioc" as const } },
        },
      ],
      grouping: "na" as const,
    };
    
    console.log('Full order object:', JSON.stringify(order, null, 2));
  
    return await this.exchangeClient.order(order);
  }
  
  async closePosition(coin: string, isLong: boolean) {
    const walletAddress = this.configService.get<Hex>('WALLET_ADDRESS');
    const userState = await this.infoClient.clearinghouseState({ user: walletAddress });
  
    const meta = await this.infoClient.meta();
    const assetIndex = meta.universe.findIndex((c) => c.name === coin);
    if (assetIndex === -1) throw new Error(`Asset ${coin} not found in universe`);
  
    const position = userState.assetPositions[assetIndex];
    if (!position?.position || parseFloat(position.position.szi) === 0) return null;
  
    const szi = parseFloat(position.position.szi);
    const size = Math.abs(szi);
    
    const isBuy = !isLong;

    const mids = await this.infoClient.allMids();
    const markPrice = parseFloat(mids[coin]);
    
    const closePrice = isBuy 
      ? Math.round(markPrice * 2).toString() + ".0"
      : Math.round(markPrice * 0.5).toString() + ".0";
    
    console.log('Asset metadata:', meta.universe[assetIndex]);
    console.log('Size to close:', size.toFixed(4));
    console.log('Position size:', szi);
    console.log('Is long position:', isLong);
    console.log('Is buy order:', isBuy);
    console.log('Mark price:', markPrice);
    console.log('Close price:', closePrice);
    
    const order = {
      orders: [
        {
          a: assetIndex,
          b: isBuy,
          p: closePrice,
          s: size.toFixed(4),
          r: true,
          t: { limit: { tif: "Ioc" as const } },
        },
      ],
      grouping: "na" as const,
    };
    
    console.log('Full order object:', JSON.stringify(order, null, 2));
  
    return await this.exchangeClient.order(order);
  }
  
}
