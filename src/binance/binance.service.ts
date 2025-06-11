import { Injectable } from '@nestjs/common';

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

@Injectable()
export class BinanceService {
  private readonly baseUrl = 'https://eapi.binance.com';

  async getOptionContracts(): Promise<OptionContract[]> {
    const url = `${this.baseUrl}/eapi/v1/exchangeInfo`;
    const response = await fetch(url);
    const data = await response.json();
    
    return data.optionSymbols.map((option: any) => ({
      symbol: option.symbol,
      underlying: option.underlying,
      strikePrice: parseFloat(option.strikePrice),
      expiryDate: option.expiryDate,
      side: option.side,
      unit: option.unit,
      minQty: parseFloat(option.minQty),
    }));
  }

  async getOptionHistoricalData(
    symbol: string,
    interval: string = '1d',
    startTime: number,
    endTime: number
  ): Promise<OptionKlineData[]> {
    const url = `${this.baseUrl}/eapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}`;
    const response = await fetch(url);
    const data = await response.json();

    return data.map((kline: any) => ({
      timestamp: new Date(kline.openTime),
      open: parseFloat(kline.open),
      high: parseFloat(kline.high),
      low: parseFloat(kline.low),
      close: parseFloat(kline.close),
      volume: parseFloat(kline.volume),
    }));
  }

  async getOptionGreeks(symbol?: string): Promise<OptionMarkData[]> {
    const url = symbol 
      ? `${this.baseUrl}/eapi/v1/mark?symbol=${symbol}`
      : `${this.baseUrl}/eapi/v1/mark`;
    const response = await fetch(url);
    const data = await response.json();

    const markData = Array.isArray(data) ? data : [data];
    return markData.map((mark: any) => ({
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

  async get24hrTicker(symbol?: string): Promise<OptionTicker[]> {
    const url = symbol 
      ? `${this.baseUrl}/eapi/v1/ticker?symbol=${symbol}`
      : `${this.baseUrl}/eapi/v1/ticker`;
    const response = await fetch(url);
    const data = await response.json();

    const tickerData = Array.isArray(data) ? data : [data];
    return tickerData.map((ticker: any) => ({
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
    const url = `${this.baseUrl}/eapi/v1/trades?symbol=${symbol}&limit=${limit}`;
    const response = await fetch(url);
    const data = await response.json();

    return data.map((trade: any) => ({
      price: parseFloat(trade.price),
      qty: parseFloat(trade.qty),
      quoteQty: parseFloat(trade.quoteQty),
      time: trade.time,
      side: trade.side,
    }));
  }

  async getHistoricalTrades(symbol: string, fromId?: number, limit: number = 100): Promise<TradeData[]> {
    let url = `${this.baseUrl}/eapi/v1/historicalTrades?symbol=${symbol}&limit=${limit}`;
    if (fromId) {
      url += `&fromId=${fromId}`;
    }
    
    const response = await fetch(url);
    const data = await response.json();

    return data.map((trade: any) => ({
      price: parseFloat(trade.price),
      qty: parseFloat(trade.qty),
      quoteQty: parseFloat(trade.quoteQty),
      time: trade.time,
      side: trade.side,
    }));
  }

  async getBTCUSDTIndexPrice(): Promise<IndexPrice> {
    const url = `${this.baseUrl}/eapi/v1/index?underlying=BTCUSDT`;
    const response = await fetch(url);
    const data = await response.json();

    return {
      time: data.time,
      indexPrice: parseFloat(data.indexPrice),
    };
  }
}
