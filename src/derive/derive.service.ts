import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface LyraTradeHistoryRequest {
  currency?: string;
  instrument_type?: 'option' | 'perp' | 'spot';
  instrument_name?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  count?: number;
}

export interface LyraInstrument {
  instrument_name: string;
  instrument_type: string;
  base_currency: string;
  quote_currency: string;
  settlement_currency: string;
  option_type?: 'call' | 'put';
  strike?: string;
  expiry_timestamp?: number;
  is_active: boolean;
}

export interface LyraTrade {
  trade_id: string;
  instrument_name: string;
  direction: 'buy' | 'sell';
  trade_amount: string;
  trade_price: string;
  timestamp: number;
  trade_fee: string;
  liquidity_role: 'maker' | 'taker';
  mark_price?: string;
  index_price?: string;
  realized_pnl?: string;
  tx_status?: string;
  tx_hash?: string;
}

export interface LyraOptionSettlement {
  instrument_name: string;
  settlement_price: string;
  expiry_timestamp: number;
  settlement_timestamp: number;
}

@Injectable()
export class DeriveService {
  private readonly logger = new Logger(DeriveService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly baseUrl = 'https://api.lyra.finance';
  private readonly defaultTimeout = 10000;
  private readonly retryAttempts = 2;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: this.defaultTimeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.axiosInstance.interceptors.request.use(
      (config) => {
        this.logger.debug(`Making request to: ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error('Request error:', error);
        return Promise.reject(error);
      },
    );

    this.axiosInstance.interceptors.response.use(
      (response) => {
        this.logger.debug(`Response received from: ${response.config.url}`);
        return response;
      },
      (error) => {
        this.logger.error('Response error:', error.message);
        return Promise.reject(error);
      },
    );
  }

  private async makeRequestWithRetry<T>(
    requestFn: () => Promise<T>,
    operation: string,
    maxRetries: number = this.retryAttempts
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const is502Error = error.response?.status === 502;
        const isTimeoutError = error.code === 'ECONNABORTED';
        
        if (is502Error || isTimeoutError) {
          this.logger.warn(`${operation} failed (attempt ${attempt}/${maxRetries}): ${error.message}`);
          if (!isLastAttempt) {
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            continue;
          }
        }
        
        if (isLastAttempt) {
          this.logger.warn(`${operation} failed after ${maxRetries} attempts: ${error.message}`);
          return null;
        }
        
        throw error;
      }
    }
    return null;
  }

  async getOptionInstruments(expired?: boolean): Promise<LyraInstrument[]> {
    if (expired !== undefined) {
      const result = await this.makeRequestWithRetry(
        () => this.axiosInstance.post('/public/get_instruments', {
          currency: 'BTC',
          instrument_type: 'option',
          expired: expired,
        }),
        `fetch ${expired ? 'expired' : 'active'} instruments`
      );
      
      return result?.data?.result || result?.data || [];
    }

    const [activeResult, expiredResult] = await Promise.allSettled([
      this.makeRequestWithRetry(
        () => this.axiosInstance.post('/public/get_instruments', {
          currency: 'BTC',
          instrument_type: 'option',
          expired: false,
        }),
        'fetch active instruments'
      ),
      this.makeRequestWithRetry(
        () => this.axiosInstance.post('/public/get_instruments', {
          currency: 'BTC',
          instrument_type: 'option',
          expired: true,
        }),
        'fetch expired instruments'
      )
    ]);

    const instruments = [];
    
    if (activeResult.status === 'fulfilled' && activeResult.value) {
      const activeInstruments = activeResult.value.data?.result || activeResult.value.data || [];
      instruments.push(...activeInstruments);
    }
    
    if (expiredResult.status === 'fulfilled' && expiredResult.value) {
      const expiredInstruments = expiredResult.value.data?.result || expiredResult.value.data || [];
      instruments.push(...expiredInstruments);
    }

    if (instruments.length === 0) {
      this.logger.warn('No instruments retrieved from either active or expired endpoints');
    }

    return instruments;
  }

  async getOptionsTradeHistory(params: LyraTradeHistoryRequest = {}): Promise<LyraTrade[]> {
    const btcParams = {
      currency: 'BTC',
      instrument_type: 'option' as const,
      count: 100,
      ...params,
    };

    const result = await this.makeRequestWithRetry(
      () => this.axiosInstance.post('/public/get_trade_history', btcParams),
      'fetch options trade history'
    );

    if (!result) {
      this.logger.error('Failed to fetch BTC options trade history after retries');
      return [];
    }

    const trades = result.data?.result?.trades || result.data?.trades || result.data || [];
    
    if (!Array.isArray(trades)) {
      this.logger.warn('Trade history response is not an array:', trades);
      return [];
    }
    
    const mappedTrades = trades.map((trade: any) => ({
      trade_id: trade.trade_id,
      instrument_name: trade.instrument_name,
      direction: trade.direction,
      trade_amount: trade.trade_amount,
      trade_price: trade.trade_price,
      timestamp: trade.timestamp,
      trade_fee: trade.trade_fee,
      liquidity_role: trade.liquidity_role,
      mark_price: trade.mark_price,
      index_price: trade.index_price,
      realized_pnl: trade.realized_pnl,
      tx_status: trade.tx_status,
      tx_hash: trade.tx_hash,
    }));

    return mappedTrades.filter(trade => 
      trade.instrument_name?.startsWith('BTC-')
    );
  }

  async getOptionSettlementHistory(
    startTimestamp?: number,
    endTimestamp?: number,
  ): Promise<LyraOptionSettlement[]> {
    const params: any = { currency: 'BTC' };
    if (startTimestamp) params.start_timestamp = startTimestamp;
    if (endTimestamp) params.end_timestamp = endTimestamp;

    const result = await this.makeRequestWithRetry(
      () => this.axiosInstance.post('/public/get_option_settlement_history', params),
      'fetch option settlement history'
    );

    if (!result) {
      this.logger.error('Failed to fetch BTC option settlement history after retries');
      return [];
    }

    const allSettlements = result.data?.result?.settlements || result.data?.settlements || result.data || [];
    
    return allSettlements.filter((settlement: LyraOptionSettlement) => 
      settlement.instrument_name?.startsWith('BTC-')
    );
  }

  async getOptionsHistoricalData(days: number = 7): Promise<{
    instruments: LyraInstrument[];
    trades: LyraTrade[];
    settlements: LyraOptionSettlement[];
  }> {
    const endTimestamp = Math.floor(Date.now() / 1000);
    const startTimestamp = endTimestamp - (days * 24 * 60 * 60);

    this.logger.log(`Fetching comprehensive BTC options data for the last ${days} days`);

    const [instruments, trades, settlements] = await Promise.all([
      this.getOptionInstruments(),
      this.getOptionsTradeHistory({ 
        start_timestamp: startTimestamp, 
        end_timestamp: endTimestamp,
        count: 2000 
      }),
      this.getOptionSettlementHistory(startTimestamp, endTimestamp),
    ]);

    this.logger.log(
      `Fetched ${instruments.length} instruments, ${trades.length} trades, ${settlements.length} settlements`,
    );

    return {
      instruments,
      trades,
      settlements,
    };
  }

  async getOptionsMarketStats(): Promise<any> {
    const result = await this.makeRequestWithRetry(
      () => this.axiosInstance.post('/public/statistics', {
        currency: 'BTC',
        instrument_type: 'option',
      }),
      'fetch options market stats'
    );

    if (!result) {
      this.logger.error('Failed to fetch BTC options market stats after retries');
      return {};
    }

    return result.data?.result || result.data || {};
  }
}
