import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as hl from '@nktkas/hyperliquid';
import { Hex } from '@nktkas/hyperliquid';
import { Config } from '../config/configuration';

@Injectable()
export class FundingService {
  private readonly logger = new Logger(FundingService.name);
  private readonly transport = new hl.HttpTransport();
  private readonly infoClient = new hl.InfoClient({ transport: this.transport });

  constructor(private configService: ConfigService<Config>) {}

  async getCurrentFundingRate(coin: string): Promise<{ 
    fundingRate: number; 
    markPrice: number; 
    premium: number;
    oraclePrice: number;
    openInterest: number;
  }> {
    const response = await this.infoClient.metaAndAssetCtxs();
    const [meta, assetCtxs] = response;
    
    const assetIndex = meta.universe.findIndex((c: any) => c.name === coin);
    if (assetIndex === -1) throw new Error(`Asset ${coin} not found in universe`);
    
    const assetCtx = assetCtxs[assetIndex];
    
    return {
      fundingRate: parseFloat(assetCtx.funding),
      markPrice: parseFloat(assetCtx.markPx),
      premium: parseFloat(assetCtx.premium),
      oraclePrice: parseFloat(assetCtx.oraclePx),
      openInterest: parseFloat(assetCtx.openInterest),
    };
  }

  async getHistoricalFundingRates(
    coin: string, 
    startTime: number, 
    endTime: number
  ): Promise<Array<{
    coin: string;
    fundingRate: number;
    premium: number;
    time: number;
  }>> {
    const response = await this.infoClient.fundingHistory({
      coin,
      startTime,
      endTime
    });
    
    return response.map((item: any) => ({
      coin: item.coin,
      fundingRate: parseFloat(item.fundingRate),
      premium: parseFloat(item.premium),
      time: item.time
    }));
  }
}
