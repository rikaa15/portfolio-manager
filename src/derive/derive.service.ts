import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Wallet } from 'ethers';
import * as ethers from 'ethers';

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
  subaccount_value?: string;
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

// New interfaces for order submission
export interface DeriveOrder {
  subaccount_id: number;
  instrument_name: string;
  direction: 'buy' | 'sell';
  amount: string;
  limit_price?: string;
  max_fee: string;
  nonce: string;
  signature_expiry_sec: number;
  signer: string;
  signature?: string;
}

export interface OrderResponse {
  success: boolean;
  result?: {
    order_id: string;
    subaccount_id: number;
    instrument_name: string;
    direction: string;
    amount: string;
    price?: string;
    order_status: string;
    timestamp: number;
  };
  error?: {
    code: number;
    message: string;
  };
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

  // EIP-712 Constants for order signing (based on Derive documentation)
  private readonly DOMAIN_SEPARATOR = '0x9bcf4dc06df5d8bf23af818d5716491b995020f377d3b7b64c29ed14e3dd1105'; // Testnet - from Protocol Constants table
  private readonly ACTION_TYPEHASH = '0x4d7a9f27c403ff9c0f19bce61d76d82f9aa29f8d6d4b0c5474607d9770d1af17'; // Same for mainnet/testnet - from Protocol Constants table
  private readonly TRADE_MODULE_ADDRESS = '0x87F2863866D85E3192a35A73b388BD625D83f2be'; // Testnet - from Protocol Constants table

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

  /**
   * Get current BTC option instruments suitable for small test trades
   */
  async getActiveOptionsForTrading(minDaysToExpiry: number = 7): Promise<LyraInstrument[]> {
    const instruments = await this.getOptionInstruments(false); // Get active only
    const now = Date.now() / 1000;
    const minExpiryTime = now + (minDaysToExpiry * 24 * 60 * 60);

    return instruments.filter(instrument => 
      instrument.instrument_name.startsWith('BTC-') &&
      instrument.expiry_timestamp &&
      instrument.expiry_timestamp > minExpiryTime &&
      instrument.is_active
    ).sort((a, b) => (a.expiry_timestamp || 0) - (b.expiry_timestamp || 0)); // Sort by expiry (nearest first)
  }

