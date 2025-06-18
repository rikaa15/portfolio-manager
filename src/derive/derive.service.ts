import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Wallet } from 'ethers';

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

export interface LyraSubaccount {
  subaccount_id: number;
  wallet: string;
  label: string;
  is_frozen: boolean;
  collaterals: any[];
}

export interface LyraAccount {
  wallet: string;
  subaccount_ids: number[];
  websocket_matching_tps: number;
  websocket_non_matching_tps: number;
  websocket_perp_tps: number;
  websocket_option_tps: number;
  cancel_on_disconnect: boolean;
  is_rfq_maker: boolean;
  per_endpoint_tps: any;
  fee_info: {
    base_fee_discount: string;
    rfq_maker_discount: string;
    rfq_taker_discount: string;
    option_maker_fee: string | null;
    option_taker_fee: string | null;
    perp_maker_fee: string | null;
    perp_taker_fee: string | null;
    spot_maker_fee: string | null;
    spot_taker_fee: string | null;
  };
}

export interface AuthHeaders {
  'X-LyraWallet': string;
  'X-LyraTimestamp': string;
  'X-LyraSignature': string;
}

@Injectable()
export class DeriveService {
  private readonly logger = new Logger(DeriveService.name);
  private readonly axiosInstance: AxiosInstance;
  private readonly baseUrl: string;
  private readonly defaultTimeout = 10000;
  private readonly retryAttempts = 2;
  private wallet: Wallet | null = null;
  private deriveWalletAddress: string | null = null;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('derive.apiUrl') || 'https://api.lyra.finance';
    
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

    // Initialize authentication if credentials are available
    this.initializeAuthentication();
  }

  private initializeAuthentication(): void {
    const privateKey = this.configService.get<string>('derive.privateKey');
    const walletAddress = this.configService.get<string>('derive.walletAddress');

    if (privateKey) {
      try {
        // Create wallet from private key (without provider for signing only)
        this.wallet = new Wallet(privateKey);
        this.deriveWalletAddress = walletAddress || this.wallet.address;
        this.logger.log('Authentication initialized successfully');
      } catch (error) {
        this.logger.error('Failed to initialize authentication:', error.message);
        this.wallet = null;
        this.deriveWalletAddress = null;
      }
    } else {
      this.logger.warn('No private key found. Only public endpoints will be available.');
    }
  }

  private async generateAuthHeaders(): Promise<AuthHeaders | null> {
    if (!this.wallet || !this.deriveWalletAddress) {
      this.logger.error('Authentication not initialized. Cannot generate auth headers.');
      return null;
    }

    try {
      const timestamp = Date.now().toString();
      const signature = await this.wallet.signMessage(timestamp);

      return {
        'X-LyraWallet': this.deriveWalletAddress,
        'X-LyraTimestamp': timestamp,
        'X-LyraSignature': signature,
      };
    } catch (error) {
      this.logger.error('Failed to generate auth headers:', error.message);
      return null;
    }
  }

  private async makeAuthenticatedRequest<T>(
    endpoint: string,
    data: any = {},
    method: 'GET' | 'POST' = 'POST'
  ): Promise<T | null> {
    const authHeaders = await this.generateAuthHeaders();
    if (!authHeaders) {
      throw new Error('Authentication failed. Cannot make authenticated request.');
    }

    const config: AxiosRequestConfig = {
      method,
      url: endpoint,
      data: method === 'POST' ? data : undefined,
      params: method === 'GET' ? data : undefined,
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
      },
    };

    return this.makeRequestWithRetry(
      () => this.axiosInstance.request<T>(config).then(response => response.data),
      `authenticated ${method} to ${endpoint}`
    );
  }

  // Authentication status check
  isAuthenticationAvailable(): boolean {
    return this.wallet !== null && this.deriveWalletAddress !== null;
  }

  getWalletAddress(): string | null {
    return this.deriveWalletAddress;
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

  // =================================
  // PRIVATE ENDPOINTS (Authenticated)
  // =================================

  /**
   * Get account information including all subaccounts
   */
  async getAccount(): Promise<LyraAccount | null> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    const result = await this.makeAuthenticatedRequest<any>('/private/get_account', {
      wallet: this.deriveWalletAddress
    });
    this.logger.debug('Raw get_account response:', JSON.stringify(result, null, 2));
    return result?.result || result || null;
  }

  /**
   * Get all subaccounts for the authenticated wallet
   */
  async getSubaccounts(): Promise<LyraSubaccount[]> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    // First try the direct endpoint
    let result = await this.makeAuthenticatedRequest<any>('/private/get_subaccounts', {
      wallet: this.deriveWalletAddress
    });
    this.logger.debug('Raw get_subaccounts response:', JSON.stringify(result, null, 2));
    
    // If that doesn't work, get account first and then get each subaccount
    if (!result || (Array.isArray(result) && result.length === 0) || result.error) {
      this.logger.debug('Direct get_subaccounts failed or empty, trying individual subaccount requests...');
      
      const account = await this.getAccount();
      if (account && account.subaccount_ids && account.subaccount_ids.length > 0) {
        const subaccounts: LyraSubaccount[] = [];
        
        for (const subaccountId of account.subaccount_ids) {
          try {
            const subaccountDetail = await this.getSubaccount(subaccountId);
            if (subaccountDetail) {
              subaccounts.push(subaccountDetail);
            }
          } catch (error) {
            this.logger.warn(`Failed to get subaccount ${subaccountId}:`, error.message);
          }
        }
        
        return subaccounts;
      }
    }
    
    return result?.result?.subaccounts || result?.subaccounts || [];
  }

  /**
   * Get specific subaccount information
   */
  async getSubaccount(subaccountId: number): Promise<LyraSubaccount | null> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    const result = await this.makeAuthenticatedRequest<any>('/private/get_subaccount', {
      subaccount_id: subaccountId
    });
    return result?.result || result || null;
  }

  /**
   * Get positions for a specific subaccount
   */
  async getPositions(subaccountId: number): Promise<any[]> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    const result = await this.makeAuthenticatedRequest<any>('/private/get_positions', {
      subaccount_id: subaccountId
    });
    return result?.result?.positions || result?.positions || [];
  }

  /**
   * Get margin information for a specific subaccount
   */
  async getMargin(subaccountId: number): Promise<any> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    const result = await this.makeAuthenticatedRequest<any>('/private/get_margin', {
      subaccount_id: subaccountId
    });
    return result?.result || result || {};
  }

  /**
   * Get open orders for a specific subaccount
   */
  async getOpenOrders(subaccountId: number, instrumentName?: string): Promise<any[]> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    const params: any = { subaccount_id: subaccountId };
    if (instrumentName) params.instrument_name = instrumentName;

    const result = await this.makeAuthenticatedRequest<any>('/private/get_open_orders', params);
    return result?.result?.orders || result?.orders || [];
  }

  /**
   * Get trade history for a specific subaccount (private version with more details)
   */
  async getPrivateTradeHistory(subaccountId: number, params: Partial<LyraTradeHistoryRequest> = {}): Promise<LyraTrade[]> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    const requestParams = {
      subaccount_id: subaccountId,
      count: 100,
      ...params,
    };

    const result = await this.makeAuthenticatedRequest<any>('/private/get_trade_history', requestParams);
    const trades = result?.result?.trades || result?.trades || [];
    
    return trades.map((trade: any) => ({
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
  }
}
