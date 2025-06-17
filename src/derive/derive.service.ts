import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { ethers } from 'ethers';
import * as WebSocket from 'ws';

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

export interface LyraOrderRequest {
  instrument_name: string;
  direction: 'buy' | 'sell';
  amount: string;
  price?: string;
  order_type?: 'limit' | 'market';
  time_in_force?: 'GTC' | 'IOC' | 'FOK';
  reduce_only?: boolean;
}

export interface LyraOrderResponse {
  order_id: string;
  instrument_name: string;
  direction: 'buy' | 'sell';
  amount: string;
  price: string;
  order_type: string;
  order_state: 'open' | 'filled' | 'cancelled' | 'rejected';
  creation_timestamp: number;
  filled_amount?: string;
  average_price?: string;
}

export interface LyraPosition {
  instrument_name: string;
  size: string;
  direction: 'buy' | 'sell';
  average_price: string;
  mark_price: string;
  unrealized_pnl: string;
  realized_pnl: string;
  creation_timestamp: number;
}

export interface DeriveAuthConfig {
  privateKey: string; // Your wallet's private key or session key private key
  deriveWallet: string; // Your Derive wallet address (from Developers section)
  subAccountId?: string; // Optional subaccount ID
}

@Injectable()
export class DeriveService {
  private readonly logger = new Logger(DeriveService.name);
  public readonly axiosInstance: AxiosInstance;
  private readonly baseUrl = 'https://api.lyra.finance'; // Correct mainnet endpoint
  private readonly wsUrl = 'wss://api.lyra.finance/ws'; // WebSocket endpoint
  private readonly defaultTimeout = 10000;
  private readonly retryAttempts = 2;
  private authConfig?: DeriveAuthConfig;

  constructor(authConfig?: DeriveAuthConfig) {
    this.authConfig = authConfig;
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

  setAuthConfig(authConfig: DeriveAuthConfig): void {
    this.authConfig = authConfig;
  }

  private async generateAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
    if (!this.authConfig) {
      throw new Error('Authentication config not set. Call setAuthConfig() first.');
    }

    // Ensure private key has 0x prefix
    const privateKey = this.authConfig.privateKey.startsWith('0x') 
      ? this.authConfig.privateKey 
      : '0x' + this.authConfig.privateKey;

    const wallet = new ethers.Wallet(privateKey);
    const timestamp = Date.now(); // Keep as number, as per Derive docs
    
    // Sign the timestamp as number (Derive docs show: wallet.signMessage(timestamp))
    const signature = await wallet.signMessage(timestamp.toString());

    return {
      'X-LyraWallet': wallet.address, // Use EOA address as shown in documentation example
      'X-LyraTimestamp': timestamp.toString(), // Send as string in header
      'X-LyraSignature': signature,
      // Temporarily disable subaccount header for testing
      // ...(this.authConfig.subAccountId && { 'X-LyraSubAccount': this.authConfig.subAccountId }),
    };
  }