  /**
   * Create order signature using EIP-712 structured data
   */
  private async signOrder(order: DeriveOrder): Promise<string> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized for signing');
    }

    // Get instrument details for base_asset_address
    const instrumentResult = await this.makeRequestWithRetry(
      () => this.axiosInstance.post('/public/get_instrument', {
        instrument_name: order.instrument_name,
      }),
      'fetch instrument details for signing'
    );

    if (!instrumentResult?.data?.result) {
      throw new Error(`Failed to get instrument details for ${order.instrument_name}`);
    }

    const instrument = instrumentResult.data.result;
    const baseAssetAddress = instrument.base_asset_address;
    const subId = instrument.base_asset_sub_id || 0;

    // Encode trade module data
    const encoder = new ethers.AbiCoder();
    const tradeModuleData = encoder.encode(
      ['address', 'uint256', 'int256', 'uint256', 'uint256', 'bool'],
      [
        baseAssetAddress,
        subId,
        ethers.parseUnits(order.amount, 18),
        ethers.parseUnits(order.max_fee, 18),
        order.subaccount_id,
        order.direction === 'buy'
      ]
    );

    const tradeModuleDataHash = ethers.keccak256(Buffer.from(tradeModuleData.slice(2), 'hex'));

    // Create action hash
    const actionHash = ethers.keccak256(
      encoder.encode(
        ['bytes32', 'uint256', 'uint256', 'address', 'bytes32', 'uint256', 'address', 'address'],
        [
          this.ACTION_TYPEHASH,
          order.subaccount_id,
          order.nonce,
          this.TRADE_MODULE_ADDRESS,
          tradeModuleDataHash,
          order.signature_expiry_sec,
          this.wallet.address,
          order.signer
        ]
      )
    );

    // Create EIP-712 typed data hash
    const typedDataHash = ethers.keccak256(
      Buffer.concat([
        Buffer.from('1901', 'hex'),
        Buffer.from(this.DOMAIN_SEPARATOR.slice(2), 'hex'),
        Buffer.from(actionHash.slice(2), 'hex')
      ])
    );

    // Sign the hash
    const signature = this.wallet.signingKey.sign(typedDataHash);
    return signature.serialized;
  }

  /**
   * Submit a signed order to Derive with automatic fee adjustment
   */
  async submitOrderWithRetry(order: DeriveOrder, maxRetries: number = 1): Promise<OrderResponse> {
    if (!this.isAuthenticationAvailable()) {
      throw new Error('Authentication not available. Please set DERIVE_PRIVATE_KEY and DERIVE_WALLET_ADDRESS environment variables.');
    }

    let currentOrder = { ...order };
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Sign the order
      const signedOrder = {
        ...currentOrder,
        signature: await this.signOrder(currentOrder)
      };

      this.logger.log(`Submitting order (attempt ${attempt + 1}): ${currentOrder.direction} ${currentOrder.amount} ${currentOrder.instrument_name} (max_fee: ${currentOrder.max_fee})`);

      const result = await this.makeAuthenticatedRequest<OrderResponse>(
        '/private/order',
        signedOrder,
        'POST'
      );

      if (result?.success) {
        this.logger.log(`Order submitted successfully: ${result.result?.order_id}`);
        return result;
      } else if (result?.error?.message?.includes('Max fee order param is too low') && attempt < maxRetries) {
        // Parse the required minimum fee from the error message
        const errorData = (result.error as any)?.data || '';
        const feeMatch = errorData.match(/must be >= ([\d.]+)/);
        
        if (feeMatch) {
          const requiredFee = parseFloat(feeMatch[1]);
          const newMaxFee = (requiredFee * 1.01).toFixed(4); // Add 1% buffer
          
          this.logger.log(`Max fee too low (${currentOrder.max_fee}), retrying with ${newMaxFee}`);
          currentOrder.max_fee = newMaxFee;
          
          // Generate new nonce for retry
          currentOrder.nonce = Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
          continue;
        }
      }
      
      // If we get here, either it succeeded, failed for other reasons, or we couldn't parse the fee
      if (result?.error) {
        this.logger.error(`Order submission failed: ${result.error.message}`);
      }
      
      return result || { success: false, error: { code: -1, message: 'Unknown error' } };
    }

    return { success: false, error: { code: -1, message: 'Max retries exceeded' } };
  }

  /**
   * Open a BTC options position with specified parameters
   */
  async openPosition(params: {
    subaccountId: number;
    instrumentName: string;
    direction: 'buy' | 'sell';
    amount: string;
    limitPrice?: string;
    maxFee: string;
    useRetry?: boolean;
  }): Promise<{
    success: boolean;
    order?: OrderResponse;
    error?: string;
  }> {
    try {
      this.logger.log(`Opening position: ${params.direction} ${params.amount} ${params.instrumentName} (max_fee: $${params.maxFee})`);

      // Get current pricing if no limit price provided
      let finalLimitPrice = params.limitPrice;
      if (!finalLimitPrice) {
        const tickerResult = await this.makeRequestWithRetry(
          () => this.axiosInstance.post('/public/get_ticker', {
            instrument_name: params.instrumentName,
          }),
          'fetch ticker for pricing'
        );

        if (!tickerResult?.data?.result) {
          return {
            success: false,
            error: 'Failed to get current pricing for instrument'
          };
        }

        const ticker = tickerResult.data.result;
        const currentPrice = parseFloat(ticker.mark_price || ticker.best_bid_price || ticker.best_ask_price || '0');
        
        if (currentPrice <= 0) {
          return {
            success: false,
            error: 'Invalid pricing data received'
          };
        }

        // Set limit price with 5% buffer (above market for buy, below for sell)
        const priceAdjustment = params.direction === 'buy' ? 1.05 : 0.95;
        finalLimitPrice = Math.round(currentPrice * priceAdjustment).toString();
        
        this.logger.log(`Auto-calculated limit price: $${finalLimitPrice} (market: $${currentPrice})`);
      }

      // Generate nonce
      const nonce = Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      
      // Create order
      const order: DeriveOrder = {
        subaccount_id: params.subaccountId,
        instrument_name: params.instrumentName,
        direction: params.direction,
        amount: params.amount,
        limit_price: finalLimitPrice,
        max_fee: params.maxFee,
        nonce,
        signature_expiry_sec: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
        signer: this.deriveWalletAddress!,
      };

      this.logger.log(`Order details: ${JSON.stringify(order, null, 2)}`);

      // Submit order (with or without retry)
      const orderResult = params.useRetry !== false 
        ? await this.submitOrderWithRetry(order, 1)
        : await this.submitOrderWithRetry(order, 0); // No retries

      return {
        success: orderResult.success || false,
        order: orderResult,
        error: orderResult.success ? undefined : orderResult.error?.message
      };

    } catch (error) {
      this.logger.error('Failed to open position:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Close a BTC options position by selling/buying back
   */
  async closePosition(params: {
    subaccountId: number;
    instrumentName: string;
    amount: string; // Amount to close (should match or be less than current position)
    limitPrice?: string;
    maxFee: string;
    useRetry?: boolean;
  }): Promise<{
    success: boolean;
    order?: OrderResponse;
    error?: string;
  }> {
    try {
      this.logger.log(`Closing position: ${params.amount} ${params.instrumentName} (max_fee: $${params.maxFee})`);

      // First, check current position to determine close direction
      const positions = await this.getPositions(params.subaccountId);
      const currentPosition = positions.find(pos => pos.instrument_name === params.instrumentName);
      
      if (!currentPosition) {
        return {
          success: false,
          error: `No position found for ${params.instrumentName} in subaccount ${params.subaccountId}`
        };
      }

      // Determine close direction (opposite of current position)
      const currentAmount = parseFloat(currentPosition.amount || '0');
      const closeDirection: 'buy' | 'sell' = currentAmount > 0 ? 'sell' : 'buy';
      
      this.logger.log(`Current position: ${currentAmount} ${params.instrumentName}, closing with ${closeDirection}`);

      // Validate close amount
      const closeAmount = parseFloat(params.amount);
      const maxCloseAmount = Math.abs(currentAmount);
      
      if (closeAmount > maxCloseAmount) {
        return {
          success: false,
          error: `Cannot close ${closeAmount} - maximum closeable amount is ${maxCloseAmount}`
        };
      }

      // Use the openPosition method with opposite direction
      return await this.openPosition({
        subaccountId: params.subaccountId,
        instrumentName: params.instrumentName,
        direction: closeDirection,
        amount: params.amount,
        limitPrice: params.limitPrice,
        maxFee: params.maxFee,
        useRetry: params.useRetry
      });

    } catch (error) {
      this.logger.error('Failed to close position:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get current position for a specific instrument
   */
  async getPositionForInstrument(subaccountId: number, instrumentName: string): Promise<{
    exists: boolean;
    amount?: string;
    averagePrice?: string;
    unrealizedPnl?: string;
    position?: any;
  }> {
    try {
      const positions = await this.getPositions(subaccountId);
      const position = positions.find(pos => pos.instrument_name === instrumentName);
      
      if (!position) {
        return { exists: false };
      }

      return {
        exists: true,
        amount: position.amount,
        averagePrice: position.average_price,
        unrealizedPnl: position.unrealized_pnl,
        position
      };

    } catch (error) {
      this.logger.error(`Failed to get position for ${instrumentName}:`, error.message);
      return { exists: false };
    }
  }
}
