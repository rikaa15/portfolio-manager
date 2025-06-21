// src/aerodrome/aerodrome.position.ts
import { PoolDayData, Position } from './types';
import {
  calculatePositionFees,
  getPositionTickRange,
  isPositionActive,
} from './aerodrome.utils';

/**
 * Manages Aerodrome LP position state during backtesting
 * Tracks daily performance, fees, and rebalancing needs
 */
export class AerodromePosition {
  private initialInvestment: number;
  private lpSharePercentage: number;
  private currentPositionValue: number;
  private cumulativeFees: number;
  private positionType: string;
  private tickSpacing: number;
  private allPositions: Position[];
  private initialToken0Price: number;
  private daysInRange: number;
  private totalDays: number;

  // Token Ratio tracking
  private initialToken0Amount: number; // Initial BTC amount
  private initialToken1Amount: number; // Initial USDC amount
  private constantProductK: number; // x * y = k constant

  constructor(
    initialInvestment: number,
    firstDayData: PoolDayData,
    positionType: string = 'full-range',
    tickSpacing: number = 2000,
    allPositions: Position[] = [],
  ) {
    this.initialInvestment = initialInvestment;
    this.lpSharePercentage =
      initialInvestment / parseFloat(firstDayData.tvlUSD);
    this.currentPositionValue = initialInvestment;
    this.cumulativeFees = 0;
    this.positionType = positionType;
    this.tickSpacing = tickSpacing;
    this.allPositions = allPositions;
    this.initialToken0Price = parseFloat(firstDayData.token0Price);
    this.daysInRange = 0;
    this.totalDays = 0;

    // Initialize token ratio tracking based on position type
    const initialSplit = this.calculateInitialTokenSplit(
      positionType,
      this.initialToken0Price,
    );

    this.initialToken0Amount = initialSplit.token0Amount;
    this.initialToken1Amount = initialSplit.token1Amount;
    this.constantProductK = this.initialToken0Amount * this.initialToken1Amount; // x * y = k
  }

  /**
   * Updates position state for a given day using existing utility functions
   */
  updateDaily(dayData: PoolDayData): void {
    this.totalDays++;

    // Calculate current position value based on TVL share
    const currentTVL = parseFloat(dayData.tvlUSD);
    this.currentPositionValue = currentTVL * this.lpSharePercentage;

    // Calculate daily fees using existing utility
    const dailyFees = calculatePositionFees(
      dayData,
      this.positionType,
      this.allPositions,
      this.lpSharePercentage,
      this.tickSpacing,
    );

    this.cumulativeFees += dailyFees;

    // Track if position is in range using existing utility
    if (this.isPositionInRange(dayData)) {
      this.daysInRange++;
    }
  }

  /**
   * Checks if position is currently in range using existing utility
   */
  private isPositionInRange(dayData: PoolDayData): boolean {
    const currentTick = parseInt(dayData.tick);
    const positionRange = getPositionTickRange(
      currentTick,
      this.positionType,
      this.tickSpacing,
    );

    return isPositionActive(currentTick, positionRange);
  }

  /**
   * Calculate initial token split based on position type
   * Position types refer to price range width, not token allocation
   * For concentrated positions deployed at current price, we start balanced
   */
  private calculateInitialTokenSplit(
    positionType: string,
    token0Price: number,
  ): {
    token0Amount: number;
    token1Amount: number;
  } {
    // All position types start with balanced 50/50 split when deployed at current price
    // The difference is in their price range width:
    // - "10%" = ±5% price range (tick space ~1000)
    // - "20%" = ±10% price range (tick space ~2000)
    // - "30%" = ±15% price range (tick space ~3000)
    // - "full-range" = entire price spectrum

    const token0Percentage = 0.5; // Always start balanced at current price

    const token0Value = this.initialInvestment * token0Percentage;
    const token1Value = this.initialInvestment * (1 - token0Percentage);

    return {
      token0Amount: token0Value / token0Price, // BTC amount
      token1Amount: token1Value, // USDC amount (≈ $1)
    };
  }

