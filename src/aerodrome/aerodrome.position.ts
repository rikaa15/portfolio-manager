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
