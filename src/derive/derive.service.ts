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

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
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

  async getOptionInstruments(): Promise<LyraInstrument[]> {
    try {
      const response = await this.axiosInstance.post('/public/get_instruments', {
        jsonrpc: '2.0',
        method: 'public/get_instruments',
        params: {
          currency: 'BTC',
          instrument_type: 'option',
          expired: false,
        },
        id: 1,
      });

      return response.data.result || [];
    } catch (error) {
      this.logger.error('Error fetching BTC option instruments:', error);
      throw new Error(`Failed to fetch BTC option instruments: ${error.message}`);
    }
  }

  async getOptionsTradeHistory(params: LyraTradeHistoryRequest = {}): Promise<LyraTrade[]> {
    try {
      const btcParams = {
        currency: 'BTC',
        instrument_type: 'option' as const,
        count: 100,
        ...params,
      };

      const response = await this.axiosInstance.post('/public/get_trade_history', {
        jsonrpc: '2.0',
        method: 'public/get_trade_history',
        params: btcParams,
        id: 1,
      });

      const trades = response.data.result?.trades || [];
      
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
        trade.instrument_name.startsWith('BTC-')
      );
    } catch (error) {
      this.logger.error('Error fetching BTC options trade history:', error);
      throw new Error(`Failed to fetch BTC options trade history: ${error.message}`);
    }
  }

  async getOptionSettlementHistory(
    startTimestamp?: number,
    endTimestamp?: number,
  ): Promise<LyraOptionSettlement[]> {
    try {
      const params: any = { currency: 'BTC' };
      if (startTimestamp) params.start_timestamp = startTimestamp;
      if (endTimestamp) params.end_timestamp = endTimestamp;

      const response = await this.axiosInstance.post('/public/get_option_settlement_history', {
        jsonrpc: '2.0',
        method: 'public/get_option_settlement_history',
        params,
        id: 1,
      });

      const allSettlements = response.data.result?.settlements || response.data.result || [];
      
      return allSettlements.filter((settlement: LyraOptionSettlement) => 
        settlement.instrument_name.startsWith('BTC-')
      );
    } catch (error) {
      this.logger.error('Error fetching BTC option settlement history:', error);
      throw new Error(`Failed to fetch BTC option settlement history: ${error.message}`);
    }
  }

  async getOptionsHistoricalData(days: number = 7): Promise<{
    instruments: LyraInstrument[];
    trades: LyraTrade[];
    settlements: LyraOptionSettlement[];
  }> {
    try {
      const endTimestamp = Math.floor(Date.now() / 1000);
      const startTimestamp = endTimestamp - (days * 24 * 60 * 60);

      this.logger.log(`Fetching comprehensive BTC options data for the last ${days} days`);

      const [instruments, trades, settlements] = await Promise.all([
        this.getOptionInstruments(),
        this.getOptionsTradeHistory({ 
          start_timestamp: startTimestamp, 
          end_timestamp: endTimestamp,
          count: 500 
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
    } catch (error) {
      this.logger.error('Error fetching comprehensive BTC options data:', error);
      throw new Error(`Failed to fetch BTC options historical data: ${error.message}`);
    }
  }

  async getOptionsMarketStats(): Promise<any> {
    try {
      const response = await this.axiosInstance.post('/public/statistics', {
        jsonrpc: '2.0',
        method: 'public/statistics',
        params: {
          currency: 'BTC',
          instrument_type: 'option',
        },
        id: 1,
      });

      return response.data.result || {};
    } catch (error) {
      this.logger.error('Error fetching BTC options market stats:', error);
      throw new Error(`Failed to fetch BTC options market stats: ${error.message}`);
    }
  }
}
