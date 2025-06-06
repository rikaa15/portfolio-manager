import { Injectable } from '@nestjs/common';
import * as hl from '@nktkas/hyperliquid';

type FundingRateHistoryItem = {
  coin: string;
  fundingRate: number;
  premium: number;
  time: number;
}

@Injectable()
export class FundingService {
  private readonly transport = new hl.HttpTransport();
  private readonly infoClient = new hl.InfoClient({ transport: this.transport });

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
    endTime: number,
    chunkSizeDays: number = 18
  ): Promise<Array<{
    coin: string;
    fundingRate: number;
    premium: number;
    time: number;
  }>> {
    const chunkSizeMs = chunkSizeDays * 24 * 60 * 60 * 1000;
    const totalDays = (endTime - startTime) / (24 * 60 * 60 * 1000);
    
    if (totalDays <= chunkSizeDays) {
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

    const allResults: Array<{
      coin: string;
      fundingRate: number;
      premium: number;
      time: number;
    }> = [];

    let currentStart = startTime;
    let chunkCount = 0;

    while (currentStart < endTime) {
      const currentEnd = Math.min(currentStart + chunkSizeMs, endTime);
      chunkCount++;

      // console.log(`Chunk ${chunkCount}: ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}`);

      try {
        const response = await this.infoClient.fundingHistory({
          coin,
          startTime: currentStart,
          endTime: currentEnd
        });

        const chunkResults = response.map((item: any) => ({
          coin: item.coin,
          fundingRate: parseFloat(item.fundingRate),
          premium: parseFloat(item.premium),
          time: item.time
        }));

        allResults.push(...chunkResults);
        
        // console.log(`  → Retrieved ${chunkResults.length} entries`);

        if (currentEnd < endTime) {
          // await new Promise(resolve => setTimeout(resolve, 100));
        }

      } catch (error) {
        console.error(`Error fetching chunk ${chunkCount}:`, error);
      }

      currentStart = currentEnd;
    }

    allResults.sort((a, b) => a.time - b.time);

    // console.log(`Total entries retrieved: ${allResults.length} across ${chunkCount} chunks`);

    return allResults;
  }

  public hourlyTo8HourFundingRates(hourlyRates: FundingRateHistoryItem[]) {
    const eightHourRates: FundingRateHistoryItem[] = [];
    
    for (let i = 0; i < hourlyRates.length; i += 8) {
        const period = hourlyRates.slice(i, i + 8);
        
        // Skip empty periods
        if (period.length === 0) continue;
        
        // Sum funding rates for the 8-hour period
        const fundingRateSum = period.reduce((sum, item) => sum + item.fundingRate, 0);
        
        // Use the first item's coin, premium, and time for the period
        const firstItem = period[0];
        
        eightHourRates.push({
            coin: firstItem.coin,
            fundingRate: fundingRateSum,
            premium: firstItem.premium,
            time: firstItem.time
        });
    }
    
    return eightHourRates;
  }
}