  /**
   * Calculate current token composition using constant product formula
   * For full range LP positions: x * y = k (constant product)
   * Only needs BTC price since USDC ≈ $1
   */
  calculateTokenRatio(currentToken0Price: number): {
    token0Amount: number;
    token1Amount: number;
    token0Value: number;
    token1Value: number;
    token0Ratio: number;
    token1Ratio: number;
    deviationFrom50_50: number;
  } {
    // Using constant product formula: x * y = k
    // Solve for current token amounts after price change
    const currentToken0Amount = Math.sqrt(
      this.constantProductK / currentToken0Price,
    );
    const currentToken1Amount = this.constantProductK / currentToken0Amount;

    // Calculate current values (USDC ≈ $1, so amount = value)
    const currentToken0Value = currentToken0Amount * currentToken0Price;
    const currentToken1Value = currentToken1Amount; // USDC amount ≈ USDC value
    const totalValue = currentToken0Value + currentToken1Value;

    // Calculate ratios
    const token0Ratio = currentToken0Value / totalValue;
    const token1Ratio = currentToken1Value / totalValue;

    // Calculate deviation from target 50/50
    const deviationFrom50_50 = Math.abs(token0Ratio - 0.5);

    return {
      token0Amount: currentToken0Amount,
      token1Amount: currentToken1Amount,
      token0Value: currentToken0Value,
      token1Value: currentToken1Value,
      token0Ratio,
      token1Ratio,
      deviationFrom50_50,
    };
  }

  /**
   * Check if hedge should be adjusted based on token ratio deviation
   * Following Aaron's strategy: "Rebalance when LP shifts >5% from 50/50"
   */
  shouldAdjustHedge(currentToken0Price: number): {
    shouldAdjust: boolean;
    adjustmentDirection: 'increase' | 'decrease' | 'none';
    deviation: number;
    tokenRatio: any;
  } {
    const tokenRatio = this.calculateTokenRatio(currentToken0Price);
    const shouldAdjust = tokenRatio.deviationFrom50_50 > 0.05; // 5% threshold from Aaron's strategy

    let adjustmentDirection: 'increase' | 'decrease' | 'none' = 'none';

    if (shouldAdjust) {
      if (tokenRatio.token0Ratio > 0.55) {
        // Too much BTC exposure (>55%), increase short hedge
        adjustmentDirection = 'increase';
      } else if (tokenRatio.token0Ratio < 0.45) {
        // Too little BTC exposure (<45%), decrease short hedge
        adjustmentDirection = 'decrease';
      }
    }

    return {
      shouldAdjust,
      adjustmentDirection,
      deviation: tokenRatio.deviationFrom50_50,
      tokenRatio,
    };
  }

  /**
   * Calculate impermanent loss using the existing formula from backtest script
   */
  calculateImpermanentLoss(currentToken0Price: number): number {
    // Reuse the exact IL calculation from the backtest script
    const priceRatio = currentToken0Price / this.initialToken0Price;
    const sqrtPriceRatio = Math.sqrt(priceRatio);
    const lpValue = (2 * sqrtPriceRatio) / (1 + priceRatio);
    const holdValue = 1;

    return (lpValue - holdValue) * 100;
  }

  /**
   * Calculate running APR based on fees only
   */
  calculateRunningAPR(): number {
    if (this.totalDays === 0) return 0;
    return (
      (this.cumulativeFees / this.initialInvestment) *
      (365 / this.totalDays) *
      100
    );
  }

  /**
   * Calculate total PnL (position change + fees)
   */
  calculateTotalPnL(): number {
    const positionPnL = this.currentPositionValue - this.initialInvestment;
    return positionPnL + this.cumulativeFees;
  }

  /**
   * Calculate time in range percentage
   */
  getTimeInRangePercent(): number {
    if (this.totalDays === 0) return 0;
    return (this.daysInRange / this.totalDays) * 100;
  }

  /**
   * Check if position needs rebalancing
   */
  shouldRebalance(dayData: PoolDayData): boolean {
    // Simple rebalancing logic: if out of range for too many consecutive days
    // For this implementation, we'll keep it simple and not track consecutive days
    // This can be enhanced later if needed
    return !this.isPositionInRange(dayData);
  }

  get value(): number {
    return this.currentPositionValue;
  }

  get fees(): number {
    return this.cumulativeFees;
  }

  get totalReturn(): number {
    return (
      ((this.currentPositionValue +
        this.cumulativeFees -
        this.initialInvestment) /
        this.initialInvestment) *
      100
    );
  }

  get initialValue(): number {
    return this.initialInvestment;
  }

  get sharePercentage(): number {
    return this.lpSharePercentage;
  }

  get daysElapsed(): number {
    return this.totalDays;
  }
}
