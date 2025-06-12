import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

interface OptionKlineData {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OptionMarkData {
  symbol: string;
  markPrice: number;
  bidIV: number;
  askIV: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  highPriceLimit: number;
  lowPriceLimit: number;
}

interface OptionContract {
  symbol: string;
  underlying: string;
  strikePrice: number;
  expiryDate: number;
  side: "CALL" | "PUT";
  unit: number;
  minQty: number;
}

interface OptionTicker {
  symbol: string;
  priceChange: number;
  priceChangePercent: number;
  lastPrice: number;
  lastQty: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  openTime: number;
  closeTime: number;
  tradeCount: number;
  strikePrice: number;
}

interface TradeData {
  price: number;
  qty: number;
  quoteQty: number;
  time: number;
  side: number;
}

interface IndexPrice {
  time: number;
  indexPrice: number;
}

interface BinanceExchangeInfoResponse {
  optionSymbols: Array<{
    symbol: string;
    underlying: string;
    strikePrice: string;
    expiryDate: number;
    side: "CALL" | "PUT";
    unit: number;
    minQty: string;
  }>;
}

interface BinanceKlineResponse extends Array<{
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  interval: string;
  tradeCount: number;
  takerVolume: string;
  takerAmount: string;
  amount: string;
  openTime: number;
  closeTime: number;
}> {}

interface BinanceMarkResponse extends Array<{
  symbol: string;
  markPrice: string;
  bidIV: string;
  askIV: string;
  delta: string;
  theta: string;
  gamma: string;
  vega: string;
  highPriceLimit: string;
  lowPriceLimit: string;
}> {}

interface BinanceTickerResponse extends Array<{
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  lastQty: string;
  open: string;
  high: string;
  low: string;
  volume: string;
  openTime: number;
  closeTime: number;
  tradeCount: number;
  strikePrice: string;
}> {}

interface BinanceTradesResponse extends Array<{
  price: string;
  qty: string;
  quoteQty: string;
  time: number;
  side: number;
}> {}

interface BinanceIndexResponse {
  time: number;
  indexPrice: string;
}

@Injectable()
export class BinanceService {
  private readonly baseUrl = 'https://eapi.binance.com';
  private readonly client: AxiosInstance = axios.create({ 
    baseURL: `${this.baseUrl}/eapi/v1` 
  });

  async getOptionContracts(): Promise<OptionContract[]> {
    const { data } = await this.client.get<BinanceExchangeInfoResponse>('/exchangeInfo');
    
    return data.optionSymbols.map((option) => ({
      symbol: option.symbol,
      underlying: option.underlying,
      strikePrice: parseFloat(option.strikePrice),
      expiryDate: option.expiryDate,
      side: option.side,
      unit: option.unit,
      minQty: parseFloat(option.minQty),
    }));
  }

  async getOptionKlineData(
    symbol: string,
    interval: string = '1d',
    startTime: number,
    endTime: number
  ): Promise<OptionKlineData[]> {
    const { data } = await this.client.get<BinanceKlineResponse>('/klines', {
      params: {
        symbol,
        interval,
        startTime,
        endTime
      }
    });

    return data.map((kline) => ({
      timestamp: new Date(kline.openTime),
      open: parseFloat(kline.open),
      high: parseFloat(kline.high),
      low: parseFloat(kline.low),
      close: parseFloat(kline.close),
      volume: parseFloat(kline.volume),
    }));
  }

  async getOptionMarkData(symbol?: string): Promise<OptionMarkData[]> {
    const { data } = await this.client.get<BinanceMarkResponse>('/mark', {
      params: {
        symbol
      }
    });

    const markData = Array.isArray(data) ? data : [data];
    return markData.map((mark) => ({
      symbol: mark.symbol,
      markPrice: parseFloat(mark.markPrice),
      bidIV: parseFloat(mark.bidIV),
      askIV: parseFloat(mark.askIV),
      delta: parseFloat(mark.delta),
      theta: parseFloat(mark.theta),
      gamma: parseFloat(mark.gamma),
      vega: parseFloat(mark.vega),
      highPriceLimit: parseFloat(mark.highPriceLimit),
      lowPriceLimit: parseFloat(mark.lowPriceLimit),
    }));
  }

  async getDailyPriceStats(symbol?: string): Promise<OptionTicker[]> {
    const { data } = await this.client.get<BinanceTickerResponse>('/ticker', {
      params: {
        symbol
      }
    });

    const tickerData = Array.isArray(data) ? data : [data];
    return tickerData.map((ticker) => ({
      symbol: ticker.symbol,
      priceChange: parseFloat(ticker.priceChange),
      priceChangePercent: parseFloat(ticker.priceChangePercent),
      lastPrice: parseFloat(ticker.lastPrice),
      lastQty: parseFloat(ticker.lastQty),
      open: parseFloat(ticker.open),
      high: parseFloat(ticker.high),
      low: parseFloat(ticker.low),
      volume: parseFloat(ticker.volume),
      openTime: ticker.openTime,
      closeTime: ticker.closeTime,
      tradeCount: ticker.tradeCount,
      strikePrice: parseFloat(ticker.strikePrice),
    }));
  }

  async getRecentTrades(symbol: string, limit: number = 100): Promise<TradeData[]> {
    const { data } = await this.client.get<BinanceTradesResponse>('/trades', {
      params: {
        symbol,
        limit
      }
    });

    return data.map((trade) => ({
      price: parseFloat(trade.price),
      qty: parseFloat(trade.qty),
      quoteQty: parseFloat(trade.quoteQty),
      time: trade.time,
      side: trade.side,
    }));
  }

  async getHistoricalTrades(symbol: string, fromId?: number, limit: number = 100): Promise<TradeData[]> {
    const { data } = await this.client.get<BinanceTradesResponse>('/historicalTrades', {
      params: {
        symbol,
        fromId,
        limit
      }
    });

    return data.map((trade) => ({
      price: parseFloat(trade.price),
      qty: parseFloat(trade.qty),
      quoteQty: parseFloat(trade.quoteQty),
      time: trade.time,
      side: trade.side,
    }));
  }

  async getIndexPrice(underlying: string = 'BTCUSDT'): Promise<IndexPrice> {
    const { data } = await this.client.get<BinanceIndexResponse>('/index', {
      params: {
        underlying
      }
    });

    return {
      time: data.time,
      indexPrice: parseFloat(data.indexPrice),
    };
  }
}
