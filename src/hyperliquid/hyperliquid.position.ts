/**
 * Represents funding rate data from FundingService
 * Must match the return type from FundingService.getHistoricalFundingRates()
 */
export interface FundingRateData {
  coin: string;
  time: number;
  fundingRate: number;
  premium: number;
}

/**
 * Manages Hyperliquid perpetual position state during backtesting
 * Based on app.service.spec.ts script
 */
export class HyperliquidPosition {
  private futuresNotional: number;
  private futuresLeverage: number;
  private futuresDirection: 'long' | 'short';
  private cumulativeFundingCosts: number;
  private cumulativeHedgePnL: number;
  private previousHedgeValue: number;
  private initialBtcPrice: number;

  // Risk management constants
  private readonly MAX_LEVERAGE = 2;
  private readonly MIN_LEVERAGE = 0.5;
  private readonly MAX_HEDGE_RATIO = 0.75;
  private readonly MAX_FUNDING_RATE = 0.001; // 0.1% per 8h maximum funding rate
  private readonly MAX_POSITION_ADJUSTMENT = 0.1; // Maximum 10% position size adjustment per day
  private readonly LIQUIDATION_BUFFER = 0.85; // 85% liquidation buffer

  constructor(
    initialFuturesNotional: number,
    initialBtcPrice: number,
    direction: 'long' | 'short' = 'short',
    initialLeverage: number = 1,
  ) {
    this.futuresNotional = initialFuturesNotional;
    this.futuresLeverage = initialLeverage;
    this.futuresDirection = direction;
    this.cumulativeFundingCosts = 0;
    this.cumulativeHedgePnL = 0;
    this.previousHedgeValue = 0;
    this.initialBtcPrice = initialBtcPrice;
  }

  /**
   * Updates position state for a given day
   */
  updateDaily(
    currentBtcPrice: number,
    fundingRateData: FundingRateData,
    lpPositionValue: number,
    impermanentLoss: number,
  ): void {
    // FUNDING CALCULATION LOGIC:
    // Funding rates determine who pays whom every 8 hours on perpetuals.
    // - Positive funding rate = longs pay shorts (bullish market sentiment)
    // - Negative funding rate = shorts pay longs (bearish market sentiment)
    //
    // For SHORT positions:
    // - Positive rate = we RECEIVE money (negative cost = income)
    // - Negative rate = we PAY money (positive cost = expense)
    //
    // For LONG positions: (opposite logic)
    // - Positive rate = we PAY money (positive cost = expense)
    // - Negative rate = we RECEIVE money (negative cost = income)
    //
    // Result: dailyFundingFlow negative = income, positive = cost
    const notionalExposure = this.futuresNotional * this.futuresLeverage;
    let dailyFundingFlow: number;

    if (this.futuresDirection === 'short') {
      // For SHORT positions:
      // Positive funding rate = longs pay shorts = you receive money (negative cost = income)
      // Negative funding rate = shorts pay longs = you pay money (positive cost = expense)
      dailyFundingFlow = -fundingRateData.fundingRate * notionalExposure;
    } else {
      // For LONG positions:
      // Positive funding rate = longs pay shorts = you pay money (positive cost = expense)
      // Negative funding rate = shorts pay longs = you receive money (negative cost = income)
      dailyFundingFlow = fundingRateData.fundingRate * notionalExposure;
    }

    this.cumulativeFundingCosts += dailyFundingFlow;

    // Calculate hedge PnL based on price change and position size
    const hedgeNotional = this.futuresNotional * this.futuresLeverage;
    const priceChange =
      (currentBtcPrice - this.initialBtcPrice) / this.initialBtcPrice;

    const hedgeValue =
      this.futuresDirection === 'short'
        ? -hedgeNotional * priceChange // Short position profits when price falls
        : hedgeNotional * priceChange; // Long position profits when price rises

    // Calculate daily hedge PnL
    const dailyHedgePnL = hedgeValue - this.previousHedgeValue;
    this.previousHedgeValue = hedgeValue;
    this.cumulativeHedgePnL += dailyHedgePnL;

    // Apply position adjustments based on IL and funding rates
    this.adjustPositionBasedOnConditions(
      impermanentLoss,
      fundingRateData.fundingRate,
      lpPositionValue,
    );
  }

  /**
   * Adjust hedge based on conditions
   */
  private adjustPositionBasedOnConditions(
    impermanentLoss: number,
    fundingRate: number,
    lpPositionValue: number,
  ): void {
    // Adjust hedge based on IL and ratio change
    if (Math.abs(impermanentLoss) > 1) {
      const adjustmentFactor = Math.min(
        Math.abs(impermanentLoss) / 100,
        this.MAX_POSITION_ADJUSTMENT,
      );

      // Calculate new hedge size
      let newHedgeSize = this.futuresNotional;
      if (impermanentLoss < 0) {
        newHedgeSize *= 1 + adjustmentFactor;
        this.futuresLeverage = Math.min(
          this.futuresLeverage * 1.1,
          this.MAX_LEVERAGE,
        );
      } else {
        newHedgeSize *= 1 - adjustmentFactor;
        this.futuresLeverage = Math.max(
          this.futuresLeverage * 0.9,
          this.MIN_LEVERAGE,
        );
      }

      // Apply hedge size limits
      const maxHedgeSize = lpPositionValue * this.MAX_HEDGE_RATIO;
      this.futuresNotional = Math.min(newHedgeSize, maxHedgeSize);
    }

    // Adjust position based on funding rates
    if (fundingRate > this.MAX_FUNDING_RATE) {
      this.futuresNotional *= 0.95; // Reduce exposure when funding is expensive
    } else if (fundingRate < 0) {
      const maxIncrease =
        lpPositionValue * this.MAX_HEDGE_RATIO - this.futuresNotional;
      this.futuresNotional = Math.min(
        this.futuresNotional * 1.05,
        this.futuresNotional + maxIncrease,
      );
    }
  }

  // Check risk limits
  checkRiskLimits(lpPositionValue: number): boolean {
    const leverageRatio =
      (this.futuresLeverage * this.futuresNotional) / lpPositionValue;
    return leverageRatio > this.LIQUIDATION_BUFFER;
  }

  // Apply risk limit adjustments
  applyRiskLimitAdjustments(): void {
    this.futuresLeverage = Math.max(
      this.MIN_LEVERAGE,
      this.futuresLeverage * 0.7,
    );
  }

  /**
   * Calculate total notional exposure
   */
  getTotalNotional(): number {
    return this.futuresNotional * this.futuresLeverage;
  }

  /**
   * Get daily hedge PnL for logging
   */
  getDailyHedgePnL(): number {
    return this.cumulativeHedgePnL - (this.previousHedgeValue || 0);
  }

  get notionalSize(): number {
    return this.futuresNotional;
  }

  get leverage(): number {
    return this.futuresLeverage;
  }

  get direction(): 'long' | 'short' {
    return this.futuresDirection;
  }

  get totalFundingCosts(): number {
    return this.cumulativeFundingCosts;
  }

  get totalHedgePnL(): number {
    return this.cumulativeHedgePnL;
  }

  get totalNotional(): number {
    return this.getTotalNotional();
  }
}