  private async makeAuthenticatedRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: any
  ): Promise<T> {
    if (!this.authConfig) {
      throw new Error('Authentication config not set. Call setAuthConfig() first.');
    }

    const privateKey = this.authConfig.privateKey.startsWith('0x') 
      ? this.authConfig.privateKey 
      : '0x' + this.authConfig.privateKey;
    
    const wallet = new ethers.Wallet(privateKey);
    const headers = await this.generateAuthHeaders(method, endpoint);
    
    // Add wallet address to request body as shown in documentation
    // Use EOA address consistently in both headers and body
    const requestBody = {
      wallet: wallet.address, // EOA address in request body (consistent with headers)
      ...data
    };
    
    const config = {
      method,
      url: endpoint,
      headers,
      ...(requestBody && { data: requestBody }),
    };

    const response = await this.axiosInstance.request(config);
    return response.data?.result || response.data;
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

  async openPosition(orderRequest: LyraOrderRequest): Promise<LyraOrderResponse> {
    if (!this.authConfig) {
      throw new Error('Authentication required for trading. Call setAuthConfig() first.');
    }

    // Risk management checks
    const amount = parseFloat(orderRequest.amount);
    if (amount <= 0) {
      throw new Error('Order amount must be greater than 0');
    }
    
    // Warning for large amounts
    if (amount > 1) {
      this.logger.warn(`⚠️  Large order amount detected: ${amount}. Consider starting smaller.`);
    }

    this.logger.log(`Opening position: ${orderRequest.direction} ${orderRequest.amount} ${orderRequest.instrument_name}`);

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<LyraOrderResponse>('POST', '/private/order', {
        instrument_name: orderRequest.instrument_name,
        direction: orderRequest.direction,
        amount: orderRequest.amount,
        order_type: orderRequest.order_type || 'market',
        ...(orderRequest.price && { price: orderRequest.price }),
        ...(orderRequest.time_in_force && { time_in_force: orderRequest.time_in_force }),
        ...(orderRequest.reduce_only && { reduce_only: orderRequest.reduce_only }),
      }),
      'open position'
    );

    if (!result) {
      throw new Error('Failed to open position after retries');
    }

    this.logger.log(`Position opened successfully: Order ID ${result.order_id}`);
    return result;
  }

  async closePosition(instrumentName: string, amount?: string): Promise<LyraOrderResponse> {
    if (!this.authConfig) {
      throw new Error('Authentication required for trading. Call setAuthConfig() first.');
    }

    // First get current position to determine close amount and direction
    const positions = await this.getPositions();
    const position = positions.find(p => p.instrument_name === instrumentName);
    
    if (!position) {
      throw new Error(`No position found for instrument: ${instrumentName}`);
    }

    const closeAmount = amount || Math.abs(parseFloat(position.size)).toString();
    const closeDirection = parseFloat(position.size) > 0 ? 'sell' : 'buy';

    const orderRequest: LyraOrderRequest = {
      instrument_name: instrumentName,
      direction: closeDirection,
      amount: closeAmount,
      order_type: 'market',
      reduce_only: true,
    };

    this.logger.log(`Closing position: ${closeDirection} ${closeAmount} ${instrumentName}`);

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<LyraOrderResponse>('POST', '/private/order', orderRequest),
      'close position'
    );

    if (!result) {
      throw new Error('Failed to close position after retries');
    }

    this.logger.log(`Position closed successfully: Order ID ${result.order_id}`);
    return result;
  }

  async getPositions(): Promise<LyraPosition[]> {
    if (!this.authConfig) {
      throw new Error('Authentication required. Call setAuthConfig() first.');
    }

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<LyraPosition[]>('POST', '/private/get_positions', {
        currency: 'BTC', // or make this configurable
      }),
      'fetch positions'
    );

    if (!result) {
      this.logger.error('Failed to fetch positions after retries');
      return [];
    }

    return Array.isArray(result) ? result : [];
  }

  async getOpenOrders(): Promise<LyraOrderResponse[]> {
    if (!this.authConfig) {
      throw new Error('Authentication required. Call setAuthConfig() first.');
    }

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<LyraOrderResponse[]>('POST', '/private/get_open_orders', {}),
      'fetch open orders'
    );

    if (!result) {
      this.logger.error('Failed to fetch open orders after retries');
      return [];
    }

    return Array.isArray(result) ? result : [];
  }

  async cancelOrder(orderId: string): Promise<LyraOrderResponse> {
    if (!this.authConfig) {
      throw new Error('Authentication required. Call setAuthConfig() first.');
    }

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<LyraOrderResponse>('POST', '/private/cancel', { 
        order_id: orderId 
      }),
      'cancel order'
    );

    if (!result) {
      throw new Error('Failed to cancel order after retries');
    }

    this.logger.log(`Order cancelled successfully: ${orderId}`);
    return result;
  }

  async getOrderBook(instrumentName: string, depth: number = 10): Promise<any> {
    const result = await this.makeRequestWithRetry(
      () => this.axiosInstance.post('/public/get_order_book', {
        instrument_name: instrumentName,
        depth,
      }),
      'fetch order book'
    );

    return result?.data?.result || result?.data || {};
  }

  async getAccountSummary(): Promise<any> {
    if (!this.authConfig) {
      throw new Error('Authentication required. Call setAuthConfig() first.');
    }

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<any>('POST', '/private/get_account', {
        wallet: this.authConfig.deriveWallet,
        ...(this.authConfig.subAccountId && { subaccount_id: this.authConfig.subAccountId }),
      }),
      'fetch account summary'
    );

    return result || {};
  }

  async getSubaccount(subaccountId: string): Promise<any> {
    if (!this.authConfig) {
      throw new Error('Authentication required. Call setAuthConfig() first.');
    }

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<any>('POST', '/private/get_subaccount', {
        subaccount_id: subaccountId,
      }),
      'fetch subaccount info'
    );

    return result || {};
  }

  async getSubaccounts(): Promise<any> {
    if (!this.authConfig) {
      throw new Error('Authentication required. Call setAuthConfig() first.');
    }

    const result = await this.makeRequestWithRetry(
      () => this.makeAuthenticatedRequest<any>('POST', '/private/get_subaccounts', {
        wallet: this.authConfig.deriveWallet,
      }),
      'fetch subaccounts'
    );

    return result || {};
  }

  // WebSocket authentication method
  async connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      
      ws.on('open', () => {
        this.logger.log('WebSocket connected');
        resolve(ws);
      });
      
      ws.on('error', (error) => {
        this.logger.error('WebSocket error:', error);
        reject(error);
      });
    });
  }

  async authenticateWebSocket(ws: WebSocket): Promise<void> {
    if (!this.authConfig) {
      throw new Error('Authentication config not set. Call setAuthConfig() first.');
    }

    const privateKey = this.authConfig.privateKey.startsWith('0x') 
      ? this.authConfig.privateKey 
      : '0x' + this.authConfig.privateKey;
    
    const wallet = new ethers.Wallet(privateKey);
    const timestamp = Date.now();
    const signature = await wallet.signMessage(timestamp.toString());

    return new Promise((resolve, reject) => {
      const loginMessage = {
        method: 'public/login',
        params: {
          wallet: wallet.address, // EOA address for WebSocket login
          timestamp: timestamp,
          signature: signature
        },
        id: 1,
      };

      ws.send(JSON.stringify(loginMessage));

      const timeoutId = setTimeout(() => {
        reject(new Error('WebSocket authentication timeout'));
      }, 10000);

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.id === 1) {
            clearTimeout(timeoutId);
            if (message.error) {
              reject(new Error(`WebSocket auth failed: ${message.error.message}`));
            } else {
              this.logger.log('WebSocket authenticated successfully');
              resolve();
            }
          }
        } catch (error) {
          // Ignore non-JSON messages
        }
      });
    });
  }
}
